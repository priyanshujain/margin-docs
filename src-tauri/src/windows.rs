// Every window the app has open and what each one holds: nothing yet, a folder, or one Markdown
// document opened on its own. Rust is the only place that sees all of them at once, so this module
// decides which window a file opens in, which paths a window may touch, which window a menu item
// talks to, and when the app is allowed to quit.
//
// A document is owned by at most one window, keyed by its canonical path, so the same file reached
// through a symlink, a second Finder double click or a sidebar row in another window focuses the
// window already editing it instead of opening a second buffer that would race it to the disk.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow, WebviewWindowBuilder};

use crate::dto::WindowRequest;
use crate::Roots;

/// The window tauri.conf.json creates at launch.
pub const MAIN: &str = "main";

/// Every other window is `window-<n>`, which is what the capabilities match on.
const LABEL_PREFIX: &str = "window-";

/// Mirrors `WINDOW_REQUEST_EVENT` in src/ipc.ts.
const REQUEST_EVENT: &str = "window-request";

/// Mirrors `MENU_ACTION_EVENT` in src/ipc.ts.
const MENU_EVENT: &str = "menu-action";

/// How far a new window is offset from the one it was opened from, so it does not land exactly on
/// top of it.
const CASCADE: f64 = 24.0;

/// Menu actions worth opening a window for when none is open. The rest act on a document or a
/// folder, and a fresh empty window has neither.
const OPENS_A_WINDOW: [&str; 5] = [
    "open-folder",
    "command-palette",
    "settings",
    "check-updates",
    "report-issue",
];

#[derive(Default)]
struct Record {
    /// The frontend has asked for its request, so a later one goes out as an event.
    ready: bool,
    /// Has held a folder or a document. Only an unused main window is reused for a file.
    used: bool,
    pending: Option<WindowRequest>,
    /// The document a standalone window was opened for. Its parent is never opened as a folder.
    standalone: Option<PathBuf>,
    roots: Vec<String>,
    documents: HashSet<PathBuf>,
}

#[derive(Default)]
struct Inner {
    records: HashMap<String, Record>,
    next: u32,
    focused: Option<String>,
    quitting: bool,
    /// Setup has run and the main window exists.
    started: bool,
    /// Files macOS handed over before that, which it does for the files that launched the app.
    early: Vec<PathBuf>,
}

impl Inner {
    fn record(&mut self, label: &str) -> &mut Record {
        self.records.entry(label.to_string()).or_default()
    }

    fn owner_of(&self, path: &Path) -> Option<String> {
        self.records
            .iter()
            .find(|(_, record)| record.documents.contains(path))
            .map(|(label, _)| label.clone())
    }

    fn new_label(&mut self) -> String {
        loop {
            self.next += 1;
            let label = format!("{LABEL_PREFIX}{}", self.next);
            if !self.records.contains_key(&label) {
                return label;
            }
        }
    }
}

#[derive(Default)]
pub struct Windows(Mutex<Inner>);

/// What a command is about to do with a path, which decides how far past a window's own folders
/// it may reach.
pub enum Access {
    /// Creating, moving, duplicating or trashing: the window's folders and nothing else.
    Folder,
    /// Reading and writing a document: its folders, plus the standalone document itself.
    Document,
    /// Looking without writing, which is what a relative image needs: also the folder a standalone
    /// document sits in.
    Nearby,
}

impl Windows {
    fn lock(&self) -> Result<MutexGuard<'_, Inner>, String> {
        self.0.lock().map_err(|e| e.to_string())
    }

    pub fn add_root(&self, label: &str, id: &str) -> Result<(), String> {
        let mut inner = self.lock()?;
        let record = inner.record(label);
        record.used = true;
        if !record.roots.iter().any(|root| root == id) {
            record.roots.push(id.to_string());
        }
        Ok(())
    }

    /// Lets one window go of a folder, and answers whether any window still has it open.
    pub fn remove_root(&self, label: &str, id: &str) -> Result<bool, String> {
        let mut inner = self.lock()?;
        inner.record(label).roots.retain(|root| root != id);
        Ok(open_anywhere(&inner, id))
    }

    pub fn open_elsewhere(&self, label: &str, id: &str) -> Result<bool, String> {
        let inner = self.lock()?;
        Ok(inner
            .records
            .iter()
            .any(|(other, record)| other != label && record.roots.iter().any(|root| root == id)))
    }

    pub fn owns_root(&self, label: &str, id: &str) -> Result<bool, String> {
        let inner = self.lock()?;
        Ok(inner
            .records
            .get(label)
            .is_some_and(|record| record.roots.iter().any(|root| root == id)))
    }

    pub fn roots_of(&self, label: &str) -> Result<Vec<String>, String> {
        let inner = self.lock()?;
        Ok(inner
            .records
            .get(label)
            .map(|record| record.roots.clone())
            .unwrap_or_default())
    }

    /// The paths a window may reach for `access`. The locks are taken one after the other and never
    /// together, so nothing here can deadlock against a command holding `Roots`.
    pub fn allowed(&self, roots: &Roots, label: &str, access: Access) -> Result<Vec<String>, String> {
        let (ids, standalone) = {
            let inner = self.lock()?;
            match inner.records.get(label) {
                Some(record) => (record.roots.clone(), record.standalone.clone()),
                None => (Vec::new(), None),
            }
        };
        let mut paths = roots.paths_for(&ids)?;
        if let Some(document) = standalone {
            match access {
                Access::Folder => {}
                Access::Document => paths.push(path_string(&document)),
                Access::Nearby => {
                    if let Some(parent) = document.parent() {
                        paths.push(path_string(parent));
                    }
                }
            }
        }
        Ok(paths)
    }

    /// Follows a document this window renamed. True when it was the window's standalone document,
    /// whose watcher has to follow it too.
    pub fn document_moved(&self, label: &str, from: &Path, to: &Path) -> Result<bool, String> {
        let mut inner = self.lock()?;
        let record = inner.record(label);
        if record.documents.remove(from) {
            record.documents.insert(to.to_path_buf());
        }
        if record.standalone.as_deref() == Some(from) {
            record.standalone = Some(to.to_path_buf());
            return Ok(true);
        }
        Ok(false)
    }
}

fn open_anywhere(inner: &Inner, id: &str) -> bool {
    inner
        .records
        .values()
        .any(|record| record.roots.iter().any(|root| root == id))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The key a document is owned by. A path that no longer resolves, a file deleted under the window
/// that still holds it, is kept as it was spelled.
fn canonical(raw: &str) -> PathBuf {
    std::fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw))
}

fn state(app: &AppHandle) -> State<'_, Windows> {
    app.state::<Windows>()
}

pub fn focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The window the user is looking at: the focused one, or the last one that was.
fn current(app: &AppHandle) -> Option<String> {
    let windows = app.webview_windows();
    if let Some((label, _)) = windows
        .iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
    {
        return Some(label.clone());
    }
    let last = state(app).lock().ok()?.focused.clone()?;
    windows.contains_key(&last).then_some(last)
}

fn cascade(app: &AppHandle) -> Option<(f64, f64)> {
    let window = app.get_webview_window(&current(app)?)?;
    let scale = window.scale_factor().ok()?;
    let at = window.outer_position().ok()?.to_logical::<f64>(scale);
    Some((at.x + CASCADE, at.y + CASCADE))
}

fn build(app: &AppHandle, label: &str) -> Result<(), String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "no window configuration".to_string())?;
    config.label = label.to_string();
    let mut builder = WebviewWindowBuilder::from_config(app, &config).map_err(|e| e.to_string())?;
    if let Some((x, y)) = cascade(app) {
        builder = builder.position(x, y);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::titlebar::install(&window);
    let _ = window.set_focus();
    Ok(())
}

/// A new window, handed `request` once its page asks for it.
pub fn create_window(app: &AppHandle, request: WindowRequest) -> Result<String, String> {
    let label = {
        let windows = state(app);
        let mut inner = windows.lock()?;
        let label = inner.new_label();
        let record = inner.record(&label);
        record.used = request.document.is_some();
        if let Some(document) = &request.document {
            let path = PathBuf::from(document);
            record.documents.insert(path.clone());
            record.standalone = Some(path);
        }
        record.pending = Some(request);
        label
    };
    if let Err(e) = build(app, &label) {
        if let Ok(mut inner) = state(app).lock() {
            inner.records.remove(&label);
        }
        return Err(e);
    }
    Ok(label)
}

/// Opens a Markdown file in a window of its own, or focuses the window that already has it.
///
/// Finder, the Dock, `mdocs` and a link followed out of a document all arrive here. The first file
/// after launch goes into the empty window the app started with; every other one gets a new window.
pub fn open_document(app: &AppHandle, raw: &Path) -> Result<(), String> {
    let path = std::fs::canonicalize(raw).map_err(|e| format!("{}: {e}", raw.display()))?;
    if !path.is_file() || crate::fs::kind_for(&path, false) != "markdown" {
        return Err(format!("not a Markdown file: {}", path.display()));
    }
    let request = WindowRequest {
        document: Some(path_string(&path)),
        ..Default::default()
    };

    enum Target {
        Owner(String),
        Main { ready: bool },
        New,
    }
    let target = {
        let windows = state(app);
        let mut inner = windows.lock()?;
        if let Some(owner) = inner.owner_of(&path) {
            Target::Owner(owner)
        } else if app.get_webview_window(MAIN).is_some()
            && inner.records.get(MAIN).is_some_and(|record| !record.used)
        {
            let record = inner.record(MAIN);
            record.used = true;
            record.standalone = Some(path.clone());
            record.documents.insert(path.clone());
            if !record.ready {
                record.pending = Some(request.clone());
            }
            Target::Main {
                ready: record.ready,
            }
        } else {
            Target::New
        }
    };

    match target {
        Target::Owner(label) => focus(app, &label),
        Target::Main { ready } => {
            crate::watch::watch_document(app, MAIN, &path);
            if ready {
                app.emit_to(EventTarget::webview_window(MAIN), REQUEST_EVENT, &request)
                    .map_err(|e| e.to_string())?;
            }
            focus(app, MAIN);
        }
        Target::New => {
            let label = create_window(app, request)?;
            crate::watch::watch_document(app, &label, &path);
        }
    }
    Ok(())
}

/// Called from setup, once the main window exists, with anything that arrived before it did.
pub fn start(app: &AppHandle) {
    let early = {
        let windows = state(app);
        let Ok(mut inner) = windows.lock() else {
            return;
        };
        inner.record(MAIN);
        inner.started = true;
        std::mem::take(&mut inner.early)
    };
    open_urls(app, early);
}

pub fn open_urls(app: &AppHandle, paths: Vec<PathBuf>) {
    {
        let windows = state(app);
        let Ok(mut inner) = windows.lock() else {
            return;
        };
        if !inner.started {
            inner.early.extend(paths);
            return;
        }
    }
    for path in paths {
        if let Err(e) = open_document(app, &path) {
            eprintln!("could not open {}: {e}", path.display());
        }
    }
}

/// A native menu item, sent to the window it was chosen in rather than to every window.
pub fn dispatch_menu(app: &AppHandle, id: &str) {
    match current(app) {
        Some(label) => {
            app.emit_to(EventTarget::webview_window(&label), MENU_EVENT, id)
                .ok();
        }
        None if OPENS_A_WINDOW.contains(&id) => {
            let request = WindowRequest {
                action: Some(id.to_string()),
                ..Default::default()
            };
            if let Err(e) = create_window(app, request) {
                eprintln!("could not open a window: {e}");
            }
        }
        None => {}
    }
}

pub fn focused(app: &AppHandle, label: &str) {
    if let Ok(mut inner) = state(app).lock() {
        inner.focused = Some(label.to_string());
    }
}

/// A window has gone. Its folders are let go of, and a folder no other window holds stops being
/// watched and indexed.
pub fn destroyed(app: &AppHandle, label: &str) {
    let released: Vec<String> = {
        let windows = state(app);
        let Ok(mut inner) = windows.lock() else {
            return;
        };
        if inner.focused.as_deref() == Some(label) {
            inner.focused = None;
        }
        let roots = inner
            .records
            .remove(label)
            .map(|record| record.roots)
            .unwrap_or_default();
        roots
            .into_iter()
            .filter(|id| !open_anywhere(&inner, id))
            .collect()
    };
    for id in released {
        crate::fs::drop_root(app, &id);
    }
    crate::watch::unwatch_document(app, label);
}

/// Closes every window the way the close button does, so each one saves what it has first. The app
/// exits once the last one is gone; a window whose save failed stays open and calls the quit off.
pub fn quit(app: &AppHandle) {
    if let Ok(mut inner) = state(app).lock() {
        inner.quitting = true;
    }
    let windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    for window in windows {
        let _ = window.close();
    }
}

pub fn quitting(app: &AppHandle) -> bool {
    state(app).lock().map(|inner| inner.quitting).unwrap_or(false)
}

/// The Dock icon clicked with nothing on screen.
pub fn reopen(app: &AppHandle, has_visible_windows: bool) {
    if has_visible_windows {
        return;
    }
    match current(app).or_else(|| app.webview_windows().into_keys().next()) {
        Some(label) => focus(app, &label),
        None => {
            if let Err(e) = create_window(app, WindowRequest::default()) {
                eprintln!("could not open a window: {e}");
            }
        }
    }
}

/// Asked once by each page as it loads, for whatever the window was opened to show.
///
/// A page that reloads asks again, and gets its standalone document back rather than an empty
/// window; the folders it had are released by the page itself through `roots_list`.
#[tauri::command]
pub fn window_init(
    window: WebviewWindow,
    windows: State<'_, Windows>,
) -> Result<Option<WindowRequest>, String> {
    let mut inner = windows.lock()?;
    let record = inner.record(window.label());
    record.ready = true;
    if let Some(request) = record.pending.take() {
        return Ok(Some(request));
    }
    record.documents.clear();
    Ok(record.standalone.clone().map(|path| {
        record.documents.insert(path.clone());
        WindowRequest {
            document: Some(path_string(&path)),
            ..Default::default()
        }
    }))
}

/// A new window opening `folder`, or an empty one.
#[tauri::command(async)]
pub fn window_create(app: AppHandle, folder: Option<String>) -> Result<(), String> {
    create_window(
        &app,
        WindowRequest {
            folder,
            ..Default::default()
        },
    )
    .map(|_| ())
}

/// Asked before a window opens a document in place. False means another window already has it,
/// and that window has been brought forward instead.
#[tauri::command]
pub fn document_claim(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, Windows>,
    path: String,
) -> Result<bool, String> {
    let key = canonical(&path);
    let label = window.label();
    let owner = {
        let mut inner = windows.lock()?;
        match inner.owner_of(&key) {
            Some(owner) if owner != label => Some(owner),
            _ => {
                let record = inner.record(label);
                record.used = true;
                record.documents.insert(key);
                None
            }
        }
    };
    match owner {
        Some(owner) => {
            focus(&app, &owner);
            Ok(false)
        }
        None => Ok(true),
    }
}

/// The document a window is showing now, or none. Every change to it in the frontend lands here.
#[tauri::command]
pub fn document_set(
    window: WebviewWindow,
    windows: State<'_, Windows>,
    path: Option<String>,
) -> Result<(), String> {
    let mut inner = windows.lock()?;
    let record = inner.record(window.label());
    record.documents.clear();
    if let Some(path) = path {
        record.documents.insert(canonical(&path));
    }
    Ok(())
}

/// A Markdown file opened in its own window, or the window that already has it focused.
#[tauri::command(async)]
pub fn document_open(app: AppHandle, path: String) -> Result<(), String> {
    open_document(&app, Path::new(&path))
}

/// A window kept itself open because its document could not be saved, which calls off a quit.
#[tauri::command]
pub fn window_close_refused(windows: State<'_, Windows>) -> Result<(), String> {
    windows.lock()?.quitting = false;
    Ok(())
}

/// Quit from the Dock, from the app menu and at logout all arrive as `terminate:`, which tao lets
/// straight through to process exit without asking any window first. This answers it instead: the
/// windows are closed one by one so each can save, and the app exits on its own once they are gone.
#[cfg(target_os = "macos")]
pub mod terminate {
    use std::sync::OnceLock;

    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// NSTerminateCancel. The quit carries on through `super::quit` rather than through AppKit.
    const CANCEL: usize = 0;

    extern "C-unwind" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        match APP.get() {
            Some(app) => {
                super::quit(app);
                CANCEL
            }
            None => 1,
        }
    }

    pub fn install(app: &AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        if APP.set(app.clone()).is_err() {
            return;
        }
        let ns_app = NSApplication::sharedApplication(mtm);
        let Some(delegate) = ns_app.delegate() else {
            return;
        };
        let object: &AnyObject = delegate.as_ref();
        let class = object.class();
        unsafe {
            let imp: Imp = std::mem::transmute(
                should_terminate as extern "C-unwind" fn(_, _, _) -> usize,
            );
            objc2::ffi::class_addMethod(
                class as *const _ as *mut _,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            );
        }
    }
}
