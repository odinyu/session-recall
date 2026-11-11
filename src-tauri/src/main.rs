// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri shell for Session Recall.
//!
//! The window is a thin wrapper: it points a `WKWebView` at
//! `http://127.0.0.1:<port>` served by the Bun sidecar that ships next to the
//! main executable. All indexing, search and asset serving stays in Bun, so the
//! Rust side owns exactly four responsibilities:
//!
//! 1. reserve a free loopback port,
//! 2. spawn + supervise the sidecar (and reap it on exit),
//! 3. open the window once the server is actually listening,
//! 4. answer `sessionrecall://` deep links — the one address that outlives the
//!    random port — by driving the UI's own hash router.

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

const WINDOW_LABEL: &str = "main";
const WINDOW_TITLE: &str = "Session Recall";
/// The scheme this bundle registers for itself; mirrors
/// `plugins.deep-link.desktop.schemes` in `tauri.conf.json` and the links
/// `src/brief.ts` emits.
const DEEP_LINK_SCHEME: &str = "sessionrecall";
/// Deep-linked sections that address a single record, i.e. `#/<section>/<id>`.
const DEEP_LINK_SECTIONS: [&str; 2] = ["session", "brief"];
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
/// router decodes it exactly once. Anything else — a foreign scheme, an unknown
/// section, a missing or nested id — is refused rather than guessed at.
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
    Some(format!("#/{section}/{id}"))
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
    if let Err(error) = result {
        eprintln!("session-recall: failed to create the window: {error}");
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
                Err(error) => eprintln!("session-recall: could not build the default menu: {error}"),
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
    });
}
