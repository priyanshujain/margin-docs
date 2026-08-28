// The IPC contract. Every type here has a matching declaration in src/ipc.ts. Both sides are
// frozen once written: implementation modules add bodies, not fields.
//
// Types only. No `#[tauri::command]` lives here: the commands sit in the modules that implement
// them and are registered in lib.rs.

use serde::{Deserialize, Serialize};

/// One open folder. `id` is derived from the path, so it survives a relaunch and a root can be
/// addressed without the frontend carrying the path around.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub id: String,
    pub path: String,
    /// The folder's own name, which is what the sidebar heading shows.
    pub name: String,
    pub opened_ms: i64,
}

/// A node in one root's tree, including the root itself. The whole tree is read in one go, so
/// `children` being empty means a directory is empty, never that it is unexplored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub path: String,
    pub name: String,
    /// dir | markdown | text | other
    pub kind: String,
    /// True for markdown and .txt, the two kinds that open in the editor. A directory is not
    /// editable either, so the greyed row in the tree is `kind == "other"` and not `!editable`.
    pub editable: bool,
    pub modified_ms: i64,
    #[serde(default)]
    pub children: Vec<FileNode>,
}

/// `modified_ms` is the timestamp the text was read at. The frontend keeps it and hands it back
/// on write, which is the only way it can tell its buffer apart from a file something else has
/// touched since. Frontmatter is not split out here: the editor parses it, hides it and writes it
/// back, so the backend only ever sees a whole document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub path: String,
    pub text: String,
    pub modified_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub modified_ms: i64,
    /// The file moved on from the timestamp the caller expected and nothing was written. Not an
    /// error: the document is still open and still unsaved, and the user has to be asked which
    /// copy wins.
    pub conflict: bool,
}

/// Where a pasted image landed. `rel_path` is what goes into the markdown link, relative to the
/// document that received the paste; `path` is absolute, which is what the tree needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetResult {
    pub path: String,
    pub rel_path: String,
}

/// Payload of the `watch-event` event. `root` is a `RootInfo` id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub root: String,
    pub path: String,
    /// created | modified | removed | renamed
    pub kind: String,
    /// Where the file was before a rename, absent on every other kind.
    #[serde(default)]
    pub old_path: Option<String>,
}

/// Progress of the SQLite index, which lives in the app data directory and never in a user
/// folder. Also the payload of the `index-progress` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// idle | indexing | error
    pub phase: String,
    pub indexed: u32,
    pub total: u32,
    /// Epoch milliseconds of the last completed pass.
    pub last_indexed: Option<i64>,
    pub error: Option<String>,
    pub message: Option<String>,
}

impl Default for IndexStatus {
    fn default() -> Self {
        IndexStatus {
            phase: "idle".to_string(),
            indexed: 0,
            total: 0,
            last_indexed: None,
            error: None,
            message: None,
        }
    }
}

/// Half-open offsets into whichever string the hit says they belong to, for highlighting.
///
/// The unit is a UTF-16 code unit, which is what a JavaScript string is indexed in and what the
/// `slice` that draws the highlight counts. Not bytes, and deliberately not code points either:
/// index.rs works in code points throughout and converts once at the boundary, in `to_utf16`,
/// because the two agree on everything in the BMP and disagree by one per emoji, which is exactly
/// the kind of difference that is invisible until somebody puts one in a filename.
///
/// `SpellIssue` counts differently on purpose. Its offsets address a ProseMirror document, and
/// ProseMirror counts code points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

/// One quick-open result. `ranges` index into `rel_path`, which is also what the row shows, so a
/// match on a folder name can be highlighted where it actually was.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenHit {
    pub path: String,
    pub name: String,
    pub root: String,
    pub rel_path: String,
    pub score: i32,
    #[serde(default)]
    pub ranges: Vec<MatchRange>,
}

/// One full text result. `line` is one-based and counted over the file as it sits on disk,
/// frontmatter included, so jumping to it lands in the right place. `ranges` index into `snippet`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub root: String,
    pub title: String,
    pub line: u32,
    pub snippet: String,
    #[serde(default)]
    pub ranges: Vec<MatchRange>,
}

/// A document that links here, shown at the end of the document it points at. Links between
/// documents are relative markdown links, so a backlink is a resolved `](../thing.md)` and
/// nothing more.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

/// One misspelling in a run of text handed to the checker.
///
/// `start` and `end` are half-open offsets in *characters*, not bytes and not UTF-16 units,
/// because the other end is JavaScript addressing a ProseMirror document and ProseMirror counts
/// in code points. macspell.rs does the conversion from the UTF-16 ranges AppKit answers in, and
/// it is the only place in the app where that conversion is allowed to happen.
///
/// A word with no guesses is still an issue: NSSpellChecker regularly flags a typo it has no
/// suggestion for, and dropping it because the menu would be empty is how a checker earns a
/// reputation for missing things.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellIssue {
    pub start: usize,
    pub end: usize,
    pub word: String,
    #[serde(default)]
    pub suggestions: Vec<String>,
}
