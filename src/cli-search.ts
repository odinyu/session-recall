import { existsSync } from "node:fs";
import { AGENT_IDS, isAgentId } from "./adapters/types.ts";
import type { AgentId } from "./adapters/types.ts";
import { localDateKey } from "./brief.ts";
import { DB_PATH, HOME } from "./config.ts";
import { openDb } from "./db.ts";
import type { IndexedDatabase } from "./db.ts";
import { searchTurns } from "./search.ts";
import type {
  ProcessHit,
  SearchHit,
  SearchParams,
  SearchResult,
  SearchScope,
} from "./search.ts";
import { clipText } from "./util/values.ts";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 5000;

export const USAGE = `usage: bun run src/cli.ts search <query> [options]

Search the local session index and print question/answer pairs.

options:
  --limit <n>      maximum sessions to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})
  --agent <id>     only these agents: ${AGENT_IDS.join(", ")}
                   repeatable, or comma-separated
  --scope <scope>  qa (prompts and answers, default) or process (tool calls, errors)
  --starred        only sessions you starred
  --include-hidden also search sessions you hid (hidden ones are skipped by default)
  --json           print machine-readable JSON instead of text
  -h, --help       show this help

examples:
  bun run src/cli.ts search "tvbox" --limit 3
  bun run src/cli.ts search "websocket" --agent omp --json
  bun run src/cli.ts search "ENOENT" --scope process
  bun run src/cli.ts search "deploy" --starred
  bun run src/cli.ts search "deploy" --include-hidden`;

export interface SearchArgs {
  query: string;
  limit: number;
  agents: AgentId[];
  scope: SearchScope;
  starred: boolean;
  includeHidden: boolean;
  json: boolean;
}

export type ParseOutcome =
  | { kind: "run"; args: SearchArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

interface FlagValue {
  value: string;
  /** True when the value came from the next argv entry. */
  consumed: boolean;
}

/** Reads `--name=value` or `--name value`; null when the value is missing. */
function flagValue(argv: string[], index: number): FlagValue | null {
  const arg = argv[index] as string;
  const eq = arg.indexOf("=");
  if (eq >= 0) {
    const value = arg.slice(eq + 1).trim();
    return value ? { value, consumed: false } : null;
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("-")) return null;
  const value = next.trim();
  return value ? { value, consumed: true } : null;
}

export function parseSearchArgs(argv: string[]): ParseOutcome {
  const terms: string[] = [];
  const agents: AgentId[] = [];
  const seenAgents = new Set<AgentId>();
  let limit = DEFAULT_LIMIT;
  let scope: SearchScope = "qa";
  let starred = false;
  let includeHidden = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;

    if (arg === "--") {
      terms.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--starred") {
      starred = true;
      continue;
    }
    if (arg === "--include-hidden") {
      includeHidden = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { kind: "help" };
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const flag = flagValue(argv, index);
      if (!flag) {
        return { kind: "error", message: "--limit requires a value, e.g. --limit 5" };
      }
      if (flag.consumed) index += 1;
      const value = Number(flag.value);
      if (!/^[0-9]+$/.test(flag.value) || value < 1 || value > MAX_LIMIT) {
        return {
          kind: "error",
          message: `invalid --limit "${flag.value}": expected an integer from 1 to ${MAX_LIMIT}`,
        };
      }
      limit = value;
      continue;
    }
    if (arg === "--agent" || arg.startsWith("--agent=")) {
      const flag = flagValue(argv, index);
      if (!flag) {
        return {
          kind: "error",
          message: `--agent requires a value: ${AGENT_IDS.join(", ")}`,
        };
      }
      if (flag.consumed) index += 1;
      for (const part of flag.value.split(",").map((value) => value.trim())) {
        if (!part) continue;
        if (!isAgentId(part)) {
          return {
            kind: "error",
            message: `unknown agent "${part}": choose one of ${AGENT_IDS.join(", ")}`,
          };
        }
        if (!seenAgents.has(part)) {
          seenAgents.add(part);
          agents.push(part);
        }
      }
      continue;
    }
    if (arg === "--scope" || arg.startsWith("--scope=")) {
      const flag = flagValue(argv, index);
      if (!flag) {
        return { kind: "error", message: "--scope requires a value: qa or process" };
      }
      if (flag.consumed) index += 1;
      if (flag.value !== "qa" && flag.value !== "process") {
        return {
          kind: "error",
          message: `invalid --scope "${flag.value}": expected qa or process`,
        };
      }
      scope = flag.value;
      continue;
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `unknown option "${arg}"` };
    }
    terms.push(arg);
  }

  const query = terms.join(" ").trim();
  if (!query) {
    return { kind: "error", message: "missing query" };
  }
  return {
    kind: "run",
    args: { query, limit, agents, scope, starred, includeHidden, json },
  };
}

function displayPath(path: string): string {
  if (!path) return "(no project)";
  if (path === HOME || path.startsWith(`${HOME}/`)) return `~${path.slice(HOME.length)}`;
  return path;
}

function day(ms: number): string {
  return ms > 0 ? localDateKey(new Date(ms)) : "";
}

export function formatSearchText(result: SearchResult, args: SearchArgs): string {
  const lines: string[] = [];
  const filters = [`scope: ${result.scope}`, `mode: ${result.mode}`];
  if (args.agents.length > 0) filters.push(`agents: ${args.agents.join(", ")}`);
  if (args.starred) filters.push("starred only");
  if (args.includeHidden) filters.push("hidden included");
  lines.push(
    `query "${result.q}" · ${result.totalTurns} hit(s) in ${result.totalSessions} session(s) · ${result.tookMs} ms · ${filters.join(" · ")}`,
  );

  if (result.sessions.length === 0) {
    lines.push("");
    lines.push("No matches. Try a shorter query, the other scope, or fewer filters.");
    return lines.join("\n");
  }

  result.sessions.forEach((session, index) => {
    lines.push("");
    lines.push(
      `${index + 1}. ${session.id}  [${session.agent}]  ${day(session.updatedAt)}`,
    );
    lines.push(`   ${displayPath(session.projectPath)}`);

    for (const hit of session.hits) {
      const question = clipText(hit.matchField === "user" ? hit.snippet : hit.userText, 200);
      const answer = clipText(
        hit.matchField === "user" ? hit.assistantSnippet : hit.snippet,
        240,
      );
      lines.push(`   · Q  ${question || "(empty prompt)"}`);
      lines.push(`     A  ${answer || "(no answer recorded)"}`);
    }

    for (const hit of session.processHits) {
      lines.push(`   · ${hit.tool || "event"} (${hit.status || "ok"}) · ${hit.matchField}`);
      lines.push(`     ${clipText(hit.snippet, 240) || "(empty)"}`);
    }
  });

  return lines.join("\n");
}

export interface CliHitJson {
  turnIdx: number;
  ts: number;
  date: string;
  matchField: "user" | "assistant" | "tool" | "input" | "error";
  snippet: string;
  question: string;
  answer: string;
  tool: string;
  status: string;
}

export interface CliSessionJson {
  sessionId: string;
  agent: AgentId;
  project: string;
  date: string;
  updatedAt: number;
  title: string;
  /** The user's flags, so a mixed `--include-hidden` result stays readable. */
  starred: boolean;
  hidden: boolean;
  hits: CliHitJson[];
}

export interface CliSearchJson {
  query: string;
  scope: SearchScope;
  mode: SearchResult["mode"];
  limit: number;
  agents: AgentId[];
  starred: boolean;
  includeHidden: boolean;
  tookMs: number;
  totalTurns: number;
  totalSessions: number;
  returned: number;
  results: CliSessionJson[];
}

function qaHitJson(hit: SearchHit): CliHitJson {
  return {
    turnIdx: hit.idx,
    ts: hit.ts,
    date: day(hit.ts),
    matchField: hit.matchField,
    snippet: hit.snippet,
    question: hit.matchField === "user" ? hit.snippet : hit.userText,
    answer: hit.matchField === "user" ? hit.assistantSnippet : hit.snippet,
    tool: "",
    status: "",
  };
}

function processHitJson(hit: ProcessHit): CliHitJson {
  return {
    turnIdx: hit.turnIdx,
    ts: hit.ts,
    date: day(hit.ts),
    matchField: hit.matchField,
    snippet: hit.snippet,
    question: "",
    answer: "",
    tool: hit.tool,
    status: hit.status,
  };
}

export function toJsonResult(result: SearchResult, args: SearchArgs): CliSearchJson {
  return {
    query: result.q,
    scope: result.scope,
    mode: result.mode,
    limit: args.limit,
    agents: args.agents,
    starred: args.starred,
    includeHidden: args.includeHidden,
    tookMs: result.tookMs,
    totalTurns: result.totalTurns,
    totalSessions: result.totalSessions,
    returned: result.sessions.length,
    results: result.sessions.map((session) => ({
      sessionId: session.id,
      agent: session.agent,
      project: session.projectPath,
      date: day(session.updatedAt),
      updatedAt: session.updatedAt,
      title: session.title,
      starred: session.starred,
      hidden: session.hidden,
      hits: [
        ...session.hits.map(qaHitJson),
        ...session.processHits.map(processHitJson),
      ],
    })),
  };
}

/** Runs the `search` subcommand and returns the process exit code. */
export function runSearchCli(argv: string[], dbPath = DB_PATH): number {
  const parsed = parseSearchArgs(argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    console.error("run with --help for usage.");
    return 2;
  }
  const { args } = parsed;

  if (!existsSync(dbPath)) {
    console.error(`index not found: ${dbPath}`);
    console.error("run `bun run scan` first to build it.");
    return 1;
  }

  let db: IndexedDatabase;
  try {
    db = openDb(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cannot open index ${dbPath}: ${message}`);
    return 1;
  }

  try {
    const params: SearchParams = {
      q: args.query,
      agents: args.agents,
      project: "",
      from: null,
      to: null,
      role: "all",
      scope: args.scope,
      limit: args.limit,
      offset: 0,
      starred: args.starred,
      includeHidden: args.includeHidden,
    };
    const result = searchTurns(db, params);
    console.log(
      args.json
        ? JSON.stringify(toJsonResult(result, args), null, 2)
        : formatSearchText(result, args),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`search failed: ${message}`);
    return 1;
  } finally {
    db.close();
  }
}
