/**
 * Runs scripts/webp-encode.html in an already-running headless Chrome and reads
 * the encoded images back out.
 *
 * usage: bun run scripts/webp-encode-cdp.ts <cdp-port> <page-url>
 *
 * The page is opened in a fresh tab (its job list travels in the URL fragment),
 * the client waits until it reports `__done`, then prints one TSV line per
 * image: `out  width  height  quality  bytes  base64`. The driver script
 * (scripts/webp-encode.sh) decodes that base64 into the .webp files.
 *
 * Chrome's `--dump-dom --virtual-time-budget` cannot be used here: it dumps as
 * soon as the page goes idle, which is while the first canvas encode is still
 * running, so all but the first image would be missing.
 */
const [portArg, url] = process.argv.slice(2);
if (!portArg || !url) {
  console.error("usage: webp-encode-cdp.ts <cdp-port> <page-url>");
  process.exit(2);
}
const port = Number(portArg);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const opened = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
  method: "PUT",
});
if (!opened.ok) {
  console.error(`could not open a tab: HTTP ${opened.status}`);
  process.exit(1);
}
const target = (await opened.json()) as { id: string; webSocketDebuggerUrl: string };

const socket = new WebSocket(target.webSocketDebuggerUrl);
const waiting = new Map<number, (message: any) => void>();
let nextId = 1;
socket.addEventListener("message", (event: MessageEvent) => {
  const message = JSON.parse(String(event.data));
  const resolve = message.id ? waiting.get(message.id) : undefined;
  if (resolve) {
    waiting.delete(message.id);
    resolve(message);
  }
});
await new Promise<void>((resolve) =>
  socket.addEventListener("open", () => resolve(), { once: true }),
);

function call(method: string, params: Record<string, unknown> = {}) {
  const id = nextId++;
  return new Promise<any>((resolve) => {
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression: string): Promise<any> {
  const answer = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (answer.result?.exceptionDetails) {
    throw new Error(
      answer.result.exceptionDetails.exception?.description ??
        answer.result.exceptionDetails.text ??
        "evaluate threw",
    );
  }
  return answer.result?.result?.value;
}

await call("Page.enable");
await call("Runtime.enable");
await call("Page.navigate", { url });

/** 60 s is ample for a handful of local PNGs; a missing reply means a real hang. */
let state = "";
for (let i = 0; i < 600; i += 1) {
  state = await evaluate(
    `window.__error ? "ERR:" + window.__error
      : window.__done ? "OK:" + window.__records.length
      : "WAIT"`,
  );
  if (state !== "WAIT") break;
  await sleep(100);
}
if (!state.startsWith("OK:")) {
  console.error(
    state.startsWith("ERR:")
      ? `the encoder page failed: ${state.slice(4)}`
      : "the encoder page never finished",
  );
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  socket.close();
  process.exit(1);
}

const count = Number(state.slice(3));
for (let i = 0; i < count; i += 1) {
  const record = await evaluate(`JSON.stringify(window.__records[${i}])`);
  const parsed = JSON.parse(record) as {
    out: string;
    width: number;
    height: number;
    quality: number;
    bytes: number;
    b64: string;
  };
  // One line per image; base64 has no tab, so the fields stay separable.
  process.stdout.write(
    `${parsed.out}\t${parsed.width}\t${parsed.height}\t${parsed.quality}\t${parsed.bytes}\t${parsed.b64}\n`,
  );
}

await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
socket.close();
process.exit(0);
