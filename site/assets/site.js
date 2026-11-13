/*!
 * Session Recall landing page — copy-to-clipboard only.
 * Progressive enhancement: the page is fully readable and usable without JS.
 * The buttons are hidden in CSS until <html> gets the `js` class.
 */
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "copy-src";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  root.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-copy]");
    if (!btn) return;

    var block = btn.closest(".term");
    var code = block && block.querySelector("pre code");
    if (!code) return;

    var text = code.textContent;
    var label = btn.textContent;

    var done = function (ok) {
      if (!ok) return;
      btn.textContent = btn.getAttribute("data-copied") || "Copied";
      btn.setAttribute("data-done", "1");
      window.setTimeout(function () {
        btn.textContent = label;
        btn.removeAttribute("data-done");
      }, 1600);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          done(fallbackCopy(text));
        }
      );
    } else {
      done(fallbackCopy(text));
    }
  });
})();
