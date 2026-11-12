/**
 * Synthetic seed data for the README screenshots.
 *
 * Everything below is invented: no real agent history, project path, owner id or
 * conversation is read, copied or derived from the machine's real index. These
 * sessions exist only so `scripts/capture-screenshots.sh` can start the web UI
 * against a throwaway index that still has plausible content to photograph.
 *
 * The file is deliberately not named `*.test.ts`, so `bun test` ignores it. Run
 * it directly to seed or inspect a fixture index:
 *
 *   bun run test/fixtures/screenshot-data.ts <db-path>            # create
 *   bun run test/fixtures/screenshot-data.ts --verify <db-path>   # inspect
 *
 * `--verify` exits non-zero when the index holds a session this file did not
 * write, which is the check the capture script runs before it photographs
 * anything.
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import type {
  ParsedEvent,
  ParsedSession,
  ParsedTurn,
} from "../../src/adapters/types.ts";
import { openDb, writeSession } from "../../src/db.ts";

/** Every external id this module writes starts with this marker. */
export const FIXTURE_ID_PREFIX = "demo-";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function turn(
  idx: number,
  ts: number,
  userText: string,
  assistantText: string,
  model: string,
): ParsedTurn {
  return { idx, ts, userText, assistantText, model };
}

/**
 * Six fictional sessions across five agents and four projects, with Chinese and
 * English turns mixed, plus a few tool events so the process index has
 * something to show as well.
 */
export function screenshotSessions(now: number = Date.now()): ParsedSession[] {
  const sessions: ParsedSession[] = [
    {
      agent: "claude-code",
      externalId: "demo-ws-reconnect",
      projectPath: "/Users/demo/demo-app",
      title: "修复 WebSocket 重连后的重复订阅",
      startedAt: now - 2 * HOUR - 12 * 60_000,
      updatedAt: now - 2 * HOUR,
      sourceKind: "jsonl",
      sourcePath: "/Users/demo/agents/claude/demo-ws-reconnect.jsonl",
      fingerprint: "fixture:demo-ws-reconnect",
      turns: [
        turn(
          0,
          now - 2 * HOUR - 12 * 60_000,
          "断网重连之后，同一个房间被订阅了 3 次，Node 抛 MaxListenersExceededWarning。重连回调里怎么写才不会重复注册？",
          [
            "重连回调必须先解绑上一个连接器，再建立新的。旧 socket 直接丢掉是不够的：监听器还挂在它上面，重连几次就有几组。",
            "",
            "```js",
            "function connect(room) {",
            "  let socket = null;",
            "  const onMessage = (payload) => handle(room, payload);",
            "",
            "  const open = () => {",
            "    socket?.off(\"message\", onMessage);",
            "    socket?.removeAllListeners();",
            "    socket?.close();",
            "",
            "    socket = createSocket(room);",
            "    socket.on(\"message\", onMessage);",
            "    socket.on(\"close\", () => scheduleReconnect(room));",
            "  };",
            "",
            "  open();",
            "}",
            "```",
            "",
            "三个关键点：",
            "",
            "- 每次重连都换一个新 socket，旧的先 `off` 再 `close`；",
            "- `onMessage` 必须是稳定引用，匿名函数没法解绑；",
            "- 重连前后断言 `socket.listenerCount(\"message\") === 1`，让重复订阅在测试里就报出来。",
          ].join("\n"),
          "claude-sonnet-4-5",
        ),
        turn(
          1,
          now - 2 * HOUR - 6 * 60_000,
          "这个重连 backoff 要不要加 jitter？我们几十个客户端会不会在 5 秒后一起回来？",
          [
            "要加。固定间隔的重连会让所有客户端在同一个时间点回到服务端，形成重连风暴，这正是固定 5 秒 backoff 最典型的故障形态。",
            "",
            "```js",
            "const base = Math.min(30_000, 500 * 2 ** attempt);",
            "const jitter = Math.random() * base * 0.5;",
            "const delay = base / 2 + jitter;",
            "```",
            "",
            "- 上限一定要有，否则第 10 次重连要等几个小时；",
            "- 抖动取当前退避的一半以内，既打散重连时刻，又不会拖长平均恢复时间；",
            "- 连上以后把 `attempt` 归零，否则下一次断线会直接从一个很大的间隔开始。",
          ].join("\n"),
          "claude-sonnet-4-5",
        ),
        turn(
          2,
          now - 2 * HOUR - 3 * 60_000,
          "经验里 subscribe() 被调用两次的竞态怎么定位？日志里看不出先后。",
          [
            "给每次调用打一个单调递增的序号，再记录返回时间。序号必须是模块级的，不能在每次调用时重新创建：",
            "",
            "```js",
            "const id = nextCallId++;",
            "log(\"subscribe\", { id, room, attempt, at: Date.now() });",
            "```",
            "",
            "如果两条日志的 `id` 相邻、`attempt` 相同，就是同一个连接器被调用了两次；如果 `attempt` 不同，那是两次重连同时进行，需要在重连入口加一个「进行中」的标志位。",
          ].join("\n"),
          "claude-sonnet-4-5",
        ),
        turn(
          3,
          now - 2 * HOUR - 60_000,
          "重连 backoff 的计时器和心跳定时器会不会互相打架？",
          [
            "会，如果两个定时器都持有同一个 socket 的引用。心跳只应该在连接处于 `open` 状态时运行：",
            "",
            "```js",
            "socket.on(\"open\", () => heartbeat.start());",
            "socket.on(\"close\", () => {",
            "  heartbeat.stop();",
            "  scheduleReconnect(room);",
            "});",
            "```",
            "",
            "心跳自己发现连接已断时也要主动 `stop()`，重连统一由 `close` 处理器负责，这样只有一个入口。",
          ].join("\n"),
          "claude-sonnet-4-5",
        ),
      ],
      events: [
        {
          turnIdx: 0,
          seq: 0,
          kind: "tool",
          name: "Bash",
          input: '{"command":"bun test test/socket.test.ts"}',
          output: [
            "test/socket.test.ts:",
            "(pass) reconnects after the socket closes",
            "(pass) drops the previous listener before reconnecting",
            "(pass) keeps one message listener per room",
            "",
            "6 pass, 0 fail, 18 expect() calls",
          ].join("\n"),
          meta: "ok",
        },
        {
          turnIdx: 0,
          seq: 1,
          kind: "reasoning",
          output:
            "先确认监听器是不是每次重连都新增一个：如果 createSocket() 每次返回新实例，旧实例上的监听器就只是泄漏，不会触发重复订阅。",
        },
        {
          turnIdx: 2,
          seq: 0,
          kind: "tool",
          name: "Bash",
          input: '{"command":"bun test --rerun-each 20 test/socket.test.ts"}',
          output: [
            "test/socket.test.ts:",
            "fail  reconnects after the socket closes (rerun 14)",
            "Timeout: waiting for the socket to open",
            "  at test/socket.test.ts:31:7",
            "",
            "79 pass, 1 fail",
          ].join("\n"),
          meta: "error",
        },
      ],
    },
    {
      agent: "codex",
      externalId: "demo-rate-limit",
      projectPath: "/Users/demo/demo-app",
      title: "Add rate limiting to the upload API",
      startedAt: now - DAY - 5 * HOUR,
      updatedAt: now - DAY - 4 * HOUR,
      sourceKind: "jsonl",
      sourcePath: "/Users/demo/agents/codex/demo-rate-limit.jsonl",
      fingerprint: "fixture:demo-rate-limit",
      turns: [
        turn(
          0,
          now - DAY - 5 * HOUR,
          "One client can fire 200 uploads at once and the worker queue explodes. What is the smallest rate limit that still survives a restart?",
          [
            "One row per client in SQLite, refilled lazily. No in-memory counter, no cron, and the limit is still correct after a restart.",
            "",
            "```sql",
            "CREATE TABLE bucket (",
            "  key       TEXT PRIMARY KEY,",
            "  tokens    REAL NOT NULL,",
            "  refilled  INTEGER NOT NULL",
            ");",
            "```",
            "",
            "```js",
            "const now = Date.now();",
            "const { tokens } = refill(bucket, now); // rate * elapsed seconds, capped at capacity",
            "if (tokens < 1) return tooManyRequests(retryAfter(tokens));",
            "```",
            "",
            "Answer `429` with `Retry-After` in seconds so clients back off instead of hammering the endpoint. Refilling lazily means an idle client costs nothing.",
          ].join("\n"),
          "gpt-5-codex",
        ),
        turn(
          1,
          now - DAY - 4 * HOUR - 30 * 60_000,
          "Should the bucket live in the process or in the database?",
          [
            "In the database, if more than one process can serve the upload route. An in-process map gives every worker its own private limit, so a 10 req/min limit becomes 10 x workers per minute.",
            "",
            "One `UPDATE ... RETURNING` per request is enough to stay correct under concurrent workers:",
            "",
            "```sql",
            "UPDATE bucket SET tokens = tokens - 1, refilled = ?",
            "WHERE key = ? AND tokens >= 1",
            "RETURNING tokens;",
            "```",
            "",
            "No rows returned means the request is over the limit, so the decision needs no second query.",
          ].join("\n"),
          "gpt-5-codex",
        ),
        turn(
          2,
          now - DAY - 4 * HOUR,
          "客户端收到 429 之后要不要用 backoff 重试？一直重试会不会把队列放大？",
          [
            "要，但必须尊重 `Retry-After`，并且只对幂等的请求自动重试。",
            "",
            "- 重试间隔从 `Retry-After` 开始，再加一点抖动，不要从 1 秒开始自己猜；",
            "- 每个客户端同时只保留一个待重试请求，失败的重试直接进死信，不再排队；",
            "- 服务端给每个 key 记一个 rejected 计数，重试风暴从指标上立刻可见。",
            "",
            "重试放大通常不是因为重试本身，而是因为重试没有上限、也没有去重。",
          ].join("\n"),
          "gpt-5-codex",
        ),
      ],
      events: [
        {
          turnIdx: 0,
          seq: 0,
          kind: "tool",
          name: "Bash",
          input: '{"command":"bun test test/upload.test.ts"}',
          output: "5 pass, 0 fail, 24 expect() calls",
          meta: "ok",
        },
      ],
    },
    {
      agent: "cursor",
      externalId: "demo-fts5-ranking",
      projectPath: "/Users/demo/notes-cli",
      title: "FTS5 中文搜索结果排序",
      startedAt: now - DAY - 3 * HOUR,
      updatedAt: now - DAY - 2 * HOUR,
      sourceKind: "jsonl",
      sourcePath: "/Users/demo/agents/cursor/demo-fts5-ranking.json",
      fingerprint: "fixture:demo-fts5-ranking",
      turns: [
        turn(
          0,
          now - DAY - 3 * HOUR,
          "FTS5 用 bm25 排序，但中文结果里短文档总是压在前面，怎么调权重？",
          [
            "bm25 的默认参数对两列的索引来说正文列权重不够，给列带上权重：",
            "",
            "```sql",
            "SELECT rowid, snippet(notes_fts, 1, '<mark>', '</mark>', '…', 12) AS hit",
            "FROM notes_fts",
            "WHERE notes_fts MATCH ?",
            "ORDER BY bm25(notes_fts, 0.0, 3.0);",
            "```",
            "",
            "- 第一个参数给标题列（0.0 表示不参与打分），第二个给正文；",
            "- `snippet()` 比自己在 JS 里截字符串更准，它知道匹配位置；",
            "- 短文档天然占优，所以标题列的权重不要给太高。",
          ].join("\n"),
          "composer-1",
        ),
        turn(
          1,
          now - DAY - 2 * HOUR,
          "trigram 分词器会让索引变大多少？值得换掉 unicode61 吗？",
          [
            "中文笔记实测大约 2.5 到 3 倍，因为每个字都要生成三字组。换来的是任意长度子串匹配，不用自己切词。",
            "",
            "如果查询几乎都是两三个字的词，`unicode61` 加一列拼音字段往往更省空间；只有确实要按子串检索时才上 trigram。",
          ].join("\n"),
          "composer-1",
        ),
      ],
      events: [
        {
          turnIdx: 0,
          seq: 0,
          kind: "tool",
          name: "Bash",
          input: '{"command":"sqlite3 notes.db select count from notes_fts"}',
          output: "18431",
          meta: "ok",
        },
      ],
    },
    {
      agent: "cindy",
      externalId: "demo-flaky-checkout",
      projectPath: "/Users/demo/demo-app",
      title: "Flaky checkout test times out once in twenty runs",
      startedAt: now - 2 * DAY - 6 * HOUR,
      updatedAt: now - 2 * DAY - 5 * HOUR,
      sourceKind: "jsonl",
      sourcePath: "/Users/demo/agents/cindy/demo-flaky-checkout.jsonl",
      fingerprint: "fixture:demo-flaky-checkout",
      turns: [
        turn(
          0,
          now - 2 * DAY - 6 * HOUR,
          "`bun test checkout` fails about 1 run in 20 with a timeout while the fixture is being set up. How do I tell a race from a slow machine?",
          [
            "Run it in a loop first and keep the failing output:",
            "",
            "```bash",
            "bun test test/checkout.test.ts --rerun-each 50 --bail=0",
            "```",
            "",
            "A timeout that repeats on the same test at the same line is a race. Scattered timeouts across different tests are usually a slow box.",
            "",
            "Then narrow it: print `performance.now()` at the start of the fixture and again right before the assertion. If the gap between them is larger than the test timeout, something inside the fixture is waiting on a timer that the fake clock never advances.",
          ].join("\n"),
          "claude-sonnet-4-5",
        ),
        turn(
          1,
          now - 2 * DAY - 5 * HOUR,
          "The log shows the fixture resolves 40 ms after the assertion gives up.",
          [
            "That is the classic missing `await`: the setup promise is created but never returned, so the assertion runs against a half-built cart.",
            "",
            "```js",
            "// wrong: the promise is dropped",
            "beforeEach(() => { seedCart(items); });",
            "// right: the test waits for it",
            "beforeEach(async () => { await seedCart(items); });",
            "```",
            "",
            "`--rerun-each` keeps passing 49 out of 50, which is exactly why this only ever showed up in CI.",
          ].join("\n"),
          "claude-sonnet-4-5",
        ),
      ],
      events: [
        {
          turnIdx: 0,
          seq: 0,
          kind: "tool",
          name: "Bash",
          input: '{"command":"bun test test/checkout.test.ts --rerun-each 50"}',
          output: [
            "test/checkout.test.ts:",
            "fail  checkout applies the discount (rerun 39)",
            "Timeout: seeding the cart exceeded 5000ms",
            "  at test/checkout.test.ts:42:11",
            "",
            "197 pass, 3 fail",
          ].join("\n"),
          meta: "error",
        },
        {
          turnIdx: 1,
          seq: 0,
          kind: "tool",
          name: "Bash",
          input: '{"command":"bun test test/checkout.test.ts"}',
          output: "4 pass, 0 fail, 12 expect() calls",
          meta: "ok",
        },
      ],
    },
    {
      agent: "opencode",
      externalId: "demo-theme-vars",
      projectPath: "/Users/demo/website",
      title: "把深色模式从 JS 类名迁移到 CSS 变量",
      startedAt: now - 4 * DAY - 2 * HOUR,
      updatedAt: now - 4 * DAY,
      sourceKind: "jsonl",
      sourcePath: "/Users/demo/agents/opencode/demo-theme-vars.json",
      fingerprint: "fixture:demo-theme-vars",
      turns: [
        turn(
          0,
          now - 4 * DAY - 2 * HOUR,
          "深色模式现在靠 JS 给每个组件挂 class，想换成 CSS 变量，怎么迁移比较稳？",
          [
            "先把颜色收进一层变量，再让 JS 只负责切换根节点上的一个属性：",
            "",
            "```css",
            ":root { --surface: #ffffff; --text: #1b1b1f; }",
            "[data-theme=\"dark\"] { --surface: #16161a; --text: #ececef; }",
            ".card { background: var(--surface); color: var(--text); }",
            "```",
            "",
            "- 一批一批地换，每换完一个组件就删掉它对应的 `.dark` 规则，别留两套；",
            "- 组件里不要再出现具体色值，出现一个就说明还有没搬完的地方；",
            "- 在 `<head>` 里先给根节点写好属性，避免首屏闪白。",
          ].join("\n"),
          "qwen3-coder",
        ),
        turn(
          1,
          now - 4 * DAY,
          "系统主题变化要不要监听 matchMedia？",
          [
            "只在用户选「跟随系统」时监听，而且要能取消：",
            "",
            "```js",
            "const media = matchMedia(\"(prefers-color-scheme: dark)\");",
            "const sync = () => root.dataset.theme = media.matches ? \"dark\" : \"light\";",
            "media.addEventListener(\"change\", sync);",
            "```",
            "",
            "用户手动选了明或暗之后要把监听摘掉，否则系统一变化就会覆盖用户的选择。",
          ].join("\n"),
          "qwen3-coder",
        ),
      ],
      events: [
        {
          turnIdx: 0,
          seq: 0,
          kind: "tool",
          name: "Edit",
          input: '{"file":"web/styles.css"}',
          output: "1 file changed, 42 insertions(+), 38 deletions(-)",
          meta: "ok",
        },
      ],
    },
    {
      agent: "codex",
      externalId: "demo-mqtt-backoff",
      projectPath: "/Users/demo/iot-gateway",
      title: "MQTT 断线重连 backoff 调参",
      startedAt: now - 6 * DAY - 4 * HOUR,
      updatedAt: now - 6 * DAY - 3 * HOUR,
      sourceKind: "jsonl",
      sourcePath: "/Users/demo/agents/codex/demo-mqtt-backoff.jsonl",
      fingerprint: "fixture:demo-mqtt-backoff",
      turns: [
        turn(
          0,
          now - 6 * DAY - 4 * HOUR,
          "网关里的 MQTT 客户端断线重连 backoff 现在固定 5 秒，几百台设备一起抖动时重连风暴很明显，怎么改？",
          [
            "把固定间隔换成带上限的指数退避，并且每台设备各自抖动：",
            "",
            "```js",
            "const cap = 60_000;",
            "const base = Math.min(cap, 1000 * 2 ** attempt);",
            "const delay = base / 2 + Math.random() * base / 2;",
            "```",
            "",
            "- 300 台设备同时重连时，抖动把重连时刻摊平到几十秒里，broker 只看到平缓的上升；",
            "- 上限 60 秒足够短，设备不会因为一次网络抖动就长时间离线；",
            "- 服务端也要限制 accept 速率，客户端退避只是第一层，",
          ].join("\n"),
          "gpt-5-codex",
        ),
        turn(
          1,
          now - 6 * DAY - 3 * HOUR - 20 * 60_000,
          "重连成功之后 attempt 需要重置吗？",
          [
            "要，而且要在收到 `CONNACK` 之后重置，而不是在 TCP 连上时就重置：",
            "",
            "```js",
            "client.on(\"connect\", () => { attempt = 0; });",
            "```",
            "",
            "如果 TCP 握手成功但 broker 立刻断开，在 socket 层重置会让退避永远是 1 秒，等于退避失效。",
          ].join("\n"),
          "gpt-5-codex",
        ),
        turn(
          2,
          now - 6 * DAY - 3 * HOUR,
          "顺便问下，重连 backoff 的上限设多少合适？设备一天只断两次那种。",
          [
            "按「可接受的最长离线时间」来定，而不是按重试次数。一天只断两次的设备，用 30 到 60 秒上限就够了，重试次数上限不要设，让它在网络恢复后自己回来。",
            "",
            "超过这个时长一般意味着设备侧有问题，应该上报指标，而不是继续安静地重连。",
          ].join("\n"),
          "gpt-5-codex",
        ),
      ],
      events: [
        {
          turnIdx: 0,
          seq: 0,
          kind: "tool",
          name: "Bash",
          input: '{"command":"bun test test/mqtt-client.test.ts"}',
          output: [
            "test/mqtt-client.test.ts:",
            "fail  reconnects with jitter after a broker restart",
            "Timeout: waiting for CONNACK after 5000ms",
            "  at test/mqtt-client.test.ts:58:5",
            "",
            "3 pass, 1 fail",
          ].join("\n"),
          meta: "error",
        },
      ],
    },
  ];
  return sessions;
}

function visibleEvent(event: ParsedEvent): boolean {
  return Boolean((event.input ?? "").trim() || (event.output ?? "").trim());
}

/** Drop events with no text, the way the adapters do, so no empty rows are stored. */
function tidySessions(sessions: ParsedSession[]): ParsedSession[] {
  return sessions.map((session) => ({
    ...session,
    events: (session.events ?? []).filter(visibleEvent),
  }));
}

/**
 * Write the synthetic sessions into a brand new index at `dbPath`, destroying
 * whatever was there. Never point this at the real `index.db`.
 */
export function seedScreenshotDb(
  dbPath: string,
  now: number = Date.now(),
): { sessions: number; turns: number; events: number } {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }
  const sessions = tidySessions(screenshotSessions(now));
  const db = openDb(dbPath);
  try {
    for (const session of sessions) writeSession(db, session);
  } finally {
    db.close();
  }
  return {
    sessions: sessions.length,
    turns: sessions.reduce((total, session) => total + session.turns.length, 0),
    events: sessions.reduce((total, session) => total + (session.events?.length ?? 0), 0),
  };
}

/**
 * What the index actually contains, so a caller can prove it holds only
 * fixtures before photographing it. `foreign` lists the ids this module did not
 * write, and it must be empty.
 */
export function verifyScreenshotDb(dbPath: string): {
  exists: boolean;
  sessions: number;
  turns: number;
  foreign: string[];
} {
  if (!existsSync(dbPath)) return { exists: false, sessions: 0, turns: 0, foreign: [] };
  const db = new Database(dbPath, { readonly: true });
  try {
    const ids = db.query("SELECT id FROM session").all() as { id: string }[];
    const turns = db.query("SELECT count(*) AS n FROM turn").get() as { n: number };
    return {
      exists: true,
      sessions: ids.length,
      turns: turns.n,
      foreign: ids
        .map((row) => row.id)
        .filter((id) => !id.includes(":" + FIXTURE_ID_PREFIX)),
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const verify = argv[0] === "--verify";
  const dbPath = verify ? argv[1] : argv[0];
  if (!dbPath) {
    console.error("usage: bun run test/fixtures/screenshot-data.ts [--verify] <db-path>");
    process.exit(2);
  }
  if (verify) {
    const report = verifyScreenshotDb(dbPath);
    console.log(JSON.stringify(report));
    if (!report.exists || report.sessions === 0) {
      console.error("fixture index is missing or empty");
      process.exit(1);
    }
    if (report.foreign.length > 0) {
      console.error("fixture index holds non-fixture sessions: " + report.foreign.join(", "));
      process.exit(1);
    }
    console.log("ok: index holds " + report.sessions + " synthetic sessions only");
  } else {
    const report = seedScreenshotDb(dbPath);
    console.log(
      "seeded " + report.sessions + " synthetic sessions, " + report.turns +
        " turns, " + report.events + " events -> " + dbPath,
    );
  }
}
