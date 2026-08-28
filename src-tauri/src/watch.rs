// One filesystem watcher per open root. Changes never come back as a return value: each debounced
// batch is emitted as a `watch-event`, so a file another program touched reaches the frontend the
// same way whether anything asked for it or not.
//
// Debounced because one logical change is a burst of raw events. A git checkout rewrites a hundred
// files, another editor's atomic save is a create, a rename and a remove for what the user thinks
// of as one save, and a folder copied in arrives file by file. Reacting to raw events would reload
// the open document several times over for a single save somewhere else.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer_opt, DebounceEventResult, DebouncedEvent, Debouncer, NoCache,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dto::WatchEvent;
use crate::Roots;

/// Mirrors `WATCH_EVENT` in src/ipc.ts.
const WATCH_EVENT: &str = "watch-event";

/// How long a burst of raw events for one path is allowed to settle before it is reported.
///
/// Long enough that an atomic save arrives as one batch rather than as its create, rename and
/// remove parts, short enough that a file changed by another program shows up while the user is
/// still looking at the window that changed it.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// How long a path stays on the self-written list.
///
/// The event for a write cannot reach the callback sooner than `DEBOUNCE` after the write finishes,
/// and the debouncer's tick is a further `DEBOUNCE / 4`, so nothing under about 375ms would suppress
/// anything at all. The rest is headroom for the write itself: an fsync on a large document on a
/// busy disk can take a good fraction of a second, and the path is registered before the write
/// starts, not after. Two seconds leaves room for that several times over, and the cost of
/// overshooting is bounded and mild.
///
/// What that cost is: an external change to a file the app itself wrote less than two seconds ago is
/// dropped. That is the right answer anyway. The only way to be inside that window is for the user
/// to be typing in that document right now, and a reload mid-keystroke would throw away their
/// unsaved text to show them somebody else's. The next save catches it regardless, because
/// `file_write` compares mtimes and reports a conflict. Erring the other way is not symmetric: a
/// leaked echo of the app's own autosave reloads the editor under the cursor on every save, which
/// makes the app unusable rather than briefly out of date.
///
/// Entries expire on time and are not consumed on the first match, because one atomic save can
/// produce several debounced events for the same path and suppressing only the first would defeat
/// the whole thing.
const SELF_WRITE_WINDOW: Duration = Duration::from_millis(2_000);

/// How long after a change was raised a file may have been born and still count as created by it.
///
/// Covers the write landing, the backend noticing and the timestamp's own granularity. Too tight
/// and a new file is reported as a modification of a file the tree has never heard of; too loose
/// and editing a file made moments ago is reported as making it again.
const BIRTH_SLACK: Duration = Duration::from_millis(250);

/// Paths this app wrote, and when.
///
/// A global rather than managed state because the commands that write files take a path and nothing
/// else: their signatures are the frozen contract, so there is no `State` for them to reach the
/// watcher through. Keyed by the path with its directory resolved, since that is the only form both
/// sides can agree on.
static SELF_WRITES: LazyLock<Mutex<HashMap<PathBuf, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Records that this app is about to write `path`, so the watcher drops the event that comes back.
///
/// Call it immediately before every write, for every path the write touches. An atomic save touches
/// two, the temp file and the target it is renamed over, and each end raises its own events, so
/// registering only the target lets the temp file's half through on its own. `fs::atomic_write` is
/// the one caller, and every write in the app goes through it.
///
/// Cheap, so a caller unsure whether a path will really be written should register it anyway. The
/// entry expires on its own and registering a path that is never written costs one map slot for two
/// seconds.
pub fn note_self_write<P: AsRef<Path>>(path: P) {
    let key = resolve(path.as_ref());
    let now = Instant::now();
    if let Ok(mut writes) = SELF_WRITES.lock() {
        writes.retain(|_, at| now.duration_since(*at) < SELF_WRITE_WINDOW);
        writes.insert(key, now);
    }
}

/// The live watchers, keyed by root id.
///
/// Dropping a debouncer stops its thread, so both `watch_stop` and closing a folder come down to a
/// remove from this map and nothing else. The map is the only place a watcher is held: a watcher
/// that is not in here is not running.
#[derive(Default)]
pub struct Watchers(pub Mutex<HashMap<String, Debouncer<RecommendedWatcher, NoCache>>>);

/// Starts watching one open root, recursively. Idempotent: starting a watch that is already running
/// is a no-op rather than a second watcher on the same folder.
///
/// Every debounced change is emitted as one `watch-event` carrying the root id, so the frontend can
/// tell which tree to patch without matching path prefixes, and no path is ever the subject of more
/// than one event per batch.
///
/// A rename is two events on macOS and not one: a `removed` for the name that went and a `created`
/// or `modified` for the name that arrived. FSEvents describes the two ends as unrelated changes and
/// nothing here can prove otherwise, so `old_path` stays empty and a frontend that wants to follow a
/// renamed document has to pair them up itself, or rely on `file_rename` for the renames it made.
/// `created` and `modified` are likewise a hint rather than a promise, since the only thing
/// separating them is how recently the file was born: both mean the row should be inserted or
/// refreshed. `removed` is exact, because it is a fact about the disk read at the moment of
/// emitting.
///
/// The app's own writes are filtered out, on the strength of the paths `note_self_write` was told
/// about. The frontend cannot do this itself: by the time it hears about a change it has already
/// been handed a path and a reason to reload, and the mtime it holds cannot tell it apart from a
/// write another program made in the same second.
///
/// The search index reads the same batch, which makes that filter its blind spot: the one document
/// this stream never mentions is the one the user is typing in, because that is the one this app
/// keeps saving. `fs::file_write` tells the index about its own saves for exactly that reason.
///
/// The root going away takes the watcher with it. A folder deleted or moved out from under a
/// running watch emits one `removed` for the root path and then the watcher is dropped, since a
/// watch on a path that no longer exists reports nothing and would sit in the map forever.
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    roots: State<'_, Roots>,
    watchers: State<'_, Watchers>,
    root_id: String,
) -> Result<(), String> {
    let root_path = roots.path_for(&root_id)?;

    let mut live = watchers.0.lock().map_err(|e| e.to_string())?;
    if live.contains_key(&root_id) {
        return Ok(());
    }

    let handle = app.clone();
    let dead_root = root_path.clone();
    let dead_id = root_id.clone();
    let debouncer = spawn_watcher(root_id.clone(), root_path, move |events| {
        for event in &events {
            handle.emit(WATCH_EVENT, event).ok();
        }
        // The index reads the same batch the frontend does, so a file another program wrote is
        // searchable at the same moment the tree learns about it. It goes here rather than inside
        // `spawn_watcher` because that function is also what the tests drive, with a real folder and
        // no app at all to hold an index.
        crate::index::note_watch_events(&handle, &events);
        if events
            .iter()
            .any(|event| event.kind == "removed" && event.path == dead_root)
        {
            reap(handle.clone(), dead_id.clone());
        }
    })?;

    live.insert(root_id, debouncer);
    Ok(())
}

/// Stops the watcher for one root and drops it. Stopping a watch that is not running is a no-op, so
/// the frontend can close a folder and stop its watcher without having to remember whether it ever
/// started one.
#[tauri::command]
pub fn watch_stop(watchers: State<'_, Watchers>, root_id: String) -> Result<(), String> {
    let mut live = watchers.0.lock().map_err(|e| e.to_string())?;
    live.remove(&root_id);
    Ok(())
}

/// Watches `root_path` recursively and hands each debounced batch to `sink` as `watch-event`
/// payloads. The watch runs until the returned debouncer is dropped.
///
/// `watch_start` is a thin wrapper over this: everything above the Tauri event lives here so the
/// tests can drive a real watcher over a real folder without an app to emit into.
pub fn spawn_watcher<F>(
    root_id: String,
    root_path: String,
    sink: F,
) -> Result<Debouncer<RecommendedWatcher, NoCache>, String>
where
    F: Fn(Vec<WatchEvent>) + Send + 'static,
{
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(format!("not a folder: {root_path}"));
    }
    let canonical = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;

    // Shared rather than owned by the handler, because the root's own disappearance is reported by
    // the watchdog below and not by the debouncer, and both have to emit into the same place. Behind
    // a lock because a sink is only `Send` and not `Sync`, which also has the two take turns rather
    // than interleave two batches in whatever the frontend is doing with them.
    let sink = Arc::new(Mutex::new(sink));
    let watchdog_sink = Arc::downgrade(&sink);

    let watched = canonical.clone();
    let watchdog_id = root_id.clone();
    let watchdog_path = root.clone();
    let handler = move |result: DebounceEventResult| {
        let batch = match result {
            Ok(batch) => batch,
            Err(errors) => {
                for error in errors {
                    eprintln!("watch error under {}: {error}", watched.display());
                }
                return;
            }
        };
        let events = watch_events(&batch, &root_id, &watched, &root);
        if !events.is_empty() {
            if let Ok(sink) = sink.lock() {
                (*sink)(events);
            }
        }
    };

    // Deliberately without the file id cache the crate would otherwise pick. Its whole job is to
    // recognise the two halves of a rename by inode, and on macOS it does more harm than good: it
    // decides the halves belong together, folds the old name's events into the new name's queue,
    // and then throws away the rename event that carried the old name, because FSEvents claims the
    // old name was created. What comes out is a modification of the new path and no word at all
    // that the old path is gone, which leaves a row in the tree for a file that no longer exists.
    // With no cache the two halves stay separate and both ends get reported.
    let mut debouncer: Debouncer<RecommendedWatcher, NoCache> = new_debouncer_opt(
        DEBOUNCE,
        None,
        handler,
        NoCache::new(),
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&canonical, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // The root's own removal is the one change this watcher cannot wait for, so it is asked about
    // instead. An FSEvents stream is placed on a path and hears nothing that happens above that
    // path, and notify does not ask for the flag that would change that, so a parent folder renamed
    // or deleted takes the root with it in complete silence. Even the root's own deletion is a
    // favour rather than a promise: a folder emptied and removed can come back as one coalesced
    // event on the parent, which is not a path this stream matches, and then the whole batch is
    // dropped before anything here sees it. Waiting for an event that may never be sent is what left
    // a folder deleted out from under the app looking open, with a watcher still in the map holding
    // a stream on a path that no longer exists.
    //
    // One stat per debounce tick settles it on any filesystem, and the answer is terminal: nothing
    // further will ever arrive on a stream whose path is gone, so the thread reports the removal and
    // stops. `watch_start` hears that removal like any other and drops the watcher.
    //
    // The thread ends with the watch. The sink is the only thing it holds and it holds it weakly, so
    // once the debouncer is dropped and its own thread lets go of the handler there is nothing left
    // to report into and nothing to report about.
    std::thread::spawn(move || loop {
        std::thread::sleep(DEBOUNCE);
        let Some(sink) = watchdog_sink.upgrade() else {
            return;
        };
        if !is_gone(&canonical) {
            continue;
        }
        if let Ok(sink) = sink.lock() {
            (*sink)(vec![WatchEvent {
                root: watchdog_id.clone(),
                path: watchdog_path.to_string_lossy().into_owned(),
                kind: "removed".to_string(),
                old_path: None,
            }]);
        }
        return;
    });

    Ok(debouncer)
}

/// Drops a root's watcher from another thread.
///
/// The call site is inside the debouncer's own callback, and dropping a debouncer from the thread it
/// is calling you on is asking for a join on yourself. One short-lived thread is the whole fix.
fn reap(app: AppHandle, root_id: String) {
    std::thread::spawn(move || {
        if let Some(watchers) = app.try_state::<Watchers>() {
            if let Ok(mut live) = watchers.0.lock() {
                live.remove(&root_id);
            }
        }
    });
}

/// One debounced batch turned into the events the frontend sees: classified, filtered and reduced
/// to at most one event per path.
fn watch_events(
    batch: &[DebouncedEvent],
    root_id: &str,
    canonical_root: &Path,
    root_path: &Path,
) -> Vec<WatchEvent> {
    let mut events: Vec<WatchEvent> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for event in batch {
        // The kernel dropped events under load and the backend is telling us so. Nothing in the
        // batch describes what was missed, so the honest answer is to report the root as changed
        // and let the frontend read the tree again.
        let next = if event.need_rescan() {
            WatchEvent {
                root: root_id.to_string(),
                path: root_path.to_string_lossy().into_owned(),
                kind: "modified".to_string(),
                old_path: None,
            }
        } else {
            let Some((kind, path, old_path)) = classify(event) else {
                continue;
            };
            // The root itself is exempt from the transient rule: a folder called `.notes` is a
            // perfectly good root, and its own removal is the one event nothing under it can
            // describe.
            if was_self_written(&path)
                || old_path.as_deref().is_some_and(was_self_written)
                || (path.as_path() != canonical_root && is_transient(&path))
                || is_hidden_below(&path, canonical_root)
            {
                continue;
            }
            WatchEvent {
                root: root_id.to_string(),
                path: rebase(&path, canonical_root, root_path),
                kind: kind.to_string(),
                old_path: old_path.map(|path| rebase(&path, canonical_root, root_path)),
            }
        };

        merge(&mut events, &mut index, next);
    }

    // The root itself going away is the one change nothing under it can describe. macOS usually does
    // report it as an event on the watched path, but a folder moved rather than emptied is a single
    // rename this side may never see, so the state of the folder is checked rather than waited for.
    // This is the fast path only: it reports the removal in the same batch as the changes that came
    // with it, and the watchdog in `spawn_watcher` is what makes it certain to be reported at all.
    if is_gone(canonical_root) {
        merge(
            &mut events,
            &mut index,
            WatchEvent {
                root: root_id.to_string(),
                path: root_path.to_string_lossy().into_owned(),
                kind: "removed".to_string(),
                old_path: None,
            },
        );
    }

    events
}

/// Whether the path is not there any more, as against unreadable for some other reason.
///
/// Only a missing file is an answer. A stat that fails because permissions changed or because a
/// volume stopped answering says nothing about whether the folder still exists, and closing the
/// user's open folder on the strength of it would be worse than reporting nothing at all.
fn is_gone(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => false,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

fn merge(events: &mut Vec<WatchEvent>, index: &mut HashMap<String, usize>, next: WatchEvent) {
    match index.get(&next.path) {
        // A later `modified` says nothing a create or a rename in the same batch has not already
        // said, and would lose that event's `old_path`. Anything else supersedes.
        Some(_) if next.kind == "modified" => {}
        Some(&at) => events[at] = next,
        None => {
            index.insert(next.path.clone(), events.len());
            events.push(next);
        }
    }
}

/// The kind, the path it happened to and, for a rename, where the file was before.
///
/// Almost nothing here comes from the event's own kind, and that is deliberate. FSEvents does not
/// describe a change, it describes a file: every event it reports for a path carries the union of
/// everything that has ever happened to that path, so `ItemCreated` is set on the modification of a
/// file that was created last week and on the deletion of one created a second ago. Trusting it
/// would report every save as a create and, once the debouncer has folded a create and a remove
/// together, every deletion as a modification.
///
/// So the file itself is asked instead. The event says which path changed, which is the one thing
/// FSEvents is reliable about, and a stat at the moment of emitting says what it changed into. That
/// is also fresher than the flags: by the time a batch comes out it is at least a debounce window
/// old, and what is on disk now is what the frontend is about to go and read.
fn classify(event: &DebouncedEvent) -> Option<(&'static str, PathBuf, Option<PathBuf>)> {
    let first = event.paths.first()?.clone();

    // The one thing a stat cannot answer afterwards is where a file used to be, so a rename the
    // debouncer managed to stitch back together is read from the event. macOS never gets here: it
    // reports the two ends of a rename as unrelated events and the pairing is left to the inode
    // cache this watcher deliberately does without. A backend that names both ends itself, which
    // inotify does through the rename cookie, still arrives whole.
    if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = &event.kind {
        let to = event.paths.get(1)?.clone();
        if is_transient(&to) || !to.exists() {
            return Some(("removed", first, None));
        }
        if is_transient(&first) {
            // Another editor saving the way this one does: a temp file renamed over the target.
            // Reporting the temp name as the document's previous name would have the frontend go
            // looking for a tree row that never existed.
            return Some((appearance(event, &to), to, None));
        }
        return Some(("renamed", to, Some(first)));
    }

    if matches!(&event.kind, EventKind::Access(_) | EventKind::Other) {
        return None;
    }

    Some((appearance(event, &first), first, None))
}

/// What is at the path now: `created`, `modified` or `removed`.
///
/// Created and modified are told apart by the file's birth time, since nothing else survives to
/// here. A file born within a slack of when the event was raised was born by the change the event
/// describes; anything older was only touched by it. The slack covers the gap between the write
/// landing and the backend seeing it, and erring towards `created` is the cheaper mistake: both
/// kinds mean the same thing to a tree that inserts or refreshes a row, and only `removed` means
/// something a frontend must not get wrong.
fn appearance(event: &DebouncedEvent, path: &Path) -> &'static str {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return "removed";
    };
    let Ok(born) = meta.created() else {
        return "modified";
    };
    let happened = SystemTime::now().checked_sub(event.time.elapsed());
    match (born.checked_add(BIRTH_SLACK), happened) {
        (Some(fresh_until), Some(happened)) if fresh_until >= happened => "created",
        _ => "modified",
    }
}

/// A name no tree row will ever carry: an editor's lock file, swap file or backup, or the temp file
/// half of somebody's atomic save.
///
/// Every path in a batch goes through this, not only the two ends of a rename the debouncer managed
/// to stitch together. macOS never reports a rename whole, so the branch in `classify` that used to
/// be the only caller never ran there, and the temp file of every save in the folder was reported to
/// the frontend as a document appearing and then vanishing.
///
/// This app's own temp file, `.<name>.<unique>.tmp`, is caught twice over, by the leading dot and by
/// the extension. That is on purpose: `note_self_write` already covers it, and a save that somehow
/// outran its two second window should still not put a temp name in front of the user.
fn is_transient(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name.starts_with('.')
        || name.ends_with('~')
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
        || name.ends_with(".swx")
}

/// Whether the path sits under a dot-directory or is a dotfile, counted from the root down.
///
/// The tree hides those, so reporting them would be reporting changes to rows that do not exist:
/// `.git` alone would fire hundreds of times for one checkout. Counted from the root and not from
/// `/` because a root may perfectly well be a folder inside `~/.config`, and that folder's contents
/// are not hidden from anybody.
fn is_hidden_below(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    rel.components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}

/// The path as the frontend knows it: under the root exactly as `Roots` spells it.
///
/// FSEvents reports resolved paths, so a root opened as `/tmp/notes` comes back as
/// `/private/tmp/notes` and every path the frontend holds would fail to match.
fn rebase(path: &Path, canonical_root: &Path, root_path: &Path) -> String {
    match path.strip_prefix(canonical_root) {
        Ok(rel) if rel.as_os_str().is_empty() => root_path.to_string_lossy().into_owned(),
        Ok(rel) => root_path.join(rel).to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// A path with its directory resolved through any symlink, which is the form event paths arrive in.
///
/// The directory and not the path itself, because the file about to be written may not exist yet and
/// there is nothing to canonicalise. macOS alone makes this necessary: `/tmp` and `/var` are
/// symlinks into `/private`, so a document under either would never match the event describing it.
fn resolve(path: &Path) -> PathBuf {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    match std::fs::canonicalize(parent) {
        Ok(dir) => dir.join(name),
        Err(_) => path.to_path_buf(),
    }
}

/// Event paths arrive already resolved, because the watch is placed on the canonicalised root, so
/// they can be looked up as they are.
fn was_self_written(path: &Path) -> bool {
    let Ok(writes) = SELF_WRITES.lock() else {
        return false;
    };
    writes
        .get(path)
        .is_some_and(|at| Instant::now().duration_since(*at) < SELF_WRITE_WINDOW)
}
