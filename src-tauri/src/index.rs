// The search index: one SQLite database, in the app data directory and never inside a folder the
// user opened, holding a row per document, an FTS5 copy of its text and every relative link it
// carries. It answers the three questions a file tree cannot: quick open by path, full text across
// every open root, and the backlinks at the end of a document.
//
// All of it is derived state. Every row is rebuilt from the files on disk, so the database can be
// deleted at any moment and costs nothing but the walk that builds it again. That is why a failure
// to open it is reported rather than fatal, why the schema guard below refuses rather than repairs,
// and why the indexer never writes anything into a user's folder: there is nothing in here worth
// saving and nothing in here that a folder should be made to carry.
//
// One worker thread owns every write. Indexing is asked for from four places that know nothing
// about each other, the rebuild command, opening a folder, the watcher and the app's own saves, and
// three of those are on threads that must not block: a debounce callback holds up the next batch of
// filesystem events while it runs, and a command holds the frontend's promise open. Handing the
// work to a channel keeps all of them cheap, and because a channel is ordered it also keeps a
// deletion that arrived after a creation from being applied before it.
//
// Reading a document to index it is a read and nothing else. The indexer touches far more files
// than the editor ever does, so the promise that opening a folder writes nothing into it matters
// more here than anywhere: no sidecar, no lock, no mtime bumped, nothing.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as Memory};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager};

use crate::dto::{Backlink, IndexStatus, MatchRange, QuickOpenHit, RootInfo, SearchHit, WatchEvent};
use crate::Roots;

/// Inside the app data directory, which is the only place this app writes anything of its own.
const DATABASE_FILE: &str = "index.sqlite3";

/// Mirrors `INDEX_PROGRESS_EVENT` in src/ipc.ts.
const INDEX_PROGRESS: &str = "index-progress";

/// The schema this build understands. A database found above it is refused rather than opened, in
/// `migrate` below.
const VERSION: i32 = 1;

/// The last completed pass, kept in `meta` so a relaunch does not report a fully built index as one
/// that has never run.
const LAST_INDEXED_KEY: &str = "last_indexed";

/// Documents written between two commits. Every write takes the connection lock, so this is also
/// how long a search can be kept waiting during a rebuild: small enough that nobody notices, large
/// enough that a pass is not one transaction per file.
const BATCH: usize = 64;

/// How often a pass says where it has got to. The event drives a status line, not a progress bar
/// anybody watches closely, and emitting per file would cost more than the indexing.
const PROGRESS_EVERY: u32 = 64;

/// Longest snippet handed to the frontend, and how much of it is spent on the text before the first
/// match, in characters.
const SNIPPET_MAX: usize = 200;
const SNIPPET_LEAD: usize = 40;

/// What `highlight()` wraps a match in. Control characters rather than anything typographic, since
/// the marks have to be found again in the text they were put into and a markdown file can contain
/// any printable string at all.
const MARK_START: char = '\u{2}';
const MARK_END: char = '\u{3}';

/// Terms in one full text query. A query is a text box's worth of words; anything past this is
/// somebody pasting a document into it, and every term is another subtree the matcher walks.
const MAX_TERMS: usize = 32;

/// Hits reported per document. A file can answer on several lines, which is what a find in files is
/// for, but one enormous file must not fill the whole list.
const HITS_PER_DOC: usize = 5;

/// One row per document, one FTS5 row holding its text, one row per relative link it carries.
///
/// `docs.path` is absolute and is the identity of a document: the rest of the row is derived from
/// it and is replaced wholesale whenever the file changes. `scanned_at` is what makes a pass able
/// to delete: every row touched by a pass carries that pass's stamp, so the rows left behind at the
/// end are exactly the files that are no longer there.
///
/// `docs_fts` is keyed by `docs.rowid` rather than by path. An FTS5 table has no index other than
/// its own inverted one, so deleting a row by anything but its rowid means scanning every document
/// in the database, which turns one rescan into quadratic work. Nothing in this app ever VACUUMs,
/// which is the one thing that would renumber those rowids, and the upsert below is written as
/// ON CONFLICT DO UPDATE rather than INSERT OR REPLACE precisely because a REPLACE deletes the row
/// and hands the new one a different rowid.
///
/// `links` records the href exactly as the file spells it and the absolute path it resolves to, so
/// backlinks are a lookup on `target_path` and nothing has to be resolved at query time. `context`
/// is the line the link sits on, kept here so the backlinks list does not have to go back to the
/// document text for a single line.
const V1: &str = "
CREATE TABLE IF NOT EXISTS docs (
    path       TEXT PRIMARY KEY,
    root_id    TEXT NOT NULL,
    rel_path   TEXT NOT NULL,
    name       TEXT NOT NULL,
    title      TEXT NOT NULL,
    mtime_ms   INTEGER NOT NULL,
    scanned_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS docs_by_root ON docs (root_id);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS links (
    src_path    TEXT NOT NULL,
    href        TEXT NOT NULL,
    target_path TEXT NOT NULL,
    context     TEXT NOT NULL,
    PRIMARY KEY (src_path, href)
);

CREATE INDEX IF NOT EXISTS links_by_target ON links (target_path);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

/// The open database, the last thing it said about itself, and the worker that writes to it.
///
/// Managed by lib.rs and built by `Default` before there is an app to open anything with, so the
/// connection starts empty and `open` fills it. A connection that is still `None` after setup means
/// the index could not be opened at all, and every command below reports that rather than failing
/// in a way that reads as "search is broken".
#[derive(Default)]
pub struct Index {
    conn: Mutex<Option<Connection>>,
    status: Mutex<IndexStatus>,
    /// Set while a full rebuild is queued or running, so pressing rebuild twice does not walk every
    /// folder twice.
    rebuilding: AtomicBool,
    worker: OnceLock<Sender<Job>>,
}

/// Work for the indexer thread. Ordered, because a create arriving after a delete for the same path
/// has to be applied in that order.
enum Job {
    /// Every open root as they were when the user asked for the rebuild.
    Rebuild(Vec<RootInfo>),
    /// One newly opened root.
    Scan(RootInfo),
    /// A closed root's rows, by root id.
    Forget(String),
    /// A path that appeared or changed. A directory is scanned and swept, so a folder dragged in
    /// arrives whole and a folder whose contents changed loses the rows for what is no longer in it.
    Changed(PathBuf),
    /// A path that is gone, with everything under it if it was a folder.
    Removed(PathBuf),
}

// ---------------------------------------------------------------- opening

/// Opens the database and runs the migration, then starts the worker that owns every write to it.
///
/// Called from lib.rs's `setup`, which fetches nothing itself: the managed state is picked up here
/// so the call site is one line and cannot get the type wrong.
pub fn open(app: &AppHandle) -> Result<(), String> {
    let index = app
        .try_state::<Index>()
        .ok_or_else(|| "the search index state is not managed".to_string())?;

    let file = crate::library::app_data_dir(app)?.join(DATABASE_FILE);
    let conn = match connect(&file) {
        Ok(conn) => conn,
        Err(e) => {
            // This is where a database from a newer build lands, and the only way the user ever
            // hears about it: the connection is left closed, so `index_status` answers with this
            // error and the search box says so instead of quietly returning nothing.
            if let Ok(mut status) = index.status.lock() {
                status.phase = "error".to_string();
                status.error = Some(e.clone());
            }
            return Err(e);
        }
    };

    let last = last_indexed(&conn);
    *index.conn.lock().map_err(|e| e.to_string())? = Some(conn);
    if let Ok(mut status) = index.status.lock() {
        status.last_indexed = last;
    }

    let (tx, rx) = mpsc::channel::<Job>();
    let handle = app.clone();
    std::thread::spawn(move || work(handle, rx));
    index.worker.set(tx).ok();
    Ok(())
}

fn connect(file: &Path) -> Result<Connection, String> {
    let conn = Connection::open(file).map_err(|e| format!("{}: {e}", file.display()))?;
    // WAL so a search reads while the indexer writes, and NORMAL because every byte in here is
    // derived from a file on disk: the worst a power cut can cost is a rescan.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .map_err(|e| format!("{}: {e}", file.display()))?;
    migrate(&conn)?;
    Ok(conn)
}

/// Forward only, keyed on `user_version`, and a refusal above it.
///
/// A database written by a later build has a shape this one does not know. Treating it as the
/// current schema would mean reading columns that have moved and writing rows the later build
/// cannot read back, so it is refused instead, and refusing costs nothing: the caller reports it,
/// the index stays closed, and the later build rebuilds it from the files whenever it next runs.
fn migrate(conn: &Connection) -> Result<(), String> {
    let found: i32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if found > VERSION {
        return Err(format!(
            "this search index is at schema {found}, which is newer than this build understands ({VERSION}). Quit, delete {DATABASE_FILE} from the app data folder and it will be built again."
        ));
    }
    if found == VERSION {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if found < 1 {
        conn.execute_batch(V1).map_err(|e| e.to_string())?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {VERSION};"))
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn last_indexed(conn: &Connection) -> Option<i64> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![LAST_INDEXED_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|raw| raw.parse::<i64>().ok())
}

// ---------------------------------------------------------------- asking for work

/// Queues a full rebuild and returns the status the pass starts with.
///
/// The status is moved to `indexing` here rather than on the worker, so the value handed back to
/// the frontend already says a pass is running: `useIndex` applies the return value on top of its
/// own optimistic `indexing`, and answering with the previous idle status would put the status line
/// back to "ready" until the first progress event arrived.
pub fn rebuild(app: &AppHandle, roots: Vec<RootInfo>) -> Result<IndexStatus, String> {
    let index = state(app)?;
    if index.rebuilding.swap(true, Memory::SeqCst) {
        // A pass is already queued or running. Walking every folder a second time would only slow
        // down the first one.
        return status_of(&index);
    }
    let mut status = status_of(&index)?;
    status.phase = "indexing".to_string();
    status.indexed = 0;
    status.total = 0;
    status.error = None;
    publish(app, &index, status.clone());

    if index
        .worker
        .get()
        .map(|tx| tx.send(Job::Rebuild(roots)).is_err())
        .unwrap_or(true)
    {
        index.rebuilding.store(false, Memory::SeqCst);
        return Err("the search index is not open".to_string());
    }
    Ok(status)
}

pub fn status(app: &AppHandle) -> Result<IndexStatus, String> {
    let index = state(app)?;
    status_of(&index)
}

/// A folder the user has just opened, indexed without waiting for the next full rebuild.
pub fn scan_root(app: &AppHandle, root: RootInfo) {
    send(app, Job::Scan(root));
}

/// A folder the user has closed. Its rows go with it: they cannot be searched into any more, and
/// leaving them would put paths from a folder that is not open in front of the user.
pub fn forget_root(app: &AppHandle, root_id: &str) {
    send(app, Job::Forget(root_id.to_string()));
}

/// A document this app wrote itself.
///
/// The watcher never reports these. `watch::note_self_write` filters the app's own writes out of
/// the stream so autosave does not fight the watcher, which is right for the tree and wrong for the
/// index: without this call the only version of a document the index would ever hold is the one
/// from before the user started typing in it.
pub fn note_write(app: &AppHandle, path: &Path) {
    send(app, Job::Changed(path.to_path_buf()));
}

/// One debounced batch from the watcher, which is every change the index hears about that this app
/// did not make itself.
pub fn note_watch_events(app: &AppHandle, events: &[WatchEvent]) {
    for event in events {
        match event.kind.as_str() {
            "removed" => send(app, Job::Removed(PathBuf::from(&event.path))),
            "renamed" => {
                if let Some(old) = &event.old_path {
                    send(app, Job::Removed(PathBuf::from(old)));
                }
                send(app, Job::Changed(PathBuf::from(&event.path)));
            }
            // created, modified, and the rescan the watcher reports as a modification of the root
            // itself, which lands here as a directory and is scanned and swept like any other.
            _ => send(app, Job::Changed(PathBuf::from(&event.path))),
        }
    }
}

fn send(app: &AppHandle, job: Job) {
    let Some(index) = app.try_state::<Index>() else {
        return;
    };
    // No worker means the database never opened. Dropping the job is the whole of the degradation:
    // the app is an editor with an empty search box until it is restarted.
    if let Some(tx) = index.worker.get() {
        tx.send(job).ok();
    }
}

fn state(app: &AppHandle) -> Result<tauri::State<'_, Index>, String> {
    app.try_state::<Index>()
        .ok_or_else(|| "the search index state is not managed".to_string())
}

fn status_of(index: &Index) -> Result<IndexStatus, String> {
    index
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|e| e.to_string())
}

fn publish(app: &AppHandle, index: &Index, status: IndexStatus) {
    if let Ok(mut held) = index.status.lock() {
        *held = status.clone();
    }
    app.emit(INDEX_PROGRESS, &status).ok();
}

// ---------------------------------------------------------------- the worker

fn work(app: AppHandle, jobs: mpsc::Receiver<Job>) {
    // Strictly increasing within this process and still a wall clock, so a pass started after a
    // relaunch is above every stamp the last run left behind and its sweep can see them.
    let mut pass = 0i64;
    let mut next = || {
        let now = now_ms();
        pass = if now > pass { now } else { pass + 1 };
        pass
    };

    for job in jobs {
        let Ok(index) = state(&app) else { continue };
        let outcome = match job {
            Job::Rebuild(roots) => {
                let done = rebuild_pass(&app, &index, &roots, next());
                index.rebuilding.store(false, Memory::SeqCst);
                done
            }
            Job::Scan(root) => scan_pass(&app, &index, std::slice::from_ref(&root), next()),
            Job::Forget(root_id) => with_conn(&index, |conn| forget_root_rows(conn, &root_id)),
            Job::Changed(path) => changed(&app, &index, &path, next()),
            Job::Removed(path) => with_conn(&index, |conn| remove_under(conn, &path)),
        };
        if let Err(e) = outcome {
            eprintln!("search index: {e}");
        }
    }
}

/// A rebuild is a scan of every open root plus the one thing a scan cannot do: drop the rows of a
/// root that is no longer open at all. A root that was closed is already forgotten as it closes,
/// but a crash between the two leaves rows nothing else would ever collect.
fn rebuild_pass(
    app: &AppHandle,
    index: &Index,
    roots: &[RootInfo],
    pass: i64,
) -> Result<(), String> {
    let ids: Vec<String> = roots.iter().map(|root| root.id.clone()).collect();
    with_conn(index, |conn| forget_roots_except(conn, &ids))?;
    scan_pass(app, index, roots, pass)
}

/// One pass over a set of roots: walk them all first so the total is known before the first file is
/// read, then index in batches, then delete whatever the pass did not touch.
fn scan_pass(
    app: &AppHandle,
    index: &Index,
    roots: &[RootInfo],
    pass: i64,
) -> Result<(), String> {
    let mut status = status_of(index)?;
    status.phase = "indexing".to_string();
    status.indexed = 0;
    status.total = 0;
    status.error = None;
    publish(app, index, status.clone());

    let plan: Vec<(&RootInfo, Vec<PathBuf>)> = roots
        .iter()
        .map(|root| (root, documents_under(Path::new(&root.path))))
        .collect();

    status.total = plan.iter().map(|(_, files)| files.len() as u32).sum();
    publish(app, index, status.clone());

    for (root, files) in &plan {
        for chunk in files.chunks(BATCH) {
            index_chunk(index, root, chunk, pass)?;
            status.indexed += chunk.len() as u32;
            if status.indexed % PROGRESS_EVERY == 0 {
                publish(app, index, status.clone());
            }
        }
        with_conn(index, |conn| sweep_root(conn, &root.id, pass))?;
    }

    let finished = now_ms();
    with_conn(index, |conn| remember(conn, LAST_INDEXED_KEY, finished))?;
    status.phase = "idle".to_string();
    status.last_indexed = Some(finished);
    publish(app, index, status);
    Ok(())
}

/// A path the watcher, or this app's own save, says has changed.
///
/// A directory is walked and then swept, which is what makes a folder dragged in arrive whole, a
/// folder whose contents were rearranged come out right, and the watcher's own "the kernel dropped
/// events, here is the root" report rescan everything under it.
fn changed(app: &AppHandle, index: &Index, path: &Path, pass: i64) -> Result<(), String> {
    let roots = open_roots(app);
    let Some(root) = owning_root(&roots, path) else {
        // A change under a folder that is not open. Nothing to index it into.
        return Ok(());
    };
    let Ok(meta) = fs::symlink_metadata(path) else {
        // Gone again between the event and here, which a debounce window makes perfectly ordinary.
        return with_conn(index, |conn| remove_under(conn, path));
    };
    if !meta.is_dir() {
        if !is_document(path) {
            return Ok(());
        }
        return with_conn(index, |conn| index_document(conn, &root, path, pass));
    }

    // Walked before the connection is taken, since a folder dropped into a root can be large and a
    // search should not wait behind a directory walk.
    let files = documents_under(path);
    for chunk in files.chunks(BATCH) {
        index_chunk(index, &root, chunk, pass)?;
    }
    // Swept after the scan has committed rather than inside it: SQLite has one transaction per
    // connection, and the sweep opens its own.
    with_conn(index, |conn| sweep_under(conn, path, pass))
}

/// One batch of documents, in one transaction, holding the connection for exactly that long. A pass
/// over a large folder is otherwise either one transaction that blocks every search until it ends
/// or one transaction per file, which is a commit per file.
fn index_chunk(
    index: &Index,
    root: &RootInfo,
    chunk: &[PathBuf],
    pass: i64,
) -> Result<(), String> {
    let held = lock(index)?;
    let conn = connection(&held)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for file in chunk {
        if let Err(e) = index_document(conn, root, file, pass) {
            // One unreadable document is one missing row, never a failed pass. A folder that size
            // will have something in it nobody can stat.
            eprintln!("search index: {e}");
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn with_conn<T>(index: &Index, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let held = lock(index)?;
    f(connection(&held)?)
}

fn lock(index: &Index) -> Result<MutexGuard<'_, Option<Connection>>, String> {
    index.conn.lock().map_err(|e| e.to_string())
}

fn connection<'a>(held: &'a MutexGuard<'_, Option<Connection>>) -> Result<&'a Connection, String> {
    held.as_ref()
        .ok_or_else(|| "the search index is not open".to_string())
}

fn open_roots(app: &AppHandle) -> Vec<RootInfo> {
    let Some(roots) = app.try_state::<Roots>() else {
        return Vec::new();
    };
    let Ok(open) = roots.0.lock() else {
        return Vec::new();
    };
    open.clone()
}

/// The open root a path belongs to, the deepest one when roots are nested inside each other.
/// Component wise, so `/notes-old` is not read as being inside `/notes`.
fn owning_root(roots: &[RootInfo], path: &Path) -> Option<RootInfo> {
    roots
        .iter()
        .filter(|root| path.starts_with(&root.path))
        .max_by_key(|root| root.path.len())
        .cloned()
}

// ---------------------------------------------------------------- walking and reading

/// Every document under `dir`, walked by the same rules `fs::scan_tree` walks the sidebar by, so
/// the index and the tree agree about what a folder holds. A file the tree hides is a file nobody
/// can open from a search result either.
fn documents_under(dir: &Path) -> Vec<PathBuf> {
    let mut builder = WalkBuilder::new(dir);
    builder
        .follow_links(false)
        .require_git(false)
        .standard_filters(true);
    builder.filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            return true;
        }
        !crate::fs::ALWAYS_SKIPPED.contains(&entry.file_name().to_string_lossy().as_ref())
    });

    let mut out = Vec::new();
    for entry in builder.build() {
        let Ok(entry) = entry else { continue };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let path = entry.path();
        if is_document(path) {
            out.push(path.to_path_buf());
        }
    }
    out
}

/// Markdown and plain text, decided exactly as the tree decides whether a row opens in the editor.
fn is_document(path: &Path) -> bool {
    matches!(crate::fs::kind_for(path, false), "markdown" | "text")
}

/// One document into the three tables, or one stat if the file has not moved since the last pass.
///
/// The mtime shortcut is what makes a rescan of an unchanged folder cost a walk rather than a read
/// of every file in it. It is also the reason a pass leaves no trace on disk: a file that has not
/// changed is never opened at all.
fn index_document(
    conn: &Connection,
    root: &RootInfo,
    path: &Path,
    pass: i64,
) -> Result<(), String> {
    let key = path.to_string_lossy().into_owned();
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mtime = crate::fs::modified_ms(&meta);

    let known: Option<i64> = conn
        .query_row("SELECT mtime_ms FROM docs WHERE path = ?1", params![key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if known == Some(mtime) {
        conn.execute(
            "UPDATE docs SET scanned_at = ?2, root_id = ?3 WHERE path = ?1",
            params![key, pass, root.id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // A file that is not UTF-8 is indexed with no text rather than skipped. Its path is still worth
    // finding in quick open, and refusing the whole row would make it invisible instead.
    let body = fs::read_to_string(path).unwrap_or_default();
    let title = title_for(path, &body);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| key.clone());
    let rel = relative_to(&root.path, path);

    let rowid: i64 = conn
        .query_row(
            "INSERT INTO docs (path, root_id, rel_path, name, title, mtime_ms, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(path) DO UPDATE SET
                 root_id = excluded.root_id,
                 rel_path = excluded.rel_path,
                 name = excluded.name,
                 title = excluded.title,
                 mtime_ms = excluded.mtime_ms,
                 scanned_at = excluded.scanned_at
             RETURNING rowid",
            params![key, root.id, rel, name, title, mtime, pass],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM docs_fts WHERE rowid = ?1", params![rowid])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO docs_fts (rowid, body) VALUES (?1, ?2)",
        params![rowid, body],
    )
    .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM links WHERE src_path = ?1", params![key])
        .map_err(|e| e.to_string())?;
    for link in links_in(&key, &body) {
        conn.execute(
            "INSERT OR IGNORE INTO links (src_path, href, target_path, context)
             VALUES (?1, ?2, ?3, ?4)",
            params![key, link.href, link.target, link.context],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The path as the row shows it: relative to its root, with the root's own separator convention.
fn relative_to(root: &str, path: &Path) -> String {
    let full = path.to_string_lossy().into_owned();
    match full.strip_prefix(root) {
        Some(rest) => rest.trim_start_matches('/').to_string(),
        None => full,
    }
}

// ---------------------------------------------------------------- deleting

/// Rows for a path and, if it was a folder, everything that was under it.
///
/// The subtree is a range over the primary key rather than a LIKE, because a folder called
/// `50% done` would turn a LIKE pattern into a wildcard that matches far more than itself. `/` is
/// 0x2f and `0` is 0x30, so everything beginning with the prefix and a separator sorts between them.
fn remove_under(conn: &Connection, path: &Path) -> Result<(), String> {
    let key = path.to_string_lossy().into_owned();
    let from = format!("{key}/");
    let to = format!("{key}0");
    let doomed = doomed_paths(
        conn,
        "SELECT rowid, path FROM docs WHERE path = ?1 OR (path > ?2 AND path < ?3)",
        vec![Value::from(key), Value::from(from), Value::from(to)],
    )?;
    delete_docs(conn, &doomed)
}

fn forget_root_rows(conn: &Connection, root_id: &str) -> Result<(), String> {
    let doomed = doomed_paths(
        conn,
        "SELECT rowid, path FROM docs WHERE root_id = ?1",
        vec![Value::from(root_id.to_string())],
    )?;
    delete_docs(conn, &doomed)
}

fn forget_roots_except(conn: &Connection, keep: &[String]) -> Result<(), String> {
    let holes = placeholders(keep.len().max(1));
    let args: Vec<Value> = if keep.is_empty() {
        // No folder open at all, so no row belongs to anything. The impossible id keeps the SQL one
        // shape rather than two.
        vec![Value::from(String::new())]
    } else {
        keep.iter().map(|id| Value::from(id.clone())).collect()
    };
    let doomed = doomed_paths(
        conn,
        &format!("SELECT rowid, path FROM docs WHERE root_id NOT IN ({holes})"),
        args,
    )?;
    delete_docs(conn, &doomed)
}

/// Whatever this pass did not touch under `dir` is no longer there.
fn sweep_under(conn: &Connection, dir: &Path, pass: i64) -> Result<(), String> {
    let key = dir.to_string_lossy().into_owned();
    let from = format!("{key}/");
    let to = format!("{key}0");
    let doomed = doomed_paths(
        conn,
        "SELECT rowid, path FROM docs WHERE scanned_at < ?1 AND (path > ?2 AND path < ?3)",
        vec![Value::from(pass), Value::from(from), Value::from(to)],
    )?;
    delete_docs(conn, &doomed)
}

fn sweep_root(conn: &Connection, root_id: &str, pass: i64) -> Result<(), String> {
    let doomed = doomed_paths(
        conn,
        "SELECT rowid, path FROM docs WHERE root_id = ?1 AND scanned_at < ?2",
        vec![Value::from(root_id.to_string()), Value::from(pass)],
    )?;
    delete_docs(conn, &doomed)
}

fn doomed_paths(
    conn: &Connection,
    sql: &str,
    args: Vec<Value>,
) -> Result<Vec<(i64, String)>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// The text and the links go first: a `docs` row is what says they exist, so losing it first would
/// leave both behind with nothing pointing at them.
///
/// Links out of a deleted document go. Links into one stay exactly where they are, in the documents
/// that hold them: a link to a file somebody has just deleted is still a link, and it works again
/// the moment the file comes back.
fn delete_docs(conn: &Connection, doomed: &[(i64, String)]) -> Result<(), String> {
    if doomed.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (rowid, path) in doomed {
        conn.execute("DELETE FROM docs_fts WHERE rowid = ?1", params![rowid])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM links WHERE src_path = ?1", params![path])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM docs WHERE path = ?1", params![path])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn remember(conn: &Connection, key: &str, value: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn placeholders(n: usize) -> String {
    std::iter::repeat_n("?", n).collect::<Vec<_>>().join(", ")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- quick open

/// Fuzzy match over every indexed path, best score first.
pub fn quick_open(app: &AppHandle, query: &str, limit: u32) -> Result<Vec<QuickOpenHit>, String> {
    let index = state(app)?;
    let ids: Vec<String> = open_roots(app).into_iter().map(|root| root.id).collect();
    // Whitespace is dropped rather than treated as a separator: a quick open query is one
    // subsequence, and a space in the middle of it is somebody typing "getting started" at a path
    // that spells it `getting-started`.
    let needle: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect();
    if needle.is_empty() || ids.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    // Scoped so the connection is handed back before the sort: the ordering is this side's work and
    // there is no reason for a rebuild to wait behind it.
    let mut hits: Vec<QuickOpenHit> = {
        let held = lock(&index)?;
        let conn = connection(&held)?;
        let mut stmt = conn
            .prepare("SELECT path, root_id, rel_path, name FROM docs")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut hits: Vec<QuickOpenHit> = Vec::new();
        let mut haystack: Vec<char> = Vec::new();
        for row in rows {
            let (path, root, rel, name) = row.map_err(|e| e.to_string())?;
            if !ids.iter().any(|id| id == &root) {
                continue;
            }
            haystack.clear();
            haystack.extend(rel.chars());
            let Some(found) = fuzzy(&needle, &haystack) else {
                continue;
            };
            hits.push(QuickOpenHit {
                path,
                name,
                root,
                score: found.score,
                ranges: to_utf16(&rel, found.ranges),
                rel_path: rel,
            });
        }
        hits
    };

    // Ties go to the shorter path, then to the alphabet, so an unchanged folder lists in the same
    // order every time it is searched.
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.rel_path.chars().count().cmp(&b.rel_path.chars().count()))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    hits.truncate(limit as usize);
    Ok(hits)
}

struct Found {
    score: i32,
    ranges: Vec<MatchRange>,
}

const SCORE_MATCH: i32 = 16;
const SCORE_CONSECUTIVE: i32 = 20;
/// The first character, or the one after a separator: what somebody typing a path is aiming at.
const BONUS_SEGMENT: i32 = 20;
const BONUS_WORD: i32 = 14;
const BONUS_CAMEL: i32 = 12;
const BONUS_DOT: i32 = 10;
/// Every character of the last segment, so a match in the filename beats the same match in a folder
/// name above it.
const BONUS_FILENAME: i32 = 6;
const GAP_LEADING: i32 = -2;
const GAP_INNER: i32 = -4;
/// Half of the floor, so adding a bonus to it can never wrap round into a good score.
const SCORE_MIN: i32 = i32::MIN / 2;

/// The scoring is fzy's: one table of the best score ending in a match at each position, one of the
/// best score reachable by that position at all, filled left to right and then walked backwards to
/// recover which characters were used. It is worth the table rather than a greedy pass because
/// greedy takes the first `e` in `keyboard-reference.md` and never finds the run that spells
/// `refe`, which is exactly the query somebody types.
fn fuzzy(needle: &[char], haystack: &[char]) -> Option<Found> {
    if needle.is_empty() || haystack.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    // Most paths are not a match at all, and a subsequence check answers that in one pass instead
    // of filling a table to find out.
    let mut at = 0;
    for c in haystack {
        if lower(*c) == needle[at] {
            at += 1;
            if at == needle.len() {
                break;
            }
        }
    }
    if at < needle.len() {
        return None;
    }

    let n = needle.len();
    let m = haystack.len();
    let bonuses = bonuses_for(haystack);
    let mut best = vec![SCORE_MIN; n * m];
    let mut reach = vec![SCORE_MIN; n * m];

    for i in 0..n {
        let mut prev_reach = SCORE_MIN;
        // Skipping characters before the first match is cheaper than skipping them in the middle of
        // one: a query is usually the tail of a path, and rarely a hole punched through a word.
        let gap = if i == 0 { GAP_LEADING } else { GAP_INNER };
        for j in 0..m {
            let cell = i * m + j;
            if needle[i] == lower(haystack[j]) {
                let score = if i == 0 {
                    GAP_LEADING * j as i32 + bonuses[j] + SCORE_MATCH
                } else if j == 0 {
                    SCORE_MIN
                } else {
                    let after_gap = reach[(i - 1) * m + j - 1] + bonuses[j];
                    let after_run = best[(i - 1) * m + j - 1] + SCORE_CONSECUTIVE;
                    after_gap.max(after_run) + SCORE_MATCH
                };
                best[cell] = score;
                reach[cell] = score.max(prev_reach + gap);
            } else {
                best[cell] = SCORE_MIN;
                reach[cell] = prev_reach + gap;
            }
            prev_reach = reach[cell];
        }
    }

    let score = reach[(n - 1) * m + m - 1];
    if score <= SCORE_MIN {
        return None;
    }

    let mut positions = vec![0usize; n];
    let mut j = m;
    let mut required = false;
    for i in (0..n).rev() {
        while j > 0 {
            j -= 1;
            let cell = i * m + j;
            if best[cell] != SCORE_MIN && (required || best[cell] == reach[cell]) {
                required = i > 0
                    && j > 0
                    && best[cell] == best[(i - 1) * m + j - 1] + SCORE_CONSECUTIVE + SCORE_MATCH;
                positions[i] = j;
                break;
            }
        }
    }

    Some(Found {
        score,
        ranges: runs(&positions),
    })
}

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

fn bonuses_for(haystack: &[char]) -> Vec<i32> {
    let filename_from = haystack
        .iter()
        .rposition(|c| *c == '/')
        .map(|at| at + 1)
        .unwrap_or(0);
    haystack
        .iter()
        .enumerate()
        .map(|(j, c)| {
            let boundary = if j == 0 {
                BONUS_SEGMENT
            } else {
                match haystack[j - 1] {
                    '/' => BONUS_SEGMENT,
                    '-' | '_' | ' ' => BONUS_WORD,
                    '.' => BONUS_DOT,
                    prev if prev.is_lowercase() && c.is_uppercase() => BONUS_CAMEL,
                    _ => 0,
                }
            };
            boundary + if j >= filename_from { BONUS_FILENAME } else { 0 }
        })
        .collect()
}

/// Retimes character ranges into the units the other end counts in.
///
/// Everything above works in code points, which is what `chars()` gives and what makes the fuzzy
/// matcher and the snippet window readable. JavaScript strings are UTF-16, and `slice` on one
/// counts UTF-16 code units, so a range measured in code points lands one position early for every
/// character past the BMP that precedes it: an emoji in a filename, and the highlight in the quick
/// open row is off by one from there on.
///
/// This is the last thing done to a range before it crosses the boundary, and it is the reason the
/// doc comments on `MatchRange` say what unit they are in. Note that `SpellIssue` deliberately does
/// not go through here: its offsets address a ProseMirror document, and ProseMirror counts code
/// points, so the two DTOs want genuinely different units and neither is wrong.
fn to_utf16(text: &str, ranges: Vec<MatchRange>) -> Vec<MatchRange> {
    if text.is_ascii() {
        return ranges;
    }
    // One pass over the string building code point index to UTF-16 index, since the ranges are few
    // and the string is short but walking it once per boundary would still be quadratic.
    let mut widths: Vec<u32> = Vec::with_capacity(text.chars().count() + 1);
    let mut at: u32 = 0;
    widths.push(0);
    for c in text.chars() {
        at += c.len_utf16() as u32;
        widths.push(at);
    }
    let last = *widths.last().unwrap_or(&0);
    ranges
        .into_iter()
        .map(|range| MatchRange {
            start: *widths.get(range.start as usize).unwrap_or(&last),
            end: *widths.get(range.end as usize).unwrap_or(&last),
        })
        .collect()
}

/// Matched positions, which are always ascending, folded into half-open ranges so a run of five
/// characters is one highlight rather than five.
fn runs(positions: &[usize]) -> Vec<MatchRange> {
    let mut out: Vec<MatchRange> = Vec::new();
    for at in positions {
        let at = *at as u32;
        match out.last_mut() {
            Some(last) if last.end == at => last.end = at + 1,
            _ => out.push(MatchRange {
                start: at,
                end: at + 1,
            }),
        }
    }
    out
}

// ---------------------------------------------------------------- full text

/// FTS5 over every open root, with the line and the characters of each match.
pub fn search(app: &AppHandle, query: &str, limit: u32) -> Result<Vec<SearchHit>, String> {
    let index = state(app)?;
    let ids: Vec<String> = open_roots(app).into_iter().map(|root| root.id).collect();
    let expression = match_expression(query);
    if expression.is_empty() || ids.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT d.path, d.root_id, d.title, highlight(docs_fts, 0, char(2), char(3))
         FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
         WHERE docs_fts MATCH ? AND d.root_id IN ({})
         ORDER BY bm25(docs_fts)
         LIMIT ?",
        placeholders(ids.len())
    );
    let mut args: Vec<Value> = vec![Value::from(expression)];
    args.extend(ids.into_iter().map(Value::from));
    args.push(Value::from(limit as i64));

    let held = lock(&index)?;
    let conn = connection(&held)?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut hits: Vec<SearchHit> = Vec::new();
    for row in rows {
        let (path, root, title, marked) = row.map_err(|e| e.to_string())?;
        for (line, snippet, ranges) in marked_lines(&marked, HITS_PER_DOC) {
            hits.push(SearchHit {
                path: path.clone(),
                root: root.clone(),
                title: title.clone(),
                line,
                ranges: to_utf16(&snippet, ranges),
                snippet,
            });
            if hits.len() >= limit as usize {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

/// The query as FTS5 will read it: every run of letters and digits, quoted.
///
/// The text box hands over whatever somebody typed, and an unpaired quote or a bare `NOT` is a
/// syntax error the user would read as the search being broken rather than as their query being
/// unusual. Splitting on everything that is not alphanumeric means no character the user typed can
/// reach the parser as syntax: what is left inside the quotes cannot contain a quote to close them
/// with, and `AND` inside quotes is the word and not the operator.
///
/// The last term is a prefix. A find in files runs while somebody is still typing, and a query that
/// only ever matches whole words answers nothing until the last letter of the last word lands.
fn match_expression(query: &str) -> String {
    let terms: Vec<&str> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .take(MAX_TERMS)
        .collect();
    let last = terms.len().saturating_sub(1);
    terms
        .iter()
        .enumerate()
        .map(|(at, term)| {
            if at == last {
                format!("\"{term}\"*")
            } else {
                format!("\"{term}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The lines a match landed on, at most `most` of them.
///
/// `marked` is the document with `highlight()`'s marks around every match, so the line number is a
/// count of the newlines before the first mark and the ranges are the marks' own positions with the
/// marks taken back out. The line is one based and counted over the file as it sits on disk,
/// frontmatter included, because that is the line the user sees in any other editor.
fn marked_lines(marked: &str, most: usize) -> Vec<(u32, String, Vec<MatchRange>)> {
    let mut out = Vec::new();
    for (line, raw) in (1u32..).zip(marked.split('\n')) {
        if raw.contains(MARK_START) {
            let (snippet, ranges) = snippet_of(raw);
            out.push((line, snippet, ranges));
            if out.len() >= most {
                break;
            }
        }
    }
    if out.is_empty() {
        // A hit with nothing marked should not happen, since a document only matches by holding a
        // term. Answering with the first line is still better than dropping a real hit.
        let first = marked.split('\n').next().unwrap_or_default();
        out.push((1, clip(first, SNIPPET_MAX), Vec::new()));
    }
    out
}

/// One marked line as the frontend shows it: trimmed, windowed around the first match, and with
/// character ranges into what is left.
fn snippet_of(line: &str) -> (String, Vec<MatchRange>) {
    let mut text: Vec<char> = Vec::new();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut open: Option<usize> = None;
    for c in line.chars() {
        match c {
            MARK_START => open = Some(text.len()),
            MARK_END => {
                if let Some(start) = open.take() {
                    ranges.push((start, text.len()));
                }
            }
            '\r' => {}
            _ => text.push(c),
        }
    }

    let lead = text.iter().take_while(|c| c.is_whitespace()).count();
    let tail = text.len() - text.iter().rev().take_while(|c| c.is_whitespace()).count();
    let first = ranges.first().map(|(start, _)| *start).unwrap_or(lead);
    // Enough of the line to see where the match is, starting a little before it when the line is
    // too long to show whole.
    let mut from = lead.max(first.saturating_sub(SNIPPET_LEAD));
    if tail.saturating_sub(from) < SNIPPET_MAX {
        from = tail.saturating_sub(SNIPPET_MAX).max(lead);
    }
    let to = tail.min(from + SNIPPET_MAX);

    let mut out = String::new();
    let mut shift = from;
    if from > lead {
        out.push('…');
        shift -= 1;
    }
    out.extend(text[from..to].iter());
    if to < tail {
        out.push('…');
    }

    let width = out.chars().count() as u32;
    let ranges = ranges
        .into_iter()
        .filter(|(start, end)| *end > from && *start < to)
        .map(|(start, end)| MatchRange {
            start: (start.max(from) - shift) as u32,
            end: ((end.min(to) - shift) as u32).min(width),
        })
        .filter(|range| range.end > range.start)
        .collect();
    (out, ranges)
}

fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push('…');
    out
}

// ---------------------------------------------------------------- backlinks

/// Every document holding a relative link that resolves to `path`.
///
/// A reverse lookup and nothing else: the rows were written when the linking documents were
/// indexed, so a backlink appears because somebody wrote a link, never because anything was
/// recorded on this side. A document that links to itself is left out, since listing the document
/// somebody is reading among the documents that point at it is noise rather than a backlink.
pub fn backlinks(app: &AppHandle, path: &str) -> Result<Vec<Backlink>, String> {
    let index = state(app)?;
    let target = normalized(path);
    let held = lock(&index)?;
    let conn = connection(&held)?;
    let mut stmt = conn
        .prepare(
            "SELECT d.path, d.title, l.context
             FROM links l JOIN docs d ON d.path = l.src_path
             WHERE l.target_path = ?1 AND l.src_path <> ?1
             ORDER BY d.title, d.path",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![target], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out: Vec<Backlink> = Vec::new();
    for row in rows {
        let (path, title, context) = row.map_err(|e| e.to_string())?;
        // Two links from one document to the same file are one backlink.
        if out.iter().any(|found| found.path == path) {
            continue;
        }
        out.push(Backlink {
            path,
            title,
            snippet: context,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------- reading a document

/// The document's title: its first heading, or its filename without the extension.
///
/// The heading and the filename are unrelated in this product. Nothing renames a file because a
/// heading changed and nothing rewrites a heading because a file moved, so the rule is only ever
/// this way round: a heading if there is one, the stem if there is not.
fn title_for(path: &Path, body: &str) -> String {
    heading_in(body).unwrap_or_else(|| {
        path.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned())
    })
}

fn heading_in(body: &str) -> Option<String> {
    let mut fence: Option<char> = None;
    let mut frontmatter = false;
    let mut previous: Option<&str> = None;

    for (n, line) in body.lines().enumerate() {
        // A leading `---` opens frontmatter, and everything to its close is metadata rather than
        // text. Skipping it is not tidiness: `title: Notes` followed by the closing `---` is a
        // setext heading to anything reading line by line, and the title of every document with
        // frontmatter would be its second line of YAML.
        if n == 0 && line.trim_end() == "---" {
            frontmatter = true;
            continue;
        }
        if frontmatter {
            let trimmed = line.trim_end();
            if trimmed == "---" || trimmed == "..." {
                frontmatter = false;
            }
            continue;
        }
        match (fence, fence_char(line)) {
            (Some(open), Some(found)) if open == found => fence = None,
            (Some(_), _) => {}
            (None, Some(found)) => fence = Some(found),
            (None, None) => {
                if let Some(text) = atx_heading(line) {
                    return Some(text);
                }
                if let Some(text) = previous {
                    if is_setext_rule(line) {
                        return Some(text.trim().to_string());
                    }
                }
                previous = if line.trim().is_empty() {
                    None
                } else {
                    Some(line)
                };
                continue;
            }
        }
        previous = None;
    }
    None
}

fn fence_char(line: &str) -> Option<char> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    ['`', '~']
        .into_iter()
        .find(|marker| trimmed.starts_with(&marker.to_string().repeat(3)))
}

fn atx_heading(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim();
    // `#` on its own is a heading with nothing in it, which is no more a title than an empty line.
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn is_setext_rule(line: &str) -> bool {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 {
        return false;
    }
    let body = trimmed.trim_end();
    !body.is_empty()
        && (body.chars().all(|c| c == '=') || body.chars().all(|c| c == '-'))
}

struct Link {
    href: String,
    target: String,
    context: String,
}

/// Every relative markdown link in a document, with what it resolves to.
///
/// Line by line, so the line a link sits on is the context the backlinks list shows and so a link
/// inside a fenced code block is not read as a link at all. A code sample showing what a link looks
/// like should not put a backlink in front of anybody.
fn links_in(from: &str, body: &str) -> Vec<Link> {
    let mut out = Vec::new();
    let mut fence: Option<char> = None;
    for line in body.lines() {
        match (fence, fence_char(line)) {
            (Some(open), Some(found)) if open == found => {
                fence = None;
                continue;
            }
            (Some(_), _) => continue,
            (None, Some(found)) => {
                fence = Some(found);
                continue;
            }
            (None, None) => {}
        }
        for href in hrefs_in(line) {
            if let Some(target) = resolve_relative(from, &href) {
                out.push(Link {
                    href,
                    target,
                    context: clip(line, SNIPPET_MAX),
                });
            }
        }
    }
    out
}

/// The destinations of every link on one line: `](dest)`, `](<dest>)` and a reference definition's
/// `[label]: dest`.
fn hrefs_in(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();

    if let Some(dest) = reference_definition(&chars) {
        out.push(dest);
    }

    let mut i = 0;
    while i + 1 < chars.len() {
        if chars[i] != ']' || chars[i + 1] != '(' {
            i += 1;
            continue;
        }
        let mut j = i + 2;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if chars.get(j) == Some(&'<') {
            let mut dest = String::new();
            let mut k = j + 1;
            while k < chars.len() && chars[k] != '>' {
                dest.push(chars[k]);
                k += 1;
            }
            if k < chars.len() && !dest.is_empty() {
                out.push(dest);
            }
            i = k + 1;
            continue;
        }
        let mut dest = String::new();
        let mut depth = 0i32;
        let mut k = j;
        while k < chars.len() {
            let c = chars[k];
            if c == '\\' && k + 1 < chars.len() {
                dest.push(chars[k + 1]);
                k += 2;
                continue;
            }
            if c.is_whitespace() {
                break;
            }
            if c == '(' {
                depth += 1;
            }
            if c == ')' {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            dest.push(c);
            k += 1;
        }
        if !dest.is_empty() {
            out.push(dest);
        }
        i = k.max(i + 2);
    }
    out
}

/// The destination of a link reference definition, if this line is one.
///
/// The label alone is not enough to tell. A line of ordinary prose that happens to open with a
/// bracketed word and a colon looks identical to a definition for its first few characters, and
/// real documents contain them: `[snippet]: an outer loop that propagates the best result` is a
/// sentence, and reading `an` out of it as a destination puts a link in the index to a file that
/// was never mentioned. What separates the two is what follows the destination, so the rule
/// CommonMark states is the rule enforced here: a definition is a label, a destination, an
/// optional title, and then nothing else on the line.
///
/// A title that continues onto the next line is a definition this scanner will not recognise. That
/// is the conservative direction to be wrong in: a link missed is a backlink that does not appear,
/// and a link invented is a backlink that is not true.
fn reference_definition(chars: &[char]) -> Option<String> {
    let start = chars.iter().take_while(|c| c.is_whitespace()).count();
    if start > 3 || chars.get(start) != Some(&'[') {
        return None;
    }
    let close = (start + 1..chars.len()).find(|at| chars[*at] == ']')?;
    if chars.get(close + 1) != Some(&':') {
        return None;
    }

    let after: Vec<char> = chars[close + 2..]
        .iter()
        .copied()
        .skip_while(|c| c.is_whitespace())
        .collect();
    let width = after.iter().take_while(|c| !c.is_whitespace()).count();
    let dest: String = after[..width].iter().collect();
    let dest = dest.trim_start_matches('<').trim_end_matches('>').to_string();
    if dest.is_empty() || !only_a_title(&after[width..]) {
        return None;
    }
    Some(dest)
}

/// Whether what follows a definition's destination is an optional title and nothing more.
///
/// The three delimiter pairs are the ones CommonMark allows. Anything else, including a second
/// word, means the line was prose that merely started like a definition.
fn only_a_title(rest: &[char]) -> bool {
    let rest: Vec<char> = rest
        .iter()
        .copied()
        .skip_while(|c| c.is_whitespace())
        .collect();
    let trimmed = rest
        .iter()
        .rposition(|c| !c.is_whitespace())
        .map(|end| &rest[..=end])
        .unwrap_or(&[]);
    if trimmed.is_empty() {
        return true;
    }
    let closer = match trimmed[0] {
        '"' => '"',
        '\'' => '\'',
        '(' => ')',
        _ => return false,
    };
    trimmed.len() >= 2 && trimmed[trimmed.len() - 1] == closer
}

/// `href` as it sits in a document, resolved against the document that holds it.
///
/// This mirrors `resolveRelative` in src/links.ts line for line, and it has to: a backlink exists
/// when following the link would land on the document, so the two sides agreeing about what a link
/// means is the whole of the feature. A bare fragment, an empty href and anything carrying a scheme
/// are not paths. A percent escape is decoded, so `./my%20notes.md` and `./my notes.md` are one
/// file rather than two.
fn resolve_relative(from_file: &str, href: &str) -> Option<String> {
    if href.is_empty() || href.starts_with('#') || has_scheme(href) {
        return None;
    }
    let head = href.split('#').next().unwrap_or(href);
    let head = head.split('?').next().unwrap_or(head);
    let target = percent_decode(head);
    if target.is_empty() {
        return None;
    }
    let joined = if target.starts_with('/') {
        target
    } else {
        format!("{}/{}", dir_name(from_file), target)
    };
    Some(normalized(&joined))
}

/// `.` and `..` resolved away, exactly as the frontend resolves them: lexically, without asking the
/// filesystem, so a link means the same thing whether or not the file it names is there.
fn normalized(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    format!("/{}", out.join("/"))
}

fn dir_name(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}

fn has_scheme(href: &str) -> bool {
    let mut chars = href.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return false;
        }
    }
    false
}

/// `decodeURIComponent`, including how it fails: an escape that is not two hex digits, or bytes
/// that are not UTF-8, throws on the frontend and is caught there, leaving the href exactly as it
/// was. Decoding half of it here would resolve to a path the other side never would.
fn percent_decode(text: &str) -> String {
    if !text.contains('%') {
        return text.to_string();
    }
    let raw = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != b'%' {
            out.push(raw[i]);
            i += 1;
            continue;
        }
        let Some(hex) = raw.get(i + 1..i + 3) else {
            return text.to_string();
        };
        let Ok(hex) = std::str::from_utf8(hex) else {
            return text.to_string();
        };
        let Ok(byte) = u8::from_str_radix(hex, 16) else {
            return text.to_string();
        };
        out.push(byte);
        i += 3;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}
