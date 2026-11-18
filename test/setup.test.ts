import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPlan, applySkills, CLIENTS, deleteEntry, loadConfig, planClients, planSkills, readEntry,
  resolveMcpCommand, SERVER_KEY, skillContent, SKILL_MARKER,
} from "../src/setup.ts";
import type { SetupOptions } from "../src/setup.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-setup-"));
let caseId = 0;

const COMMAND = { command: "/bin/echo", args: ["mcp"] };

/** A fresh home per case, so one case can never see another one files. */
function freshHome(): string {
  const dir = join(root, "case-" + caseId++);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function options(home: string, overrides: Partial<SetupOptions> = {}): SetupOptions {
  return { home, dryRun: false, yes: true, remove: false, json: false, command: COMMAND, ...overrides };
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("creates the config when the client is installed but the file is missing", () => {
  const home = freshHome();
  mkdirSync(join(home, ".cursor"));
  const plans = planClients(options(home));
  const cursor = plans.find((plan) => plan.id === "cursor");
  expect(cursor?.action).toBe("add");

  const results = applyPlan(plans, options(home));
  expect(results.every((result) => result.ok)).toBe(true);
  const doc = read(join(home, ".cursor", "mcp.json"));
  const servers = doc.mcpServers as Record<string, { command: string; type: string }>;
  expect(servers[SERVER_KEY].command).toBe("/bin/echo");
  expect(servers[SERVER_KEY].type).toBe("stdio");
});

test("leaves other servers in the file untouched", () => {
  const home = freshHome();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const path = join(home, ".cursor", "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "/usr/bin/true", args: [] } } }));

  applyPlan(planClients(options(home)), options(home));
  const doc = read(path);
  const servers = doc.mcpServers as Record<string, unknown>;
  expect(Object.keys(servers).sort()).toEqual(["other", SERVER_KEY]);
  expect(servers.other).toEqual({ command: "/usr/bin/true", args: [] });
});

test("a second run is a no-op", () => {
  const home = freshHome();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  applyPlan(planClients(options(home)), options(home));

  const again = planClients(options(home));
  expect(again.find((plan) => plan.id === "cursor")?.action).toBe("already");
  expect(applyPlan(again, options(home))).toEqual([]);
});

test("an entry with the same meaning but different key order still counts as configured", () => {
  const home = freshHome();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const path = join(home, ".cursor", "mcp.json");
  writeFileSync(path, JSON.stringify({
    mcpServers: { [SERVER_KEY]: { type: "stdio", args: ["mcp"], command: "/bin/echo" } },
  }));
  expect(planClients(options(home)).find((plan) => plan.id === "cursor")?.action).toBe("already");
});

test("dry run writes nothing", () => {
  const home = freshHome();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const plans = planClients(options(home, { dryRun: true }));
  expect(plans.find((plan) => plan.id === "cursor")?.action).toBe("add");
  expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
});

test("a file that is not valid JSON is reported and left byte-identical", () => {
  const home = freshHome();
  mkdirSync(join(home, ".qwen"), { recursive: true });
  const path = join(home, ".qwen", "settings.json");
  const broken = "{ this is not json";
  writeFileSync(path, broken);

  const plans = planClients(options(home));
  const plan = plans.find((item) => item.id === "qwen-code");
  expect(plan?.action).toBe("manual");
  expect(plan?.detail).toContain("not valid JSON");
  // Nothing actionable was produced, so applying cannot touch it.
  expect(applyPlan(plans, options(home))).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(broken);
});

test("remove drops only our entry and prunes the empty container", () => {
  const home = freshHome();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const path = join(home, ".cursor", "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "/usr/bin/true", args: [] } } }));
  applyPlan(planClients(options(home)), options(home));

  applyPlan(planClients(options(home, { remove: true })), options(home, { remove: true }));
  const servers = read(path).mcpServers as Record<string, unknown>;
  expect(Object.keys(servers)).toEqual(["other"]);
});

test("remove drops a file that only ever held our entry", () => {
  const home = freshHome();
  mkdirSync(join(home, ".config", "alma"), { recursive: true });
  const path = join(home, ".config", "alma", "mcp.json");
  applyPlan(planClients(options(home)), options(home));
  expect(read(path).mcpServers).toBeDefined();

  // Ours was the only entry, so removing it leaves nothing worth keeping: the
  // file goes away rather than lingering as an empty "{}".
  applyPlan(planClients(options(home, { remove: true })), options(home, { remove: true }));
  expect(existsSync(path)).toBe(false);
});

test("remove keeps the file when other entries remain", () => {
  const home = freshHome();
  mkdirSync(join(home, ".config", "alma"), { recursive: true });
  const path = join(home, ".config", "alma", "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { Fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }));
  applyPlan(planClients(options(home)), options(home));
  expect(Object.keys(read(path).mcpServers as object).length).toBe(2);

  applyPlan(planClients(options(home, { remove: true })), options(home, { remove: true }));
  const servers = read(path).mcpServers as Record<string, unknown>;
  expect(Object.keys(servers)).toEqual(["Fetch"]);
});

test("writes a backup next to the file before changing it", () => {
  const home = freshHome();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const path = join(home, ".cursor", "mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: {} }));

  const results = applyPlan(planClients(options(home)), options(home));
  const cursor = results.find((result) => result.id === "cursor");
  expect(cursor?.backup).toBeDefined();
  expect(existsSync(cursor!.backup!)).toBe(true);
  expect(readdirSync(join(home, ".cursor")).some((name) => name.includes(".session-recall.bak-"))).toBe(true);
});

test("opencode gets the mcp.servers shape the schema expects", () => {
  const home = freshHome();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  const path = join(home, ".config", "opencode", "opencode.json");
  writeFileSync(path, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "x" }));

  applyPlan(planClients(options(home)), options(home));
  const doc = read(path);
  expect(doc.model).toBe("x");
  const servers = (doc.mcp as Record<string, Record<string, unknown>>).servers;
  const entry = servers[SERVER_KEY] as { type: string; command: string[] };
  expect(entry.type).toBe("local");
  expect(entry.command).toEqual(["/bin/echo", "mcp"]);
});

test("a client we have not verified is reported manual and never written", () => {
  const home = freshHome();
  mkdirSync(join(home, ".codex"), { recursive: true });
  const plans = planClients(options(home));
  const codex = plans.find((plan) => plan.id === "codex");
  expect(codex?.action).toBe("manual");
  expect(applyPlan(plans, options(home))).toEqual([]);
  expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
});

test("clients that are not installed are skipped", () => {
  const home = freshHome();
  const plans = planClients(options(home));
  expect(plans.every((plan) => plan.action === "skip")).toBe(true);
});

test("a client we cannot name is rejected", () => {
  const home = freshHome();
  expect(() => planClients(options(home, { only: "nope" }))).not.toThrow();
  expect(CLIENTS.some((client) => client.id === "nope")).toBe(false);
});

test("loadConfig refuses a non-object document", () => {
  const home = freshHome();
  const path = join(home, "arr.json");
  writeFileSync(path, "[1,2,3]");
  expect(() => loadConfig(path)).toThrow(/not a JSON object/);
});

test("readEntry and deleteEntry ignore an absent container", () => {
  const spec = CLIENTS.find((client) => client.id === "cursor")!;
  expect(readEntry({}, spec)).toBeUndefined();
  expect(deleteEntry({}, spec)).toBe(false);
});

test("the command resolver returns null rather than a path that does not exist", () => {
  const resolved = resolveMcpCommand({});
  if (resolved) expect(existsSync(resolved.command)).toBe(true);
  else expect(resolved).toBeNull();
});

test("a sidecar override wins when it exists", () => {
  const home = freshHome();
  const fake = join(home, "fake-sidecar");
  writeFileSync(fake, "#!/bin/sh\n");
  expect(resolveMcpCommand({ SESSION_RECALL_SIDECAR: fake })).toEqual({ command: fake, args: ["mcp"] });
});

test("installs the skill into every agent skill folder that exists", () => {
  const home = freshHome();
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });

  const plans = planSkills(options(home));
  const claude = plans.find((plan) => plan.id === "skill:claude-code");
  expect(claude?.action).toBe("add");

  const results = applySkills(plans, options(home));
  expect(results.filter((result) => !result.ok)).toEqual([]);
  const dir = join(home, ".claude", "skills", "session-recall");
  expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  expect(existsSync(join(dir, SKILL_MARKER))).toBe(true);
  // The binary path is baked in, so the skill works without PATH setup.
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("/bin/echo");
});

test("covers Alma's own skill folder, not just the other agents'", () => {
  const home = freshHome();
  mkdirSync(join(home, ".config", "alma", "skills"), { recursive: true });
  const plans = planSkills(options(home));
  const alma = plans.find((plan) => plan.id === "skill:alma");
  expect(alma?.action).toBe("add");

  applySkills(plans, options(home));
  const dir = join(home, ".config", "alma", "skills", "session-recall");
  expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  // Alma reads the frontmatter name to register the skill.
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("name: session-recall");
});

test("a second skill install is a no-op", () => {
  const home = freshHome();
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  applySkills(planSkills(options(home)), options(home));
  const again = planSkills(options(home));
  expect(again.find((plan) => plan.id === "skill:claude-code")?.action).toBe("already");
  expect(applySkills(again, options(home))).toEqual([]);
});

test("a SKILL.md we did not write is never overwritten", () => {
  const home = freshHome();
  const dir = join(home, ".claude", "skills", "session-recall");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const mine = "---\nname: mine\n---\nhandwritten\n";
  writeFileSync(path, mine);

  const plan = planSkills(options(home)).find((item) => item.id === "skill:claude-code");
  expect(plan?.action).toBe("manual");
  expect(applySkills(planSkills(options(home)), options(home))).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(mine);
});

test("removing the skill deletes only what it installed", () => {
  const home = freshHome();
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  applySkills(planSkills(options(home)), options(home));
  const dir = join(home, ".claude", "skills", "session-recall");
  expect(existsSync(dir)).toBe(true);

  applySkills(planSkills(options(home, { remove: true })), options(home, { remove: true }));
  expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
  // An empty folder we created goes too; a shared one would be kept.
  expect(existsSync(dir)).toBe(false);
});

test("removing the skill keeps a folder still holding other files", () => {
  const home = freshHome();
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  applySkills(planSkills(options(home)), options(home));
  const dir = join(home, ".claude", "skills", "session-recall");
  writeFileSync(join(dir, "notes.md"), "mine\n");

  applySkills(planSkills(options(home, { remove: true })), options(home, { remove: true }));
  expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
  expect(existsSync(join(dir, "notes.md"))).toBe(true);
});

test("the skill body names the real commands", () => {
  const body = skillContent({ command: "/usr/local/bin/session-recall", args: ["mcp"] });
  expect(body.startsWith("---\nname: session-recall\n")).toBe(true);
  expect(body).toContain("/usr/local/bin/session-recall search");
  expect(body).toContain("/usr/local/bin/session-recall doctor");
  expect(body).toContain("recall_search");
});
