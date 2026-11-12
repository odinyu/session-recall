import type { ParsedEvent, ParsedSession, ParsedTurn } from "../adapters/types.ts";

/**
 * Write-time redaction of secrets and personal identifiers.
 *
 * Every function here is a pure, synchronous text pass: an adapter hands the raw
 * transcript text over and gets it back with secrets replaced by short
 * placeholders such as [REDACTED:api-key]. Because redaction happens before rows
 * are written, it also covers the FTS index (filled by INSERT triggers) and
 * every read path that goes through the index.
 *
 * The module is deliberately conservative: a pattern only fires on text that
 * looks like a credential, so ordinary prose, code and Chinese text keep their
 * wording and stay searchable.
 *
 * Placeholders never contain a fragment of the original value, never contain
 * quotes or newlines (so JSON strings and Markdown stay well formed), and never
 * match any pattern below, which keeps the pass idempotent.
 *
 * Home-directory user names are the one opt-in rule: masking every
 * /Users/<name>/ segment would rewrite other machines' paths, test fixtures and
 * code samples, so the caller passes the real names it wants hidden (see
 * homeDirOptions) and nothing is masked without them.
 */

export interface RedactOptions {
  /**
   * Home-directory user names to mask inside absolute paths, for example
   * ["odin"] for /Users/odin/projects/app. Empty or missing disables path
   * masking entirely; pass homeDirOptions(os.homedir()) for the local user.
   */
  homeUsers?: readonly string[];
}

/** Local home root -> { homeUsers: [last path segment] }, ready for RedactOptions. */
export function homeDirOptions(home: string): RedactOptions {
  const parts = home.split(/[\\/]+/).filter((part) => part.length > 0);
  const user = parts[parts.length - 1];
  return user ? { homeUsers: [user] } : {};
}

/** Placeholder wrapper; short so it survives inside JSON strings and Markdown. */
const MARK_OPEN = "[REDACTED:";

function mark(label: string): string {
  return MARK_OPEN + label + "]";
}

/** Values that are templates or code references rather than secrets. */
const NON_SECRET =
  /^(?:\[|\$|%|<|\{|\(|\*|\.\.\.|your|example|sample|dummy|redacted|changeme|placeholder|none|null|true|false|env\.|process\.env|os\.environ|getenv)/i;

/** A single braced token, for example a template variable or a masked value. */
const BRACED = /^\{\{([A-Za-z0-9]+_[A-Za-z0-9_./:=-]{2,})\}\}$/;

function isSecretLike(value: string): boolean {
  const braced = BRACED.exec(value);
  const candidate = braced ? braced[1] : value;
  return candidate.length > 0 && !NON_SECRET.test(candidate);
}

interface Rule {
  label: string;
  re: RegExp;
}

/**
 * Credential shapes, applied in order. Each label names the family that was
 * found, so a reader can tell what was removed without seeing the value.
 */
const TOKEN_RULES: Rule[] = [
  // PEM private key blocks, including the escaped form found inside JSON strings.
  {
    label: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/g,
  },
  // A truncated (or body-only) key: header plus the base64 lines after it.
  {
    label: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\r\n]*(?:[A-Za-z0-9+/=]{16,}[\r\n]*)+/g,
  },
  // OpenAI / Anthropic style keys, and Stripe live or test keys.
  { label: "api-key", re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g },
  { label: "api-key", re: /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  // AWS access key ids.
  { label: "aws-key", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  // GitHub tokens and fine-grained personal access tokens.
  { label: "github", re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "github", re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g },
  // Slack tokens.
  { label: "slack", re: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // Google API keys.
  { label: "google", re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g },
  // JWT / JWS: three base64url segments, anchored on the eyJ header prefix so
  // dotted identifiers and version strings are left alone.
  {
    label: "jwt",
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
];

/**
 * Authorization and bare Bearer headers, with or without the Bearer scheme. The
 * value is either a plain token or one braced token, so a masked credential is
 * caught too.
 */
const HEADER_VALUE = "(?:[A-Za-z0-9._~+/-]{8,}=*|\\{\\{[A-Za-z0-9]+_[A-Za-z0-9_./:=-]{2,}\\}\\})";
const AUTH_RE = new RegExp(
  "(\\bauthorization[\"']?\\s*[:=]\\s*[\"']?)(?:Bearer\\s+)?" + HEADER_VALUE,
  "gi",
);
const BEARER_RE = new RegExp("\\bBearer\\s+" + HEADER_VALUE, "g");

function redactHeaders(text: string): string {
  return text
    .replace(AUTH_RE, (_match, head: string) => head + mark("token"))
    .replace(BEARER_RE, "Bearer " + mark("token"));
}

/**
 * Key names whose value is a credential, in the spellings seen in the wild.
 * Matching is case-insensitive, so apiKey, API_KEY and Api-Key all hit, and the
 * boundary guards keep lookalikes such as "monkey" out.
 */
const SECRET_NAMES = [
  "APIKEY", "API_KEY", "API-KEY", "ACCESSKEY", "ACCESS_KEY", "SECRET_KEY", "SECRETKEY",
  "PRIVATE_KEY", "PRIVATEKEY", "SIGNING_KEY", "ENCRYPTION_KEY", "SESSION_KEY", "SECRET_KEY_BASE",
  "TOKEN", "API_TOKEN", "ACCESS_TOKEN", "AUTH_TOKEN", "REFRESH_TOKEN", "SESSION_TOKEN",
  "ID_TOKEN", "BEARER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "AWS_SESSION_TOKEN",
  "CREDENTIAL", "CREDENTIALS", "SECRET", "API_SECRET", "CLIENT_SECRET", "APP_SECRET", "JWT_SECRET",
  "PASSWORD", "PASSWD", "PWD", "DB_PASS", "DB_PASSWORD", "DATABASE_PASSWORD",
  "MYSQL_PASSWORD", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "AWS_SECRET_ACCESS_KEY",
  "DATABASE_URL", "DB_URL", "CONNECTION_STRING", "MONGO_URL", "MONGODB_URI", "MONGODB_URL",
  "REDIS_URL", "MYSQL_URL", "POSTGRES_URL",
].join("|");

/**
 * KEY=value, KEY: value and "KEY": "value" in shell commands, .env files, YAML
 * and JSON text. Only the value is replaced, so the key name and the separator
 * (useful context, and part of the Markdown/JSON structure) stay as they were.
 * Quoted values may contain spaces; bare values must look like a credential. A
 * value that opens a URL is left to the database-URL rule, which keeps the host
 * readable.
 */
const ENV_RE = new RegExp(
  "(?<![A-Za-z0-9])([\"']?)(" +
    SECRET_NAMES +
    ")\\1(?![A-Za-z0-9_])([ \\t]*:[ \\t]*|=)" +
    "(?![\"']?\\w+://)" +
    "(?:\"([^\"\\\\\\n]{4,})\"|'([^'\\\\\\n]{4,})'|" +
    "([A-Za-z0-9/+._][A-Za-z0-9+/=_.:@#!*~^$%?-]{5,})|" +
    "(\\{\\{[A-Za-z0-9]+_[A-Za-z0-9_./:=-]{2,}\\}\\}))(?!\\()",
  "gi",
);

function redactEnv(text: string): string {
  return text.replace(
    ENV_RE,
    (match, keyQuote, name, separator, doubleQuoted, singleQuoted, bare, braced) => {
      const quoted = doubleQuoted !== undefined || singleQuoted !== undefined;
      const value = (doubleQuoted ?? singleQuoted ?? bare ?? braced) as string | undefined;
      if (value === undefined || !isSecretLike(value)) return match as string;
      const quote = doubleQuoted !== undefined ? "\"" : singleQuoted !== undefined ? "'" : "";
      return keyQuote + name + keyQuote + separator + quote + mark("secret") + quote;
    },
  );
}

/** Database and broker URLs with an inline password; only the password is replaced. */
const DB_URL_RE =
  /(?<![A-Za-z0-9+])((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|clickhouse):\/\/)(?!\[REDACTED)([^:@\s"']*):(?!\[REDACTED)([^@\s"']+)@/g;

const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

/** Asset suffixes that look like a TLD but are really file names. */
const FILE_SUFFIXES = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "ico", "heic",
  "css", "js", "ts", "jsx", "tsx", "json", "txt", "md", "html", "xml", "yml", "yaml",
  "py", "rs", "go", "java", "sh", "sql", "toml", "lock", "woff", "woff2", "ttf",
]);

function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, (match) => {
    // git@github.com is an SSH host, not an address.
    if (/^git@/i.test(match)) return match;
    const suffix = match.slice(match.lastIndexOf(".") + 1).toLowerCase();
    if (FILE_SUFFIXES.has(suffix)) return match;
    return mark("email");
  });
}

/** Mainland-China mobile numbers, bounded so digit runs (ids, timestamps) survive. */
const PHONE_RE = /(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d{9}(?![\dA-Za-z])/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

/** Compiled path matchers, keyed by the requested user names. */
const pathMatchers = new Map<string, RegExp>();

/**
 * /Users/<me> and /home/<me> for the names the caller asked to hide. The
 * trailing slash, when present, is consumed and re-emitted so the result keeps
 * exactly one separator. Returns null when no name was requested.
 */
function userPathRe(homeUsers: readonly string[] | undefined): RegExp | null {
  const names = [...new Set((homeUsers ?? []).filter((name) => name.length > 0))];
  if (names.length === 0) return null;
  const key = names.join("\n");
  const cached = pathMatchers.get(key);
  if (cached) return cached;
  const re = new RegExp(
    "(\\/(?:Users|home)\\/)(?:" +
      names.map(escapeRegExp).join("|") +
      ")(?![A-Za-z0-9_-])(\\/?)",
    "gi",
  );
  pathMatchers.set(key, re);
  return re;
}

/**
 * Redact every supported pattern in one pass. Safe to call on text that is
 * already redacted: a second run never changes the result.
 */
export function redactText(text: string, options: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const rule of TOKEN_RULES) out = out.replace(rule.re, mark(rule.label));
  out = redactHeaders(out);
  out = redactEnv(out);
  out = out.replace(
    DB_URL_RE,
    (_match, head: string, user: string) => head + user + ":" + mark("db-password") + "@",
  );
  const homeRe = userPathRe(options.homeUsers);
  if (homeRe) {
    out = out.replace(homeRe, (_match, head: string, slash: string) => head + mark("user") + slash);
  }
  out = redactEmails(out);
  return out.replace(PHONE_RE, mark("phone"));
}

function redactEvent(event: ParsedEvent, options: RedactOptions): ParsedEvent {
  return {
    ...event,
    ...(event.name !== undefined ? { name: redactText(event.name, options) } : {}),
    ...(event.input !== undefined ? { input: redactText(event.input, options) } : {}),
    ...(event.output !== undefined ? { output: redactText(event.output, options) } : {}),
    ...(event.meta !== undefined ? { meta: redactText(event.meta, options) } : {}),
  };
}

/**
 * Redact a parsed session without mutating it: every field that reaches the
 * index (title, project path, turn text, event name/input/output/meta) is copied
 * through redactText. Identifiers used for upserts and resume links (agent,
 * externalId, fingerprint, sourcePath, timestamps) are kept as they are, and the
 * options default to "secrets only", so a bare redactSession(session) is safe.
 */
export function redactSession<T extends ParsedSession>(
  session: T,
  options: RedactOptions = {},
): T {
  const events = session.events?.map((event) => redactEvent(event, options));
  const turns: ParsedTurn[] = session.turns.map((turn) => ({
    ...turn,
    userText: redactText(turn.userText, options),
    assistantText: redactText(turn.assistantText, options),
  }));
  return {
    ...session,
    title: redactText(session.title, options),
    projectPath: redactText(session.projectPath, options),
    turns,
    ...(events ? { events } : {}),
  } as T;
}
