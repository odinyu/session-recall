export type AgentId = "omp" | "opencode" | "cursor" | "alma" | "cindy";

/** Every id in the `AgentId` union, for validation and help text. */
export const AGENT_IDS = ["omp", "opencode", "cursor", "alma", "cindy"] as const;

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
