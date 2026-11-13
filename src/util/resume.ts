import { AGENT_LABELS } from "../adapters/types.ts";
import type { AgentId } from "../adapters/types.ts";

/** Single-quote a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The shell command that continues an omp or OpenCode session, or "". */
export function resumeCommand(
  agent: AgentId,
  externalId: string,
  projectPath: string,
): string {
  const cwd = projectPath ? `cd ${shellQuote(projectPath)} && ` : "";
  if (agent === "omp") {
    const resumeId = externalId.slice(externalId.lastIndexOf("_") + 1);
    return `${cwd}omp --resume ${resumeId}`;
  }
  if (agent === "opencode") {
    return `${cwd}opencode --session ${externalId}`;
  }
  if (agent === "claude-code") {
    return `${cwd}claude --resume ${externalId}`;
  }
  if (agent === "pi") {
    // pi filenames are `<timestamp>_<uuid>.jsonl`; resume by the uuid.
    const uuid = externalId.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )?.[0];
    return `${cwd}pi --session ${uuid ?? externalId}`;
  }
  if (agent === "codex") {
    // Rollout files end in the session uuid; older ones may be named by id.
    const uuid = externalId.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )?.[0];
    return `${cwd}codex resume ${uuid ?? externalId}`;
  }
  return "";
}

/** Stable app deep link; mirrors the scheme registered by the macOS bundle. */
export function sessionDeepLink(sessionId: string): string {
  return `sessionrecall://session/${encodeURIComponent(sessionId)}`;
}

/** Alma's own deep link for a thread. */
export function almaDeepLink(externalId: string): string {
  return `alma://thread/${externalId}`;
}

/** How a *new* session starts in an agent that has a command-line entry point. */
const LAUNCH: Partial<Record<AgentId, string>> = {
  omp: "omp",
  pi: "pi",
  opencode: "opencode",
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
};

export interface Continuation {
  kind: "resume" | "deep-link" | "launch" | "manual";
  /** Shell command or deep link; empty when no one-liner exists. */
  command: string;
  /** One sentence for the card and the UI; says what the command does. */
  note: string;
}

export interface ContinuationSource {
  agent: AgentId;
  externalId: string;
  projectPath: string;
}

/**
 * How to continue `source` in `target`.
 *
 * Same agent: resume the exact session when that agent has a resume command or
 * a deep link. Any other target starts a *new* session in that agent and leaves
 * the handoff card as the context — session ids do not transfer between agents.
 */
export function continuationFor(
  target: AgentId,
  source: ContinuationSource,
): Continuation {
  if (target === source.agent) {
    const resume = resumeCommand(target, source.externalId, source.projectPath);
    if (resume) {
      return { kind: "resume", command: resume, note: "继续这条会话" };
    }
    if (target === "alma") {
      return {
        kind: "deep-link",
        command: almaDeepLink(source.externalId),
        note: "在 Alma 中打开这条对话",
      };
    }
  }

  const launcher = LAUNCH[target];
  if (launcher) {
    const command =
      target === "cursor"
        ? [launcher, source.projectPath ? shellQuote(source.projectPath) : ""]
            .filter(Boolean)
            .join(" ")
        : source.projectPath
          ? `cd ${shellQuote(source.projectPath)} && ${launcher}`
          : launcher;
    const note =
      target === "cursor"
        ? "在 Cursor 中打开项目，把交接卡粘进新对话"
        : `在 ${AGENT_LABELS[target]} 中新开一个会话，把交接卡作为上下文`;
    return { kind: "launch", command, note };
  }

  return {
    kind: "manual",
    command: "",
    note: `在 ${AGENT_LABELS[target]} 中新建会话并粘贴交接卡`,
  };
}
