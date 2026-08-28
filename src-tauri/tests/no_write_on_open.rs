// Does the editor touch files the user has not edited?
//
// Every test here runs against a real git repository on disk (a docs folder with subfolders, an
// assets folder, a .gitignore and a vendored node_modules) rather than against a TempDir, because
// the promise being checked is a promise about the user's own folder: the evidence that nothing was
// touched is `git status` being empty, plus a byte-level snapshot of every path under the root
// including .git itself.
//
// The repository is built by the suite, under /private/tmp, on the first test that asks for it, and
// there is nothing to set up by hand. `tests/support/notes_repo.rs` is where it comes from.
//
// Run single threaded. The tests share one folder and several of them mutate it.
//
//     cargo test --test no_write_on_open -- --test-threads=1 --nocapture

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use margin_docs_lib::dto::{FileNode, WatchEvent};
use margin_docs_lib::fs::{
    read_document, resolve_in_roots, root_id_for, scan_tree, write_document,
};
use margin_docs_lib::watch::spawn_watcher;

#[path = "support/notes_repo.rs"]
mod notes_repo;

// ---------------------------------------------------------------- fixture

/// The fixture repository, built on the first call and shared by every test after it.
fn repo() -> PathBuf {
    let path = notes_repo::path().to_path_buf();
    assert!(
        path.join(".git").is_dir(),
        "the fixture repo is missing: {}",
        path.display()
    );
    path
}

fn git(args: &[&str]) -> String {
    notes_repo::git(args)
}

/// Back to the committed state, then one warm `git status` so the index's stat cache is already
/// refreshed and a later `git status` is not itself the thing that wrote to .git.
fn pristine() -> PathBuf {
    let root = repo();
    git(&["reset", "--hard", "-q"]);
    git(&["clean", "-fdq"]);
    let status = git(&["status", "--porcelain"]);
    assert!(
        status.is_empty(),
        "the fixture repo did not start clean:\n{status}"
    );
    root
}

fn git_status() -> String {
    git(&["status", "--porcelain"])
}

// ---------------------------------------------------------------- snapshots

#[derive(Clone, PartialEq, Eq, Debug)]
struct Stamp {
    kind: &'static str,
    len: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
    ino: u64,
    mode: u32,
    nlink: u64,
    /// Content hash, for everything outside node_modules. `None` for directories and for the
    /// 11,000 junk files, where size plus both timestamps plus the inode is already conclusive.
    hash: Option<u64>,
}

type Snapshot = BTreeMap<String, Stamp>;

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Every path under `root`, dotfiles, .git and node_modules included. Deliberately not the `ignore`
/// crate: the point is to see everything the app might have touched, including what it hides.
fn snapshot(root: &Path) -> Snapshot {
    let mut out = Snapshot::new();
    walk(root, root, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Snapshot) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let kind = if meta.is_dir() {
            "dir"
        } else if meta.is_symlink() {
            "link"
        } else {
            "file"
        };
        let cheap = rel.starts_with("node_modules/") || rel.starts_with(".git/");
        let hash = if kind == "file" && !cheap {
            fs::read(&path).ok().map(|bytes| fnv1a(&bytes))
        } else {
            None
        };
        out.insert(
            rel,
            Stamp {
                kind,
                len: meta.len(),
                mtime: (meta.mtime(), meta.mtime_nsec()),
                ctime: (meta.ctime(), meta.ctime_nsec()),
                ino: meta.ino(),
                mode: meta.mode(),
                nlink: meta.nlink(),
                hash,
            },
        );
        if meta.is_dir() {
            walk(root, &path, out);
        }
    }
}

#[derive(Default, Debug)]
struct Diff {
    added: Vec<String>,
    removed: Vec<String>,
    changed: Vec<String>,
}

impl Diff {
    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty()
    }
}

fn diff(before: &Snapshot, after: &Snapshot) -> Diff {
    let mut out = Diff::default();
    for (path, stamp) in after {
        match before.get(path) {
            None => out.added.push(path.clone()),
            Some(was) if was != stamp => out.changed.push(format!(
                "{path}\n      was {was:?}\n      now {stamp:?}"
            )),
            Some(_) => {}
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            out.removed.push(path.clone());
        }
    }
    out
}

fn assert_untouched(label: &str, before: &Snapshot, after: &Snapshot) {
    let d = diff(before, after);
    assert!(
        d.is_empty(),
        "{label} touched the folder\n  added: {:?}\n  removed: {:?}\n  changed:\n    {}",
        d.added,
        d.removed,
        d.changed.join("\n    ")
    );
    println!("  [{label}] {} paths, none touched", before.len());
}

fn assert_clean(label: &str) {
    let status = git_status();
    println!("  [{label}] git status --porcelain:\n{}", quoted(&status));
    assert!(status.is_empty(), "{label} left git dirty:\n{status}");
}

fn quoted(status: &str) -> String {
    if status.is_empty() {
        "    <empty: working tree clean>".to_string()
    } else {
        status
            .lines()
            .map(|line| format!("    {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

// ---------------------------------------------------------------- tree helpers

fn flatten(node: &FileNode, into: &mut Vec<String>) {
    into.push(node.path.clone());
    for child in &node.children {
        flatten(child, into);
    }
}

fn all_paths(node: &FileNode) -> Vec<String> {
    let mut out = Vec::new();
    flatten(node, &mut out);
    out
}

fn child_names(node: &FileNode) -> Vec<String> {
    node.children.iter().map(|c| c.name.clone()).collect()
}

/// What `file_read` does, minus the Tauri `State`: the same path gate, then the same read.
fn file_read(root: &Path, path: &str) -> Result<String, String> {
    let roots = vec![root.to_string_lossy().into_owned()];
    let checked = resolve_in_roots(&roots, path)?;
    read_document(&checked).map(|r| r.text)
}

// ================================================================ 1. scanning

#[test]
fn scanning_the_tree_writes_nothing() {
    let root = pristine();

    let before = snapshot(&root);
    let started = Instant::now();
    let tree = scan_tree(&root, false).expect("a tree");
    let took = started.elapsed();
    let after = snapshot(&root);

    println!("scan_tree: {} rows in {took:?}", all_paths(&tree).len());
    println!("root children: {:?}", child_names(&tree));
    assert_untouched("scan_tree", &before, &after);
    assert_clean("scan_tree");

    // The root id is derived from the path, never persisted into the folder.
    println!("root id: {}", root_id_for(&root.to_string_lossy()));
}

// ================================================================ 2. reading

#[test]
fn reading_every_document_writes_nothing() {
    let root = pristine();
    let tree = scan_tree(&root, false).expect("a tree");

    let mut docs: Vec<String> = Vec::new();
    collect_editable(&tree, &mut docs);
    assert!(docs.len() >= 10, "expected a realistic docs folder, got {docs:?}");

    let before = snapshot(&root);
    let mut bytes = 0usize;
    for path in &docs {
        let text = file_read(&root, path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        bytes += text.len();
    }
    let after = snapshot(&root);

    println!("read {} documents, {bytes} bytes", docs.len());
    assert_untouched("file_read x N", &before, &after);
    assert_clean("file_read x N");
}

fn collect_editable(node: &FileNode, into: &mut Vec<String>) {
    if node.editable {
        into.push(node.path.clone());
    }
    for child in &node.children {
        collect_editable(child, into);
    }
}

// ================================================================ 3. open then close

#[test]
fn opening_a_document_and_closing_it_writes_nothing() {
    let root = pristine();
    let doc = root.join("docs/architecture.md");
    let path = doc.to_string_lossy().into_owned();

    let before = snapshot(&root);

    // Open: the store's `open` calls `loadDocument`, which is one `file_read` and nothing else.
    let text = file_read(&root, &path).expect("the document");
    assert!(!text.is_empty());
    // Close: `useDocument.close()` flushes only when the buffer is dirty, and it is not. Nothing
    // reaches the backend at all, so there is nothing to call here. That absence is the test.
    let after = snapshot(&root);

    assert_untouched("open then close", &before, &after);
    assert_clean("open then close");
}

// ================================================================ 4. the watcher

#[test]
fn the_watcher_does_not_cause_a_write() {
    let root = pristine();
    let (tx, rx) = mpsc::channel::<WatchEvent>();

    let before = snapshot(&root);
    let watcher = spawn_watcher(
        "root-1".to_string(),
        root.to_string_lossy().into_owned(),
        move |events| {
            for event in events {
                tx.send(event).ok();
            }
        },
    )
    .expect("a watcher");

    // Long enough for a watcher that was going to write something to have written it: FSEvents
    // establishes its stream, the debouncer ticks every 75ms, and 3s is ten times its window.
    std::thread::sleep(Duration::from_secs(3));

    // And a full read pass while the watch is live, which is the shape of real use.
    let tree = scan_tree(&root, false).expect("a tree");
    let mut docs = Vec::new();
    collect_editable(&tree, &mut docs);
    for path in &docs {
        file_read(&root, path).expect("a read");
    }
    std::thread::sleep(Duration::from_secs(2));

    let after = snapshot(&root);
    drop(watcher);

    let events: Vec<WatchEvent> = rx.try_iter().collect();
    println!(
        "watcher ran 5s over {} paths and emitted {} events: {:?}",
        before.len(),
        events.len(),
        events
            .iter()
            .map(|e| format!("{} {}", e.kind, e.path))
            .collect::<Vec<_>>()
    );
    assert!(
        events.is_empty(),
        "the watcher reported changes when nothing changed"
    );
    assert_untouched("watcher idle + reads", &before, &after);
    assert_clean("watcher idle + reads");
}

// ================================================================ 5. node_modules

#[test]
fn node_modules_is_skipped_rather_than_walked() {
    let root = pristine();
    let junk = root.join("node_modules");
    let junk_files = snapshot(&junk).len();
    assert!(junk_files > 5_000, "the fixture needs a real node_modules");

    let started = Instant::now();
    let skipped = scan_tree(&root, false).expect("a tree");
    let skipped_ms = started.elapsed();
    let skipped_rows = all_paths(&skipped).len();

    let started = Instant::now();
    let walked = scan_tree(&root, true).expect("a tree");
    let walked_ms = started.elapsed();
    let walked_rows = all_paths(&walked).len();

    let started = Instant::now();
    let alone = scan_tree(&junk, true).expect("a tree");
    let alone_ms = started.elapsed();

    println!("node_modules holds {junk_files} entries");
    println!("scan_tree(show_ignored=false): {skipped_rows} rows in {skipped_ms:?}");
    println!("scan_tree(show_ignored=true):  {walked_rows} rows in {walked_ms:?}");
    println!(
        "scan_tree(node_modules alone): {} rows in {alone_ms:?}",
        all_paths(&alone).len()
    );

    assert!(
        !child_names(&skipped).contains(&"node_modules".to_string()),
        "node_modules is in the tree: {:?}",
        child_names(&skipped)
    );
    assert!(
        !all_paths(&skipped)
            .iter()
            .any(|p| p.contains("node_modules")),
        "something under node_modules reached the tree"
    );
    assert!(
        skipped_rows < 40,
        "the skipped scan returned {skipped_rows} rows, so it walked more than the documents"
    );
    assert!(
        child_names(&walked).contains(&"node_modules".to_string()),
        "show_ignored did not turn the skip off"
    );
    assert!(
        walked_rows > 10_000,
        "show_ignored=true only found {walked_rows} rows"
    );
    // Skipping is not merely a filter over a walk that happened anyway.
    assert!(
        skipped_ms * 10 < walked_ms,
        "skipping node_modules ({skipped_ms:?}) was not much faster than walking it ({walked_ms:?})"
    );
    // And walking it, when asked to, is not absurd either.
    assert!(
        walked_ms < Duration::from_secs(20),
        "walking node_modules took {walked_ms:?}"
    );

    let after = snapshot(&root);
    assert_eq!(after.len(), snapshot(&root).len());
    assert_clean("three scans");
}

// ================================================================ 6. one write, one file

#[test]
fn a_write_to_one_file_leaves_every_other_file_alone() {
    let root = pristine();
    let target = root.join("docs/architecture.md");

    let read = read_document(&target).expect("the document");
    let before = snapshot(&root);

    let result = write_document(&target, &format!("{}\n\nAn edit.\n", read.text), Some(read.modified_ms))
        .expect("the write");
    assert!(!result.conflict);

    let after = snapshot(&root);
    let d = diff(&before, &after);

    println!("added:   {:?}", d.added);
    println!("removed: {:?}", d.removed);
    println!(
        "changed: {:?}",
        d.changed
            .iter()
            .map(|c| c.lines().next().unwrap_or_default().to_string())
            .collect::<Vec<_>>()
    );

    let status = git_status();
    println!("git status --porcelain after one write:\n{}", quoted(&status));

    // .git moves because git status re-reads it; that is git's doing, not the editor's.
    let touched: Vec<&String> = d
        .changed
        .iter()
        .filter(|c| !c.starts_with(".git/") && !c.starts_with(".git\n"))
        .collect();
    assert!(d.added.is_empty(), "the write added files: {:?}", d.added);
    assert!(
        d.removed.is_empty(),
        "the write removed files: {:?}",
        d.removed
    );
    assert_eq!(
        touched.len(),
        2,
        "expected only docs/architecture.md and its parent dir to move, got:\n{}",
        d.changed.join("\n")
    );
    assert_eq!(
        status.lines().collect::<Vec<_>>(),
        vec![" M docs/architecture.md"],
        "one edit should be one line of git status"
    );
}

// ================================================================ 7. the .bak

#[test]
fn a_write_leaves_no_bak_behind_once_it_has_finished() {
    let root = pristine();
    let target = root.join("docs/guides/mobile.md");
    let read = read_document(&target).expect("the document");

    write_document(&target, &format!("{}\nedited\n", read.text), Some(read.modified_ms))
        .expect("the write");

    let leftovers: Vec<String> = snapshot(&root)
        .keys()
        .filter(|p| !p.starts_with(".git/"))
        .filter(|p| p.ends_with(".bak") || p.ends_with(".tmp"))
        .cloned()
        .collect();
    println!("*.bak and *.tmp under the root after a completed write: {leftovers:?}");

    // The two the fixture committed on purpose are the user's own and must still be there.
    assert!(leftovers.contains(&"docs/design.md.bak".to_string()));
    assert!(leftovers.contains(&"docs/conventions.md.tmp".to_string()));
    assert_eq!(
        leftovers.len(),
        2,
        "the write left a backup or temp file behind: {leftovers:?}"
    );
    println!("git status --porcelain:\n{}", quoted(&git_status()));
}

/// Nothing visible may appear inside the user's folder while a write is running, because git,
/// Dropbox, a backup tool and the app's own watcher are all looking at that folder too.
#[test]
fn a_save_puts_nothing_visible_in_the_folder_even_for_an_instant() {
    let root = pristine();
    let target = root.join("docs/big.md");
    // Big enough that the copy-then-fsync window is wide enough to observe. Untracked, and removed
    // at the end of the test.
    let payload = "x".repeat(48 * 1024 * 1024);
    fs::write(&target, &payload).expect("the fixture document");

    // This test used to assert the opposite. It was written to prove the bug that a save put a
    // `docs/big.md.bak` and a `docs/big.md.tmp` inside the user's folder, where git, a backup tool
    // or another editor would see them, and where a crash stranded them. The `.bak` is gone and the
    // temp file is now hidden and uniquely named, so the same window is now the proof of the fix.
    let docs = root.join("docs");
    let before: Vec<String> = fs::read_dir(&docs)
        .expect("the docs folder")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    let sightings = Arc::new(Mutex::new(Vec::<String>::new()));

    let watching = sightings.clone();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let poller = std::thread::spawn(move || {
        while stop_rx.try_recv().is_err() {
            let Ok(entries) = fs::read_dir(&docs) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == "big.md" {
                    continue;
                }
                let mut seen = watching.lock().unwrap();
                if !seen.contains(&name) {
                    seen.push(name);
                }
            }
        }
    });

    let second = format!("{payload}y");
    write_document(&target, &second, None).expect("the write");
    stop_tx.send(()).ok();
    poller.join().ok();

    let seen = sightings.lock().unwrap().clone();
    println!("seen inside docs/ during one save: {seen:?}");
    println!("git status --porcelain after the save:\n{}", quoted(&git_status()));

    fs::remove_file(&target).ok();

    // Diff against what was there before rather than an allowlist, because two of the files that
    // survive a save are the planted user owned `design.md.bak` and `conventions.md.tmp`, and
    // hardcoding those would mean this test stopped noticing if a save started creating them.
    let from_the_save: Vec<&String> = seen.iter().filter(|name| !before.contains(*name)).collect();

    assert!(
        from_the_save.iter().all(|name| name.starts_with('.')),
        "a save must not put a visible file in the user's folder, even for an instant: {from_the_save:?}"
    );
    assert!(
        !from_the_save.iter().any(|name| name.ends_with(".bak")),
        "the .bak rotation is gone and must stay gone: {from_the_save:?}"
    );
    assert!(
        from_the_save.iter().all(|name| !name.starts_with(".big.md.tmp")),
        "the temp name must carry the pid and a stamp so two saves cannot collide: {from_the_save:?}"
    );
}

/// The same window, but seen through the app's own watcher: does a `.bak` path reach the frontend?
#[test]
fn the_watcher_reports_the_bak_and_tmp_to_the_frontend() {
    let root = pristine();
    let (tx, rx) = mpsc::channel::<WatchEvent>();
    let watcher = spawn_watcher(
        "root-1".to_string(),
        root.to_string_lossy().into_owned(),
        move |events| {
            for event in events {
                tx.send(event).ok();
            }
        },
    )
    .expect("a watcher");
    std::thread::sleep(Duration::from_secs(2));
    while rx.try_recv().is_ok() {}

    let target = root.join("docs/design.md");
    let read = read_document(&target).expect("the document");
    write_document(&target, &format!("{}\nedited\n", read.text), Some(read.modified_ms))
        .expect("the write");

    std::thread::sleep(Duration::from_secs(3));
    drop(watcher);

    let events: Vec<String> = rx
        .try_iter()
        .map(|e| format!("{} {}", e.kind, e.path))
        .collect();
    println!("watch events for one save of docs/design.md:");
    for event in &events {
        println!("    {event}");
    }
    println!("git status --porcelain:\n{}", quoted(&git_status()));

    // Not an assertion about what is right, just a record of what the frontend is handed.
    let noise: Vec<&String> = events
        .iter()
        .filter(|e| e.ends_with(".bak") || e.ends_with(".tmp"))
        .collect();
    println!("of which temp/backup paths: {noise:?}");
}

// ================================================================ 8. collateral

/// A write to `x.md` unlinks `x.md.bak` and `x.md.tmp` if the user happens to have files by those
/// names. Neither is a file the user edited, and neither goes to the Trash.
#[test]
fn a_write_deletes_a_sibling_bak_the_user_owns() {
    let root = pristine();

    let bak = root.join("docs/design.md.bak");
    let tmp = root.join("docs/conventions.md.tmp");
    let bak_text = fs::read_to_string(&bak).expect("the user's own backup");
    let tmp_text = fs::read_to_string(&tmp).expect("the user's own scratch file");
    println!("before: docs/design.md.bak = {bak_text:?}");
    println!("before: docs/conventions.md.tmp = {tmp_text:?}");
    println!("both are tracked: {}", git(&["ls-files", "docs/"]).replace('\n', " "));

    let design = root.join("docs/design.md");
    let read = read_document(&design).expect("the document");
    write_document(&design, &format!("{}\nedited\n", read.text), Some(read.modified_ms))
        .expect("the write");

    let conventions = root.join("docs/conventions.md");
    let read = read_document(&conventions).expect("the document");
    write_document(
        &conventions,
        &format!("{}\nedited\n", read.text),
        Some(read.modified_ms),
    )
    .expect("the write");

    let status = git_status();
    println!("git status --porcelain after editing design.md and conventions.md:\n{}", quoted(&status));

    let bak_gone = !bak.exists();
    let tmp_gone = !tmp.exists();
    println!("docs/design.md.bak still there: {}", !bak_gone);
    println!("docs/conventions.md.tmp still there: {}", !tmp_gone);

    assert!(
        !bak_gone && !tmp_gone,
        "editing design.md and conventions.md deleted files the user never opened:\n{status}"
    );
}

// ================================================================ 9. is it really skipped?

/// Timing says node_modules is skipped rather than filtered after the fact. Taking away the right
/// to read it says so without a stopwatch: a walk that entered it would come back with rows from
/// it, or with an error, and this one comes back with neither.
#[test]
fn node_modules_is_not_entered_at_all() {
    let root = pristine();
    let junk = root.join("node_modules");

    let locked = fs::Permissions::from_mode(0o000);
    let open = fs::metadata(&junk).expect("node_modules").permissions();
    fs::set_permissions(&junk, locked).expect("lock node_modules");

    let started = Instant::now();
    let tree = scan_tree(&root, false);
    let took = started.elapsed();

    fs::set_permissions(&junk, open).expect("unlock node_modules");

    let tree = tree.expect("an unreadable node_modules must not fail the scan");
    let rows = all_paths(&tree);
    println!("scan with node_modules at mode 000: {} rows in {took:?}", rows.len());
    println!("root children: {:?}", child_names(&tree));
    assert!(!rows.iter().any(|p| p.contains("node_modules")));
    assert_eq!(rows.len(), 21);
    assert_clean("scan with node_modules locked");
}

use std::os::unix::fs::PermissionsExt;

// ================================================================ 10. atime

/// A read is not a write, but it does bump the access time on some volumes. Recorded rather than
/// asserted: the question is whether anything about the file the user can see has changed, and
/// mtime, ctime, size and bytes are what that means.
#[test]
fn what_a_read_actually_changes() {
    let root = pristine();
    let doc = root.join("docs/architecture.md");

    let before = fs::metadata(&doc).expect("the document");
    std::thread::sleep(Duration::from_millis(50));
    let _ = file_read(&root, &doc.to_string_lossy()).expect("the read");
    let after = fs::metadata(&doc).expect("the document");

    println!(
        "atime {}.{:09} -> {}.{:09}  ({})",
        before.atime(),
        before.atime_nsec(),
        after.atime(),
        after.atime_nsec(),
        if (before.atime(), before.atime_nsec()) == (after.atime(), after.atime_nsec()) {
            "unchanged"
        } else {
            "bumped by the read"
        }
    );
    assert_eq!(before.mtime_nsec(), after.mtime_nsec());
    assert_eq!(before.ctime_nsec(), after.ctime_nsec());
    assert_eq!(before.len(), after.len());
    assert_clean("one read");
}

// ================================================================ 11. two saves at once

/// The temp file and the backup are named after the target and nothing else, so two writes to one
/// document race on the same two paths, and the loser of the race can take the document with it.
/// A debounced autosave landing while Cmd+S is in flight is exactly that shape.
#[test]
fn concurrent_saves_of_one_document() {
    const TRIALS: usize = 15;
    const PAYLOAD: usize = 2 * 1024 * 1024;

    let mut worst: Vec<String> = Vec::new();
    for writers in [2usize, 3, 4, 8] {
        let mut lost = 0;
        let mut torn = 0;
        let mut leftovers: Vec<String> = Vec::new();
        let mut first_status = String::new();

        for _ in 0..TRIALS {
            let root = pristine();
            let doc = root.join("docs/guides/setup.md");
            let seen = read_document(&doc).expect("the document").modified_ms;

            // Every save carries the same expected mtime, because in the app they all come from the
            // same read: the conflict guard lets all of them through.
            let payloads: Vec<String> = (0..writers)
                .map(|n| format!("save number {n}\n{}\n", "z".repeat(PAYLOAD)))
                .collect();
            let handles: Vec<_> = payloads
                .iter()
                .cloned()
                .map(|text| {
                    let doc = doc.clone();
                    std::thread::spawn(move || write_document(&doc, &text, Some(seen)).err())
                })
                .collect();
            let _errors: Vec<String> = handles
                .into_iter()
                .filter_map(|h| h.join().expect("a thread"))
                .collect();

            match fs::read_to_string(&doc).ok() {
                None => {
                    lost += 1;
                    if first_status.is_empty() {
                        first_status = git_status();
                    }
                }
                Some(text) if !payloads.contains(&text) => torn += 1,
                Some(_) => {}
            }
            for path in snapshot(&root).keys() {
                if path.starts_with(".git/") {
                    continue;
                }
                let owned = path == "docs/conventions.md.tmp" || path == "docs/design.md.bak";
                if (path.ends_with(".bak") || path.ends_with(".tmp")) && !owned {
                    leftovers.push(path.clone());
                }
            }
        }

        println!(
            "{writers} concurrent saves x {TRIALS} trials: {lost} destroyed the document, {torn} left it torn, leftovers {leftovers:?}"
        );
        if !first_status.is_empty() {
            println!("    git status --porcelain from a trial that lost it:\n{}", quoted(&first_status));
        }
        if lost > 0 || torn > 0 || !leftovers.is_empty() {
            worst.push(format!(
                "{writers} writers: {lost} destroyed, {torn} torn, leftovers {leftovers:?}"
            ));
        }
    }

    pristine();
    assert!(
        worst.is_empty(),
        "concurrent saves of one document are not safe:\n  {}",
        worst.join("\n  ")
    );
}

/// Four writers is more overlap than the app is likely to produce. Two is not: an autosave whose
/// write is still in flight and a Cmd+S is two. This walks the second save's start across the
/// first save's whole duration looking for the interleaving, rather than hoping to land on it.
/// It has not found one here, which bounds how likely the two-writer case is without making it
/// safe: the destructive window is between two adjacent renames and is sub-microsecond wide.
#[test]
fn two_concurrent_saves_across_the_whole_window() {
    const PAYLOAD: usize = 8 * 1024 * 1024;
    let mut losses = Vec::new();

    for delay_us in (0..40_000u64).step_by(500) {
        let root = pristine();
        let doc = root.join("docs/guides/setup.md");
        let seen = read_document(&doc).expect("the document").modified_ms;

        let big = format!("the autosave\n{}\n", "z".repeat(PAYLOAD));
        let small = "the Cmd+S\n".to_string();

        let first = {
            let doc = doc.clone();
            std::thread::spawn(move || write_document(&doc, &big, Some(seen)).err())
        };
        let second = {
            let doc = doc.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_micros(delay_us));
                write_document(&doc, &small, Some(seen)).err()
            })
        };
        let a = first.join().expect("a thread");
        let b = second.join().expect("a thread");

        if !doc.exists() {
            losses.push(format!(
                "second save started {delay_us}us in: document destroyed; errors {a:?} / {b:?}; git status {:?}",
                git_status().trim().to_string()
            ));
            if losses.len() >= 3 {
                break;
            }
        }
    }

    for loss in &losses {
        println!("  {loss}");
    }
    println!("{} of the offsets tried destroyed the document", losses.len());
    pristine();
    assert!(losses.is_empty(), "two concurrent saves destroyed the document");
}

// ================================================================================================
// Re-verification. Everything below was added to break the four fixes, not to confirm them.
// ================================================================================================

/// Every path under `dir` right now, as a sorted list of names. Used by the pollers, so it has to
/// be as cheap as a `read_dir` and nothing more.
fn names_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = fs::symlink_metadata(path).ok()?;
    Some(Stamp {
        kind: if meta.is_dir() { "dir" } else { "file" },
        len: meta.len(),
        mtime: (meta.mtime(), meta.mtime_nsec()),
        ctime: (meta.ctime(), meta.ctime_nsec()),
        ino: meta.ino(),
        mode: meta.mode(),
        nlink: meta.nlink(),
        hash: fs::read(path).ok().map(|b| fnv1a(&b)),
    })
}

/// Files a user might plausibly own that share a stem with a document the tests save. The last two
/// are the shape the app's own temp file takes, planted deliberately: a save that reasons about
/// "its" temp file by name rather than by having created it would unlink these.
const PLANTED: [&str; 8] = [
    "docs/architecture.md.bak",
    "docs/architecture.md.tmp",
    "docs/guides/setup.md.bak",
    "docs/guides/setup.md.tmp",
    "docs/guides/mobile.md~",
    "docs/design.md.bak.bak",
    "docs/.architecture.md.tmp",
    "docs/.architecture.md.4242-0-1a2b3c4d.tmp",
];

fn plant(root: &Path) -> BTreeMap<String, Stamp> {
    let mut out = BTreeMap::new();
    for rel in PLANTED {
        let path = root.join(rel);
        fs::write(&path, format!("the user's own file: {rel}\n")).expect("plant");
        out.insert(rel.to_string(), stamp_of(&path).expect("a stamp"));
    }
    out
}

// ---------------------------------------------------------------- 12. the user's own siblings

/// Claim 1. A save must not touch a `.bak` or `.tmp` sibling the user owns, and must not touch one
/// that happens to be shaped exactly like the app's own temp file either.
#[test]
fn saving_leaves_every_user_owned_sibling_byte_for_byte() {
    let root = pristine();

    // The two the fixture commits, so a deletion is a line of `git status` and not just an absence.
    let tracked = ["docs/design.md.bak", "docs/conventions.md.tmp"];
    let tracked_before: Vec<Option<Stamp>> =
        tracked.iter().map(|r| stamp_of(&root.join(r))).collect();
    let planted_before = plant(&root);

    let tree = scan_tree(&root, false).expect("a tree");
    let mut docs = Vec::new();
    collect_editable(&tree, &mut docs);
    assert!(docs.len() >= 10, "expected a realistic docs folder: {docs:?}");

    // Three rounds, because a rotation that keeps one generation only shows up on the second save.
    for round in 0..3 {
        for path in &docs {
            let read = read_document(Path::new(path)).expect("the document");
            write_document(
                Path::new(path),
                &format!("{}\nround {round}\n", read.text),
                Some(read.modified_ms),
            )
            .expect("the write");
        }
    }

    let status = git_status();
    println!("git status --porcelain after 3 saves of all {} documents:\n{}", docs.len(), quoted(&status));

    let mut damaged = Vec::new();
    for (rel, was) in &planted_before {
        match stamp_of(&root.join(rel)) {
            None => damaged.push(format!("{rel}: GONE")),
            Some(now) if &now != was => {
                damaged.push(format!("{rel}: changed\n      was {was:?}\n      now {now:?}"))
            }
            Some(_) => println!("  untouched: {rel}"),
        }
    }
    for (rel, was) in tracked.iter().zip(tracked_before.iter()) {
        let now = stamp_of(&root.join(rel));
        if &now != was {
            damaged.push(format!("{rel}: changed\n      was {was:?}\n      now {now:?}"));
        } else {
            println!("  untouched: {rel}");
        }
    }

    // A deletion of a tracked file is a ` D` line. Nothing but ` M` on documents is allowed.
    let unexpected: Vec<&str> = status
        .lines()
        .filter(|line| !line.starts_with(" M ") && !line.starts_with("?? "))
        .collect();

    for rel in PLANTED {
        fs::remove_file(root.join(rel)).ok();
    }
    pristine();

    assert!(damaged.is_empty(), "a save touched files the user owns:\n    {}", damaged.join("\n    "));
    assert!(
        unexpected.is_empty(),
        "git status shows something other than modified documents: {unexpected:?}"
    );
}

// ---------------------------------------------------------------- 13. what is there mid save

/// Claim 2. Poll the folder as hard as a thread can while a save runs, and record every name that
/// ever appears. Then say whether what appeared is hidden, unique per save, and gone afterwards.
#[test]
fn every_path_that_appears_in_the_folder_during_a_save() {
    let root = pristine();
    let dir = root.join("docs");
    let target = dir.join("big.md");
    // Big enough that the copy and the fsync are wide open to a poller. Untracked; removed below.
    let payload = "x".repeat(64 * 1024 * 1024);
    fs::write(&target, &payload).expect("the fixture document");

    let quiet = names_in(&dir);
    println!("docs/ before any save: {quiet:?}");

    let mut per_save: Vec<Vec<String>> = Vec::new();
    for save in 0..3 {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let watching = seen.clone();
        let polling = dir.clone();
        let baseline = quiet.clone();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let poller = std::thread::spawn(move || {
            let mut passes = 0u64;
            while stop_rx.try_recv().is_err() {
                for name in names_in(&polling) {
                    if !baseline.contains(&name) {
                        let mut got = watching.lock().unwrap();
                        if !got.contains(&name) {
                            got.push(name);
                        }
                    }
                }
                passes += 1;
            }
            passes
        });

        let text = format!("{payload}\nsave {save}\n");
        write_document(&target, &text, None).expect("the write");
        stop_tx.send(()).ok();
        let passes = poller.join().expect("the poller");

        let mut got = seen.lock().unwrap().clone();
        got.retain(|n| n != "big.md");
        println!("save {save}: {passes} polling passes, appeared in docs/: {got:?}");
        per_save.push(got);

        let after = names_in(&dir);
        let residue: Vec<&String> = after.iter().filter(|n| !quiet.contains(n) && *n != "big.md").collect();
        assert!(residue.is_empty(), "save {save} left something in docs/: {residue:?}");
    }

    println!("git status --porcelain after three saves:\n{}", quoted(&git_status()));
    fs::remove_file(&target).ok();

    let all: Vec<&String> = per_save.iter().flatten().collect();
    assert!(!all.is_empty(), "the poller never caught the write in flight; the test proves nothing");
    for name in &all {
        assert!(name.starts_with('.'), "the save created a visible file: {name}");
        assert!(name.ends_with(".tmp"), "the save created a name the watcher's transient rule misses: {name}");
        assert!(
            name.contains(&format!(".{}", std::process::id())),
            "the temp name does not carry the pid, so two processes could collide: {name}"
        );
    }
    let unique: std::collections::BTreeSet<&&String> = all.iter().collect();
    assert_eq!(unique.len(), all.len(), "two saves used the same temp name: {all:?}");
    pristine();
}

/// Claim 2, the failure path. The folder is made unwritable while the save is in flight, so the
/// rename cannot land. What is left behind, and is the document still whole?
///
/// The clamp is aimed the same way the kill below is: it waits for the save's own temp file to
/// appear and takes the write bit off the folder the instant it sees it, so the failure lands
/// between the temp file and the rename rather than wherever a sleep happened to fall.
#[test]
fn what_a_failed_save_leaves_behind() {
    let root = pristine();
    let dir = root.join("docs");
    let target = dir.join("big.md");
    let payload = "x".repeat(96 * 1024 * 1024);
    let open = fs::metadata(&dir).expect("docs").permissions();

    let mut attempt = 0;
    let (outcome, before, before_hash, residue) = loop {
        attempt += 1;
        fs::set_permissions(&dir, open.clone()).ok();
        fs::write(&target, &payload).expect("the fixture document");
        let before = fs::read(&target).expect("the document");
        let before_hash = fnv1a(&before);
        let quiet = names_in(&dir);

        let locking = dir.clone();
        let clamp = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            while Instant::now() < deadline {
                if names_in(&locking).iter().any(|n| !quiet.contains(n)) {
                    break;
                }
            }
            fs::set_permissions(&locking, fs::Permissions::from_mode(0o500)).ok();
            quiet
        });

        let outcome = write_document(&target, &format!("{payload}\nthe save that fails\n"), None);
        let quiet = clamp.join().expect("the clamp");
        fs::set_permissions(&dir, open.clone()).ok();

        let residue: Vec<String> = names_in(&dir)
            .into_iter()
            .filter(|n| !quiet.contains(n) && n != "big.md")
            .collect();
        if outcome.is_err() || attempt >= 8 {
            break (outcome, before.len(), before_hash, residue);
        }
        println!("attempt {attempt}: the save beat the clamp, trying again");
        for name in &residue {
            fs::remove_file(dir.join(name)).ok();
        }
    };

    let after = fs::read(&target).ok();
    println!("the save returned: {outcome:?}");
    println!("the document is still there: {}", after.is_some());
    println!(
        "its bytes: {} -> {}, hash {} -> {}",
        before,
        after.as_ref().map(|b| b.len()).unwrap_or(0),
        before_hash,
        after.as_ref().map(|b| fnv1a(b)).unwrap_or(0)
    );
    println!("left in docs/ after the failure: {residue:?}");
    println!("git status --porcelain:\n{}", quoted(&git_status()));

    for name in &residue {
        fs::remove_file(dir.join(name)).ok();
    }
    fs::remove_file(&target).ok();

    assert!(outcome.is_err(), "the clamp never managed to make a save fail: {outcome:?}");
    let after = after.expect("the document must survive a failed save");
    assert_eq!(after.len(), before, "a failed save truncated the document");
    assert_eq!(fnv1a(&after), before_hash, "a failed save changed the document");
    for name in &residue {
        assert!(name.starts_with('.') && name.ends_with(".tmp"),
            "a failed save left something that is not a hidden temp file: {name}");
    }
    pristine();
}

// ---------------------------------------------------------------- 14. killed mid write

/// Re-exec of this same binary, used as the victim of the SIGKILL below. A no-op when the
/// environment does not ask for it, which is every normal run of the suite.
#[test]
fn the_child_writer() {
    let Ok(target) = std::env::var("MARGIN_KILL_TARGET") else {
        return;
    };
    let megabytes: usize = std::env::var("MARGIN_KILL_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(512);
    let text = format!("the interrupted save\n{}\n", "q".repeat(megabytes * 1024 * 1024));
    let _ = write_document(Path::new(&target), &text, None);
    println!("the child finished its write, which the parent did not want");
}

/// Claim 3. SIGKILL in the middle of a real save of a real document. The document must be whole
/// afterwards, at the old bytes or the new ones and never in between.
///
/// The kill is aimed rather than timed: the parent watches the folder for the save's own temp file
/// to appear, which is proof the write is under way, and fires a fixed number of microseconds after
/// that. A round where the child finished first is not a round, and the test says so.
#[test]
fn killing_the_process_mid_write_leaves_the_document_whole() {
    let root = pristine();
    let dir = root.join("docs");
    let target = dir.join("architecture.md");
    let before = fs::read(&target).expect("the document");
    let quiet = names_in(&dir);
    const MB: usize = 512;

    let mut orphans: Vec<String> = Vec::new();
    let mut survived = 0;
    let mut killed = 0;
    let mut missed = 0;

    for after_us in [0u64, 200, 1_000, 5_000, 20_000, 80_000, 250_000, 600_000] {
        let mut child = Command::new(std::env::current_exe().expect("this binary"))
            .args(["--exact", "the_child_writer", "--nocapture"])
            .env("MARGIN_KILL_TARGET", &target)
            .env("MARGIN_KILL_MB", MB.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("the child");

        // Wait for the write to actually be in flight: its temp file is the only signal, and it is
        // created before a single byte of the new content is written.
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut mid: Vec<String> = Vec::new();
        while Instant::now() < deadline {
            mid = names_in(&dir)
                .into_iter()
                .filter(|n| !quiet.contains(n))
                .collect();
            if !mid.is_empty() {
                break;
            }
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
        }
        std::thread::sleep(Duration::from_micros(after_us));

        let raced = child.try_wait().ok().flatten().is_some();
        child.kill().ok();
        let status = child.wait().expect("the child exits");
        if raced {
            missed += 1;
        } else {
            killed += 1;
        }

        let now = fs::read(&target).expect("the document must still be there");
        let new_whole = now.starts_with(b"the interrupted save\n") && now.len() == MB * 1024 * 1024 + 22;
        let whole = now == before || new_whole;
        if whole && !raced {
            survived += 1;
        }
        println!(
            "kill {after_us}us after the temp file appeared: child {status:?}{}, \
             saw {mid:?} in flight, document {} bytes, {}",
            if raced { " (finished first, not a kill)" } else { "" },
            now.len(),
            if now == before { "the old content" } else if new_whole { "the new content" } else { "TORN" }
        );
        assert!(whole, "the document is neither the old content nor the new one");

        let left: Vec<String> = names_in(&dir)
            .into_iter()
            .filter(|n| !quiet.contains(n))
            .collect();
        for name in &left {
            if !orphans.contains(name) {
                orphans.push(name.clone());
            }
            fs::remove_file(dir.join(name)).ok();
        }
        // Back to the old bytes for the next round.
        fs::write(&target, &before).expect("reset");
    }

    assert!(killed >= 5, "only {killed} of the rounds actually caught a write in flight");
    println!("{survived}/{killed} real kills left the document whole ({missed} rounds the child won)");
    println!("orphans left by a killed save: {orphans:?}");
    println!("git status --porcelain (orphans already swept by this test):\n{}", quoted(&git_status()));

    assert_eq!(survived, killed, "a kill mid-write left the document neither old nor new");
    for name in &orphans {
        assert!(
            name.starts_with('.') && name.ends_with(".tmp"),
            "a killed save left a visible file in the user's folder: {name}"
        );
    }
    pristine();
}

// ---------------------------------------------------------------- 15. concurrency, harder

/// Claim 4. 2, 4, 8 and 16 writers against one document, 20 trials each. The document must come out
/// as exactly one writer's bytes: never missing, never truncated, never a mixture.
#[test]
fn concurrent_writers_two_four_eight_sixteen() {
    const TRIALS: usize = 20;

    let mut broken: Vec<String> = Vec::new();
    for writers in [2usize, 4, 8, 16] {
        let mut lost = 0;
        let mut torn = 0;
        let mut short = 0;
        let mut errors: Vec<String> = Vec::new();
        let mut leftovers: Vec<String> = Vec::new();
        let mut sizes: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
        let mut bad_status = String::new();

        for trial in 0..TRIALS {
            let root = pristine();
            let doc = root.join("docs/guides/setup.md");
            let seen = read_document(&doc).expect("the document").modified_ms;

            // Wildly different lengths, so a torn result cannot pass for a whole one by luck: a
            // truncation of the 4 MiB writer is not equal to any other writer's payload.
            let payloads: Vec<String> = (0..writers)
                .map(|n| {
                    let size = 64 * 1024 * (1 << (n % 7));
                    format!("save number {n}\n{}\nend of save number {n}\n", "z".repeat(size))
                })
                .collect();

            let gate = Arc::new(std::sync::Barrier::new(writers));
            let handles: Vec<_> = payloads
                .iter()
                .cloned()
                .map(|text| {
                    let doc = doc.clone();
                    let gate = gate.clone();
                    std::thread::spawn(move || {
                        gate.wait();
                        write_document(&doc, &text, Some(seen)).err()
                    })
                })
                .collect();
            for handle in handles {
                if let Some(e) = handle.join().expect("a thread") {
                    errors.push(e);
                }
            }

            match fs::read_to_string(&doc).ok() {
                None => {
                    lost += 1;
                    if bad_status.is_empty() {
                        bad_status = git_status();
                    }
                }
                Some(text) if !payloads.contains(&text) => {
                    if payloads.iter().any(|p| p.starts_with(&text) || text.starts_with(p)) {
                        short += 1;
                    } else {
                        torn += 1;
                    }
                    if bad_status.is_empty() {
                        bad_status = git_status();
                    }
                    println!("  trial {trial}: {} bytes, matching no writer", text.len());
                }
                Some(text) => {
                    sizes.insert(text.len());
                }
            }

            for path in snapshot(&root).keys() {
                if path.starts_with(".git/") {
                    continue;
                }
                let owned = path == "docs/conventions.md.tmp" || path == "docs/design.md.bak";
                let sidecar = path.ends_with(".bak") || path.ends_with(".tmp") || path.contains("/.");
                if sidecar && !owned && !leftovers.contains(path) {
                    leftovers.push(path.clone());
                }
            }
        }

        println!(
            "{writers} writers x {TRIALS} trials: {lost} destroyed, {torn} torn, {short} truncated, \
             {} errors, winners had sizes {:?}, leftovers {leftovers:?}",
            errors.len(),
            sizes
        );
        if !errors.is_empty() {
            println!("    first error: {}", errors[0]);
        }
        if !bad_status.is_empty() {
            println!("    git status --porcelain from a bad trial:\n{}", quoted(&bad_status));
        }
        if lost > 0 || torn > 0 || short > 0 || !leftovers.is_empty() || !errors.is_empty() {
            broken.push(format!(
                "{writers} writers: {lost} destroyed, {torn} torn, {short} truncated, \
                 {} errors, leftovers {leftovers:?}",
                errors.len()
            ));
        }
    }

    pristine();
    assert!(
        broken.is_empty(),
        "concurrent saves of one document are not safe:\n  {}",
        broken.join("\n  ")
    );
}

// ---------------------------------------------------------------- 16. the watcher stays quiet

/// Claim 5. A save emits nothing to the frontend, for the document or for the temp file, and the
/// watcher is demonstrably alive while it does so: the same test makes a change the app did not
/// make and requires that one through.
#[test]
fn a_save_emits_no_watch_event_but_an_outside_change_does() {
    let root = pristine();
    let (tx, rx) = mpsc::channel::<WatchEvent>();
    let watcher = spawn_watcher(
        "root-1".to_string(),
        root.to_string_lossy().into_owned(),
        move |events| {
            for event in events {
                tx.send(event).ok();
            }
        },
    )
    .expect("a watcher");
    std::thread::sleep(Duration::from_secs(2));
    while rx.try_recv().is_ok() {}

    // Every shape of write the app performs: an existing document, a run of quick saves, a brand
    // new file, a document in a nested folder, and one big enough that the copy and the fsync take
    // real time.
    let existing = root.join("docs/design.md");
    let read = read_document(&existing).expect("the document");
    write_document(&existing, &format!("{}\nedited\n", read.text), Some(read.modified_ms))
        .expect("the write");

    for n in 0..8 {
        let read = read_document(&existing).expect("the document");
        write_document(&existing, &format!("{}\nautosave {n}\n", read.text), Some(read.modified_ms))
            .expect("the write");
    }

    let nested = root.join("docs/internals/website.md");
    let read = read_document(&nested).expect("the document");
    write_document(&nested, &format!("{}\nedited\n", read.text), Some(read.modified_ms))
        .expect("the write");

    let fresh = root.join("docs/guides/brand-new.md");
    write_document(&fresh, "# new\n", None).expect("the write");

    let big = root.join("docs/heavy.md");
    write_document(&big, &"h".repeat(48 * 1024 * 1024), None).expect("the write");

    // At the root of the watched folder, where neither the hidden rule nor the transient rule can
    // help: only `note_self_write` stands between this save and the frontend.
    let top = root.join("README.md");
    let read = read_document(&top).expect("the document");
    write_document(&top, &format!("{}\nedited\n", read.text), Some(read.modified_ms))
        .expect("the write");

    // Spelled through the /tmp symlink, which is how a path picked in a file dialog can reach the
    // backend while the watcher is placed on the canonical /private/tmp form.
    let aliased = PathBuf::from(
        root.to_string_lossy()
            .replacen("/private/tmp/", "/tmp/", 1),
    )
    .join("notes.txt");
    let read = read_document(&aliased).expect("the document");
    write_document(&aliased, &format!("{}\nedited\n", read.text), Some(read.modified_ms))
        .expect("the write");

    std::thread::sleep(Duration::from_secs(3));
    let ours: Vec<String> = rx.try_iter().map(|e| format!("{} {}", e.kind, e.path)).collect();
    println!("watch events for {} saves the app made:", 14);
    for event in &ours {
        println!("    {event}");
    }

    // Now a change the app did not make, written straight to disk with no suppression, to prove the
    // silence above is suppression and not a dead watcher.
    let outside = root.join("docs/guides/release.md");
    let text = fs::read_to_string(&outside).expect("the document");
    fs::write(&outside, format!("{text}\nsomebody else edited this\n")).expect("the outside write");
    std::thread::sleep(Duration::from_secs(3));
    let theirs: Vec<String> = rx.try_iter().map(|e| format!("{} {}", e.kind, e.path)).collect();
    println!("watch events for one change the app did not make:");
    for event in &theirs {
        println!("    {event}");
    }
    drop(watcher);

    println!("git status --porcelain:\n{}", quoted(&git_status()));
    fs::remove_file(&fresh).ok();
    fs::remove_file(&big).ok();
    pristine();

    assert!(ours.is_empty(), "the app's own saves reached the frontend as external changes: {ours:?}");
    assert!(
        theirs.iter().any(|e| e.ends_with("docs/guides/release.md")),
        "the watcher missed a change the app did not make, so the silence above proves nothing: {theirs:?}"
    );
}

/// Claim 5, the wiring. `note_self_write` is called from production code, for both ends of the
/// rename, and not only from tests.
#[test]
fn note_self_write_is_called_from_production_code() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut callers: Vec<String> = Vec::new();
    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("src").flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let text = fs::read_to_string(&path).expect("a source file");
            for (n, line) in text.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.starts_with("//") || trimmed.starts_with("///") {
                    continue;
                }
                if trimmed.contains("note_self_write(") && !trimmed.starts_with("pub fn") {
                    callers.push(format!(
                        "{}:{}: {trimmed}",
                        path.strip_prefix(&src).unwrap_or(&path).display(),
                        n + 1
                    ));
                }
            }
        }
    }
    println!("callers of note_self_write outside tests:");
    for caller in &callers {
        println!("    {caller}");
    }
    assert!(
        !callers.is_empty(),
        "note_self_write is dead code: nothing in src/ calls it"
    );
    assert!(
        callers.iter().any(|c| c.starts_with("fs.rs")),
        "nothing in the write path calls note_self_write: {callers:?}"
    );
    // Both ends of the rename: the target and the temp file.
    assert!(
        callers.iter().any(|c| c.contains("(&tmp)")),
        "the temp file is not registered as a self write: {callers:?}"
    );
    assert!(
        callers.iter().any(|c| c.contains("(path)")),
        "the document is not registered as a self write: {callers:?}"
    );
}

/// Claim 2 again, on the failure path the app can actually clean up after: the folder stays
/// writable and the copy of the original is what fails. Nothing at all may be left behind.
#[test]
fn a_save_that_fails_where_it_can_tidy_up_leaves_nothing() {
    let root = pristine();
    let dir = root.join("docs");
    let target = dir.join("architecture.md");
    let before = fs::read(&target).expect("the document");
    let quiet = names_in(&dir);

    let open = fs::metadata(&target).expect("the document").permissions();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o000)).expect("lock the document");
    let outcome = write_document(&target, "the save that cannot read the original\n", None);
    fs::set_permissions(&target, open).expect("unlock the document");

    let residue: Vec<String> = names_in(&dir)
        .into_iter()
        .filter(|n| !quiet.contains(n))
        .collect();
    println!("the save returned: {outcome:?}");
    println!("left in docs/: {residue:?}");
    println!("git status --porcelain:\n{}", quoted(&git_status()));

    assert!(outcome.is_err(), "a save over an unreadable document reported success");
    assert!(residue.is_empty(), "a recoverable failure left something behind: {residue:?}");
    assert_eq!(fs::read(&target).expect("the document"), before, "the document changed");
    assert!(git_status().is_empty(), "a failed save left the repo dirty");
    pristine();
}
