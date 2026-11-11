import { expect, test } from "bun:test";
import { deepLinkRoute, inAppRoute, parseDeepLink } from "../web/links.ts";

test("routes loopback links to their hash route, on any port", () => {
  // The CLI records the default port (4319); the packaged app serves on a
  // random free port. Both must land in the app's own router.
  expect(inAppRoute("http://127.0.0.1:4319/#/session/omp%3Aabc")).toBe(
    "#/session/omp%3Aabc",
  );
  expect(inAppRoute("http://localhost:59574/#/brief/2026-11-10")).toBe(
    "#/brief/2026-11-10",
  );
  expect(inAppRoute("http://127.0.0.1:9/#/search?q=x")).toBe("#/search?q=x");
  expect(inAppRoute("http://[::1]:4319/#/session/x")).toBe("#/session/x");
  expect(inAppRoute("http://LOCALHOST:8080/#/session/x")).toBe("#/session/x");
});

test("falls back to the search route for a loopback url without a route", () => {
  expect(inAppRoute("http://127.0.0.1:6060/")).toBe("#/search");
  expect(inAppRoute("http://localhost:8788/v1/models")).toBe("#/search");
});

test("leaves everything else alone", () => {
  expect(inAppRoute("https://example.com/#/session/x")).toBeNull();
  expect(inAppRoute("http://127.0.0.1.evil.com/#/session/x")).toBeNull();
  expect(inAppRoute("mailto:someone@example.com")).toBeNull();
  expect(inAppRoute("alma://thread/01a1c36e")).toBeNull();
  // Relative links already stay inside the document.
  expect(inAppRoute("#/session/x")).toBeNull();
  expect(inAppRoute("/api/brief/file?date=2026-11-10")).toBeNull();
});

test("maps the sessionrecall deep link onto a hash route", () => {
  // The link a generated brief carries, and the one the app is opened with.
  expect(inAppRoute("sessionrecall://session/alma%3Amwbhgpzz9n7zy56fdm")).toBe(
    "#/session/alma%3Amwbhgpzz9n7zy56fdm",
  );
  expect(inAppRoute("sessionrecall://session/omp%3Aabc")).toBe(
    "#/session/omp%3Aabc",
  );
  expect(inAppRoute("sessionrecall://brief/2026-11-10")).toBe("#/brief/2026-11-10");
  // The section is host-cased by the URL parser; ids keep their case.
  expect(inAppRoute("sessionrecall://Session/omp%3AAbc")).toBe("#/session/omp%3AAbc");
});

test("decodes the deep-link id exactly once", () => {
  // `%3A` is the `:` in `alma:mwbhgpzz9n7zy56fdm`; the router's parseHash decodes
  // the route's id once more, so both sides must agree on one encoded form.
  expect(parseDeepLink("sessionrecall://session/alma%3Amwbhgpzz9n7zy56fdm")).toEqual({
    section: "session",
    id: "alma:mwbhgpzz9n7zy56fdm",
  });
  const route = deepLinkRoute("sessionrecall://session/alma%3Amwbhgpzz9n7zy56fdm");
  expect(route).toBe("#/session/alma%3Amwbhgpzz9n7zy56fdm");
  expect(decodeURIComponent((route ?? "").replace("#/session/", ""))).toBe(
    "alma:mwbhgpzz9n7zy56fdm",
  );
  // A percent-encoded slash stays part of the id instead of splitting the route.
  expect(parseDeepLink("sessionrecall://session/a%2Fb")?.id).toBe("a/b");
});

test("rejects malformed deep links instead of inventing a route", () => {
  expect(deepLinkRoute("sessionrecall://")).toBeNull();
  expect(deepLinkRoute("sessionrecall:")).toBeNull();
  expect(deepLinkRoute("sessionrecall://session")).toBeNull();
  expect(deepLinkRoute("sessionrecall://session/")).toBeNull();
  // A second path segment is not a session id.
  expect(deepLinkRoute("sessionrecall://session/alma%3Ax/extra")).toBeNull();
  // Unknown section.
  expect(deepLinkRoute("sessionrecall://thread/01a1c36e")).toBeNull();
  // A broken escape sequence must not throw.
  expect(deepLinkRoute("sessionrecall://session/%E0%A4%A")).toBeNull();
  // Not URLs at all.
  expect(deepLinkRoute("")).toBeNull();
  expect(deepLinkRoute("sessionrecall")).toBeNull();
  expect(deepLinkRoute("//session/x")).toBeNull();
  expect(deepLinkRoute("https://example.com/sessionrecall://session/x")).toBeNull();
  // A deep-link-shaped path under another scheme stays external.
  expect(inAppRoute("https://example.com/sessionrecall://session/x")).toBeNull();
});
