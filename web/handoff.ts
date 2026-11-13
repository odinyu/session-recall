/**
 * DOM-free pieces of the handoff card flow: the cache key, the bounded cache and
 * the bounded wait a click uses while the prefetch is still in flight.
 *
 * They live here so `bun test` can cover the state machine without a browser:
 * `web/app.ts` calls `boot()` on import and needs a document.
 */

/** One cached Markdown card per session *and* target; a new target is a new card. */
export function handoffKey(id: string, targetAgent: string | null): string {
  return `${id}|${targetAgent ?? ""}`;
}

/** A card is a full copy of the session text, so only the recent few are kept. */
export const HANDOFF_CACHE_LIMIT = 32;

/** How long the UI waits for a card before handing the button back to the user. */
export const HANDOFF_WAIT_MS = 5000;

/**
 * Insert a card, newest last, and evict the oldest once over `limit`. Deleting
 * first makes a refreshed card count as the newest rather than staying stale.
 */
export function rememberHandoff(
  cache: Map<string, string>,
  key: string,
  value: string,
  limit = HANDOFF_CACHE_LIMIT,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

/** How an in-flight card ended, as far as the UI can tell. */
export type HandoffWait = "ready" | "failed" | "timeout";

/**
 * Wait for an in-flight card without letting a stuck request freeze the button:
 * a request that never settles reports `timeout` after `timeoutMs`. The promise's
 * value is ignored — callers read the cache afterwards, because a timeout does
 * not cancel the request and it may still fill the cache later.
 */
export function waitForHandoff(
  promise: Promise<unknown>,
  timeoutMs = HANDOFF_WAIT_MS,
): Promise<HandoffWait> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve("ready");
      },
      () => {
        clearTimeout(timer);
        resolve("failed");
      },
    );
  });
}
