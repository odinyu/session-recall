/**
 * Link classification for the hash-routed UI.
 *
 * Two kinds of link belong to the app itself and must navigate in place:
 *
 * - `sessionrecall://session/<id>`, the stable deep link a brief is generated
 *   with (`src/brief.ts`). It addresses the app, not the machine, so clicking
 *   one inside the app should not make an OS round trip through the URL handler.
 * - absolute loopback links (`http://127.0.0.1:<port>/#/session/<id>`). The port
 *   is whatever the launch that generated them happened to use, which is why
 *   they are only still understood, never emitted.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const ABSOLUTE = /^https?:\/\//i;

/** The URL scheme the bundled app registers for itself. */
export const DEEP_LINK_SCHEME = "sessionrecall";
const DEEP_LINK_PREFIX = new RegExp(`^${DEEP_LINK_SCHEME}:`, "i");
/** Deep-linked sections that address one record, i.e. `#/<section>/<id>`. */
const DEEP_LINK_SECTIONS = new Set(["session", "brief"]);

export interface DeepLink {
  section: string;
  /** The decoded record id, e.g. `alma:mwbhgpzz9n7zy56fdm`. */
  id: string;
}

/**
 * The in-app hash route an absolute loopback link points at, or null when the
 * link should keep its default behaviour.
 *
 * Only absolute `http(s)://<loopback>[:any port]` links qualify: relative links
 * (`#/session/x`, `/api/brief/file?…`) already stay inside the document, and
 * every non-loopback host is left alone so external links keep opening
 * externally.
 */
export function loopbackRoute(href: string): string | null {
  if (!ABSOLUTE.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url.hash.startsWith("#/") ? url.hash : "#/search";
}

/**
 * Split a `sessionrecall://<section>/<id>` URL, or return null when it is not
 * one. Junk — a foreign scheme, a section the app does not have, a missing id —
 * is rejected rather than turned into a route, so a bad link can never navigate
 * somewhere arbitrary.
 */
export function parseDeepLink(href: string): DeepLink | null {
  if (!DEEP_LINK_PREFIX.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== `${DEEP_LINK_SCHEME}:`) return null;
  const section = url.hostname.toLowerCase();
  if (!DEEP_LINK_SECTIONS.has(section)) return null;
  const raw = url.pathname.replace(/^\//, "");
  if (!raw || raw.includes("/")) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return id ? { section, id } : null;
}

/** The hash route a deep link addresses, re-encoded the way the router expects. */
export function deepLinkRoute(href: string): string | null {
  const link = parseDeepLink(href);
  return link ? `#/${link.section}/${encodeURIComponent(link.id)}` : null;
}

/**
 * The hash route a click on `href` should navigate to, or null to let the link
 * do whatever it would normally do.
 */
export function inAppRoute(href: string): string | null {
  return loopbackRoute(href) ?? deepLinkRoute(href);
}
