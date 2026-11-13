import { expect, test } from "bun:test";
import {
  HANDOFF_CACHE_LIMIT,
  handoffKey,
  rememberHandoff,
  waitForHandoff,
} from "../web/handoff.ts";

/**
 * The handoff card is prefetched so the copy button can write to the clipboard
 * synchronously from the click; these are the DOM-free pieces that decide what
 * is cached, how much, and how a click behaves while the card is still loading.
 */

test("a target change is a different card; missing and empty targets agree", () => {
  expect(handoffKey("omp:abc", "omp")).toBe("omp:abc|omp");
  expect(handoffKey("omp:abc", "codex")).not.toBe(handoffKey("omp:abc", "omp"));
  expect(handoffKey("omp:abc", null)).toBe(handoffKey("omp:abc", ""));
  expect(handoffKey("session|with|pipes", "pi")).toBe("session|with|pipes|pi");
});

test("rememberHandoff evicts the oldest card once over the limit", () => {
  const cache = new Map<string, string>();
  for (let index = 0; index < HANDOFF_CACHE_LIMIT + 3; index += 1) {
    rememberHandoff(cache, `s${index}`, `card ${index}`);
  }
  expect(cache.size).toBe(HANDOFF_CACHE_LIMIT);
  expect(cache.has("s0")).toBe(false);
  expect(cache.has("s2")).toBe(false);
  expect(cache.has("s3")).toBe(true);
  expect(cache.get(`s${HANDOFF_CACHE_LIMIT + 2}`)).toBe(
    `card ${HANDOFF_CACHE_LIMIT + 2}`,
  );
});

test("re-caching a card keeps it and makes it the newest", () => {
  const cache = new Map<string, string>();
  rememberHandoff(cache, "a", "old");
  rememberHandoff(cache, "b", "b-card");
  rememberHandoff(cache, "a", "new", 2);
  rememberHandoff(cache, "c", "c-card", 2);
  expect([...cache.keys()]).toEqual(["a", "c"]);
  expect(cache.get("a")).toBe("new");
});

test("waitForHandoff reports ready, failed and timeout without throwing", async () => {
  expect(await waitForHandoff(Promise.resolve("card"))).toBe("ready");
  expect(await waitForHandoff(Promise.reject(new Error("nope")))).toBe("failed");
  // A request that never settles must still hand control back to the caller.
  expect(await waitForHandoff(new Promise(() => {}), 20)).toBe("timeout");
});
