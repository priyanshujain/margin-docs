// An export over a real folder of markdown, asked the same question src-tauri/tests/no_write_on_open.rs
// asks of a save: did anything in the folder move?
//
// src-tauri/tests/pdf.rs already covers what the compiler refuses and what it survives, against a
// TempDir with two files in it. That is the right shape for a question about diagnostics and the
// wrong shape for a question about bytes: a bag of files in a temporary folder cannot say that a
// folder somebody would plausibly have opened comes back from `git status` with no lines in it. So
// this suite runs against the same generated git repository the no-write suite does, built by
// tests/support/notes_repo.rs, and the oracle is the same one: `git status --porcelain`, plus a
// stat and content snapshot of every path under the root so that a rewrite with identical bytes is
// still caught.
//
// The tests share that one folder and `pristine()` resets it, so they hold a lock rather than
// needing `--test-threads=1`. Running the binary under any thread count is correct.
//
// The sharp question is at the bottom, and it is about `pdf_write` rather than about the compiler.
// `pdf_write` skips the open-roots guard on purpose, because its path came from a native save panel
// and is the user's own choice of destination. What that also means is that it will write to
// whatever it is given, and nothing on either side of the boundary checks that the destination is
// not one of the user's own documents. `a_save_panel_pointed_at_a_document_is_refused` is what
// happens then, written down so that it is a fact somebody decided rather than one nobody noticed.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use margin_docs_lib::dto::ImageInput;
use margin_docs_lib::pdf::{compile, pdf_write};
use tempfile::TempDir;

#[path = "support/notes_repo.rs"]
mod notes_repo;

// ---------------------------------------------------------------- fixture

/// One test in the folder at a time. The suite shares a single repository and `pristine()` throws
/// away whatever the last test did to it, so this is what makes the sharing safe under `cargo
/// test`'s default thread count instead of a flag in CI that somebody has to remember.
static FIXTURE: Mutex<()> = Mutex::new(());

/// Back to the committed state, with the lock held for as long as the guard lives.
///
/// A poisoned lock is taken anyway: it means an earlier test panicked, which is a failure that has
/// already been reported, and refusing to run the rest of the suite on top of it turns one red test
/// into a file of them.
fn pristine() -> (MutexGuard<'static, ()>, PathBuf) {
    let guard = FIXTURE.lock().unwrap_or_else(|e| e.into_inner());
    let root = notes_repo::path().to_path_buf();
    assert!(
        root.join(".git").is_dir(),
        "the fixture repo is missing: {}",
        root.display()
    );
    notes_repo::git(&["reset", "--hard", "-q"]);
    notes_repo::git(&["clean", "-fdq"]);
    let status = notes_repo::git(&["status", "--porcelain"]);
    assert!(
        status.is_empty(),
        "the fixture repo did not start clean:\n{status}"
    );
    (guard, root)
}

fn git_status() -> String {
    notes_repo::git(&["status", "--porcelain"])
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

fn assert_clean(label: &str) {
    let status = git_status();
    println!("  [{label}] git status --porcelain:\n{}", quoted(&status));
    assert!(status.is_empty(), "{label} left git dirty:\n{status}");
}

// ---------------------------------------------------------------- snapshots

/// Enough of a file to notice a rewrite that put the same bytes back. `git status` cannot see one
/// of those and it is exactly what an exporter tidying up after itself would leave.
#[derive(Clone, PartialEq, Eq, Debug)]
struct Stamp {
    kind: &'static str,
    len: u64,
    mtime: (i64, i64),
    ino: u64,
    /// Content hash, for everything outside the vendored `node_modules`, where the stat is already
    /// conclusive and hashing 13,000 files on every snapshot is not worth the second it costs.
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

/// Every path under `root`, dotfiles, .git and node_modules included.
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
        out.insert(
            rel,
            Stamp {
                kind,
                len: meta.len(),
                mtime: (meta.mtime(), meta.mtime_nsec()),
                ino: meta.ino(),
                hash: if kind == "file" && !cheap {
                    fs::read(&path).ok().map(|bytes| fnv1a(&bytes))
                } else {
                    None
                },
            },
        );
        if meta.is_dir() {
            walk(root, &path, out);
        }
    }
}

/// What moved between two snapshots, ignoring nothing.
fn changes(before: &Snapshot, after: &Snapshot) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for (path, stamp) in after {
        match before.get(path) {
            None => added.push(path.clone()),
            Some(was) if was != stamp => {
                changed.push(format!("{path}\n      was {was:?}\n      now {stamp:?}"))
            }
            Some(_) => {}
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            removed.push(path.clone());
        }
    }
    (added, removed, changed)
}

fn assert_untouched(label: &str, before: &Snapshot, after: &Snapshot) {
    let (added, removed, changed) = changes(before, after);
    assert!(
        added.is_empty() && removed.is_empty() && changed.is_empty(),
        "{label} touched the folder\n  added: {added:?}\n  removed: {removed:?}\n  changed:\n    {}",
        changed.join("\n    ")
    );
    println!("  [{label}] {} paths, none touched", before.len());
}

/// The same, allowing exactly the paths named to appear and the folders holding them to have been
/// written into. A PDF exported next to the documents is a new file, and a new file is a new mtime
/// on its parent directory; nothing else is allowed to move.
fn assert_only_added(label: &str, before: &Snapshot, after: &Snapshot, expected: &[&str]) {
    let (added, removed, changed) = changes(before, after);
    assert_eq!(added, expected, "{label} added something unexpected");
    assert!(removed.is_empty(), "{label} removed {removed:?}");
    let parents: Vec<String> = expected
        .iter()
        .map(|p| match p.rfind('/') {
            Some(at) => p[..at].to_string(),
            None => String::new(),
        })
        .collect();
    let unexpected: Vec<&String> = changed
        .iter()
        .filter(|entry| {
            let path = entry.lines().next().unwrap_or_default();
            !parents.iter().any(|parent| parent == path)
        })
        .collect();
    assert!(
        unexpected.is_empty(),
        "{label} changed more than the folder it wrote into:\n    {}",
        unexpected
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n    ")
    );
    println!("  [{label}] added {expected:?} and moved nothing else");
}

// ---------------------------------------------------------------- the document

/// The head of what src/export/typst.ts writes: the mitex import that is the contract between the
/// converter and src-tauri/src/pdf.rs, and set rules naming no font, because which faces exist is
/// the backend's business.
const PREAMBLE: &str = r#"#import "/mitex/lib.typ": mitex, mi
#set document(title: "Handbook")
#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt, lang: "en")
"#;

/// A drawn mermaid diagram as it crosses the boundary: SVG from the webview, with no file behind it.
const DIAGRAM: &[u8] =
    br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#456"/></svg>"##;

/// The whole export, as the converter would have written it for a document in this folder: a
/// picture that is a real file inside the open root, a drawn diagram that is bytes, a table and a
/// formula. Every one of those is a path the exporter does extra work on, and three of them mean
/// the compiler opening something.
fn document_from(root: &Path) -> (String, Vec<ImageInput>) {
    let picture = root.join("assets/logo.png");
    assert!(picture.is_file(), "the fixture has an asset to point at");

    let source = format!(
        "{PREAMBLE}
= The handbook

Prose, then a picture that is a file in the open folder.

#image(\"{}\")

#figure(image(\"/inline/diagram-1.svg\"))

#table(columns: 2, [region], [total], [north], [12])

Inline #mi(\"a^2 + b^2 = c^2\") and a display one:

#mitex(\"\\\\frac{{1}}{{2}} \\\\int_0^1 x^2 dx\")
",
        picture.display()
    );

    let images = vec![
        ImageInput {
            path: picture.to_string_lossy().into_owned(),
            data: None,
        },
        ImageInput {
            path: "/inline/diagram-1.svg".to_string(),
            data: Some(STANDARD.encode(DIAGRAM)),
        },
    ];
    (source, images)
}

fn roots_of(root: &Path) -> Vec<String> {
    vec![root.to_string_lossy().into_owned()]
}

// ================================================================ compiling

#[test]
fn compiling_a_document_out_of_a_real_folder_writes_nothing_in_it() {
    let (_lock, root) = pristine();
    let (source, images) = document_from(&root);

    let before = snapshot(&root);
    let (bytes, warnings) =
        compile(source, &images, &roots_of(&root)).expect("the folder compiles");
    let after = snapshot(&root);

    assert_eq!(&bytes[..4], b"%PDF", "the answer is a PDF");
    // The picture really was read off disk rather than worked around, so the one step of the
    // compile that opens a file in the user's folder is a step this test actually took.
    let worked_around: Vec<&str> = warnings
        .iter()
        .filter(|w| w.kind == "image")
        .map(|w| w.message.as_str())
        .collect();
    assert!(
        worked_around.is_empty(),
        "the image in the open folder was read: {worked_around:?}"
    );

    assert_untouched("a compile", &before, &after);
    assert_clean("a compile");
}

#[test]
fn compiling_the_same_folder_ten_times_over_still_writes_nothing() {
    // Once could be a compile that failed early and touched nothing because it did nothing. Ten
    // laps, with the fonts loaded and the images opened every time, is the shape of the thing the
    // user actually does: export, read it, change a line, export again.
    let (_lock, root) = pristine();
    let before = snapshot(&root);

    for lap in 0..10 {
        let (source, images) = document_from(&root);
        let (bytes, _) =
            compile(source, &images, &roots_of(&root)).unwrap_or_else(|e| panic!("lap {lap}: {e}"));
        assert_eq!(&bytes[..4], b"%PDF");
    }

    assert_untouched("ten compiles", &before, &snapshot(&root));
    assert_clean("ten compiles");
}

// ================================================================ writing

#[test]
fn exporting_to_a_folder_of_its_own_leaves_the_documents_alone() {
    // The ordinary export: the panel points somewhere outside the notes folder, which is where a
    // PDF belongs. Nothing in the folder the document came from has any business moving, and the
    // whole of `git status` is the evidence.
    let (_lock, root) = pristine();
    let (source, images) = document_from(&root);
    let elsewhere = TempDir::new().expect("a temp dir");
    let target = elsewhere.path().join("The handbook.pdf");

    let before = snapshot(&root);
    let (bytes, _) = compile(source, &images, &roots_of(&root)).expect("the folder compiles");
    pdf_write(target.to_string_lossy().into_owned(), bytes.clone()).expect("the panel's path");
    let after = snapshot(&root);

    assert_eq!(fs::read(&target).expect("the PDF is there"), bytes);
    assert_untouched("an export to another folder", &before, &after);
    assert_clean("an export to another folder");
}

#[test]
fn exporting_beside_the_documents_adds_the_pdf_and_moves_nothing_else() {
    // The other ordinary export, and the one that cannot leave `git status` empty: a PDF written
    // next to the document is a new file in the folder and shows up as one. What matters is that
    // it is the only line, and that no document was rewritten to put it there.
    let (_lock, root) = pristine();
    let (source, images) = document_from(&root);
    let target = root.join("docs/guides/setup.pdf");

    let before = snapshot(&root);
    let (bytes, _) = compile(source, &images, &roots_of(&root)).expect("the folder compiles");
    pdf_write(target.to_string_lossy().into_owned(), bytes).expect("a path inside the root");
    let after = snapshot(&root);

    assert_only_added(
        "an export into the folder",
        &before,
        &after,
        &["docs/guides/setup.pdf"],
    );

    let status = git_status();
    println!(
        "git status --porcelain after an export into the folder:\n{}",
        quoted(&status)
    );
    assert_eq!(
        status.lines().collect::<Vec<_>>(),
        vec!["?? docs/guides/setup.pdf"],
        "the PDF is the only thing git can see"
    );

    // And the atomic write left nothing of its own behind: the temp file it renames through is
    // gone, so there is no `.setup.pdf.tmp` for the next `git add -A` to sweep up.
    let strays: Vec<String> = fs::read_dir(root.join("docs/guides"))
        .expect("the guides folder")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.ends_with(".md") && name != "setup.pdf")
        .collect();
    assert!(strays.is_empty(), "the write left {strays:?} behind");
}

// ================================================================ the guard that is not there

#[test]
fn a_save_panel_pointed_at_a_document_is_refused() {
    // This test was written the other way up, pinning the overwrite as a fact somebody had decided.
    // Nobody had: it was the one way an export could destroy markdown, and it needed only a user who
    // reached the save panel and typed a `.md` name into it. It has not been seen because the panel
    // carries a PDF filter and AppKit usually appends `.pdf` to a name typed with another extension,
    // which is the panel being careful rather than this module, and the promise that the editor
    // never writes a file the user did not edit is not the panel's to keep.
    //
    // So `pdf_write` now refuses a destination that already holds one of the user's documents, and
    // this is the same test rewritten to the truth that replaced it. Everything about the rest of
    // the decision still stands: the root guard is still off this path on purpose, which is what
    // `pdf_write_will_also_write_outside_every_open_folder` below is about.
    let (_lock, root) = pristine();
    let (source, images) = document_from(&root);
    let document = root.join("docs/design.md");
    let markdown = fs::read(&document).expect("a document to aim at");
    assert!(
        markdown.starts_with(b"#") || markdown.len() > 100,
        "the fixture document has real markdown in it"
    );

    let (bytes, _) = compile(source, &images, &roots_of(&root)).expect("the folder compiles");
    let answer = pdf_write(document.to_string_lossy().into_owned(), bytes.clone());

    let message = answer.expect_err("a document is not a place to put a PDF");
    assert!(
        message.contains("design.md") && message.contains("document"),
        "the refusal names the file and says why: {message}"
    );
    assert_eq!(
        fs::read(&document).expect("the document is still a file"),
        markdown,
        "the document is untouched, byte for byte"
    );

    let status = git_status();
    assert_eq!(status, "", "the folder is clean:\n{}", quoted(&status));

    // A .txt is a document too, and a .pdf that is already there is not: replacing one is what a
    // save panel is for, and it has already asked.
    let notes = root.join("docs/notes.txt");
    fs::write(&notes, b"a plain text document\n").expect("a text file");
    let again = bytes;
    pdf_write(notes.to_string_lossy().into_owned(), again.clone())
        .expect_err("a .txt is a document as much as a .md is");

    let existing = root.join("docs/already.pdf");
    fs::write(&existing, b"%PDF-1.7 an older export\n").expect("an older PDF");
    pdf_write(existing.to_string_lossy().into_owned(), again.clone())
        .expect("replacing a PDF is what the panel asked about");
    assert_eq!(fs::read(&existing).expect("the newer export"), again);

    let fresh = root.join("docs/never-existed.md");
    pdf_write(fresh.to_string_lossy().into_owned(), again)
        .expect("a name nothing holds destroys nothing, however odd it looks");
}

#[test]
fn pdf_write_will_also_write_outside_every_open_folder() {
    // The half of the same decision that is intended, kept next to the half that is not so the two
    // are read together. A PDF belongs on the Desktop or in Downloads far more often than it
    // belongs in the notes folder, so `resolve_in_roots` is not on this path and must not be. The
    // fix for the test above, if there is one, is not a root guard.
    let (_lock, root) = pristine();
    let elsewhere = TempDir::new().expect("a temp dir");
    let target = elsewhere.path().join("report.pdf");

    pdf_write(
        target.to_string_lossy().into_owned(),
        b"%PDF-1.7\n".to_vec(),
    )
    .expect("somewhere the user never opened");

    assert_eq!(fs::read(&target).expect("the PDF"), b"%PDF-1.7\n");
    assert_clean("a write outside every root");
    let _ = root;
}
