import { expect, test } from "bun:test";
import type { ParsedSession } from "../src/adapters/types.ts";
import { homeDirOptions, redactSession, redactText } from "../src/util/redact.ts";

const OPENAI_KEY = "sk-proj-9f2c4b7d1e8a3c6f0b5d9e2a7c4f1b8d";
const ANTHROPIC_KEY = "sk-ant-api03-Qw8Zt3kLm2Np5Rr7Vv1Bd4Fh6Jk9Mo0Tz2Xc5Gq7Wu";
const STRIPE_KEY = "sk_live_51H8ZkQ2eZvKYlo2Cwq7Rt9Mn";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GH_TOKEN = "ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";
const GH_PAT = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz";
const SLACK_TOKEN = "xoxb-123456789012-abcdefghijklmnopqrstuv";
const GOOGLE_KEY = "AIzaSyD9k2Lm4Np6Qr8Tv0Wx1Yz3Ab5Cd7Ef9Gh";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.ZmFrZXNpZ25hdHVyZXZhbHVlMTIzNDU2";
const BEARER = "abc123DEF456ghi789JKL";
const PEM_BODY = "MIIEowIBAAKCAQEA7f2c9b1a4d8e3f6b0c5a9d2e7f1b8c3a4d5e6f708192a3b4c5d";
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", PEM_BODY, "-----END RSA PRIVATE KEY-----"].join("\n");
const DB_PASSWORD = "sup3rS3cr3tPassw0rd";
const ENV_SECRET = "s3cretValue123456";

test("redacts OpenAI, Anthropic and Stripe keys", () => {
  expect(redactText("export OPENAI_API_KEY=" + OPENAI_KEY)).toBe(
    "export OPENAI_API_KEY=[REDACTED:api-key]",
  );
  expect(redactText("apiKey: '" + ANTHROPIC_KEY + "'")).toBe("apiKey: '[REDACTED:api-key]'");
  expect(redactText("STRIPE_SECRET_KEY=" + STRIPE_KEY)).toBe(
    "STRIPE_SECRET_KEY=[REDACTED:api-key]",
  );
  for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, STRIPE_KEY]) {
    expect(redactText("value " + secret)).not.toContain(secret);
  }
});

test("redacts AWS, GitHub, Slack and Google credentials", () => {
  expect(redactText("AWS_ACCESS_KEY_ID=" + AWS_KEY)).toBe("AWS_ACCESS_KEY_ID=[REDACTED:aws-key]");
  expect(redactText("remote https://" + GH_TOKEN + "@github.com/x/y")).toBe(
    "remote https://[REDACTED:github]@github.com/x/y",
  );
  expect(redactText("token " + GH_PAT)).toBe("token [REDACTED:github]");
  expect(redactText("SLACK=" + SLACK_TOKEN)).toBe("SLACK=[REDACTED:slack]");
  expect(redactText("GOOGLE_API_KEY=" + GOOGLE_KEY)).toBe("GOOGLE_API_KEY=[REDACTED:google]");
  for (const secret of [AWS_KEY, GH_TOKEN, GH_PAT, SLACK_TOKEN, GOOGLE_KEY]) {
    expect(redactText("value " + secret)).not.toContain(secret);
  }
});

test("redacts bearer tokens, authorization headers and JWTs", () => {
  expect(redactText("curl -H 'Authorization: Bearer " + BEARER + "'")).toBe(
    "curl -H 'Authorization: [REDACTED:token]'",
  );
  expect(redactText("Authorization: Bearer " + JWT)).toBe("Authorization: Bearer [REDACTED:jwt]");
  expect(redactText("Bearer " + BEARER)).toBe("Bearer [REDACTED:token]");
  expect(redactText('{"access_token": "' + JWT + '"}')).not.toContain(JWT);
});

test("redacts PEM private key blocks, including escaped JSON strings", () => {
  expect(redactText("key:\n" + PEM + "\n")).toBe("key:\n[REDACTED:private-key]\n");
  expect(redactText("key:\n" + PEM + "\n")).not.toContain(PEM_BODY);
  expect(redactText(JSON.stringify({ key: PEM }))).toBe('{"key":"[REDACTED:private-key]"}');
  const truncated = "-----BEGIN RSA PRIVATE KEY-----\n" + PEM_BODY;
  const out = redactText(truncated);
  expect(out).toContain("[REDACTED:private-key]");
  expect(out).not.toContain(PEM_BODY);
});

test("redacts credentials in shell, .env, YAML and JSON text", () => {
  expect(redactText("export API_KEY=" + ENV_SECRET)).toBe("export API_KEY=[REDACTED:secret]");
  expect(redactText("--token=" + ENV_SECRET)).toBe("--token=[REDACTED:secret]");
  expect(redactText("db_password=" + ENV_SECRET)).toBe("db_password=[REDACTED:secret]");
  expect(redactText("apiKey: " + ENV_SECRET)).toBe("apiKey: [REDACTED:secret]");
  // The key name and separator stay, so the JSON/YAML structure and context survive.
  expect(redactText(JSON.stringify({ api_key: ENV_SECRET, note: "keep me" }))).toBe(
    '{"api_key":"[REDACTED:secret]","note":"keep me"}',
  );
  // Quoted values may contain spaces.
  expect(redactText('{"db_password":"my secret pass"}')).toBe(
    '{"db_password":"[REDACTED:secret]"}',
  );
});

test("keeps references, templates and short values out of the env rule", () => {
  const untouched = [
    "API_KEY=$OPENAI_API_KEY",
    "PASSWORD=<your-password>",
    "const api_key = get_api_key()",
    "token: 参考上文",
    "key: value",
    "monkey: banana",
  ];
  for (const text of untouched) expect(redactText(text)).toBe(text);
});

test("redacts database URLs but keeps the user and host readable", () => {
  expect(redactText("DATABASE_URL=postgres://appuser:" + DB_PASSWORD + "@localhost:5432/app")).toBe(
    "DATABASE_URL=postgres://appuser:[REDACTED:db-password]@localhost:5432/app",
  );
  expect(redactText("mongodb+srv://admin:" + DB_PASSWORD + "@cluster0.example.net/db")).toBe(
    "mongodb+srv://admin:[REDACTED:db-password]@cluster0.example.net/db",
  );
  expect(redactText("redis://:" + DB_PASSWORD + "@cache:6379")).toBe(
    "redis://:[REDACTED:db-password]@cache:6379",
  );
  const mysql = redactText("mysql://root:" + DB_PASSWORD + "@127.0.0.1:3306/app");
  expect(mysql).not.toContain(DB_PASSWORD);
  expect(mysql).toContain("@127.0.0.1:3306/app");
});

test("masks home-directory user names only for the names the caller passes", () => {
  const path = "cd /Users/odin/projects/omp/session-recall";
  expect(redactText(path)).toBe(path);
  expect(redactText(path, { homeUsers: ["odin"] })).toBe(
    "cd /Users/[REDACTED:user]/projects/omp/session-recall",
  );
  // Exactly one separator, never a doubled slash.
  expect(redactText(path, { homeUsers: ["odin"] })).not.toContain("//");
  expect(redactText("cd /Users/test/project", { homeUsers: ["test"] })).toBe(
    "cd /Users/[REDACTED:user]/project",
  );
  expect(redactText("cd /Users/someelse/app", { homeUsers: ["odin"] })).toBe(
    "cd /Users/someelse/app",
  );
  expect(redactText("cd ~/projects/app", { homeUsers: ["odin"] })).toBe("cd ~/projects/app");
  expect(redactText("cat /home/odin/.config", homeDirOptions("/Users/odin"))).toBe(
    "cat /home/[REDACTED:user]/.config",
  );
  expect(homeDirOptions("/Users/odin/")).toEqual({ homeUsers: ["odin"] });
});

test("redacts emails and phone numbers without touching hosts or file names", () => {
  expect(redactText("mail alice@example.com now")).toBe("mail [REDACTED:email] now");
  expect(redactText("call 13812345678 or +8613800138000")).toBe(
    "call [REDACTED:phone] or [REDACTED:phone]",
  );
  const untouched = [
    "git@github.com:makecindy/cindy.git",
    "logo@2x.png",
    "session 1762944000000",
  ];
  for (const text of untouched) expect(redactText(text)).toBe(text);
});

test("is idempotent", () => {
  const sample = [
    "OPENAI_API_KEY=" + OPENAI_KEY,
    "Authorization: Bearer " + JWT,
    "DATABASE_URL=postgres://appuser:" + DB_PASSWORD + "@localhost:5432/app",
    "db_password: " + ENV_SECRET,
    "path /Users/odin/projects/app",
    "mail alice@example.com",
    "mongodb://appuser:" + DB_PASSWORD + "@cluster.example.net:27017/app",
    PEM,
  ].join("\n");
  const options = { homeUsers: ["odin"] };
  const once = redactText(sample, options);
  expect(redactText(once, options)).toBe(once);
  // A redacted URL must never be redacted twice into nested placeholders.
  expect(once).not.toContain("[REDACTED:[REDACTED:");
  expect(redactText(redactText("[REDACTED:api-key]"))).toBe("[REDACTED:api-key]");
});

test("leaves ordinary prose, code and Chinese text alone", () => {
  const untouched = [
    "12. 目录范围怎么控制？",
    "通过角色范围控制，先看 common 目录",
    "findFileByName 按名称模糊匹配",
    "npm run build && bun test",
    "GET /api/sessions?limit=20",
    "https://example.com/docs/getting-started",
    "version 1.2.3 or v1.1.1",
    "src/util/redact.ts",
    "cd /Users/test/project",
    "timeout: 30000",
  ];
  for (const text of untouched) expect(redactText(text)).toBe(text);
});

function sampleSession(): ParsedSession {
  return {
    agent: "omp",
    externalId: "session-1",
    projectPath: "/Users/odin/projects/omp/session-recall",
    title: "fix parser " + OPENAI_KEY,
    startedAt: Date.UTC(2026, 10, 11),
    updatedAt: Date.UTC(2026, 10, 12),
    sourceKind: "jsonl",
    sourcePath: "/Users/odin/.omp/session-1.jsonl",
    fingerprint: "1",
    turns: [
      {
        idx: 0,
        ts: Date.UTC(2026, 10, 11),
        userText: "why does " + AWS_KEY + " fail?",
        assistantText: "rotate it: postgres://appuser:" + DB_PASSWORD + "@h/db",
      },
    ],
    events: [
      {
        turnIdx: 0,
        seq: 0,
        kind: "tool",
        name: "Read",
        input: JSON.stringify({ token: GH_TOKEN }),
        output: "SLACK=" + SLACK_TOKEN,
        meta: "alice@example.com",
      },
    ],
  };
}

test("redactSession redacts every indexed field and never mutates the input", () => {
  const session = sampleSession();
  const before = JSON.stringify(session);
  const clean = redactSession(session, { homeUsers: ["odin"] });

  expect(clean.title).toBe("fix parser [REDACTED:api-key]");
  expect(clean.projectPath).toBe("/Users/[REDACTED:user]/projects/omp/session-recall");
  expect(clean.turns[0].userText).toBe("why does [REDACTED:aws-key] fail?");
  expect(clean.turns[0].assistantText).toBe(
    "rotate it: postgres://appuser:[REDACTED:db-password]@h/db",
  );
  expect(clean.events?.[0].input).toBe('{"token":"[REDACTED:github]"}');
  expect(clean.events?.[0].output).toBe("SLACK=[REDACTED:slack]");
  expect(clean.events?.[0].meta).toBe("[REDACTED:email]");
  // Identifiers used for upserts and resume links stay as they are.
  expect(clean.sourcePath).toBe("/Users/odin/.omp/session-1.jsonl");
  expect(clean.fingerprint).toBe("1");
  expect(clean.externalId).toBe("session-1");
  expect(JSON.stringify(clean)).not.toContain(OPENAI_KEY);
  expect(JSON.stringify(clean)).not.toContain(GH_TOKEN);
  expect(JSON.stringify(clean)).not.toContain(DB_PASSWORD);
  expect(JSON.stringify(session)).toBe(before);
  expect(clean).not.toBe(session);
  expect(clean.turns[0]).not.toBe(session.turns[0]);
});

test("redactSession works with no options and keeps paths readable", () => {
  const session = sampleSession();
  const clean = redactSession(session);
  expect(clean.projectPath).toBe("/Users/odin/projects/omp/session-recall");
  expect(clean.title).toBe("fix parser [REDACTED:api-key]");
  expect(JSON.stringify(clean)).not.toContain(SLACK_TOKEN);
  expect(JSON.stringify(clean)).not.toContain(PEM_BODY);
});

test("no fixture secret survives a redacted write", () => {
  const sample = [
    "OPENAI_API_KEY=" + OPENAI_KEY,
    "ANTHROPIC_API_KEY=" + ANTHROPIC_KEY,
    "STRIPE_SECRET_KEY=" + STRIPE_KEY,
    "AWS_ACCESS_KEY_ID=" + AWS_KEY,
    "GITHUB_TOKEN=" + GH_TOKEN,
    "GITHUB_TOKEN=" + GH_PAT,
    "SLACK_TOKEN=" + SLACK_TOKEN,
    "GOOGLE_API_KEY=" + GOOGLE_KEY,
    "Authorization: Bearer " + JWT,
    "DATABASE_URL=postgres://appuser:" + DB_PASSWORD + "@localhost:5432/app",
    "db_password: " + ENV_SECRET,
    "path /Users/odin/projects/app",
    "mail alice@example.com",
    "call 13812345678",
    PEM,
  ].join("\n");
  const out = redactText(sample, { homeUsers: ["odin"] });
  for (const secret of [
    OPENAI_KEY,
    ANTHROPIC_KEY,
    STRIPE_KEY,
    AWS_KEY,
    GH_TOKEN,
    GH_PAT,
    SLACK_TOKEN,
    GOOGLE_KEY,
    JWT,
    DB_PASSWORD,
    ENV_SECRET,
    PEM_BODY,
    "alice@example.com",
    "13812345678",
  ]) {
    expect(out).not.toContain(secret);
  }
  expect(out).toContain("[REDACTED:api-key]");
  expect(out).toContain("[REDACTED:private-key]");
  expect(out).toContain("[REDACTED:user]");
  expect(redactText("")).toBe("");
});

test("redacts braced values in env and header positions", () => {
  const braced = "{" + "{API_KEY_7d2vq4mc}}";
  const spaced = "{" + "{ your_key }}";
  const pair = "{" + "{host}}:{" + "{port}}";
  expect(redactText("API_KEY=" + braced)).toBe("API_KEY=[REDACTED:secret]");
  expect(redactText('{"api_key":"' + braced + '"}')).toBe('{"api_key":"[REDACTED:secret]"}');
  expect(redactText("Authorization: Bearer " + braced)).toBe("Authorization: [REDACTED:token]");
  expect(redactText("Bearer " + braced)).toBe("Bearer [REDACTED:token]");
  // Multi-part or spaced templates are references, not credentials.
  expect(redactText("API_KEY=" + spaced)).toBe("API_KEY=" + spaced);
  expect(redactText("API_KEY=" + pair)).toBe("API_KEY=" + pair);
  const once = redactText("API_KEY=" + braced);
  expect(redactText(once)).toBe(once);
});
