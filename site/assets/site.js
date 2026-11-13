/*!
 * Session Recall landing page — copy-to-clipboard, back-to-top, theme switch.
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

  /* --- back to top ---------------------------------------------------------
     The <a href="#top"> anchor works on its own. This only adds the
     show-on-scroll behaviour and smooth scrolling; with reduced motion we
     leave the native instant jump alone. */
  var toTop = document.querySelector(".to-top");
  if (toTop) {
    var THRESHOLD = 600;
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var main = document.getElementById("main");

    var updateToTop = function () {
      toTop.classList.toggle("is-visible", window.scrollY > THRESHOLD);
    };

    window.addEventListener("scroll", updateToTop, { passive: true });
    updateToTop();

    toTop.addEventListener("click", function (event) {
      var supportsSmooth = "scrollBehavior" in document.documentElement.style;
      if (!supportsSmooth || reduceMotion.matches) return;

      event.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (main && typeof main.focus === "function") {
        main.focus({ preventScroll: true });
      }
    });
  }

  /* --- theme switch --------------------------------------------------------
     Auto (no data-theme attribute) follows the OS; light and dark set the
     attribute. theme-init.js has already applied the stored choice before the
     first paint — this keeps the label, the browser chrome colour and OS
     changes in sync afterwards. */
  var THEME_KEY = "sr-theme";
  var themeBtn = document.getElementById("theme-btn");
  var osDark = window.matchMedia("(prefers-color-scheme: dark)");

  function themeFromStorage() {
    try {
      var value = window.localStorage.getItem(THEME_KEY);
      return value === "light" || value === "dark" ? value : "auto";
    } catch (e) {
      return "auto";
    }
  }

  function storeTheme(mode) {
    try {
      if (mode === "auto") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, mode);
    } catch (e) {
      /* storage unavailable: the choice still applies for this page view */
    }
  }

  function resolvedTheme(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return osDark.matches ? "dark" : "light";
  }

  function paintTheme(mode) {
    if (mode === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);

    var colour = resolvedTheme(mode) === "dark" ? "#141715" : "#f2f3ef";
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      metas[i].setAttribute("content", colour);
    }

    if (themeBtn) {
      var label = themeBtn.getAttribute("data-theme-label-" + mode);
      if (label) {
        themeBtn.setAttribute("aria-label", label);
        themeBtn.setAttribute("title", label);
      }
    }
  }

  function nextTheme(mode) {
    if (mode === "auto") return "light";
    if (mode === "light") return "dark";
    return "auto";
  }

  var themeMode = themeFromStorage();
  paintTheme(themeMode);

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      themeMode = nextTheme(themeMode);
      storeTheme(themeMode);
      paintTheme(themeMode);
    });
  }

  var onOsThemeChange = function () {
    if (themeMode === "auto") paintTheme("auto");
  };
  if (typeof osDark.addEventListener === "function") {
    osDark.addEventListener("change", onOsThemeChange);
  } else if (typeof osDark.addListener === "function") {
    osDark.addListener(onOsThemeChange);
  }
})();
