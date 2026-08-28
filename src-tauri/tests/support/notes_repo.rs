// The folder the `no_write_on_open` suite runs against, built from nothing every time the test
// binary starts.
//
// It has to be a real git repository and not a `TempDir` full of loose files, because `git status`
// is the oracle the whole suite leans on: an editor that promises to write nothing the user did not
// edit is believable exactly when a checkout of that folder comes back with no lines. A snapshot of
// inodes and timestamps says a byte moved; `git status` says which document it belonged to and
// whether the user would have seen it in their own diff.
//
// It used to be a repository somebody built by hand at a fixed path under /tmp, which meant the
// suite ran on one machine until macOS reaped the folder and then ran nowhere. Everything below
// exists so that the repository is an output of the test run rather than a precondition of it.
//
// The documents are copied out of `src/markdown/corpus/real`, the same real world markdown the
// bridge tests parse, rather than invented here. Reusing them keeps one corpus in the repository
// instead of two, and gives the fixture documents that are the length and shape of the ones people
// actually keep in a notes folder. Nothing in the suite asserts on their bytes, only that they read
// back as UTF-8 and that the tree has the right number of rows, so the corpus is free to grow.
//
// The vendored `node_modules` is generated rather than copied. Several tests need a folder large
// enough that walking it is measurably slower than skipping it, and thirteen thousand tiny files
// that exist to be ignored are not files worth committing.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Every fixture this suite builds is named `margin-notouch-<pid>-<nanos>`, so a later run can
/// recognise the ones earlier runs left behind and work out which of them are finished with.
const PREFIX: &str = "margin-notouch-";

/// 500 packages of 26 entries each is 13,000 paths under `node_modules`. Two tests put a floor
/// under this: one wants more than 5,000 entries there, and one wants a walk of the whole root with
/// the skip turned off to return more than 10,000 rows. Building it costs about a second.
const PACKAGES: usize = 500;
const MODULES_PER_PACKAGE: usize = 21;

/// Where each document in the fixture comes from in `src/markdown/corpus/real`. The paths on the
/// left are named by the tests and cannot move without moving the tests too. There are twelve
/// editable documents here, three more than the suite's floor of ten, and the two sidecars are the
/// files the tests describe as the user's own: a save must not touch either.
const DOCUMENTS: [(&str, &str); 14] = [
    ("README.md", "margin-readme.md"),
    ("notes.txt", "margin-claude.md"),
    ("docs/index.md", "calendar-readme.md"),
    ("docs/architecture.md", "editor-architecture.md"),
    ("docs/conventions.md", "editor-conventions.md"),
    ("docs/design.md", "editor-design.md"),
    ("docs/guides/setup.md", "editor-setup.md"),
    ("docs/guides/release.md", "editor-release.md"),
    ("docs/guides/mobile.md", "calendar-mobile.md"),
    ("docs/internals/website.md", "margin-website-readme.md"),
    ("docs/internals/indexing.md", "calendar-architecture.md"),
    ("docs/internals/watcher.md", "calendar-design.md"),
    // Not documents. A `.bak` and a `.tmp` the user owns, committed so that a save deleting one is
    // a line of `git status` and not merely an absence somebody has to notice.
    ("docs/design.md.bak", "editor-design.md"),
    ("docs/conventions.md.tmp", "editor-conventions.md"),
];

/// Two files that are not text, so the tree has rows the editor cannot open.
const ASSETS: [(&str, &str); 2] = [
    ("assets/logo.png", "128x128.png"),
    ("assets/logo@2x.png", "128x128@2x.png"),
];

/// Built once per test binary, on whichever test calls `pristine()` first, and then shared. The
/// suite runs single threaded, but `LazyLock` is what makes that a property of the fixture rather
/// than a rule someone has to remember.
static REPO: LazyLock<PathBuf> = LazyLock::new(build);

/// The root of the fixture repository. Always canonical, so it starts `/private/tmp/` on macOS and
/// the same folder is also reachable through the `/tmp` symlink, which one test needs.
pub fn path() -> &'static Path {
    REPO.as_path()
}

/// Runs git inside the fixture and hands back everything it said, output and errors together. The
/// suite reads these as prose, so a failing command shows up in the assertion that used it rather
/// than as an empty string that quietly looks clean.
pub fn git(args: &[&str]) -> String {
    let out = run(path(), args);
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    text
}

// ---------------------------------------------------------------- running git

/// Git, with the machine it happens to be running on held at arm's length.
///
/// The fixture is an oracle, so nothing outside it may change what it says. A developer with a
/// `core.excludesFile` full of `*.tmp`, a commit template, a signing key, a `gc.auto` that fires
/// mid run, or a stray `GIT_DIR` in the environment would each turn a green suite red or, worse, a
/// red one green. The config files are pointed at /dev/null and the inherited git variables are
/// dropped, so the only configuration in play is the handful of keys written into the repository
/// itself by `configure` below.
fn run(dir: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_CEILING_DIRECTORIES")
        .env_remove("GIT_ATTR_NOSYSTEM")
        .args(args)
        .output()
        .unwrap_or_else(|e| {
            panic!(
                "cannot run `git {}`: {e}\n\
                 This suite needs the git command line tool on PATH. Its whole method is to ask a \
                 real repository whether anything moved, so there is no useful way to run it \
                 without git and it fails here rather than passing on a folder nobody checked.",
                args.join(" ")
            )
        })
}

fn must(dir: &Path, args: &[&str]) {
    let out = run(dir, args);
    assert!(
        out.status.success(),
        "building the fixture: `git {}` failed with {}\n{}{}",
        args.join(" "),
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

// ---------------------------------------------------------------- building

fn build() -> PathBuf {
    let tmp = fs::canonicalize("/tmp").unwrap_or_else(|_| std::env::temp_dir());
    sweep(&tmp);

    // Per process and per instant, so two runs of the suite at once get two repositories and
    // neither has to wait for the other. `notes-repo` is a folder inside it rather than the
    // temporary folder itself, so the repository has a parent the tests never touch.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let root = tmp
        .join(format!("{PREFIX}{}-{stamp}", std::process::id()))
        .join("notes-repo");
    fs::create_dir_all(&root)
        .unwrap_or_else(|e| panic!("cannot build the fixture at {}: {e}", root.display()));

    populate(&root);
    commit(&root);
    root
}

fn populate(root: &Path) {
    let corpus = corpus_dir();
    for (rel, source) in DOCUMENTS {
        let from = corpus.join(source);
        let bytes = fs::read(&from).unwrap_or_else(|e| {
            panic!(
                "the fixture is built out of the markdown corpus and {} is missing: {e}",
                from.display()
            )
        });
        put(&root.join(rel), &bytes);
    }

    let icons = project_root().join("src-tauri/icons");
    for (rel, source) in ASSETS {
        let from = icons.join(source);
        let bytes = fs::read(&from)
            .unwrap_or_else(|e| panic!("the fixture wants {} for an asset: {e}", from.display()));
        put(&root.join(rel), &bytes);
    }

    // The only thing the folder ignores. Deliberately not `*.tmp` or `*.bak`: the tests plant files
    // by those names on purpose and need git to report them.
    put(
        &root.join(".gitignore"),
        b"node_modules/\n.DS_Store\n" as &[u8],
    );

    vendor(root);
}

/// A vendored `node_modules`, big enough that walking it and skipping it are visibly different
/// jobs. The contents are filler; only the count and the shape matter.
fn vendor(root: &Path) {
    let node_modules = root.join("node_modules");
    for package in 0..PACKAGES {
        let dir = node_modules.join(format!("pkg-{package:03}"));
        let lib = dir.join("lib");
        fs::create_dir_all(&lib)
            .unwrap_or_else(|e| panic!("cannot build {}: {e}", lib.display()));
        put(
            &dir.join("package.json"),
            format!("{{\n  \"name\": \"pkg-{package:03}\",\n  \"version\": \"1.0.{package}\"\n}}\n")
                .as_bytes(),
        );
        put(
            &dir.join("index.js"),
            b"module.exports = require(\"./lib/mod-00.js\");\n" as &[u8],
        );
        put(
            &dir.join("README.md"),
            format!("# pkg-{package:03}\n\nVendored. Not a document, and not the user's writing.\n")
                .as_bytes(),
        );
        for module in 0..MODULES_PER_PACKAGE {
            put(
                &lib.join(format!("mod-{module:02}.js")),
                format!("exports.value = {package} * 100 + {module};\n").as_bytes(),
            );
        }
    }
}

fn commit(root: &Path) {
    must(root, &["init", "-q", "-b", "main"]);
    configure(root);
    must(root, &["add", "-A"]);
    must(
        root,
        &["commit", "-q", "-m", "the folder as the user left it"],
    );

    let out = run(root, &["status", "--porcelain"]);
    let status = String::from_utf8_lossy(&out.stdout);
    assert!(
        status.is_empty(),
        "the fixture did not commit clean, so `git status` cannot be trusted as the oracle:\n{status}"
    );
}

/// Written into the repository rather than passed as `-c` flags on every call, so that the settings
/// travel with the fixture and a command run by hand inside it behaves the way the suite's commands
/// do.
fn configure(root: &Path) {
    for (key, value) in [
        ("user.name", "Margin Fixture"),
        ("user.email", "fixture@margin.invalid"),
        // Signing would ask for a passphrase, and a passphrase in CI is a hang rather than a
        // failure.
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        // A background repack landing between two snapshots would move bytes under .git and read
        // as the editor having written something.
        ("gc.auto", "0"),
        ("maintenance.auto", "false"),
        // The suite asserts on exactly which paths git reports, so the answer must not depend on
        // what the person running it happens to ignore everywhere.
        ("core.excludesFile", "/dev/null"),
        ("core.autocrlf", "false"),
        // Both write to .git while only reading the working tree, which is the one thing every
        // snapshot in this suite is watching for.
        ("core.fsmonitor", "false"),
        ("core.untrackedCache", "false"),
        ("core.splitIndex", "false"),
        ("status.showUntrackedFiles", "normal"),
    ] {
        must(root, &["config", key, value]);
    }
}

// ---------------------------------------------------------------- odds and ends

fn put(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .unwrap_or_else(|e| panic!("cannot build {}: {e}", parent.display()));
    }
    fs::write(path, bytes).unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
}

fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

fn corpus_dir() -> PathBuf {
    project_root().join("src/markdown/corpus/real")
}

/// The fixture outlives the run that built it, on purpose.
///
/// A `TempDir` parked in a `static` is a destructor that never runs, and a suite that quietly
/// relies on that is worse than one that says so. Nothing here tries to delete the repository when
/// the tests finish: the last thing a failing run should do is destroy the evidence, and running
/// `git status` and `git diff` inside the folder is the first thing anyone will want. Thirteen
/// thousand files that each take a block is about fifty megabytes, which is small enough to leave
/// lying about once and much too big to leave lying about once per `cargo test`.
///
/// So the clearing up happens at the start of the next run instead, and it goes by whether the
/// process that built a fixture is still running rather than by how old the folder looks. The pid
/// is in the name for exactly this. Asking that question can only be wrong in the safe direction:
/// a pid that has been recycled reads as alive and the folder is kept, and a folder is only ever
/// removed once nothing is left that could be using it.
fn sweep(tmp: &Path) {
    let Ok(entries) = fs::read_dir(tmp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_prefix(PREFIX).and_then(|rest| rest.split('-').next()) else {
            continue;
        };
        if !alive(pid) {
            fs::remove_dir_all(entry.path()).ok();
        }
    }
}

/// Signal zero asks whether a process exists without sending it anything. A `kill` that cannot be
/// run at all counts as alive, which leaves the folder where it is rather than deleting a
/// repository on a guess.
fn alive(pid: &str) -> bool {
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    Command::new("/bin/kill")
        .args(["-0", pid])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(true)
}
