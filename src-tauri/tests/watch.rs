// The watcher against a real folder and real filesystem calls, because every interesting thing it
// does is a reaction to what the kernel actually reports rather than to what notify's documentation
// says it reports. FSEvents sets `ItemCreated` on every event it ever emits for a path, describes
// an atomic save as a rename with no relation to the file it replaced, and spells every path
// through /private. None of that is visible from the types.
//
// Waiting is done by writing a probe file and waiting for its event, not by sleeping. Batches are
// delivered oldest first, so the probe's event arriving is proof that everything caused before it
// has already been delivered, which is what makes "nothing was reported" a bounded assertion rather
// than a guess at how long to wait. The one deliberate sleep is in the fixture helper, where a file
// has to be older than the watcher's own idea of newly born for the test to mean anything.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use margin_docs_lib::dto::WatchEvent;
use margin_docs_lib::fs::write_document;
use margin_docs_lib::watch::{note_self_write, spawn_watcher};
use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, NoCache};
use tempfile::TempDir;

/// How long a test waits for the watcher to prove it is running before calling it broken.
const DEADLINE: Duration = Duration::from_secs(15);

/// The debouncer holds an event for 300ms and ticks every quarter of that, so a batch that has not
/// arrived in this long is not on its way.
const QUIET: Duration = Duration::from_millis(900);

/// Comfortably more than the 250ms within which the watcher counts a file as newly born, so that a
/// fixture written by the test is unambiguously a file that was already there.
const AGE: Duration = Duration::from_millis(600);

const ROOT: &str = "root-1";

struct Harness {
    /// Declared first so the watcher stops before the folder it is watching is deleted.
    _watcher: Debouncer<RecommendedWatcher, NoCache>,
    dir: TempDir,
    rx: Receiver<WatchEvent>,
    probes: AtomicU32,
}

impl Harness {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Waits until the watcher is up and throws away whatever it has reported so far.
    fn sync(&self) {
        self.drain();
    }

    /// Everything reported up to a fresh probe file, the probe events themselves left out.
    fn drain(&self) -> Vec<WatchEvent> {
        let give_up = Instant::now() + DEADLINE;
        let mut seen = Vec::new();
        loop {
            let n = self.probes.fetch_add(1, Ordering::Relaxed);
            let probe = self.path(&format!("probe-{n}.md"));
            fs::write(&probe, format!("probe {n}\n")).unwrap();
            let want = probe.to_string_lossy().into_owned();
            loop {
                match self.rx.recv_timeout(QUIET) {
                    Ok(event) if event.path == want => return seen,
                    Ok(event) => {
                        if !is_probe(&event.path) {
                            seen.push(event);
                        }
                    }
                    // Nothing is arriving at all, so the watcher was not yet up when the probe was
                    // written. Write another one.
                    Err(_) => break,
                }
            }
            assert!(
                Instant::now() < give_up,
                "the watcher never reported anything"
            );
        }
    }

    fn events_for(&self, path: &Path) -> Vec<WatchEvent> {
        let want = path.to_string_lossy().into_owned();
        self.drain()
            .into_iter()
            .filter(|event| event.path == want)
            .collect()
    }
}

/// A watched folder holding `fixtures`, all of them old enough to count as files that were already
/// there when the watch started.
fn harness(fixtures: &[&str]) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    for name in fixtures {
        let path = dir.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, format!("# {name}\n")).unwrap();
    }
    if !fixtures.is_empty() {
        std::thread::sleep(AGE);
    }

    let (tx, rx) = mpsc::channel();
    let watcher = spawn_watcher(
        ROOT.to_string(),
        dir.path().to_string_lossy().into_owned(),
        move |events| {
            for event in events {
                tx.send(event).ok();
            }
        },
    )
    .unwrap();
    Harness {
        _watcher: watcher,
        dir,
        rx,
        probes: AtomicU32::new(0),
    }
}

fn is_probe(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("probe-"))
}

fn one<'a>(events: &'a [WatchEvent], what: &str) -> &'a WatchEvent {
    assert_eq!(events.len(), 1, "{what}, got {events:?}");
    &events[0]
}

#[test]
fn a_created_file_is_reported_created() {
    let harness = harness(&[]);
    harness.sync();

    let note = harness.path("note.md");
    fs::write(&note, "# Note\n").unwrap();

    let events = harness.events_for(&note);
    let event = one(&events, "a new file is one event");
    assert_eq!(event.kind, "created");
    assert_eq!(event.root, ROOT);
    assert_eq!(event.old_path, None);
    assert_eq!(event.path, note.to_string_lossy());
}

#[test]
fn a_modified_file_is_reported_modified() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    fs::write(&note, "# Note\n\nA second paragraph.\n").unwrap();

    let events = harness.events_for(&note);
    let event = one(&events, "a write to an existing file is one event");
    assert_eq!(event.kind, "modified");
    assert_eq!(event.old_path, None);
}

#[test]
fn a_deleted_file_is_reported_removed() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    fs::remove_file(&note).unwrap();

    let events = harness.events_for(&note);
    assert_eq!(one(&events, "a delete is one event").kind, "removed");
}

#[test]
fn a_self_write_is_reported_as_nothing() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    note_self_write(&note);
    fs::write(&note, "# Note\n\nWritten by the app itself.\n").unwrap();

    let events = harness.events_for(&note);
    assert!(events.is_empty(), "the app's own write echoed: {events:?}");
}

#[test]
fn the_apps_own_atomic_save_is_reported_as_nothing() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    let temp = harness.path("note.md.tmp");
    harness.sync();

    // Both halves have to be registered. The rename names the temp file as well as the document,
    // and either name getting through would let the echo through with it.
    note_self_write(&temp);
    note_self_write(&note);
    fs::write(&temp, "# Note\n\nWritten by the app itself.\n").unwrap();
    fs::rename(&temp, &note).unwrap();

    let events = harness.drain();
    assert!(
        events.is_empty(),
        "the app's own atomic save echoed: {events:?}"
    );
}

/// The two tests above register the paths by hand, which proves the mechanism and not that anything
/// uses it. This one goes through the real write path: a save of a document reaches the frontend as
/// nothing at all, neither the document nor the temp file it went through.
#[test]
fn a_real_save_is_reported_as_nothing() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    write_document(&note, "# Note\n\nSaved by the app itself.\n", None).unwrap();

    let events = harness.drain();
    assert!(
        events.is_empty(),
        "the app's own save came back as an external change: {events:?}"
    );
}

#[test]
fn a_self_write_stops_suppressing_once_the_window_is_up() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    note_self_write(&note);
    fs::write(&note, "one\n").unwrap();
    assert!(harness.events_for(&note).is_empty());

    // The suppression is a window and not a switch: a later write to the same path, by the app or
    // by anything else, has to come through again once the window is up.
    std::thread::sleep(Duration::from_millis(2_100));
    fs::write(&note, "two\n").unwrap();

    let events = harness.events_for(&note);
    assert_eq!(
        one(&events, "the write after the window is one event").kind,
        "modified"
    );
}

#[test]
fn a_burst_of_writes_is_not_a_burst_of_events() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    for n in 0..10 {
        fs::write(&note, format!("# Note\n\nRevision {n}.\n")).unwrap();
    }

    let events = harness.events_for(&note);
    assert!(
        (1..=2).contains(&events.len()),
        "ten writes should coalesce, got {events:?}"
    );
    assert!(events.iter().all(|event| event.kind == "modified"));
}

#[test]
fn a_rename_is_reported_at_both_ends() {
    let harness = harness(&["before.md"]);
    let before = harness.path("before.md");
    let after = harness.path("after.md");
    harness.sync();

    fs::rename(&before, &after).unwrap();

    let events = harness.drain();
    let gone = events
        .iter()
        .find(|event| event.path == before.to_string_lossy())
        .unwrap_or_else(|| panic!("the old name was not reported: {events:?}"));
    assert_eq!(gone.kind, "removed");

    // Not `renamed`. FSEvents reports the two ends as unrelated events and marks both of them
    // created, which defeats the debouncer's attempt to pair them up, so the honest report is that
    // one name went away and another appeared.
    let arrived = events
        .iter()
        .find(|event| event.path == after.to_string_lossy())
        .unwrap_or_else(|| panic!("the new name was not reported: {events:?}"));
    assert_ne!(arrived.kind, "removed");
    if let Some(old) = &arrived.old_path {
        assert_eq!(old, &*before.to_string_lossy());
    }
}

#[test]
fn another_editors_atomic_save_is_one_event_on_the_document() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    let temp = harness.path(".note.md.tmp");
    harness.sync();

    fs::write(&temp, "# Note\n\nSaved by something else.\n").unwrap();
    fs::rename(&temp, &note).unwrap();

    let events = harness.drain();
    assert!(
        events
            .iter()
            .all(|event| event.path != temp.to_string_lossy()),
        "the temp file was reported as if it were a document: {events:?}"
    );
    let on_note: Vec<_> = events
        .into_iter()
        .filter(|event| event.path == note.to_string_lossy())
        .collect();
    let event = one(&on_note, "an atomic save is one event on the document");
    assert_ne!(event.kind, "removed");
    assert_eq!(
        event.old_path, None,
        "the document was reported as renamed from a temp file it never was"
    );
}

#[test]
fn hidden_paths_are_not_reported() {
    let harness = harness(&[]);
    harness.sync();

    fs::create_dir_all(harness.path(".git")).unwrap();
    fs::write(harness.path(".git/index"), "not a document").unwrap();
    fs::write(harness.path(".DS_Store"), "not a document either").unwrap();
    let note = harness.path("note.md");
    fs::write(&note, "# Note\n").unwrap();

    let events = harness.drain();
    assert!(
        events
            .iter()
            .all(|event| event.path == note.to_string_lossy()),
        "hidden paths reached the frontend: {events:?}"
    );
}

#[test]
fn nested_changes_are_reported_under_the_path_the_root_was_opened_as() {
    let harness = harness(&["sub/deep.md"]);
    let nested = harness.path("sub/deep.md");
    harness.sync();

    fs::write(&nested, "# Deep\n\nEdited.\n").unwrap();

    let events = harness.events_for(&nested);
    let event = one(&events, "a nested file is one event");
    assert_eq!(event.kind, "modified");
    // Not the /private form FSEvents hands out, which nothing else in the app spells that way.
    assert!(event
        .path
        .starts_with(&*harness.dir.path().to_string_lossy()));
}

#[test]
fn a_deleted_root_is_reported_removed() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("notes");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("note.md"), "# Note\n").unwrap();

    let (tx, rx) = mpsc::channel();
    let watcher = spawn_watcher(
        ROOT.to_string(),
        root.to_string_lossy().into_owned(),
        move |events| {
            for event in events {
                tx.send(event).ok();
            }
        },
    )
    .unwrap();

    let give_up = Instant::now() + DEADLINE;
    let mut live = false;
    let mut probe = 0;
    while !live {
        fs::write(root.join(format!("probe-{probe}.md")), "probe\n").unwrap();
        probe += 1;
        live = rx.recv_timeout(QUIET).is_ok();
        assert!(
            live || Instant::now() < give_up,
            "the watcher never reported anything"
        );
    }

    fs::remove_dir_all(&root).unwrap();

    let want = root.to_string_lossy().into_owned();
    let give_up = Instant::now() + DEADLINE;
    let mut removed = false;
    while !removed && Instant::now() < give_up {
        match rx.recv_timeout(QUIET) {
            Ok(event) => removed = event.path == want && event.kind == "removed",
            // A quiet window is not an answer, it is the absence of one. FSEvents coalesces on its
            // own schedule, so on a loaded machine the first 900ms can pass with nothing in it and
            // the removal still arrive comfortably inside the 15s deadline. Breaking here gave up
            // after one such window and made the test a coin flip on any runner slower than this
            // laptop. Only a dropped sender means no answer is ever coming.
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(removed, "deleting the root reported nothing");

    drop(watcher);
}

#[test]
fn a_watch_on_a_folder_that_is_not_there_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("gone");
    let started = spawn_watcher(
        ROOT.to_string(),
        missing.to_string_lossy().into_owned(),
        |_| {},
    );
    assert!(started.is_err());
}
