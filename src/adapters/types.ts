export type AgentId =
  | "omp"
  | "pi"
  | "opencode"
  | "cursor"
  | "alma"
  | "cindy"
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "qwen-code"
  | "kimi-code"
  | "copilot-cli"
  | "goose";

/** Every id in the `AgentId` union, for validation and help text. */
export const AGENT_IDS = [
  "omp",
  "pi",
  "opencode",
  "cursor",
  "alma",
  "cindy",
  "claude-code",
  "codex",
  "gemini-cli",
  "qwen-code",
  "kimi-code",
  "copilot-cli",
  "goose",
] as const;

/** Human-facing names, shared by the brief, handoff card and MCP tools. */
export const AGENT_LABELS: Record<AgentId, string> = {
  omp: "omp",
  pi: "pi",
  opencode: "OpenCode",
  cursor: "Cursor",
  alma: "Alma",
  cindy: "Cindy",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "qwen-code": "Qwen Code",
  "kimi-code": "Kimi Code",
  "copilot-cli": "Copilot CLI",
  goose: "Goose",
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

export interface ParsedTurn {
  idx: number;
  ts: number;
  userText: string;
  assistantText: string;
  model?: string;
  truncated?: boolean;
}

export type EventKind = "reasoning" | "tool";

/** A tool call or a reasoning block, stored outside the search index. */
export interface ParsedEvent {
  turnIdx: number;
  seq: number;
  kind: EventKind;
  name?: string;
  input?: string;
  output?: string;
  meta?: string;
  truncated?: boolean;
}

export interface ParsedSession {
  agent: AgentId;
  externalId: string;
  parentId?: string;
  projectPath: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  sourceKind: "jsonl" | "sqlite" | "cursor-kv";
  sourcePath: string;
  fingerprint: string;
  turns: ParsedTurn[];
  events?: ParsedEvent[];
}

export interface SessionRef {
  agent: AgentId;
  externalId: string;
  fingerprint: string;
  sourcePath: string;
}

export interface Adapter {
  id: AgentId;
  label: string;
  /** Bump when parsing changes so fingerprints invalidate. */
  version?: number;
  /** List every session the source currently exposes, cheaply. */
  list(): Promise<SessionRef[]>;
  /** Read one session fully; null when it vanished between list and load. */
  load(ref: SessionRef): Promise<ParsedSession | null>;
  close?(): void;
}
