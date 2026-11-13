# Product

[English](PRODUCT.md) | [Chinese](PRODUCT.zh-CN.md)

<!-- impeccable:product-schema 1 -->

## Platform

macOS desktop app (Tauri shell around a Bun sidecar, `sessionrecall://` deep
links) plus the web UI it serves on a random loopback port.

## Stack

Bun + TypeScript, zero runtime dependencies: `Bun.serve` for HTTP, `bun:sqlite` for the index, vanilla TypeScript + CSS for the UI, bundled with `Bun.build`. Delegated by the owner after the Bun/TypeScript choice; the npm registry was unreachable (`bun add` timed out), and the tool benefits from a dependency-free single-repo install.

## Users

The owner: a developer on macOS who runs several coding agents (omp, pi, OpenCode,
Cursor, Alma, Cindy, Claude Code, Codex) across many projects, often in Chinese
and English. The job is to find a past task — "where did I solve this?" — when the only memory left is a phrase from a prompt or an answer.

## Product Purpose

Build a local, read-only index of every agent session on this machine and make the question/answer pairs searchable in a web UI. Success means a half-remembered Chinese phrase or a code identifier returns the right session, the right agent, the right project, and the surrounding answer in under a second.

## Positioning

A recall tool, not an agent dashboard or usage meter. It persists a turn-level full-text index across agents, so search is instant and ranked, and results are question/answer pairs rather than files or token totals. It never writes to an agent's store.

## Operating Context

- macOS; local `http://127.0.0.1` only.
- Primary sources for v1: omp (`~/.omp/agent/sessions`), OpenCode (`~/.local/share/opencode/opencode.db`), Cursor IDE (`~/.cursor/projects/*/agent-transcripts`, `state.vscdb`).
- Agents are launched from terminals and from Cursor; sessions grow while the index runs.
- The owner reads results on a laptop screen, often while another agent is working.

## Capabilities and Constraints

- Adapters: omp, pi, OpenCode (v1 and v2 tables), Cursor (transcripts + composer/bubble KV), Alma, Cindy, Claude Code, Codex.
- Search across prompts, answers and process events (tool calls, commands, errors), with agent, project, date, scope, and role filters.
- Session view pairs each prompt with the answer that followed it; the Process disclosure opens the tool/reasoning trail.
- Read-only: agent databases are opened read-only; the index lives under `~/Library/Application Support/session-recall`.
- Write-time redaction of secrets and PII, plus “Forget session” (`forget` / `unforget`) to drop a session from the index without touching its transcript.
- Agent-accessible recall: the `sr` CLI and a read-only stdio MCP server.
- Daily standup and ISO-week reports, in the sidebar and via `bun run brief`.
- WorkBuddy exposes local session metadata only; transcripts are cloud-side. Deferred with an explicit "no local transcript" state.
- Assumption (not yet confirmed): the owner wants local-only storage and no cloud sync.

## Evidence on Hand

- Live local data: 89 omp sessions, 181 OpenCode v2 sessions, 425 Cursor composers, 256 Cursor transcripts.
- A throwaway feasibility run produced 3,141 turns / 6.6 MB of text; Chinese trigram queries returned in 0.3 ms and a two-character LIKE fallback in 7 ms.
- Screenshots live in `docs/screenshots/en/` and `docs/screenshots/zh/`, generated from synthetic sessions by
  `scripts/capture-screenshots.sh` (the real index is never opened). No
  testimonials or brand assets exist; none should be fabricated.

## Product Principles

1. Find the moment, not the file: every result is a question/answer pair.
2. Read-only by construction: a broken index must never damage an agent's history.
3. Local by default: no network calls, no accounts, no telemetry.
4. Precision over decoration: the interface is a working archive, dense and calm.
5. Degrade honestly: a source that cannot be read says so instead of disappearing.

## Accessibility & Inclusion

Keyboard-first search and navigation, visible focus, WCAG AA contrast, reduced-motion support. Chinese and English content must both render and search correctly.
