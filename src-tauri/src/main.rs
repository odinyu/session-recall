// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri shell for Session Recall.
//!
//! The window is a thin wrapper: it points a `WKWebView` at
//! `http://127.0.0.1:<port>` served by the Bun sidecar that ships next to the
//! main executable. All indexing, search and asset serving stays in Bun, so the
//! Rust side owns exactly five responsibilities:
//!
//! 1. reserve a free loopback port,
//! 2. spawn + supervise the sidecar (and reap it on exit),
//! 3. open the window once the server is actually listening,
//! 4. answer `sessionrecall://` deep links — the one address that outlives the
//!    random port — by driving the UI's own hash router,
//! 5. own the global shortcut that summons the window from any app.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::menu::Menu;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const WINDOW_LABEL: &str = "main";
const WINDOW_TITLE: &str = "Session Recall";
/// The scheme this bundle registers for itself; mirrors
/// `plugins.deep-link.desktop.schemes` in `tauri.conf.json` and the links
/// `src/brief.ts` emits.
const DEEP_LINK_SCHEME: &str = "sessionrecall";
/// Deep-linked sections that address a single record, i.e. `#/<section>/<id>`.
const DEEP_LINK_SECTIONS: [&str; 2] = ["session", "brief"];
/// The shortcut this build registers when prefs say nothing else.
///
/// `Option+Space` is deliberately avoided: Raycast and Spotlight claim it on
/// most Macs, and taking it over would break them for everyone who uses them.
const DEFAULT_HOTKEY: &str = "Option+Command+R";
/// Overrides the shortcut for one launch; also what the tests use.
const HOTKEY_ENV: &str = "SESSION_RECALL_HOTKEY";
/// Env values that mean "no shortcut" instead of a key combination.
const DISABLED_HOTKEY_VALUES: [&str; 4] = ["", "off", "none", "false"];
/// Where this launch records its registration outcome, for `GET /api/hotkey`.
const HOTKEY_STATE_FILE: &str = "hotkey-state.json";
/// Appended to every registration failure: on macOS an unapproved app is the
/// likeliest reason, and the dialog that explains it never appears on its own.
const HOTKEY_FAILURE_HINT: &str = "Another app may already own this shortcut, or macOS may be withholding it: allow Session Recall under System Settings → Privacy & Security → Accessibility and Input Monitoring, then restart the app.";
/// How long we give the sidecar to start answering on its port.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const READY_INTERVAL: Duration = Duration::from_millis(150);
/// Only used if the OS refuses to hand us an ephemeral port (should not happen).
const FALLBACK_PORT: u16 = 4319;

/// The bundled sidecar plus the "we are shutting down" flag.
///
/// `child` and `quitting` are guarded by the same mutex so that a quit racing a
/// just-spawned sidecar can never leak an orphan: either `set` stores the child
/// first and `kill` reaps it, or `kill` flips the flag first and `set` reaps it.
struct Sidecar {
    child: Mutex<Option<Child>>,
    quitting: Arc<AtomicBool>,
}

impl Sidecar {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            quitting: Arc::new(AtomicBool::new(false)),
        }
    }

    fn set(&self, child: Child) {
        let mut slot = self.child.lock().unwrap_or_else(|error| error.into_inner());
        if self.quitting.load(Ordering::SeqCst) {
            // The app is already on its way out; do not leave an orphan behind.
            drop(slot);
            terminate(child);
            return;
        }
        *slot = Some(child);
    }

    fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn kill(&self) {
        let mut slot = self.child.lock().unwrap_or_else(|error| error.into_inner());
        self.quitting.store(true, Ordering::SeqCst);
        if let Some(child) = slot.take() {
            drop(slot);
            terminate(child);
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

fn terminate(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// A route (`#/session/<id>`) requested by a deep link, plus whether the window
/// is in a state to receive one.
#[derive(Default)]
struct RouteState {
    /// Set once the window has finished loading the UI at least once. Before
    /// that, an `eval` is silently dropped by the webview, so routes must wait.
    ready: bool,
    /// A route that arrived before that; only the most recent one matters.
    pending: Option<String>,
}

/// Where deep links hand their route over to the UI.
#[derive(Default)]
struct Routes {
    inner: Mutex<RouteState>,
}

impl Routes {
    fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, RouteState> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Send a route to the window now, or park it until the webview is ready.
    fn deliver(&self, app: &AppHandle, route: String) {
        {
            let mut inner = self.lock();
            if !inner.ready {
                inner.pending = Some(route);
                return;
            }
        }
        match app.get_webview_window(WINDOW_LABEL) {
            Some(window) => navigate(&window, &route),
            // Only possible if the window was closed after it had loaded; there
            // is nothing left to navigate.
            None => eprintln!("session-recall: no window for deep link route {route}"),
        }
    }

    /// The UI finished loading: hand over whatever arrived while it could not.
    fn flush(&self, window: &WebviewWindow) {
        let pending = {
            let mut inner = self.lock();
            inner.ready = true;
            inner.pending.take()
        };
        if let Some(route) = pending {
            eprintln!("session-recall: applying the queued route {route}");
            navigate(window, &route);
        }
    }
}

/// The hash route a `sessionrecall://` URL addresses, if it addresses one.
///
/// `sessionrecall://session/<id>` becomes `#/session/<id>`: the section is the
/// URL host, the id its one path segment, still percent-encoded so the app's
/// router decodes it exactly once. A session link may also carry
/// `?turn=<n>` (as MCP search results do); the turn is forwarded into the hash
/// query, where the UI scrolls to that turn. A search that produced the link
/// may also pass `?q=<terms>`; it travels with the route so a cold start can
/// highlight the hit and offer a way back to the results. A non-numeric turn is
/// dropped, and the app opens the session at the top. Anything else — a foreign
/// scheme, an unknown section, a missing or nested id — is refused rather than
/// guessed at.
fn route_for(url: &Url) -> Option<String> {
    if url.scheme() != DEEP_LINK_SCHEME {
        return None;
    }
    let section = url.host_str()?.to_ascii_lowercase();
    if !DEEP_LINK_SECTIONS.contains(&section.as_str()) {
        return None;
    }
    let id = url.path().trim_start_matches('/');
    if id.is_empty() || id.contains('/') {
        return None;
    }
    let mut route = format!("#/{section}/{id}");
    if section == "session" {
        let mut params: Vec<String> = Vec::new();
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "turn" if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) => {
                    params.push(format!("turn={value}"));
                }
                "q" if !value.is_empty() => {
                    params.push(format!("q={}", encode_component(&value)));
                }
                _ => {}
            }
        }
        if !params.is_empty() {
            route.push('?');
            route.push_str(&params.join("&"));
        }
    }
    Some(route)
}

/// `encodeURIComponent`-equivalent percent-encoding.
///
/// The webview decodes the forwarded `q` with `decodeURIComponent`, so keep
/// exactly that unreserved set and escape everything else — including `&` and
/// `=`, which would otherwise split the hash query.
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = char::from(*byte);
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(ch);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

/// Drive the UI to `route` and bring the window forward.
///
/// The window renders the sidecar's page, not a Tauri document, so this is a
/// plain `location.hash` assignment: the app's own `hashchange` handler does the
/// routing, exactly as it does for a link clicked inside the app.
fn navigate(window: &WebviewWindow, route: &str) {
    let script = format!(
        "location.hash = {};",
        serde_json::to_string(route).unwrap_or_else(|_| "\"#/search\"".into())
    );
    if let Err(error) = window.eval(script) {
        eprintln!("session-recall: could not route to {route}: {error}");
        return;
    }
    // The link came from outside, so the window may be hidden or behind
    // something else; the click should end with this session on screen.
    let _ = window.unminimize();
    let _ = window.show();
    if let Err(error) = window.set_focus() {
        eprintln!("session-recall: could not focus the window: {error}");
    }
}

/// The directory the sidecar calls `APP_DIR` (see `src/config.ts`).
///
/// The shell and the sidecar are separate processes sharing `prefs.json` and
/// the hotkey state file, so both derive the path the same way —
/// `SESSION_RECALL_HOME` first, then the macOS Application Support location.
fn app_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("SESSION_RECALL_HOME") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(
        home.join("Library")
            .join("Application Support")
            .join("session-recall"),
    )
}

/// Parse `Option+Command+R` into a shortcut that can be registered.
///
/// Only what `isHotkey` in `src/prefs.ts` accepts gets through, so a preference
/// the UI stores is never rejected here: at least one of Option/Alt, Command,
/// Ctrl/Control and Shift — each at most once, all of them before the key — and
/// one key out of `A`–`Z`, `0`–`9` or `F1`–`F12`. The string is rebuilt in a
/// canonical order before the plugin's own parser sees it, so a spelling the
/// plugin does not know (such as `Opt`) cannot slip through.
fn parse_hotkey_spec(spec: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut key: Option<String> = None;
    for raw in spec.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return None;
        }
        let upper = token.to_ascii_uppercase();
        let modifier = match upper.as_str() {
            "OPTION" | "ALT" => Some(Modifiers::ALT),
            "COMMAND" | "CMD" => Some(Modifiers::SUPER),
            "CONTROL" | "CTRL" => Some(Modifiers::CONTROL),
            "SHIFT" => Some(Modifiers::SHIFT),
            _ => None,
        };
        match modifier {
            Some(bit) => {
                // `Option+Alt` is one modifier written twice, not two modifiers.
                if key.is_some() || mods.contains(bit) {
                    return None;
                }
                mods |= bit;
            }
            None => {
                if key.is_some() || !is_key_token(&upper) {
                    return None;
                }
                key = Some(upper);
            }
        }
    }
    if mods.is_empty() {
        return None;
    }
    let mut names: Vec<&str> = Vec::new();
    if mods.contains(Modifiers::CONTROL) {
        names.push("Control");
    }
    if mods.contains(Modifiers::ALT) {
        names.push("Alt");
    }
    if mods.contains(Modifiers::SUPER) {
        names.push("Super");
    }
    if mods.contains(Modifiers::SHIFT) {
        names.push("Shift");
    }
    format!("{}+{}", names.join("+"), key?).parse().ok()
}

/// One key of a hotkey, in the narrow set a preference may name.
fn is_key_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.len() == 1 {
        return bytes[0].is_ascii_uppercase() || bytes[0].is_ascii_digit();
    }
    match token.strip_prefix('F') {
        Some(number) => number
            .parse::<u8>()
            .map(|n| (1..=12).contains(&n))
            .unwrap_or(false),
        None => false,
    }
}

/// The stored preference, reduced to "register this" or "disabled".
///
/// Mirrors `effectiveHotkey` in `src/prefs.ts`: absent or unusable means the
/// default, `null` means the user turned the shortcut off.
fn prefs_hotkey() -> Option<String> {
    let Some(text) = app_dir()
        .map(|dir| dir.join("prefs.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
    else {
        return Some(DEFAULT_HOTKEY.to_string());
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Some(DEFAULT_HOTKEY.to_string());
    };
    match value.get("hotkey") {
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(spec)) => {
            let spec = spec.trim();
            if parse_hotkey_spec(spec).is_some() {
                Some(spec.to_string())
            } else {
                eprintln!(
                    "session-recall: prefs.json has an unusable hotkey {spec:?}; using {DEFAULT_HOTKEY}"
                );
                Some(DEFAULT_HOTKEY.to_string())
            }
        }
        _ => Some(DEFAULT_HOTKEY.to_string()),
    }
}

/// The shortcut this launch should register: the environment first, then the
/// preference, then [`DEFAULT_HOTKEY`]. `None` means "do not register one".
fn effective_hotkey() -> Option<String> {
    if let Some(raw) = std::env::var_os(HOTKEY_ENV) {
        let raw = raw.to_string_lossy().trim().to_string();
        if DISABLED_HOTKEY_VALUES.contains(&raw.to_ascii_lowercase().as_str()) {
            return None;
        }
        if parse_hotkey_spec(&raw).is_some() {
            return Some(raw);
        }
        eprintln!("session-recall: {HOTKEY_ENV}={raw:?} is not a usable shortcut; ignoring it");
    }
    prefs_hotkey()
}

/// Publish what this launch did with the shortcut, for `GET /api/hotkey`.
///
/// Written before the sidecar starts, so the endpoint can never observe a
/// half-initialised state. The port identifies the launch: the packaged app
/// reserves a new one every time, so a stale file is recognisable. Best effort
/// throughout — a state file that cannot be written must not stop the boot.
fn record_hotkey_state(port: u16, hotkey: Option<&str>, registered: bool, error: Option<&str>) {
    let Some(dir) = app_dir() else {
        eprintln!("session-recall: HOME is unset; nowhere to record the hotkey state");
        return;
    };
    if let Err(failure) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "session-recall: could not create {}: {failure}",
            dir.display()
        );
        return;
    }
    let state = serde_json::json!({
        "hotkey": hotkey,
        "registered": registered,
        "error": error,
        "port": port,
    });
    let target = dir.join(HOTKEY_STATE_FILE);
    let temp = dir.join(format!("{HOTKEY_STATE_FILE}.{}.tmp", std::process::id()));
    let write =
        std::fs::write(&temp, format!("{state}\n")).and_then(|()| std::fs::rename(&temp, &target));
    if let Err(failure) = write {
        let _ = std::fs::remove_file(&temp);
        eprintln!(
            "session-recall: could not write {}: {failure}",
            target.display()
        );
    }
}

/// Show and focus the window, or hide it when it is already the front window.
///
/// A press that arrives before the window exists is ignored: `bootstrap` opens
/// it as soon as the server listens, so the window is never more than a second
/// away and there is nothing to summon yet.
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        eprintln!("session-recall: the hotkey fired before the window existed; ignoring it");
        return;
    };
    let focused = window.is_focused().unwrap_or(false);
    let visible = window.is_visible().unwrap_or(true);
    if visible && focused {
        if let Err(error) = window.hide() {
            eprintln!("session-recall: could not hide the window: {error}");
        }
        return;
    }
    let _ = window.unminimize();
    if let Err(error) = window.show() {
        eprintln!("session-recall: could not show the window: {error}");
        return;
    }
    if let Err(error) = window.set_focus() {
        eprintln!("session-recall: could not focus the window: {error}");
    }
}

/// Register the summon shortcut, once per launch.
///
/// A `hotkey` written while the app runs therefore needs a restart to take
/// effect (live re-registration is out of scope for 1.6.0); `/api/hotkey`
/// reports that gap instead of pretending the new key works. Registration
/// failures are never fatal — the window still opens, the reason is logged, and
/// the same sentence is served to the UI.
fn register_hotkey(app: &AppHandle, port: u16) {
    let Some(spec) = effective_hotkey() else {
        eprintln!("session-recall: the global shortcut is disabled");
        record_hotkey_state(port, None, false, None);
        return;
    };
    let Some(shortcut) = parse_hotkey_spec(&spec) else {
        // `effective_hotkey` already vetted the string, so this cannot happen
        // from a file; it keeps the two validators honest if they ever drift.
        let error = format!("could not parse the shortcut {spec}");
        eprintln!("session-recall: {error}");
        record_hotkey_state(port, Some(&spec), false, Some(&error));
        return;
    };
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            // Only the press matters; the release would hide it straight again.
            if event.state == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        });
    match result {
        Ok(()) => {
            eprintln!("session-recall: {spec} summons the window");
            record_hotkey_state(port, Some(&spec), true, None);
        }
        Err(error) => {
            let message = format!("could not register {spec}: {error}. {HOTKEY_FAILURE_HINT}");
            eprintln!("session-recall: {message}");
            record_hotkey_state(port, Some(&spec), false, Some(&message));
        }
    }
}

/// Reserve an ephemeral loopback port by binding and immediately releasing it.
fn free_port() -> Option<u16> {
    for _ in 0..8 {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else {
            continue;
        };
        let port = listener.local_addr().ok().map(|addr| addr.port());
        drop(listener);
        if let Some(port) = port {
            return Some(port);
        }
    }
    None
}

/// Locate the `session-recall` sidecar executable.
///
/// Order: explicit override, then a `session-recall*` file sitting next to the
/// main executable (where `bundle.externalBin` puts it), then the repo-local
/// `binaries/` directory used by `cargo tauri dev`.
fn sidecar_path() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("SESSION_RECALL_SIDECAR") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
        eprintln!(
            "session-recall: SESSION_RECALL_SIDECAR={} is not a file, ignoring it",
            path.display()
        );
    }

    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    // Bundled layout: Contents/MacOS/{Session Recall, session-recall[-<triple>]}.
    if let Some(found) = find_sidecar(dir, Some(&exe)) {
        return Some(found);
    }

    // Dev layout: target/<profile>/ up to the repo's src-tauri/binaries/.
    let mut cursor = Some(dir);
    for _ in 0..6 {
        let Some(current) = cursor else { break };
        for candidate in [
            current.join("binaries"),
            current.join("src-tauri").join("binaries"),
        ] {
            if let Some(found) = find_sidecar(&candidate, None) {
                return Some(found);
            }
        }
        cursor = current.parent();
    }
    None
}

/// Best sidecar candidate in `dir`, ignoring `exclude`.
///
/// Prefers the exact bundled name `session-recall` (verified: Tauri strips the
/// target-triple suffix at bundle time) and only then accepts a suffixed copy
/// such as `session-recall-aarch64-apple-darwin`. `exclude` keeps the main
/// executable — which is named `session-recall-app` — from ever being mistaken
/// for the sidecar.
fn find_sidecar(dir: &Path, exclude: Option<&Path>) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut exact: Option<PathBuf> = None;
    let mut suffixed: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if exclude.is_some_and(|excluded| path == excluded) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name == "session-recall" {
            exact = Some(path);
        } else if name.starts_with("session-recall") && suffixed.is_none() {
            suffixed = Some(path);
        }
    }
    exact.or(suffixed)
}

/// Locate the bundled `web/dist` resources, i.e. the UI the sidecar serves.
///
/// Tauri's `resource_dir()` is the primary source, but it fails with
/// "unknown path" when `Contents/MacOS/<exe>` is executed directly from a
/// terminal instead of through LaunchServices — and a missing resource dir
/// means the sidecar cannot serve the UI at all (it answers 503). So fall back
/// to the standard macOS bundle layout derived from the executable path, and
/// only accept a directory that really contains the UI.
fn web_dist_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    match app.path().resource_dir() {
        Ok(dir) => candidates.push(dir.join("web").join("dist")),
        Err(error) => eprintln!(
            "session-recall: resource_dir() unavailable ({error}); falling back to the bundle layout"
        ),
    }

    if let Ok(exe) = std::env::current_exe() {
        // <bundle>.app/Contents/MacOS/<exe> -> <bundle>.app/Contents/Resources
        if let Some(contents) = exe.parent().and_then(Path::parent) {
            candidates.push(contents.join("Resources").join("web").join("dist"));
        }
    }

    match candidates
        .into_iter()
        .find(|dir| dir.join("index.html").is_file())
    {
        Some(dir) => Some(dir),
        None => {
            eprintln!(
                "session-recall: no web/dist resources found; the window will not render the UI"
            );
            None
        }
    }
}

/// Poll the port until it accepts a connection. Returns false on timeout or if
/// the sidecar died before it came up.
fn wait_for_port(port: u16, state: &Sidecar) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
        if state.quitting() {
            return false;
        }
        if sidecar_exited(state) {
            eprintln!("session-recall: the sidecar exited before it started serving");
            return false;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(READY_INTERVAL);
    }
}

fn sidecar_exited(state: &Sidecar) -> bool {
    let Ok(mut slot) = state.child.lock() else {
        return false;
    };
    let Some(child) = slot.as_mut() else {
        return false;
    };
    matches!(child.try_wait(), Ok(Some(_)))
}

/// Start the sidecar, wait for readiness, then open the window.
///
/// Runs on a worker thread so the event loop keeps turning (and Cmd+Q keeps
/// working) during the wait.
fn bootstrap(app: AppHandle) {
    let state = app.state::<Sidecar>();

    let port = match free_port() {
        Some(port) => port,
        None => {
            eprintln!(
                "session-recall: no free loopback port available, falling back to {FALLBACK_PORT}"
            );
            FALLBACK_PORT
        }
    };

    // Before the sidecar exists: `GET /api/hotkey` then reports a settled state
    // from its very first request.
    register_hotkey(&app, port);

    let web_dist = web_dist_dir(&app);

    let Some(sidecar) = sidecar_path() else {
        eprintln!(
            "session-recall: sidecar not found. Looked in $SESSION_RECALL_SIDECAR, next to {}, and src-tauri/binaries/. Run `bash scripts/make-app.sh` first.",
            std::env::current_exe()
                .map(|exe| exe.display().to_string())
                .unwrap_or_else(|_| "<unknown>".into())
        );
        // Still open the window so the failure is visible instead of a silent hang.
        open_window(&app, port);
        return;
    };

    eprintln!(
        "session-recall: sidecar {} on http://127.0.0.1:{port}",
        sidecar.display()
    );

    let mut command = Command::new(&sidecar);
    command
        .env("SESSION_RECALL_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    match &web_dist {
        Some(dir) => {
            command.env("SESSION_RECALL_WEB_DIST", dir);
        }
        None => eprintln!(
            "session-recall: no resource dir; the sidecar will fall back to its own web/dist"
        ),
    }

    match command.spawn() {
        Ok(child) => state.set(child),
        Err(error) => {
            eprintln!(
                "session-recall: failed to start {}: {error}",
                sidecar.display()
            );
            open_window(&app, port);
            return;
        }
    }

    if state.quitting() {
        return;
    }

    if wait_for_port(port, state.inner()) {
        eprintln!("session-recall: ready on http://127.0.0.1:{port}");
    } else if state.quitting() {
        return;
    } else {
        eprintln!(
            "session-recall: the sidecar did not answer within {}s; opening the window anyway",
            READY_TIMEOUT.as_secs()
        );
    }

    open_window(&app, port);
}

fn open_window(app: &AppHandle, port: u16) {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return;
    }
    let url = match tauri::Url::parse(&format!("http://127.0.0.1:{port}/")) {
        Ok(url) => url,
        Err(error) => {
            eprintln!("session-recall: invalid window url: {error}");
            return;
        }
    };
    let result = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title(WINDOW_TITLE)
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .on_page_load(|window, payload| {
            // A deep link that raced the webview is parked in `Routes`; this is
            // the moment it can finally be applied.
            if let PageLoadEvent::Finished = payload.event() {
                window.app_handle().state::<Routes>().flush(&window);
            }
        })
        .build();
    match result {
        Ok(window) => {
            // Closing must not destroy the only window: the global shortcut has
            // nothing to summon afterwards, and the window is built here rather
            // than declared in `tauri.conf.json`, so it would not come back.
            // Hiding keeps the app and its sidecar running, like a tray app.
            // A quit is allowed through, or Cmd+Q would only hide the window.
            let handle = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let quitting = handle
                        .try_state::<Sidecar>()
                        .is_some_and(|state| state.quitting());
                    if !quitting {
                        api.prevent_close();
                        if let Err(error) = handle.hide() {
                            eprintln!("session-recall: could not hide the window: {error}");
                        }
                    }
                }
            });
        }
        Err(error) => eprintln!("session-recall: failed to create the window: {error}"),
    }
}

/// Answer `sessionrecall://` links, however they arrive.
///
/// A link can reach us three ways, and all three end in `Routes::deliver`:
///
/// 1. the app is not running: LaunchServices launches it and hands the URL over
///    as it starts, before `setup` — `get_current` picks that one up;
/// 2. the app is running: macOS sends the URL to the running instance, which the
///    plugin reports as an open-url event;
/// 3. it arrives before the webview has loaded — `Routes` holds it until the
///    window reports its first finished page load.
fn register_deep_links(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            match route_for(&url) {
                Some(route) => {
                    eprintln!("session-recall: deep link {url} -> {route}");
                    handle.state::<Routes>().deliver(&handle, route);
                }
                None => eprintln!("session-recall: ignoring deep link {url}"),
            }
        }
    });

    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                match route_for(&url) {
                    Some(route) => {
                        eprintln!("session-recall: launched with {url} -> {route}");
                        app.state::<Routes>().deliver(app, route);
                    }
                    None => eprintln!("session-recall: ignoring launch url {url}"),
                }
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("session-recall: could not read the launch url: {error}"),
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        // No shortcut is configured on the plugin itself: `register_hotkey`
        // registers the one prefs ask for, and attaches its handler there.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            app.manage(Sidecar::new());
            app.manage(Routes::new());
            // No window is declared in tauri.conf.json, and without a menu the
            // standard macOS shortcuts (Cmd+Q, Cmd+W) would not exist.
            match Menu::default(app.handle()) {
                Ok(menu) => {
                    if let Err(error) = app.set_menu(menu) {
                        eprintln!("session-recall: could not install the default menu: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("session-recall: could not build the default menu: {error}")
                }
            }
            register_deep_links(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || bootstrap(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Session Recall shell");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<Sidecar>() {
                state.kill();
            }
        }
        // A hidden window is still "the app", so clicking the dock icon has to
        // bring it back — otherwise hiding it would look like a crash.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            if !has_visible_windows {
                if let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{is_key_token, parse_hotkey_spec, route_for};
    use tauri::Url;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    fn route(link: &str) -> Option<String> {
        route_for(&Url::parse(link).expect("valid deep link"))
    }

    #[test]
    fn forwards_a_session_turn_into_the_hash_route() {
        assert_eq!(
            route("sessionrecall://session/omp%3Aabc?turn=3").as_deref(),
            Some("#/session/omp%3Aabc?turn=3")
        );
        assert_eq!(
            route("sessionrecall://session/omp%3Aabc?turn=0").as_deref(),
            Some("#/session/omp%3Aabc?turn=0")
        );
    }

    #[test]
    fn drops_a_turn_that_is_not_a_turn_index() {
        for bad in ["abc", "-1", "1.5", ""] {
            let link = format!("sessionrecall://session/omp%3Aabc?turn={bad}");
            assert_eq!(
                route(&link).as_deref(),
                Some("#/session/omp%3Aabc"),
                "turn={bad}"
            );
        }
    }

    #[test]
    fn forwards_a_session_search_query_into_the_hash_route() {
        assert_eq!(
            route("sessionrecall://session/omp%3Aabc?turn=3&q=rust%20mutex").as_deref(),
            Some("#/session/omp%3Aabc?turn=3&q=rust%20mutex")
        );
        assert_eq!(
            route("sessionrecall://session/omp%3Aabc?q=deep%20link").as_deref(),
            Some("#/session/omp%3Aabc?q=deep%20link")
        );
    }

    #[test]
    fn escapes_reserved_characters_in_the_search_query() {
        assert_eq!(
            route("sessionrecall://session/omp%3Aabc?q=a%26b%3Dc%23d").as_deref(),
            Some("#/session/omp%3Aabc?q=a%26b%3Dc%23d")
        );
    }

    #[test]
    fn without_a_query_the_route_is_unchanged() {
        assert_eq!(
            route("sessionrecall://session/omp%3Aabc").as_deref(),
            Some("#/session/omp%3Aabc")
        );
    }

    #[test]
    fn briefs_never_carry_a_turn() {
        assert_eq!(
            route("sessionrecall://brief/2026-11-10?turn=2").as_deref(),
            Some("#/brief/2026-11-10")
        );
    }

    #[test]
    fn parses_the_default_shortcut() {
        let shortcut = parse_hotkey_spec("Option+Command+R").expect("the default hotkey parses");
        assert_eq!(shortcut.mods, Modifiers::ALT | Modifiers::SUPER);
        assert_eq!(shortcut.key, Code::KeyR);
    }

    #[test]
    fn accepts_aliases_case_and_any_modifier_order() {
        for spec in [
            "option+command+r",
            "Command+Option+R",
            "Option+Cmd+R",
            "Alt+Command+R",
            "  Option + Command + R  ",
        ] {
            let shortcut = parse_hotkey_spec(spec).unwrap_or_else(|| panic!("{spec} should parse"));
            assert_eq!(
                shortcut.mods,
                Modifiers::ALT | Modifiers::SUPER,
                "modifiers of {spec}"
            );
            assert_eq!(shortcut.key, Code::KeyR, "key of {spec}");
        }

        let digits = parse_hotkey_spec("Shift+Ctrl+1").expect("a digit key parses");
        assert_eq!(digits.mods, Modifiers::SHIFT | Modifiers::CONTROL);
        assert_eq!(digits.key, Code::Digit1);

        let f_key = parse_hotkey_spec("Control+Alt+F12").expect("an F-key parses");
        assert_eq!(f_key.key, Code::F12);
    }

    #[test]
    fn rejects_shortcuts_the_prefs_validator_rejects() {
        for spec in [
            "",
            "R",      // a bare key would be grabbed system-wide
            "Option", // a modifier with no key
            "Option+",
            "Option++R",
            "Option+R+Shift",     // modifiers come first
            "Option+Alt+R",       // the same modifier twice
            "Super+R",            // not one of the four accepted names
            "Option+Command+Rr",  // not a key
            "Option+Command+F13", // only F1–F12
            "Option+Command+F0",
            "Option+Command+Return",
        ] {
            assert!(
                parse_hotkey_spec(spec).is_none(),
                "{spec:?} should be refused"
            );
        }
    }

    #[test]
    fn accepts_only_letter_digit_and_function_key_tokens() {
        for token in ["A", "Z", "0", "9", "F", "F1", "F9", "F12"] {
            assert!(is_key_token(token), "{token} should be a key");
        }
        for token in ["", "F0", "F13", "F99", "AB", "RETURN", "?", "SPACE"] {
            assert!(!is_key_token(token), "{token} should not be a key");
        }
    }
}
