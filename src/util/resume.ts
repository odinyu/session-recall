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
