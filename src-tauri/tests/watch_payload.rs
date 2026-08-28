// The shape of a `watch-event` as the frontend receives it, rather than as Rust holds it.
//
// src-tauri/tests/watch.rs proves the watcher reports the right things about the right paths, but
// it asserts against `WatchEvent`'s Rust fields, and the frontend never sees those. What crosses
// the IPC boundary is serde's JSON, and the frontend reads `event.payload.oldPath` off it. A
// missing `#[serde(rename_all = "camelCase")]` would leave every Rust test green and hand the
// frontend `old_path`, which reads as `undefined`, which is neither the string nor the null the
// TypeScript type promises. Nothing else in the suite would notice.
//
// So this file drives the same real watcher over a real folder and asserts the serialized object
// exactly: every key, no extra keys, and the literal values the TypeScript union in src/ipc.ts
// lists. Between this and the Playwright suite in tests/external-changes.spec.ts, which feeds
// payloads of this shape through the real Tauri listener into the real UI, both ends of the wire
// are pinned to the same object.
//
// The waiting strategy is the one watch.rs uses and for the same reason: a probe file whose event
// proves everything caused before it has already been delivered.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use margin_docs_lib::dto::WatchEvent;
use margin_docs_lib::watch::spawn_watcher;
use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, NoCache};
use serde_json::{json, Value};
use tempfile::TempDir;

const DEADLINE: Duration = Duration::from_secs(15);
const QUIET: Duration = Duration::from_millis(900);
const AGE: Duration = Duration::from_millis(600);
const ROOT: &str = "root-1";

struct Harness {
    _watcher: Debouncer<RecommendedWatcher, NoCache>,
    dir: TempDir,
    rx: Receiver<WatchEvent>,
    probes: AtomicU32,
}

impl Harness {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn sync(&self) {
        self.drain();
    }

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
                    Err(_) => break,
                }
            }
            assert!(
                Instant::now() < give_up,
                "the watcher never reported anything"
            );
        }
    }

    /// The one event for `path`, as the JSON object the frontend will be handed.
    fn payload_for(&self, path: &Path) -> Value {
        let want = path.to_string_lossy().into_owned();
        let events: Vec<WatchEvent> = self
            .drain()
            .into_iter()
            .filter(|event| event.path == want)
            .collect();
        assert_eq!(events.len(), 1, "expected one event, got {events:?}");
        serde_json::to_value(&events[0]).unwrap()
    }
}

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

/// Exactly these four keys, spelled the way `WatchEvent` in src/ipc.ts spells them.
fn expect_payload(actual: &Value, path: &Path, kind: &str) {
    assert_eq!(
        actual,
        &json!({
            "root": ROOT,
            "path": path.to_string_lossy(),
            "kind": kind,
            "oldPath": Value::Null,
        }),
        "the payload the frontend receives is not the object it is typed as"
    );
}

#[test]
fn an_external_edit_serialises_as_the_frontend_reads_it() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    fs::write(&note, "# Note\n\nEdited by another program.\n").unwrap();

    expect_payload(&harness.payload_for(&note), &note, "modified");
}

#[test]
fn a_created_file_serialises_as_the_frontend_reads_it() {
    let harness = harness(&[]);
    harness.sync();

    let note = harness.path("note.md");
    fs::write(&note, "# Note\n").unwrap();

    expect_payload(&harness.payload_for(&note), &note, "created");
}

#[test]
fn a_deleted_file_serialises_as_the_frontend_reads_it() {
    let harness = harness(&["note.md"]);
    let note = harness.path("note.md");
    harness.sync();

    fs::remove_file(&note).unwrap();

    expect_payload(&harness.payload_for(&note), &note, "removed");
}

/// `old_path` is the one field whose name differs between the two languages, and the only one that
/// is ever anything but a plain string. A rename is where it would be filled in if it ever were,
/// so this is where a wrong spelling would do its damage.
#[test]
fn old_path_is_spelled_the_way_the_frontend_reads_it() {
    let renamed = WatchEvent {
        root: ROOT.to_string(),
        path: "/tmp/after.md".to_string(),
        kind: "renamed".to_string(),
        old_path: Some("/tmp/before.md".to_string()),
    };
    assert_eq!(
        serde_json::to_value(&renamed).unwrap(),
        json!({
            "root": ROOT,
            "path": "/tmp/after.md",
            "kind": "renamed",
            "oldPath": "/tmp/before.md",
        })
    );
}

/// A source-literal check and nothing more: it cannot see a running app. What it does catch is the
/// one silent break the runtime tests on either side cannot, because each side is internally
/// consistent with its own constant. Rename the event on one side and the frontend simply stops
/// hearing anything, with every test still green.
#[test]
fn both_sides_name_the_event_the_same_string() {
    assert!(
        include_str!("../src/watch.rs").contains(r#"const WATCH_EVENT: &str = "watch-event";"#),
        "the backend no longer emits under `watch-event`"
    );
    assert!(
        include_str!("../../src/ipc.ts").contains(r#"export const WATCH_EVENT = "watch-event";"#),
        "the frontend no longer listens for `watch-event`"
    );
}
