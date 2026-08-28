// Rust owns the filesystem and nothing above it. Every byte that reaches or leaves the disk goes
// through this module: opening a folder, walking it, reading a document, writing one back, sending
// a file to the Trash, dropping a pasted image beside the document that received it, and the
// SQLite index that answers the three questions a plain tree cannot. Markdown is never parsed
// here; that is the bridge's job in TypeScript.
//
// Two promises constrain nearly every function below, and both are the product's rather than the
// implementation's. Opening a folder or a file never writes anything, so nothing here may leave a
// dotfile, a lock, a cache or a sidecar inside a folder the user opened. And every write is
// atomic: a temp file beside the target, flushed, then renamed over it, so a crash or a full disk
// can never leave a half written document where the user's document used to be.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as Memory};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::{DirEntry, WalkBuilder};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::dto::{
    AssetResult, Backlink, FileNode, IndexStatus, QuickOpenHit, ReadResult, RootInfo, SearchHit,
    WriteResult,
};
use crate::Roots;

/// Skipped whatever the folder's own gitignore says, because not one of the four is ever a
/// document and a documents folder that happens to be a checkout should not open with its build
/// output filling the sidebar.
///
/// The index walks by the same rule, so the sidebar and the search box agree about what a folder
/// holds.
pub(crate) const ALWAYS_SKIPPED: [&str; 4] = [".git", "node_modules", "target", "dist"];

/// These two mirror `src/model/doc.ts` and have to keep agreeing with it: the frontend decides
/// from the extension whether a row opens in the editor, and `FileNode.editable` is that same
/// decision made here.
const MARKDOWN_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "mkdn"];
const TEXT_EXTENSIONS: [&str; 2] = ["txt", "text"];

/// Where the open folders are remembered between launches, inside the app data directory and never
/// inside a folder the user opened.
const ROOTS_FILE: &str = "roots.json";

/// What a pasted image is called when the clipboard suggests nothing usable.
const FALLBACK_ASSET_NAME: &str = "image.png";

// Path validation. Every path below arrives as a string from the frontend, and the frontend is a
// webview: a bug in a link resolver, a crafted document, a drag from somewhere unexpected or a
// stale path belonging to a folder that has since been closed can all put an arbitrary string
// here. This is the one place in the app where being wrong damages files the user never opened, so
// the rule is deliberately blunt and every command that takes a path goes through it, reads as
// well as writes.
//
// A path is accepted only when it holds no `..` component at all and, once symlinks have been
// resolved, sits inside a folder that is currently open. Canonicalising first is what makes the
// second half mean anything: without it both `~/notes/../../.ssh/id_rsa` and a symlink pointing at
// /etc read as being inside the root. A path that does not exist yet is resolved against its
// deepest existing ancestor and the remaining components are appended, so creating a file is
// checked exactly as strictly as writing one. With no folder open nothing is inside a root, so
// every path is rejected, which is the right default rather than an inconvenience.

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn ms_since_epoch(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    ms_since_epoch(SystemTime::now())
}

pub(crate) fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified().map(ms_since_epoch).unwrap_or(0)
}

/// True for a broken symlink too, which `Path::exists` is not. A name pointing at nothing is still
/// a name that cannot be created.
fn taken(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub(crate) fn kind_for(path: &Path, is_dir: bool) -> &'static str {
    if is_dir {
        return "dir";
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot > 0 => {
            let ext = &name[dot + 1..];
            if MARKDOWN_EXTENSIONS.contains(&ext) {
                "markdown"
            } else if TEXT_EXTENSIONS.contains(&ext) {
                "text"
            } else {
                "other"
            }
        }
        _ => "other",
    }
}

fn node_from(path: &Path, is_dir: bool, modified: i64) -> FileNode {
    let kind = kind_for(path, is_dir);
    FileNode {
        path: path_string(path),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_string(path)),
        kind: kind.to_string(),
        editable: kind == "markdown" || kind == "text",
        modified_ms: modified,
        children: Vec::new(),
    }
}

fn node_for(path: &Path) -> Result<FileNode, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(node_from(path, meta.is_dir(), modified_ms(&meta)))
}

/// A base name and not a path. `file_rename` cannot move anything, so a name carrying a separator
/// is refused rather than quietly turned into a move.
fn check_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(format!("not a usable name: {name}"));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(format!("a name cannot contain a path separator: {name}"));
    }
    Ok(trimmed)
}

fn resolve(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("path is not absolute: {}", path.display()));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("path contains a parent traversal: {}", path.display()));
    }
    let mut tail: Vec<OsString> = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        if let Ok(base) = fs::canonicalize(&cursor) {
            let mut out = base;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return Ok(out);
        }
        let name = cursor
            .file_name()
            .ok_or_else(|| format!("cannot resolve path: {}", path.display()))?
            .to_os_string();
        tail.push(name);
        cursor = cursor
            .parent()
            .ok_or_else(|| format!("cannot resolve path: {}", path.display()))?
            .to_path_buf();
    }
}

/// The gate described above. `root_paths` are the folders the user has actually opened.
pub fn resolve_in_roots(root_paths: &[String], raw: &str) -> Result<PathBuf, String> {
    let resolved = resolve(Path::new(raw))?;
    for root in root_paths {
        let base = match fs::canonicalize(root) {
            Ok(base) => base,
            Err(_) => continue,
        };
        // Component wise, so /notes-old is not read as being inside /notes.
        if resolved.starts_with(&base) {
            return Ok(resolved);
        }
    }
    Err(format!("path is outside every open folder: {raw}"))
}

/// The lock is taken and dropped before any filesystem call, so a slow disk never blocks a command
/// that only wants to know which folders are open.
fn open_root_paths(roots: &State<'_, Roots>) -> Result<Vec<String>, String> {
    let open = roots.0.lock().map_err(|e| e.to_string())?;
    Ok(open.iter().map(|root| root.path.clone()).collect())
}

fn checked(roots: &State<'_, Roots>, raw: &str) -> Result<PathBuf, String> {
    resolve_in_roots(&open_root_paths(roots)?, raw)
}

/// One lock per document being written, so two saves of one file cannot interleave.
///
/// Keyed by the resolved path, because `/tmp/notes/a.md` and `/private/tmp/notes/a.md` are one
/// document and two keys would be two locks and no mutual exclusion at all. An entry lives only
/// while somebody holds it: every caller drops the locks nobody is using on the way in, so the map
/// is the size of the writes in flight rather than of every document ever saved.
static WRITE_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Separates one temp name from the next inside this process, as the pid and the clock separate
/// this process from any other.
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Enough tries that a name collision has to be deliberate rather than unlucky.
const TEMP_NAME_TRIES: u32 = 64;

fn write_lock_for(path: &Path) -> Arc<Mutex<()>> {
    let key = resolve(path).unwrap_or_else(|_| path.to_path_buf());
    let mut locks = match WRITE_LOCKS.lock() {
        Ok(locks) => locks,
        // The guarded value is `()`, so a writer that panicked left nothing half-built behind.
        Err(poisoned) => poisoned.into_inner(),
    };
    locks.retain(|_, held| Arc::strong_count(held) > 1);
    locks.entry(key).or_default().clone()
}

/// A name for the temp file that no other write is using and no user is plausibly holding.
///
/// Beside the target, because a rename is only atomic within one filesystem. Hidden, so it is not
/// mistaken for a document by the tree, by the watcher or by the person looking at the folder.
/// Unique per call, because a name derived from the target alone is a name two concurrent saves
/// both own and neither can safely delete. `.tmp` last so the watcher's transient rule catches it
/// whatever the document happens to be called.
fn temp_path(path: &Path) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("cannot write {}: no folder to write in", path.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("cannot write {}: no name to write to", path.display()))?
        .to_string_lossy()
        .into_owned();
    let pid = std::process::id();
    for _ in 0..TEMP_NAME_TRIES {
        let n = WRITE_SEQUENCE.fetch_add(1, Memory::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let candidate = dir.join(format!(".{name}.{pid}-{n}-{stamp:x}.tmp"));
        // A name already on disk is somebody else's, and this call is the only thing allowed to
        // delete the name it picks.
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!("cannot find a free temp name beside {}", path.display()))
}

fn fill_temp(path: &Path, tmp: &Path, bytes: &[u8], existed: bool) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true);
    if existed {
        fs::copy(path, tmp).map_err(|e| e.to_string())?;
        options.truncate(true);
    } else {
        options.create_new(true);
    }
    let mut file = options.open(tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

/// Writes `bytes` to `path` through a temp file beside it and a rename, which is atomic within a
/// filesystem. At no instant does the target hold half a document: it holds every old byte or
/// every new one, whatever happens in between, and that is what makes an autosaving editor safe
/// against a crash or a full disk mid-write. A rename that fails has not happened, so the original
/// is still whole and still where it was.
///
/// The temp file starts as a copy of the original rather than as an empty file. On macOS
/// `fs::copy` carries permissions, ACLs and extended attributes across, and since the file the
/// user is left with is the temp file, that copy is the only thing stopping a save from quietly
/// dropping a Finder tag or the executable bit.
///
/// There is no `.bak` rotation, deliberately. This is the user's own markdown in the user's own
/// folder, very often under version control, and the app is already holding the whole source
/// string in memory and refusing to write when the mtime on disk has moved. A backup sibling buys
/// none of that back, and a backup named after the target is a file the user may own themselves,
/// which the rotation would unlink without asking and without the Trash. Nothing is deleted here
/// but the temp file this call created.
///
/// Writes to one path are serialized. Two saves of one document, which is all a debounced autosave
/// and a Cmd+S landing together are, would otherwise race between two renames and leave the
/// document at neither name.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let lock = write_lock_for(path);
    let _held = match lock.lock() {
        Ok(held) => held,
        Err(poisoned) => poisoned.into_inner(),
    };
    write_through_temp(path, bytes)
}

fn write_through_temp(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = temp_path(path)?;
    let existed = taken(path);

    // Both ends of the rename, before either is touched: the watcher sees the temp file appear and
    // the document change as two unrelated events, and either one getting through is the app's own
    // save coming back to the frontend as somebody else's edit.
    crate::watch::note_self_write(&tmp);
    crate::watch::note_self_write(path);

    if let Err(e) = fill_temp(path, &tmp, bytes, existed) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // Again, because the suppression is a window that started before the copy and the fsync, and on
    // a large document those are most of it.
    crate::watch::note_self_write(&tmp);
    crate::watch::note_self_write(path);

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// The untitled rule: `untitled.md`, then `untitled-2.md`, and never an overwrite. The suffix goes
/// before the extension so the file keeps opening in the same app as the one it was named after.
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !taken(&first) {
        return first;
    }
    let as_path = Path::new(name);
    let stem = as_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = as_path.extension().map(|e| e.to_string_lossy().into_owned());
    let joined = |suffix: String| match &ext {
        Some(ext) => dir.join(format!("{stem}-{suffix}.{ext}")),
        None => dir.join(format!("{stem}-{suffix}")),
    };
    for n in 2..10_000u32 {
        let candidate = joined(n.to_string());
        if !taken(&candidate) {
            return candidate;
        }
    }
    joined(now_ms().to_string())
}

fn compare_nodes(a: &FileNode, b: &FileNode) -> Ordering {
    let a_dir = a.kind == "dir";
    let b_dir = b.kind == "dir";
    b_dir
        .cmp(&a_dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

fn assemble(
    path: &Path,
    nodes: &mut HashMap<PathBuf, FileNode>,
    children: &HashMap<PathBuf, Vec<PathBuf>>,
) -> Option<FileNode> {
    let mut node = nodes.remove(path)?;
    if let Some(kids) = children.get(path) {
        let mut built: Vec<FileNode> = kids
            .iter()
            .filter_map(|kid| assemble(kid, nodes, children))
            .collect();
        built.sort_by(compare_nodes);
        node.children = built;
    }
    Some(node)
}

/// True for everything a walk should keep, which is everything except one of the four always
/// skipped names turning up as a folder somewhere below the walk root. Returning false for a
/// directory prunes it, so nothing inside it is walked either.
///
/// The root itself is kept whatever it is called, because a user who opens a folder named `dist`
/// opened it deliberately and hiding its entire contents from them would be absurd. Files are kept
/// whatever they are called too: the four names describe folders, and a document called `target.md`
/// is a document.
///
/// Shared by every walk in the app rather than written out once per walk, so the sidebar, the index
/// and the link sweep cannot drift apart about which folders are never worth descending into.
fn not_always_skipped(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
        return true;
    }
    !ALWAYS_SKIPPED.contains(&entry.file_name().to_string_lossy().as_ref())
}

/// One pass over a folder, returning the root node with everything under it already attached.
///
/// `show_ignored` turns off gitignore, the hidden file rule and the four always skipped folders in
/// one go, for a settings toggle that lets a user see what the tree is holding back.
pub fn scan_tree(root: &Path, show_ignored: bool) -> Result<FileNode, String> {
    let meta = fs::metadata(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if !meta.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }

    let mut builder = WalkBuilder::new(root);
    builder
        // A symlinked folder pointing back at one of its own ancestors would otherwise walk for
        // ever, and a documents folder is exactly where somebody keeps one.
        .follow_links(false)
        // A .gitignore is worth honouring whether or not the folder is a checkout: the user wrote
        // it about these files either way.
        .require_git(false)
        .standard_filters(!show_ignored);
    if !show_ignored {
        builder.filter_entry(not_always_skipped);
    }

    let mut nodes: HashMap<PathBuf, FileNode> = HashMap::new();
    let mut children: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for entry in builder.build() {
        // One unreadable entry is one missing row and not a failed tree. A documents folder can
        // easily hold something the user cannot stat, and losing the whole sidebar over it would
        // be a far worse answer than losing the row.
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path().to_path_buf();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let modified = entry.metadata().map(|m| modified_ms(&m)).unwrap_or(0);
        if entry.depth() > 0 {
            if let Some(parent) = path.parent() {
                children
                    .entry(parent.to_path_buf())
                    .or_default()
                    .push(path.clone());
            }
        }
        nodes.insert(path.clone(), node_from(&path, is_dir, modified));
    }

    assemble(root, &mut nodes, &children).ok_or_else(|| format!("cannot read {}", root.display()))
}

/// Every markdown document under `root`, as flat paths, walked by the link sweep's rules rather
/// than the sidebar's.
///
/// This walk exists because a .gitignore is a statement about version control and not about whether
/// a file is a document. The tree and the index honour it, and they are right to: a sidebar full of
/// build output and a search box full of vendored READMEs are both worse than those files staying
/// out of sight, and neither of them changes anything by leaving a file alone. A link is the
/// opposite case. A relative link inside an ignored draft is still a link the user follows, and
/// leaving it pointing at a path that this app is the thing that moved is a break nobody finds
/// until the day they click it. Hiding that file costs the user a broken document rather than a
/// tidy sidebar, so the sweep walks by its own rules and the two are allowed to disagree.
///
/// So the three git sources come off and the four hardcoded folders stay on, which is what keeps a
/// checkout's node_modules out of the sweep whether or not git was ever asked about it. Hidden
/// files stay out for the same reason, since a dotted folder is where other languages keep their
/// tooling and none of `.venv`, `.next`, `.cache`, `.tox` or `.gradle` holds a link anybody wrote.
/// A `.ignore` or `.rgignore` is still honoured, because that file is written for tools that walk
/// rather than for git, which makes it the honest way to tell this walk to stay out of a folder.
///
/// `limit` bounds the work, because the sweep reads and rewrites every file this returns and an
/// unbounded one over a folder the size of somebody's home directory is not what they asked for
/// when they renamed a file. There is deliberately no depth cap to go with it: a document one level
/// past a depth cap is silently not swept and nothing anywhere says so, which is the same class of
/// bug this function exists to fix. A count is honest instead, because the caller can see it was
/// hit. Which is why one path past the limit comes back rather than exactly `limit` of them: a
/// folder holding exactly the budget and a folder holding ten thousand more look identical at
/// `limit` paths, and the caller has to be able to tell them apart to say that its coverage was
/// partial rather than reporting a complete sweep of a subset.
pub fn documents_for_sweep(root: &Path, limit: usize) -> Vec<String> {
    let mut builder = WalkBuilder::new(root);
    builder
        // A symlinked folder pointing back at one of its own ancestors would otherwise walk for
        // ever, exactly as it would for the tree.
        .follow_links(false)
        .hidden(true)
        // No climbing above the walk root looking for ignore files. The sweep is about this one
        // folder, and what some parent of it happens to say about it is not this folder's business.
        .parents(false)
        .ignore(true)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false);
    builder.filter_entry(not_always_skipped);

    let mut out = Vec::new();
    for entry in builder.build() {
        // One unreadable entry is one document the sweep does not visit and not a failed sweep. The
        // caller reports what it covered either way, so losing a row here is a smaller and more
        // honest failure than refusing to rewrite anything at all.
        let Ok(entry) = entry else { continue };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        // Markdown only. Plain text is indexed and searchable, but nothing in a .txt is a markdown
        // link this app knows how to rewrite, and opening every one of them to find that out would
        // be work spent to change nothing.
        if kind_for(entry.path(), false) != "markdown" {
            continue;
        }
        out.push(path_string(entry.path()));
        if out.len() > limit {
            break;
        }
    }
    out
}

pub fn read_document(path: &Path) -> Result<ReadResult, String> {
    // The mtime is taken before the read rather than after. Read the other way round and a change
    // landing between the two would be stamped onto older text, and the next save would overwrite
    // it believing it had seen it.
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("not a file: {}", path.display()));
    }
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(ReadResult {
        path: path_string(path),
        text,
        modified_ms: modified_ms(&meta),
    })
}

pub fn write_document(
    path: &Path,
    text: &str,
    expected_modified_ms: Option<i64>,
) -> Result<WriteResult, String> {
    // A file that is gone falls through to the write. Recreating a document somebody deleted under
    // the user is not clobbering a change, and refusing would strand the buffer with nowhere to go.
    if let (Some(expected), Ok(meta)) = (expected_modified_ms, fs::metadata(path)) {
        let current = modified_ms(&meta);
        if current != expected {
            return Ok(WriteResult {
                path: path_string(path),
                modified_ms: current,
                conflict: true,
            });
        }
    }
    atomic_write(path, text.as_bytes())?;
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(WriteResult {
        path: path_string(path),
        modified_ms: modified_ms(&meta),
        conflict: false,
    })
}

pub fn create_file(parent: &Path, name: &str) -> Result<FileNode, String> {
    let name = check_name(name)?;
    if !parent.is_dir() {
        return Err(format!("not a folder: {}", parent.display()));
    }
    let target = free_path(parent, name);
    // create_new rather than a check and then a create: the whole point of the untitled rule is
    // that nothing is ever overwritten, and another process can take the name between the two.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("{}: {e}", target.display()))?;
    node_for(&target)
}

pub fn create_folder(parent: &Path, name: &str) -> Result<FileNode, String> {
    let name = check_name(name)?;
    if !parent.is_dir() {
        return Err(format!("not a folder: {}", parent.display()));
    }
    let target = free_path(parent, name);
    fs::create_dir(&target).map_err(|e| format!("{}: {e}", target.display()))?;
    node_for(&target)
}

pub fn rename_entry(path: &Path, name: &str) -> Result<FileNode, String> {
    let name = check_name(name)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("cannot rename {}", path.display()))?;
    let target = parent.join(name);
    if target == path {
        return node_for(path);
    }
    // On a case insensitive volume a case only rename finds the file being renamed already sitting
    // at the target, which is not a collision.
    if taken(&target) && fs::canonicalize(&target).ok() != fs::canonicalize(path).ok() {
        return Err(format!("already exists: {}", target.display()));
    }
    fs::rename(path, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    node_for(&target)
}

pub fn move_entry(path: &Path, dest_dir: &Path) -> Result<FileNode, String> {
    if !dest_dir.is_dir() {
        return Err(format!("not a folder: {}", dest_dir.display()));
    }
    if dest_dir.starts_with(path) {
        return Err(format!("cannot move {} inside itself", path.display()));
    }
    if path.parent() == Some(dest_dir) {
        // Already there. Going on would hand it a free name and leave two of it.
        return node_for(path);
    }
    let name = path
        .file_name()
        .ok_or_else(|| format!("cannot move {}", path.display()))?
        .to_string_lossy()
        .into_owned();
    let target = free_path(dest_dir, &name);
    if fs::rename(path, &target).is_ok() {
        return node_for(&target);
    }
    // A rename cannot cross a volume, so the move becomes a copy and a trip to the Trash. Never a
    // remove: if anything about this went wrong the original is still recoverable in Finder.
    copy_tree(path, &target)?;
    trash_entry(path)?;
    node_for(&target)
}

fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| format!("{}: {e}", src.display()))?;
    if !meta.is_dir() {
        return fs::copy(src, dest)
            .map(|_| ())
            .map_err(|e| format!("{}: {e}", dest.display()));
    }
    fs::create_dir(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("{}: {e}", src.display()))?;
        copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
    }
    Ok(())
}

pub fn duplicate_entry(path: &Path) -> Result<FileNode, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("cannot duplicate {}", path.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("cannot duplicate {}", path.display()))?
        .to_string_lossy()
        .into_owned();
    let target = free_path(parent, &name);
    copy_tree(path, &target)?;
    node_for(&target)
}

/// Never `fs::remove_file`. These are the user's own documents and this app does not get to be the
/// reason one of them is gone for good.
pub fn trash_entry(path: &Path) -> Result<(), String> {
    // Not `trash::delete`, whose macOS default asks Finder to do it over an Apple event. That is
    // the method that leaves Put Back on the file, and it is the wrong trade here: an Apple event
    // from a hardened runtime needs an entitlement and a one time permission prompt, and a delete
    // that fails because the user said no to a dialog about controlling Finder is a worse answer
    // than a delete with no Put Back. `trashItemAtURL:` asks nobody, makes no sound and is faster.
    // A file trashed this way is still in the Trash and can still be dragged back out.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::default();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context
            .delete(path)
            .map_err(|e| format!("{}: {e}", path.display()))
    }
    #[cfg(not(target_os = "macos"))]
    trash::delete(path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn write_asset(doc_path: &Path, bytes: &[u8], name: &str) -> Result<AssetResult, String> {
    let dir = doc_path
        .parent()
        .ok_or_else(|| format!("cannot place an image beside {}", doc_path.display()))?;
    // The clipboard suggests the name, so it is a suggestion and not a path: only the last
    // component of it is ever used.
    let suggested = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| check_name(n).is_ok())
        .unwrap_or_else(|| FALLBACK_ASSET_NAME.to_string());

    let assets = dir.join("assets");
    if taken(&assets) {
        if !assets.is_dir() {
            return Err(format!("not a folder: {}", assets.display()));
        }
    } else {
        fs::create_dir_all(&assets).map_err(|e| format!("{}: {e}", assets.display()))?;
    }

    let target = free_path(&assets, &suggested);
    atomic_write(&target, bytes)?;
    let file = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(suggested);
    Ok(AssetResult {
        path: path_string(&target),
        rel_path: format!("assets/{file}"),
    })
}

/// A root id is a hash of the path and of nothing else, so the same folder is the same root after
/// a relaunch and the frontend can address one without carrying its path around. FNV-1a rather
/// than the standard hasher, whose output is only promised to be stable within one build.
pub fn root_id_for(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn roots_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::library::app_data_dir(app)?.join(ROOTS_FILE))
}

fn load_roots(app: &AppHandle) -> Vec<RootInfo> {
    let Ok(file) = roots_file(app) else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(file) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_roots(app: &AppHandle, roots: &[RootInfo]) -> Result<(), String> {
    let file = roots_file(app)?;
    let text = serde_json::to_string_pretty(roots).map_err(|e| e.to_string())?;
    atomic_write(&file, text.as_bytes())
}

/// Every folder currently open, in the order they were opened, which is the order the sidebar
/// lists them in.
///
/// The list outlives a relaunch, so the first call after launch reads it back from the app data
/// directory and fills the managed state from it. A root whose folder has since been deleted,
/// renamed or unmounted is dropped rather than handed back as a row that cannot be expanded.
#[tauri::command]
pub fn roots_list(app: AppHandle, roots: State<'_, Roots>) -> Result<Vec<RootInfo>, String> {
    let mut open = roots.0.lock().map_err(|e| e.to_string())?;
    if open.is_empty() {
        *open = load_roots(&app);
    }
    let before = open.len();
    open.retain(|root| Path::new(&root.path).is_dir());
    if open.len() != before {
        save_roots(&app, &open)?;
    }
    Ok(open.clone())
}

/// Adds `path` to the open roots and returns it. Idempotent: opening a folder that is already open
/// returns the entry that is already there rather than a second copy of it.
///
/// `id` is derived from the path and from nothing else, so the same folder is the same root across
/// relaunches and the frontend can address a root without carrying its path around. Opening a
/// folder never writes anything into it, and that includes not creating it: a `path` that is not
/// an existing directory is an error, not a mkdir.
#[tauri::command]
pub fn root_open(app: AppHandle, roots: State<'_, Roots>, path: String) -> Result<RootInfo, String> {
    let canonical = fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a folder: {}", canonical.display()));
    }
    let path = path_string(&canonical);
    let id = root_id_for(&path);

    let mut open = roots.0.lock().map_err(|e| e.to_string())?;
    if open.is_empty() {
        *open = load_roots(&app);
    }
    if let Some(existing) = open.iter().find(|root| root.id == id) {
        return Ok(existing.clone());
    }
    let info = RootInfo {
        id,
        name: canonical
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone()),
        path,
        opened_ms: now_ms(),
    };
    open.push(info.clone());
    save_roots(&app, &open)?;
    // The lock goes before the index hears about the folder: the indexer's first move is to ask
    // `Roots` where that root is, and it should not have to wait for this command to return.
    drop(open);
    // Scanned now rather than at the next rebuild, or a folder just opened would answer nothing at
    // all to a search until something else asked for a full pass.
    crate::index::scan_root(&app, info.clone());
    Ok(info)
}

/// Forgets a root and persists the shorter list. Touches nothing inside the folder itself.
///
/// Stopping the watcher is not done here. The frontend calls `watch_stop` for the same root, which
/// keeps this module from having to know that the watcher exists.
#[tauri::command]
pub fn root_close(app: AppHandle, roots: State<'_, Roots>, root_id: String) -> Result<(), String> {
    let mut open = roots.0.lock().map_err(|e| e.to_string())?;
    let before = open.len();
    open.retain(|root| root.id != root_id);
    if open.len() == before {
        return Ok(());
    }
    save_roots(&app, &open)?;
    drop(open);
    // The rows go with the folder. Nothing can be opened from a search result that belongs to a
    // folder that is no longer there to open it in.
    crate::index::forget_root(&app, &root_id);
    Ok(())
}

/// The whole tree for one root in a single pass, the root node itself included. Empty `children`
/// therefore means an empty directory, never one that has not been explored yet.
///
/// Gitignore aware through the `ignore` crate, and `.git` itself is skipped too: a documents folder
/// under version control should not surface its own ignored build output as if it were documents.
/// Everything else is returned, including files the editor cannot open, because the tree greys
/// those rows out rather than hiding them. Children come back sorted directories first and then by
/// name, case insensitively, so the tree does not reshuffle itself between two reads of an
/// unchanged folder.
#[tauri::command(async)]
pub fn tree_read(roots: State<'_, Roots>, root_id: String) -> Result<FileNode, String> {
    let path = roots.path_for(&root_id)?;
    scan_tree(Path::new(&path), false)
}

/// The flat list of markdown documents the link rewrite sweep has to visit in one root, at most
/// `limit` of them plus one more if the folder holds more than that.
///
/// This is deliberately not `tree_read`, and the difference is the whole point of it. The tree
/// hides what the folder's gitignore hides, which is the right answer for a sidebar and for search
/// because both of them only ever read: the worst a hidden row costs is a file the user has to find
/// another way. The sweep writes. A stale link left inside a file the tree chose not to show is
/// bytes on disk that look correct and are not, and the user learns about it by clicking the link
/// long after the rename that broke it. Reusing the tree's walk here would mean the app quietly
/// breaks the documents it decided were not worth showing, which is worse than either not renaming
/// or renaming loudly.
///
/// The count that comes back is the caller's, not this command's, business: a list longer than
/// `limit` means the folder overflowed the budget, and the caller is expected to say the sweep was
/// partial rather than rewrite the first `limit` files and report a finished job.
#[tauri::command(async)]
pub fn sweep_documents(
    roots: State<'_, Roots>,
    root_id: String,
    limit: u32,
) -> Result<Vec<String>, String> {
    let path = roots.path_for(&root_id)?;
    Ok(documents_for_sweep(Path::new(&path), limit as usize))
}

/// Opens Finder with the file selected, rather than opening the file.
#[tauri::command]
pub fn reveal_in_finder(
    app: AppHandle,
    roots: State<'_, Roots>,
    path: String,
) -> Result<(), String> {
    let path = checked(&roots, &path)?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Hands a file to whatever macOS opens it with. This is the only way a non editable file in the
/// tree can be opened at all, so it has to work for anything, not just for documents.
#[tauri::command]
pub fn open_external(app: AppHandle, roots: State<'_, Roots>, path: String) -> Result<(), String> {
    let path = checked(&roots, &path)?;
    app.opener()
        .open_path(path_string(&path), None::<&str>)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Reads a document as UTF-8, and reads nothing else: no metadata is written, no lock is taken and
/// no sidecar appears beside it.
///
/// `modified_ms` is the file's mtime as it was at the moment of the read. The caller keeps it and
/// hands it back on write, which is the only thing that can tell an unsaved buffer apart from a
/// file another program has touched since. A file that is not valid UTF-8 is an error rather than
/// a lossy conversion, because a lossy read followed by a save would corrupt the user's file.
#[tauri::command(async)]
pub fn file_read(roots: State<'_, Roots>, path: String) -> Result<ReadResult, String> {
    read_document(&checked(&roots, &path)?)
}

/// Writes a document atomically: a temp file in the same directory, flushed and synced, then
/// renamed over the target. The old bytes survive a crash, a full disk and a power cut mid-write.
///
/// `expected_modified_ms` is the mtime the caller last saw. If the file has moved on from it,
/// nothing is written and the result carries `conflict`, which is not an error: the document is
/// still open, still unsaved, and the user is the one who decides which copy wins. `None` means
/// write regardless, which is what a first save of a new file does.
///
/// Permissions, ownership and any extended attributes of the original survive the rename, since
/// the file the user ends up with is the temp file and it must not arrive with different bits.
///
/// The index is told directly rather than through the watcher. `watch::note_self_write` drops the
/// app's own writes out of the watch stream so an autosave does not come back as somebody else's
/// edit, which means the one document the watcher never reports is the one the user is working in.
/// Without this line the only version of it the index would ever hold is the one from before they
/// started typing.
#[tauri::command(async)]
pub fn file_write(
    app: AppHandle,
    roots: State<'_, Roots>,
    path: String,
    text: String,
    expected_modified_ms: Option<i64>,
) -> Result<WriteResult, String> {
    let path = checked(&roots, &path)?;
    let result = write_document(&path, &text, expected_modified_ms)?;
    // A conflict wrote nothing, and whatever moved the file on is an outside change the watcher
    // does report.
    if !result.conflict {
        crate::index::note_write(&app, &path);
    }
    Ok(result)
}

/// Creates an empty file inside `parent_path`. `name` is a suggestion: a name already taken gets a
/// suffix, and the node that comes back carries the name that was really used, so the caller never
/// has to guess at it or race another process for it.
#[tauri::command]
pub fn file_create(
    roots: State<'_, Roots>,
    parent_path: String,
    name: String,
) -> Result<FileNode, String> {
    create_file(&checked(&roots, &parent_path)?, &name)
}

/// Creates an empty directory inside `parent_path`, under the same suggested-name rule as
/// `file_create`.
#[tauri::command]
pub fn file_folder_create(
    roots: State<'_, Roots>,
    parent_path: String,
    name: String,
) -> Result<FileNode, String> {
    create_folder(&checked(&roots, &parent_path)?, &name)
}

/// Renames a file or folder where it stands. `name` is a base name and not a path: a `name` holding
/// a path separator is an error, because this command cannot move anything and quietly doing so
/// would be worse than refusing.
///
/// This is the only thing that changes a document's identity, and it happens because the user asked
/// for it. Nothing in this app renames a file on its own, least of all because a heading changed.
#[tauri::command]
pub fn file_rename(
    roots: State<'_, Roots>,
    path: String,
    name: String,
) -> Result<FileNode, String> {
    rename_entry(&checked(&roots, &path)?, &name)
}

/// Moves a file or folder into `dest_dir`, keeping its name unless that name is taken there.
///
/// This command moves bytes and nothing else. The relative links a move breaks are rewritten a
/// layer up, in src/linkRewrite.ts, which splices one destination at a time into the file's own
/// text and never hands a document to the serializer, so a file whose links did not move is not
/// written at all.
#[tauri::command]
pub fn file_move(
    roots: State<'_, Roots>,
    path: String,
    dest_dir: String,
) -> Result<FileNode, String> {
    let open = open_root_paths(&roots)?;
    let path = resolve_in_roots(&open, &path)?;
    let dest_dir = resolve_in_roots(&open, &dest_dir)?;
    move_entry(&path, &dest_dir)
}

/// Copies a file, or a folder and everything under it, beside itself under a free name. The copy is
/// byte for byte: nothing is parsed, normalised or reformatted on the way through.
#[tauri::command(async)]
pub fn file_duplicate(roots: State<'_, Roots>, path: String) -> Result<FileNode, String> {
    duplicate_entry(&checked(&roots, &path)?)
}

/// Sends a file or folder to the system Trash through the `trash` crate, never `remove_file`. These
/// are the user's own documents and this app does not get to be the reason one of them is gone for
/// good, so a delete is always something Finder can undo.
#[tauri::command(async)]
pub fn file_trash(roots: State<'_, Roots>, path: String) -> Result<(), String> {
    trash_entry(&checked(&roots, &path)?)
}

/// Writes a pasted image into an `assets/` folder beside the document that received the paste,
/// creating that folder when it is not already there. Images are the only thing other than markdown
/// this app ever puts inside a user's folder.
///
/// `name` is what the clipboard suggested, which is usually `image.png` and usually already taken,
/// so a taken name gets a suffix. `rel_path` in the result is what goes into the markdown link,
/// relative to the document, so the folder stays movable and shareable as a whole.
#[tauri::command(async)]
pub fn asset_write(
    roots: State<'_, Roots>,
    doc_path: String,
    bytes: Vec<u8>,
    name: String,
) -> Result<AssetResult, String> {
    write_asset(&checked(&roots, &doc_path)?, &bytes, &name)
}

// The SQLite index, which lives in the app data directory and never inside a folder the user
// opened. It is derived state rather than a source of truth: every row is rebuilt from the files on
// disk, so deleting the database costs nothing but the time to walk the open roots again. It is
// kept current from the same debounced batch the watcher already sends the frontend, plus one call
// in `file_write` for the app's own saves, which are the changes that batch deliberately never
// mentions.
//
// Everything below is a handful of lines because the index itself is a module of its own: these are
// the commands, and index.rs is the database.

/// Rescans every open root from scratch and returns the status the pass started with. Progress
/// arrives on the `index-progress` event, because a full rescan of a large folder outlives any one
/// command.
#[tauri::command(async)]
pub fn index_rebuild(app: AppHandle, roots: State<'_, Roots>) -> Result<IndexStatus, String> {
    // The roots are read here rather than on the indexer's thread, so the pass covers the folders
    // that were open when the user asked for it and not whatever the list has become since.
    let open = roots.0.lock().map_err(|e| e.to_string())?.clone();
    crate::index::rebuild(&app, open)
}

/// Where the index has got to, for the status line. Cheap enough to poll and safe to call before
/// any indexing has ever run.
#[tauri::command]
pub fn index_status(app: AppHandle) -> Result<IndexStatus, String> {
    crate::index::status(&app)
}

/// Fuzzy match over paths relative to their root, across every open root, best score first.
///
/// `ranges` index into `rel_path`, which is also the string the row shows, so a match on a folder
/// name is highlighted where it really was. They are character offsets and not byte offsets,
/// because the other end is JavaScript and highlights by character.
#[tauri::command(async)]
pub fn search_quick_open(
    app: AppHandle,
    query: String,
    limit: u32,
) -> Result<Vec<QuickOpenHit>, String> {
    crate::index::quick_open(&app, &query, limit)
}

/// Full text search across every open root through FTS5.
///
/// `line` is one based and counted over the file as it sits on disk, frontmatter included, so
/// jumping to a hit lands on the line the user can see in any other editor. `ranges` index into
/// `snippet`, again by character.
#[tauri::command(async)]
pub fn search_text(app: AppHandle, query: String, limit: u32) -> Result<Vec<SearchHit>, String> {
    crate::index::search(&app, &query, limit)
}

/// Every document holding a relative markdown link that resolves to `path`.
///
/// This is a reverse lookup over links that are already in the files. Nothing is written anywhere
/// to make a backlink exist, and a document with no incoming links simply has none.
#[tauri::command(async)]
pub fn backlinks_for(app: AppHandle, path: String) -> Result<Vec<Backlink>, String> {
    crate::index::backlinks(&app, &path)
}
