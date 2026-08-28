// The filesystem layer is the only part of this app that can lose somebody's work, so the tests
// here are about the promises rather than the plumbing: a failed write leaves the old file whole,
// a conflict writes nothing at all, a name is never taken from a file that already has it, a path
// from the frontend cannot reach outside the folders the user opened, and a delete is always
// something Finder can undo.

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

use margin_docs_lib::dto::FileNode;
use margin_docs_lib::fs::{
    atomic_write, create_file, create_folder, duplicate_entry, free_path, move_entry, read_document,
    rename_entry, resolve_in_roots, root_id_for, scan_tree, trash_entry, write_asset,
    write_document,
};
use tempfile::TempDir;

fn root() -> TempDir {
    TempDir::new().expect("a temp dir")
}

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, text).unwrap();
}

fn names(node: &FileNode) -> Vec<String> {
    node.children.iter().map(|c| c.name.clone()).collect()
}

fn find<'a>(node: &'a FileNode, name: &str) -> Option<&'a FileNode> {
    node.children.iter().find(|c| c.name == name)
}

fn flat(node: &FileNode, into: &mut Vec<String>) {
    into.push(node.name.clone());
    for child in &node.children {
        flat(child, into);
    }
}

#[test]
fn a_failed_write_leaves_the_original_whole() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "the original");

    // A folder that cannot be written to makes the write fail at its first step, which is the
    // moment the original is most at risk. The temp name cannot be blocked from outside any more,
    // since it is unique per call, so the folder is what gets taken away instead.
    let open = fs::metadata(dir.path()).unwrap().permissions();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o500)).unwrap();

    let result = atomic_write(&doc, b"the replacement");

    fs::set_permissions(dir.path(), open).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(&doc).unwrap(), "the original");
}

/// A `.bak` or a `.tmp` named after a document is a file somebody may have written on purpose, and
/// a save of the document it is named after is not permission to unlink it.
#[test]
fn a_write_leaves_the_users_own_bak_and_tmp_siblings_alone() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    let bak = dir.path().join("doc.md.bak");
    let tmp = dir.path().join("doc.md.tmp");
    write(&doc, "one");
    write(&bak, "a revision the author kept on purpose");
    write(&tmp, "a scratch file the author kept on purpose");

    atomic_write(&doc, b"two").unwrap();

    assert_eq!(fs::read_to_string(&doc).unwrap(), "two");
    assert_eq!(
        fs::read_to_string(&bak).unwrap(),
        "a revision the author kept on purpose",
        "the save deleted a backup the user owned"
    );
    assert_eq!(
        fs::read_to_string(&tmp).unwrap(),
        "a scratch file the author kept on purpose",
        "the save deleted a scratch file the user owned"
    );
}

/// Nothing named after the document may appear beside it, not even for the length of one save.
/// Anything else watching the folder, git included, sees whatever is there while the write runs, and
/// a crash halfway through strands it for good.
#[test]
fn a_save_puts_nothing_document_shaped_beside_the_document() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "one");

    let watched = dir.path().to_path_buf();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let poller = std::thread::spawn(move || {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        while stop_rx.try_recv().is_err() {
            if let Ok(entries) = fs::read_dir(&watched) {
                for entry in entries.flatten() {
                    seen.insert(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        seen
    });

    // Big enough that the copy, the write and the fsync are a window a poller can see into.
    atomic_write(&doc, &vec![b'z'; 32 * 1024 * 1024]).unwrap();
    stop_tx.send(()).ok();
    let seen = poller.join().unwrap();

    let strays: Vec<&String> = seen
        .iter()
        .filter(|name| name.as_str() != "doc.md")
        .filter(|name| !(name.starts_with(".doc.md.") && name.ends_with(".tmp")))
        .collect();
    assert!(strays.is_empty(), "a save put these beside the document: {strays:?}");
    assert!(
        seen.iter().any(|name| name.starts_with(".doc.md.")),
        "the poller never caught the temp file, so this proved nothing: {seen:?}"
    );

    let left: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, vec!["doc.md".to_string()]);
}

/// A debounced autosave and a Cmd+S both in flight are two saves of one document. Naming the temp
/// file after the target made them race on one path, and the loser took the document with it.
#[test]
fn concurrent_saves_of_one_document_all_land_and_none_loses_it() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "the original");

    let payloads: Vec<String> = (0..4)
        .map(|n| format!("save number {n}\n{}\n", "z".repeat(1024 * 1024)))
        .collect();
    let writers: Vec<_> = payloads
        .iter()
        .cloned()
        .map(|text| {
            let doc = doc.clone();
            std::thread::spawn(move || atomic_write(&doc, text.as_bytes()))
        })
        .collect();
    for writer in writers {
        writer
            .join()
            .expect("a writer thread")
            .expect("every concurrent save succeeds");
    }

    let landed = fs::read_to_string(&doc).expect("the document is still there");
    assert!(
        payloads.contains(&landed),
        "the document holds neither writer's text"
    );
    let left: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, vec!["doc.md".to_string()]);
}

#[test]
fn a_write_leaves_no_temp_and_no_backup_behind() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "one");

    atomic_write(&doc, b"two").unwrap();

    assert_eq!(fs::read_to_string(&doc).unwrap(), "two");
    let mut left: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, vec!["doc.md".to_string()]);
}

#[test]
fn a_write_keeps_the_permissions_the_file_had() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "one");
    fs::set_permissions(&doc, fs::Permissions::from_mode(0o600)).unwrap();

    atomic_write(&doc, b"two").unwrap();

    let mode = fs::metadata(&doc).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn a_conflict_writes_nothing() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "what is on disk");
    let seen = read_document(&doc).unwrap();

    let result = write_document(&doc, "what the buffer holds", Some(seen.modified_ms - 5_000))
        .expect("a conflict is a result and not an error");

    assert!(result.conflict);
    assert_eq!(fs::read_to_string(&doc).unwrap(), "what is on disk");
}

#[test]
fn the_timestamp_the_caller_saw_lets_the_write_through() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "one");
    let seen = read_document(&doc).unwrap();

    let result = write_document(&doc, "two", Some(seen.modified_ms)).unwrap();

    assert!(!result.conflict);
    assert_eq!(fs::read_to_string(&doc).unwrap(), "two");
}

#[test]
fn reading_a_document_writes_nothing() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    write(&doc, "# Heading\n");
    let before = fs::metadata(&doc).unwrap().modified().unwrap();

    let read = read_document(&doc).unwrap();

    assert_eq!(read.text, "# Heading\n");
    assert_eq!(fs::metadata(&doc).unwrap().modified().unwrap(), before);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn a_document_that_is_not_utf8_is_an_error_and_not_a_lossy_read() {
    let dir = root();
    let doc = dir.path().join("doc.md");
    fs::write(&doc, [0xff, 0xfe, 0x00, 0x41]).unwrap();

    assert!(read_document(&doc).is_err());
}

#[test]
fn untitled_naming_does_not_collide() {
    let dir = root();

    let first = create_file(dir.path(), "untitled.md").unwrap();
    let second = create_file(dir.path(), "untitled.md").unwrap();
    let third = create_file(dir.path(), "untitled.md").unwrap();

    assert_eq!(first.name, "untitled.md");
    assert_eq!(second.name, "untitled-2.md");
    assert_eq!(third.name, "untitled-3.md");
    assert!(dir.path().join("untitled.md").exists());
    assert!(dir.path().join("untitled-2.md").exists());
    assert!(dir.path().join("untitled-3.md").exists());
    assert!(first.editable);
    assert_eq!(first.kind, "markdown");
}

#[test]
fn a_free_name_never_lands_on_a_file_that_is_there() {
    let dir = root();
    write(&dir.path().join("note.md"), "one");
    write(&dir.path().join("note-2.md"), "two");

    assert_eq!(free_path(dir.path(), "note.md"), dir.path().join("note-3.md"));
}

#[test]
fn a_new_folder_follows_the_same_rule() {
    let dir = root();

    let first = create_folder(dir.path(), "untitled").unwrap();
    let second = create_folder(dir.path(), "untitled").unwrap();

    assert_eq!(first.name, "untitled");
    assert_eq!(first.kind, "dir");
    assert!(!first.editable);
    assert_eq!(second.name, "untitled-2");
}

#[test]
fn the_tree_skips_node_modules_and_the_rest() {
    let dir = root();
    write(&dir.path().join("note.md"), "note");
    write(&dir.path().join("node_modules/left-pad/index.js"), "js");
    write(&dir.path().join(".git/config"), "config");
    write(&dir.path().join("target/debug/thing"), "binary");
    write(&dir.path().join("dist/bundle.js"), "bundle");

    let tree = scan_tree(dir.path(), false).unwrap();

    assert_eq!(names(&tree), vec!["note.md".to_string()]);
}

#[test]
fn the_tree_respects_a_gitignore() {
    let dir = root();
    write(&dir.path().join(".gitignore"), "drafts/\nsecret.md\n");
    write(&dir.path().join("note.md"), "note");
    write(&dir.path().join("secret.md"), "secret");
    write(&dir.path().join("drafts/half.md"), "half");

    let tree = scan_tree(dir.path(), false).unwrap();

    assert_eq!(names(&tree), vec!["note.md".to_string()]);
}

#[test]
fn showing_ignored_files_brings_them_back() {
    let dir = root();
    write(&dir.path().join(".gitignore"), "secret.md\n");
    write(&dir.path().join("note.md"), "note");
    write(&dir.path().join("secret.md"), "secret");
    write(&dir.path().join("node_modules/left-pad/index.js"), "js");

    let tree = scan_tree(dir.path(), true).unwrap();
    let mut all = Vec::new();
    flat(&tree, &mut all);

    assert!(all.contains(&"secret.md".to_string()));
    assert!(all.contains(&"node_modules".to_string()));
}

#[test]
fn the_tree_classifies_every_kind_and_sorts_folders_first() {
    let dir = root();
    write(&dir.path().join("zebra.md"), "md");
    write(&dir.path().join("Apple.txt"), "txt");
    write(&dir.path().join("photo.png"), "png");
    write(&dir.path().join("beta/inner.markdown"), "md");

    let tree = scan_tree(dir.path(), false).unwrap();

    assert_eq!(
        names(&tree),
        vec![
            "beta".to_string(),
            "Apple.txt".to_string(),
            "photo.png".to_string(),
            "zebra.md".to_string(),
        ]
    );
    assert_eq!(find(&tree, "zebra.md").unwrap().kind, "markdown");
    assert!(find(&tree, "Apple.txt").unwrap().editable);
    assert_eq!(find(&tree, "Apple.txt").unwrap().kind, "text");
    assert_eq!(find(&tree, "photo.png").unwrap().kind, "other");
    assert!(!find(&tree, "photo.png").unwrap().editable);
    assert_eq!(find(&tree, "beta").unwrap().children.len(), 1);
}

#[test]
fn a_symlink_loop_does_not_hang_the_scan() {
    let dir = root();
    write(&dir.path().join("note.md"), "note");
    fs::create_dir(dir.path().join("inner")).unwrap();
    symlink(dir.path(), dir.path().join("inner/loop")).unwrap();

    let tree = scan_tree(dir.path(), false).unwrap();
    let mut all = Vec::new();
    flat(&tree, &mut all);

    assert!(all.contains(&"note.md".to_string()));
}

#[test]
fn path_validation_rejects_an_escape() {
    let dir = root();
    let roots = vec![dir.path().to_string_lossy().into_owned()];

    let escape = dir.path().join("../escaped.md");
    assert!(resolve_in_roots(&roots, &escape.to_string_lossy()).is_err());
    assert!(resolve_in_roots(&roots, "/etc/hosts").is_err());
    assert!(resolve_in_roots(&roots, "notes/relative.md").is_err());
    assert!(resolve_in_roots(&[], &dir.path().join("note.md").to_string_lossy()).is_err());
}

#[test]
fn path_validation_rejects_a_symlink_pointing_out_of_the_root() {
    let inside = root();
    let outside = root();
    let secret = outside.path().join("secret.md");
    write(&secret, "secret");
    symlink(&secret, inside.path().join("link.md")).unwrap();
    let roots = vec![inside.path().to_string_lossy().into_owned()];

    let link = inside.path().join("link.md");
    assert!(resolve_in_roots(&roots, &link.to_string_lossy()).is_err());
}

#[test]
fn path_validation_does_not_treat_a_sibling_as_a_child() {
    let dir = root();
    fs::create_dir(dir.path().join("notes")).unwrap();
    fs::create_dir(dir.path().join("notes-old")).unwrap();
    write(&dir.path().join("notes-old/note.md"), "note");
    let roots = vec![dir.path().join("notes").to_string_lossy().into_owned()];

    let sibling = dir.path().join("notes-old/note.md");
    assert!(resolve_in_roots(&roots, &sibling.to_string_lossy()).is_err());
}

#[test]
fn path_validation_accepts_what_is_really_inside() {
    let dir = root();
    let doc = dir.path().join("folder/note.md");
    write(&doc, "note");
    let roots = vec![dir.path().to_string_lossy().into_owned()];

    let resolved = resolve_in_roots(&roots, &doc.to_string_lossy()).unwrap();
    assert_eq!(resolved, fs::canonicalize(&doc).unwrap());

    // A file being created has no canonical path of its own, and it still has to be checked.
    let unborn = dir.path().join("folder/new.md");
    let resolved = resolve_in_roots(&roots, &unborn.to_string_lossy()).unwrap();
    assert_eq!(
        resolved,
        fs::canonicalize(dir.path().join("folder")).unwrap().join("new.md")
    );
}

#[test]
fn trash_does_not_hard_delete() {
    let dir = root();
    let unique = format!(
        "margin-docs-trash-test-{}.md",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let doc = dir.path().join(&unique);
    write(&doc, "recoverable");

    trash_entry(&doc).unwrap();

    assert!(!doc.exists(), "the file is gone from where it was");
    let trashed = PathBuf::from(std::env::var("HOME").unwrap())
        .join(".Trash")
        .join(&unique);
    assert!(trashed.exists(), "and it is sitting in the Trash instead");

    // Best effort, because the contents of the Trash are not always readable or writable by a
    // process that is not Finder. The test above is the assertion; this is only tidying up.
    let _ = fs::remove_file(&trashed);
}

#[test]
fn a_rename_will_not_move() {
    let dir = root();
    let doc = dir.path().join("note.md");
    write(&doc, "note");

    assert!(rename_entry(&doc, "../elsewhere.md").is_err());
    assert!(rename_entry(&doc, "sub/other.md").is_err());
    assert!(rename_entry(&doc, "  ").is_err());
    assert!(doc.exists());

    let renamed = rename_entry(&doc, "other.md").unwrap();
    assert_eq!(renamed.name, "other.md");
    assert!(dir.path().join("other.md").exists());
    assert!(!doc.exists());
}

#[test]
fn a_rename_onto_a_name_that_is_taken_is_refused() {
    let dir = root();
    write(&dir.path().join("one.md"), "one");
    write(&dir.path().join("two.md"), "two");

    assert!(rename_entry(&dir.path().join("one.md"), "two.md").is_err());
    assert_eq!(fs::read_to_string(dir.path().join("two.md")).unwrap(), "two");
}

#[test]
fn a_move_into_the_folder_it_is_already_in_does_nothing() {
    let dir = root();
    let doc = dir.path().join("note.md");
    write(&doc, "note");

    let node = move_entry(&doc, dir.path()).unwrap();

    assert_eq!(node.name, "note.md");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn a_move_will_not_put_a_folder_inside_itself() {
    let dir = root();
    let outer = dir.path().join("outer");
    let inner = outer.join("inner");
    fs::create_dir_all(&inner).unwrap();

    assert!(move_entry(&outer, &inner).is_err());
    assert!(move_entry(&outer, &outer).is_err());
}

#[test]
fn a_move_keeps_the_name_unless_it_is_taken() {
    let dir = root();
    let from = dir.path().join("from");
    let to = dir.path().join("to");
    fs::create_dir_all(&from).unwrap();
    fs::create_dir_all(&to).unwrap();
    write(&from.join("note.md"), "moved");
    write(&to.join("note.md"), "already here");

    let node = move_entry(&from.join("note.md"), &to).unwrap();

    assert_eq!(node.name, "note-2.md");
    assert_eq!(fs::read_to_string(to.join("note.md")).unwrap(), "already here");
    assert_eq!(fs::read_to_string(to.join("note-2.md")).unwrap(), "moved");
}

#[test]
fn duplicating_copies_a_folder_and_everything_under_it() {
    let dir = root();
    write(&dir.path().join("project/note.md"), "note");
    write(&dir.path().join("project/deep/inner.md"), "inner");

    let node = duplicate_entry(&dir.path().join("project")).unwrap();

    assert_eq!(node.name, "project-2");
    assert_eq!(
        fs::read_to_string(dir.path().join("project-2/deep/inner.md")).unwrap(),
        "inner"
    );
    assert_eq!(fs::read_to_string(dir.path().join("project/note.md")).unwrap(), "note");
}

#[test]
fn duplicating_a_document_is_byte_for_byte() {
    let dir = root();
    let doc = dir.path().join("note.md");
    write(&doc, "---\ntitle: x\n---\n\n#   ragged   heading\n");

    let node = duplicate_entry(&doc).unwrap();

    assert_eq!(node.name, "note-2.md");
    assert_eq!(
        fs::read_to_string(dir.path().join("note-2.md")).unwrap(),
        "---\ntitle: x\n---\n\n#   ragged   heading\n"
    );
}

#[test]
fn a_pasted_image_lands_in_assets_beside_the_document() {
    let dir = root();
    let doc = dir.path().join("folder/note.md");
    write(&doc, "note");

    let first = write_asset(&doc, &[0x89, 0x50, 0x4e, 0x47], "image.png").unwrap();
    let second = write_asset(&doc, &[0x89, 0x50, 0x4e, 0x47], "image.png").unwrap();

    assert_eq!(first.rel_path, "assets/image.png");
    assert_eq!(second.rel_path, "assets/image-2.png");
    assert_eq!(
        fs::read(dir.path().join("folder/assets/image.png")).unwrap(),
        vec![0x89, 0x50, 0x4e, 0x47]
    );
    assert!(Path::new(&first.path).is_absolute());
}

#[test]
fn a_suggested_asset_name_is_a_name_and_not_a_path() {
    let dir = root();
    let doc = dir.path().join("note.md");
    write(&doc, "note");

    let result = write_asset(&doc, &[1, 2, 3], "../../../evil.png").unwrap();

    assert_eq!(result.rel_path, "assets/evil.png");
    assert!(dir.path().join("assets/evil.png").exists());
}

#[test]
fn a_root_id_is_the_same_folder_every_time() {
    assert_eq!(root_id_for("/Users/x/notes"), root_id_for("/Users/x/notes"));
    assert_ne!(root_id_for("/Users/x/notes"), root_id_for("/Users/x/other"));
    assert_eq!(root_id_for("/Users/x/notes").len(), 16);
}
