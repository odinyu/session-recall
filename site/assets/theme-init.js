/*!
 * Session Recall — apply a stored theme before the stylesheet paints.
 *
 * Loaded synchronously in <head>, before site.css, so <html data-theme> is
 * already set when the first stylesheet is applied and the page never flashes
 * the opposite theme. Kept in its own file rather than inline because the
 * deployed Content-Security-Policy is script-src 'self'.
 *
 * Storage key: sr-theme. Values: "light" | "dark". Absent means auto, which
 * leaves data-theme off so the stylesheet's prefers-color-scheme rules apply.
 */
(function () {
  var root = document.documentElement;
  var mode = "auto";

  try {
    var stored = window.localStorage.getItem("sr-theme");
    if (stored === "light" || stored === "dark") mode = stored;
  } catch (e) {
    /* private mode or blocked storage: fall back to following the OS */
  }

  if (mode !== "auto") root.setAttribute("data-theme", mode);

  /* Set the browser chrome colour for the very first paint. Both media-scoped
     theme-color tags get the resolved value, so an explicit choice wins over
     the OS even before site.js runs. No-JS visitors keep the media-based tags. */
  var dark =
    mode === "dark" ||
    (mode === "auto" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    metas[i].setAttribute("content", dark ? "#141715" : "#f2f3ef");
  }
})();