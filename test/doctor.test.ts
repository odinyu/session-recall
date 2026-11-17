import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";

const root = mkdtempSync(join(tmpdir(), "session-recall-doctor-"));
let caseId = 0;

function freshDir(): string {
  const dir = join(root, "case-" + caseId++);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Check { id: string; status: string; detail: string; fix?: string }
interface DoctorOutput { home: string; checks: Check[] }

/** Run the real CLI, hermetically: isolated home, isolated index, no handshake. */
function runDoctor(dbPath: string, home: string): { code: number; out: DoctorOutput } {
  const result = Bun.spawnSync(
    ["bun", "run", "src/cli.ts", "doctor", "--json", "--no-handshake", "--home", home],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SESSION_RECALL_DB: dbPath, SESSION_RECALL_HOME: home },
    },
  );
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!stdout.trim()) throw new Error("doctor printed nothing: " + stderr);
  return { code: result.exitCode ?? 0, out: JSON.parse(stdout) as DoctorOutput };
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a missing index fails with a fix command", () => {
  const dir = freshDir();
  const { code, out } = runDoctor(join(dir, "absent.db"), dir);
  const index = out.checks.find((check) => check.id === "index");
  expect(index?.status).toBe("fail");
  expect(index?.fix).toContain("scan");
  expect(code).toBe(1);
});

test("a freshly created index passes the structural checks", () => {
  const dir = freshDir();
  const dbPath = join(dir, "index.db");
  const db = openDb(dbPath);
  db.close();

  const { out } = runDoctor(dbPath, dir);
  const index = out.checks.find((check) => check.id === "index");
  const schema = out.checks.find((check) => check.id === "schema");
  const integrity = out.checks.find((check) => check.id === "integrity");
  // Empty but valid: worth a warning (nothing indexed yet), not a failure.
  expect(index?.status).toBe("warn");
  expect(schema?.status).toBe("ok");
  expect(integrity?.status).toBe("ok");
});

test("clients that are not installed are skipped, not failed", () => {
  const dir = freshDir();
  const dbPath = join(dir, "index.db");
  const db = openDb(dbPath);
  db.close();

  const { out } = runDoctor(dbPath, dir);
  const wiring = out.checks.filter((check) => check.id.startsWith("mcp:"));
  expect(wiring.length).toBeGreaterThan(0);
  expect(wiring.every((check) => check.status === "skip")).toBe(true);
});

test("an installed client without our entry warns and points at setup", () => {
  const dir = freshDir();
  const dbPath = join(dir, "index.db");
  const db = openDb(dbPath);
  db.close();
  mkdirSync(join(dir, ".cursor"), { recursive: true });

  const { out } = runDoctor(dbPath, dir);
  const cursor = out.checks.find((check) => check.id === "mcp:cursor");
  expect(cursor?.status).toBe("warn");
  expect(cursor?.fix).toContain("setup --agent cursor");
});
