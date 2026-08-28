// Everything the open document does to the disk, and the only place that decides when. The store
// next door holds what is on screen and the setters a keystroke can settle on its own; this module
// reads the file, hands it to the markdown bridge, and writes it back 500ms after the last edit.
//
// Opening writes nothing. There are exactly two calls to `fileWrite` in this file and they are
// worth naming. The first is inside `performSave`, which returns before reaching it unless the
// buffer is dirty, which only `setContent` can make it. That is the product's first promise and
// src/store/useDocument.test.ts asserts it rather than trusting this paragraph. The second is
// inside `rewriteOpenDocument` at the bottom, which src/linkRewrite.ts calls when a move has made
// the open document's own links wrong. It is reached only for a buffer nobody has typed into, and
// only with bytes the caller worked out from the file's own text rather than from the serializer,
// so nothing on that path can put a house style rewrite on a document the user has not edited.
//
// `setContent` marks the buffer dirty through `differsFromDisk` below, which is the second half of
// that promise. That question is asked of the document the file was read from and never of the
// keystroke before, so the answer is "is the buffer different" rather than "did something happen":
// a paragraph typed into and then undone is the document that was opened, and it does not put the
// file on the debounce. A transaction that moved something the markdown has no spelling for gets
// the same answer for the same reason, since the file would not show it either. Dragging a table
// column is the whole of that today.
//
// One edit is refused rather than written, and the serializer's own comments are where that is
// argued out: a raw block beside a list is put back to the bytes the file gave it, because the
// edited bytes are read back as part of the list. That decision is not this module's, but saying
// so is. The writer marks it on the way past, this module puts it in a toast and holds the buffer
// dirty until the edit is taken back or the block is moved, and `refusedOnDisk` below is where it
// is kept. It is the one difference between the buffer and the file that comparing two trees
// cannot find, since the tree those bytes were written from is the buffer itself.
//
// `performSave` also never runs twice at once for the open document: `saveNow` keeps at most one
// call to it on the wire, folding anything that arrives while one is running into a single next
// lap rather than starting a second write alongside the first.
//
// This module and src/store/useDocument.ts import each other: the store's async actions delegate
// down here, and the work down here lands back in the store. Neither touches the other while its
// own module body is still evaluating, so the cycle resolves. Nothing here runs at import time for
// the same reason: the subscription that drives the debounce is installed by `initDocument`, which
// `loadDocument` calls itself so the shell cannot forget to.

import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { fileRead, fileWrite } from "./api/files";
import type { ReadResult, WriteResult } from "./ipc";
import {
  parseMarkdown,
  parsePlainText,
  type Refused,
  serializeMarkdown,
  serializePlainText,
} from "./markdown";
import { documentKindForPath, type MarkdownDocument } from "./model/doc";
import { useDocument } from "./store/useDocument";
import { notify } from "./store/useToast";

/** Long enough that a sentence is one save, short enough that Cmd+Tab away is already on disk. */
export const SAVE_DEBOUNCE_MS = 500;

/**
 * Said when the writer hands back bytes an edit is not in, which is the one edit this editor
 * knowingly does not save.
 *
 * It says which block and it says why, because the alternative the user is left with otherwise is a
 * change that is on screen, is not in the file, and has nothing anywhere to say so. The wording is
 * about the file rather than about the writer: what has happened to them is that the block on disk
 * is the one that was there before, and the reason is that a list is the one construct a blank line
 * does not close.
 */
const REFUSED_MESSAGE =
  "The edit to that block was not saved: beside a list those bytes read back as part of the list, so the file keeps the block it had.";

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * The file as this module last saw it, either read or written: its bytes, and the tree those bytes
 * are the serialization of.
 *
 * The bytes are here because a watcher fires on a touch, on a git checkout that restores the same
 * content and on this app's own save, and without them the buffer would be thrown away and rebuilt
 * for all three. The tree is here because the bytes cannot answer whether the buffer still holds
 * the document that was read: a hand written file does not serialize to its own bytes, so from the
 * moment it opens the two differ for house style reasons that have nothing to do with any edit.
 *
 * Either can be null on its own, because they answer different questions. Null bytes mean the file
 * no longer holds the bytes this module last saw, so there is nothing a write could be compared
 * against and `performSave` reads it as "write". A null document means the file holds a document
 * this module has never had, somebody else's copy or none at all, so `differsFromDisk` reads it as
 * "dirty". Both say the same thing: the one thing worse than an unnecessary write is a skipped
 * necessary one.
 */
let diskText: string | null = null;
let diskDoc: ProseMirrorNode | null = null;

/**
 * Whether the bytes in `diskText` are missing an edit the buffer still holds.
 *
 * `diskDoc` cannot answer this and it is not a bug in it. The tree the writer refused part of is
 * the same tree the bytes were written from, and serializing it again gives the same bytes back, so
 * the comparison below says the buffer and the file agree at the one moment the thing on screen is
 * not in the file at all. The writer says so on the way past and this is where that is kept, for
 * exactly as long as those bytes are the file's.
 */
let refusedOnDisk = false;

/** The only way any of those move, so that they cannot drift apart into two answers about the
 * same file, one of which sends a write and the other of which holds it back. The refusal defaults
 * to none, because every caller but the serializer's own is saying where the file is rather than
 * what went into it, and none of those can leave an edit behind. */
function rememberDisk(text: string | null, doc: ProseMirrorNode | null, refused = false): void {
  diskText = text;
  diskDoc = doc;
  refusedOnDisk = refused;
}

/** Markdown and plain text are two different round trips and picking the wrong one mangles a .txt. */
function bridgeFor(path: string) {
  const kind = documentKindForPath(path);
  if (kind === null) throw new Error(`${path} is not a document this editor opens`);
  return kind === "markdown"
    ? { parse: parseMarkdown, serialize: serializeMarkdown }
    : { parse: parsePlainText, serialize: serializePlainText };
}

/**
 * The attributes the serializer never reads, by the node that carries them.
 *
 * `colwidth` is the whole list, and the list was written by going through src/model/schema.ts
 * attribute by attribute against src/markdown/serialize.ts. prosemirror-tables puts a width on
 * every cell of a column when its edge is dragged and GFM has no column widths, so that drag is a
 * real change to the document and no change at all to the file.
 *
 * Three others were considered and left off. `colspan` and `rowspan` are unreadable to the
 * serializer too, but no op this editor offers can move them, and a table that carried one could
 * not be written as a table at all, so calling a change to one insignificant would be hiding the
 * one case that needs to be seen. `raw.source` is the file's own bytes and is never written to
 * after the parse. And `align` is the near miss: the serializer reads it off the table's first row
 * only, so a body cell's copy does not reach the file on its own, but that first row is the
 * delimiter row and every align op in tables.ts writes the whole column at once. An alignment
 * change is always a change to the file.
 */
const UNWRITTEN_ATTRS: Record<string, readonly string[]> = {
  tableHeader: ["colwidth"],
  tableCell: ["colwidth"],
};

/**
 * Why nothing below compares a NodeType or a MarkType, only its name.
 *
 * The two documents this comparison is given are never built on the same schema. The one the file
 * was read from comes off the bridge, which parses against src/model/schema.ts; the one the editor
 * hands back is bound to TipTap's own schema, which src/editor/extensions.ts generates from those
 * same specs and which src/editor/Editor.tsx rebinds every opened document on to before it can be
 * edited. Two `Schema` instances over one set of specs, so every type object in one is a different
 * object from its twin in the other, and `a.type !== b.type` was true of every pair this function
 * had ever been handed. Everything behind it, the colwidth exemption included, was unreachable.
 *
 * The name is also the right thing to compare rather than a way around that. src/markdown/
 * serialize.ts dispatches on `node.type.name` and `mark.type.name` and reads nothing else off a
 * type, so two nodes agreeing on their name, their attributes, their marks, their text and their
 * children are two nodes it writes the same bytes for.
 */
const sameType = (a: { name: string }, b: { name: string }): boolean => a.name === b.name;

/** Two nodes of the same type, agreeing on every attribute the serializer would go looking for. */
function sameAttrs(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
  const unwritten = UNWRITTEN_ATTRS[a.type.name];
  const names = Object.keys(a.attrs);
  // An attribute one side carries and the other does not is not provably nothing, and walking a's
  // names only ever shows one of the two directions.
  if (names.length !== Object.keys(b.attrs).length) return false;
  for (const name of names) {
    if (a.attrs[name] === b.attrs[name]) continue;
    if (unwritten !== undefined && unwritten.includes(name)) continue;
    return false;
  }
  return true;
}

/**
 * The marks on one piece of text, in order.
 *
 * This replaces `Mark.sameSet`, which compares MarkType by object and so answered "different" for
 * every span anybody had ever made bold or turned into a link. Order is compared rather than the
 * set treated as unordered because ProseMirror keeps a mark set sorted by the schema's own
 * declaration order and both schemas declare the same marks in the same order, so a mismatch is
 * either a real difference or the two schemas having drifted apart, and both are worth a write.
 */
function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const one = a[i];
    const other = b[i];
    if (one === other) continue;
    if (!sameType(one.type, other.type)) return false;
    const names = Object.keys(one.attrs);
    if (names.length !== Object.keys(other.attrs).length) return false;
    for (const name of names) if (one.attrs[name] !== other.attrs[name]) return false;
  }
  return true;
}

function sameToTheSerializer(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
  // The whole reason this is cheap enough to run on every keystroke, even against a tree many
  // transactions old. A transaction rebuilds only the spine down to what it touched, so every
  // subtree no edit since the read has visited is still the same object it was and the walk stops
  // dead at it. Only what has actually been typed into is ever compared node by node.
  //
  // It buys nothing between an open and the first save, because the tree that was read and the
  // editor's rebind of it share no object at all, so every keystroke in that window walks the
  // whole document. Measured at 0.08ms on a 57kB file of 984 nodes, against a 500ms debounce.
  // Once a save has landed, `diskDoc` is the editor's own tree and the sharing is back.
  if (a === b) return true;
  if (!sameType(a.type, b.type) || a.text !== b.text || a.childCount !== b.childCount) return false;
  if (!sameMarks(a.marks, b.marks)) return false;
  if (!sameAttrs(a, b)) return false;
  for (let i = 0; i < a.childCount; i += 1) {
    if (!sameToTheSerializer(a.child(i), b.child(i))) return false;
  }
  return true;
}

/**
 * Whether a tree differs, anywhere the file would show it, from the document on disk.
 *
 * This is what the dirty flag is, and the whole of it. Asking it of the document that was read
 * rather than of the tree a keystroke ago is what makes it a fact about the file instead of a
 * count of transactions: a paragraph typed into and then undone comes back false, because the
 * buffer is the file again, and a flag that only ever counted up would have had the whole document
 * rewritten in house style for an edit that no longer exists.
 *
 * It is deliberately lopsided: everything counts as a change to the file unless it is provably not
 * one. A change wrongly called insignificant is a keystroke that never reaches the disk, which is
 * the worst thing in this module; a change wrongly called significant costs one write that
 * `performSave` then finds nothing to do.
 *
 * The comparison is not the whole answer, because there is one difference no comparison of trees
 * can find: a refused edit is in the buffer and is not in the file, and the tree the bytes were
 * written from is the buffer, so the two agree. That is what `refusedOnDisk` is holding and it is
 * why it comes first.
 */
export function differsFromDisk(next: ProseMirrorNode): boolean {
  return refusedOnDisk || wouldWrite(next);
}

/**
 * The same question with the refusal left out: whether another write would put different bytes on
 * the disk. A refused edit is a difference the user has to keep seeing and not one a second write
 * could fix, so it makes the buffer dirty and it does not arm the debounce.
 */
function wouldWrite(next: ProseMirrorNode): boolean {
  return diskDoc === null || !sameToTheSerializer(diskDoc, next);
}

/** The same question, asked of whatever the store is holding now. */
function bufferDiffersFromDisk(): boolean {
  const now = useDocument.getState().content;
  return now !== null && differsFromDisk(now);
}

/** And the same again for the debounce, which only ever wants to know about the bytes. */
function bufferWouldWrite(): boolean {
  const now = useDocument.getState().content;
  return now !== null && wouldWrite(now);
}

function apply(read: ReadResult, document: MarkdownDocument): void {
  rememberDisk(read.text, document.doc);
  useDocument.setState({
    path: read.path,
    document,
    content: document.doc,
    modifiedMs: read.modifiedMs,
    frontmatter: document.frontmatter,
    dirty: false,
    savePhase: "idle",
    saveError: null,
    externalChange: "synced",
  });
}

function scheduleSave(): void {
  cancelPendingSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow().catch((e) => notify(`Could not save: ${String(e)}`));
  }, SAVE_DEBOUNCE_MS);
}

export function cancelPendingSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
}

/**
 * The one edit this editor knowingly does not save, said out loud.
 *
 * Once per occurrence rather than once per save. The flag stays up for as long as those bytes are
 * the file's, so five more laps of the debounce over the same unsavable block say nothing more, and
 * taking the edit back and making it again is a new occurrence and is worth saying again.
 *
 * Read before `rememberDisk`, never after: this is the only place that can tell the refusal that
 * has just happened from the one that was already standing, and the call that records the new one
 * is what wipes that difference out.
 */
function noteRefusal(refused: boolean): void {
  if (refused && !refusedOnDisk) notify(REFUSED_MESSAGE);
}

/**
 * Starts the debounce. Idempotent, and returning the teardown rather than keeping it private is
 * what lets a test run the lifecycle without leaving a timer behind for the next one.
 */
export function initDocument(): () => void {
  if (unsubscribe !== null) return unsubscribe;
  const stop = useDocument.subscribe((state, previous) => {
    if (state.content === previous.content) return;
    // Clean is not just "nothing more to schedule". The edit that armed the timer can have been
    // undone while it was still counting down, and letting it run out would put the debounce's
    // whole point, one write per burst of typing, behind a document nobody changed.
    if (state.dirty) scheduleSave();
    else cancelPendingSave();
  });
  unsubscribe = () => {
    stop();
    unsubscribe = null;
    cancelPendingSave();
  };
  return unsubscribe;
}

/**
 * Reads a file and puts it in the store. Reads only: the bridge is pure, nothing here has a path
 * to `fileWrite`, and a document that is opened and closed again leaves the file untouched.
 */
export async function loadDocument(path: string): Promise<void> {
  initDocument();
  const { parse } = bridgeFor(path);
  const read = await fileRead(path);
  apply(read, parse(read.text, read.path));
}

/** Throws the buffer away and takes what is on disk. The explicit half of a conflict. */
export async function reloadDocument(): Promise<void> {
  const path = useDocument.getState().path;
  if (path === null) return;
  cancelPendingSave();
  await loadDocument(path);
}

/** The single write for the open document that is currently on the wire, if any. */
let writeInFlight: Promise<void> | null = null;

/** Set when a save is requested while `writeInFlight` is already running. One flag, not a queue:
 * it can only ever mean "write again after this one", never "write N more times". */
let saveAgainRequested = false;

/**
 * Serializes and writes, now. Returns having done nothing when the buffer is clean, which is what
 * makes Cmd+S on an untouched document a no-op rather than a reformat.
 *
 * At most one `fileWrite` for the open document is ever in flight at a time. A call that lands
 * while one is already running does not start a second: it flags that another save is wanted and
 * folds into a single write that goes out the moment the first one lands, picking up whatever is
 * newest in the store by then. That is what keeps the backend from ever seeing two writes of the
 * same path race each other, and it is also what keeps the last thing the user typed from being
 * the one write that never happened: it is either the content already on the wire, or it is
 * exactly what the next lap serializes.
 */
export async function saveNow(): Promise<void> {
  cancelPendingSave();
  if (writeInFlight !== null) {
    saveAgainRequested = true;
    return writeInFlight;
  }
  const inFlight = runSaveLoop();
  writeInFlight = inFlight;
  try {
    await inFlight;
  } finally {
    if (writeInFlight === inFlight) writeInFlight = null;
  }
}

/**
 * Runs `performSave` once, then again for every save that arrived while it was on the wire,
 * collapsed to the single latest one. Stops the moment a lap does not end in a clean write: a
 * conflict or a no-op buffer is not something a stacked-up request should cause to be retried.
 */
async function runSaveLoop(): Promise<void> {
  for (;;) {
    saveAgainRequested = false;
    const outcome = await performSave();
    if (outcome !== "wrote" || !saveAgainRequested) return;
  }
}

async function performSave(): Promise<"wrote" | "conflict" | "skipped"> {
  const { path, document, content, dirty, modifiedMs } = useDocument.getState();
  if (path === null || document === null || content === null || !dirty) return "skipped";
  const { serialize } = bridgeFor(path);

  useDocument.setState({ savePhase: "saving", saveError: null });
  const refused: Refused = { rawBlock: false };
  let text: string;
  try {
    text = serialize(document, content, refused);
  } catch (e) {
    useDocument.setState({ savePhase: "error", saveError: String(e) });
    throw e;
  }

  // The second line, not the first. `differsFromDisk` is what keeps a buffer that is not different
  // from the file from being dirty at all, and it has to be, because this comparison only catches
  // the case where the serialized bytes already match the file: on a document the editor has
  // written before they do, and on a hand written one they differ for house style reasons that have
  // nothing to do with any edit, so this would let the write through and the whole file would be
  // reformatted for a gesture that moved a line on screen. What is left here is everything else
  // that can serialize to the bytes already on disk: two different trees that spell the same
  // markdown, and a buffer this module cannot vouch for because the file moved under it.
  if (text === diskText) {
    // Those bytes are on disk and this is a tree that produces them, which is all `diskDoc` has
    // ever claimed to be. Nothing was written, so nothing needs to be.
    //
    // This is the branch the refused edit arrives on, and it arrives on it precisely because the
    // writer put the file's own bytes back, so saying nothing here is saying nothing at all.
    noteRefusal(refused.rawBlock);
    rememberDisk(text, content, refused.rawBlock);
    useDocument.setState({
      dirty: bufferDiffersFromDisk(),
      savePhase: "idle",
      saveError: null,
    });
    return "skipped";
  }

  let result: WriteResult;
  try {
    result = await fileWrite(path, text, modifiedMs ?? undefined);
  } catch (e) {
    if (useDocument.getState().path === path) {
      useDocument.setState({ savePhase: "error", saveError: String(e) });
    }
    throw e;
  }

  // The document was switched while the write was in flight, so this result belongs to a buffer
  // nobody is looking at any more and applying it would stamp the new one's timestamp.
  if (useDocument.getState().path !== path) return "skipped";

  if (result.conflict) {
    // Not an error and not something to retry. Nothing was written, the edit is still only in the
    // buffer, and which copy wins is the user's call. What is on disk is somebody else's copy,
    // which this module has not read, so it stops claiming to know either the bytes or the
    // document: the buffer stays dirty however much of the edit the user takes back, and the
    // decision the UI is now asking for is the only thing that clears it.
    rememberDisk(null, null);
    useDocument.setState({ savePhase: "idle", externalChange: "changed-on-disk" });
    return "conflict";
  }

  noteRefusal(refused.rawBlock);
  rememberDisk(text, content, refused.rawBlock);
  const unwritten = bufferWouldWrite();
  useDocument.setState({
    modifiedMs: result.modifiedMs,
    dirty: bufferDiffersFromDisk(),
    savePhase: "idle",
    saveError: null,
    externalChange: "synced",
  });
  // Typed into, or undone, while that write was on the wire. An undo is the case that needs this:
  // it went past the subscription at a moment when the buffer and the file did agree, so nothing
  // armed the debounce for it, and this write is what has just made it a difference again. A
  // refusal is not one of these. Those bytes are already everything the file can hold, so the
  // buffer stays dirty and the debounce stays down, which is the difference between the two
  // questions asked above: the flag is about what the user can see, the timer is about the bytes.
  if (unwritten) scheduleSave();
  else cancelPendingSave();
  return "wrote";
}

/**
 * Gets an unsaved edit onto disk before something else happens to the document: switching away,
 * closing it, quitting. Swallows its own error into a toast, because the caller is on its way
 * somewhere else and failing that journey over a failed save helps nobody.
 */
export function flushPendingSave(): Promise<void> {
  if (!useDocument.getState().dirty) {
    cancelPendingSave();
    return Promise.resolve();
  }
  return saveNow().catch((e) => notify(`Could not save: ${String(e)}`));
}

/**
 * Resolves a conflict the other way from `reloadDocument`: the buffer wins and the copy on disk is
 * the one that goes.
 *
 * Dropping `modifiedMs` is what makes the next write land. The backend refuses a write whose
 * expected timestamp has moved on, which is the whole conflict mechanism, and there is no way to
 * say "yes, I know" other than to stop claiming to know what was there. The write itself is the
 * ordinary debounced one, so nothing is put on disk here either.
 */
export function keepBuffer(): void {
  if (useDocument.getState().path === null) return;
  // What is on disk is whatever the other writer put there, which this module has not read, so the
  // last bytes it saw are no longer the file's and neither is the document they came from. Saying
  // so is what stops `performSave` from deciding this write is unnecessary and leaving the other
  // copy in place, which is the opposite of what the user just asked for, and it is what keeps the
  // buffer dirty through an undo taken while the banner is up.
  rememberDisk(null, null);
  // Dirty even if nothing has been typed: the file moved or went, so the buffer and the disk
  // disagree, and that is the only thing the flag has ever meant.
  useDocument.setState({ modifiedMs: null, externalChange: "synced", dirty: true });
  scheduleSave();
}

/**
 * Lets go of the open document without writing it, for when the file it came from has just gone.
 * `close` on its own flushes, which for a document that was this second sent to the Trash would
 * put the file straight back.
 */
export function abandonDocument(): void {
  cancelPendingSave();
  useDocument.setState({ dirty: false });
  useDocument.getState().close();
}

/**
 * This app has just renamed or moved the open document's own file, and its buffer holds an edit
 * nothing else has.
 *
 * The buffer follows the file instead of being thrown away and read back from it, because that
 * edit is the only copy of itself and a reopen is a read. Nothing else here moves. The bytes and
 * the document this module last saw are still the ones the file held when it was moved, the
 * timestamp is still that file's, and whatever armed the debounce is still armed. So the save that
 * follows goes to the new path carrying the old file's timestamp: it lands when nothing touched
 * the file on the way, and it comes back a conflict when the link rewrite did, which is a question
 * put to the user rather than either copy being lost.
 *
 * What this replaces is worse than it sounds. Left pointed at the path the file has just moved off,
 * that same save writes a path that no longer exists, and `write_document` falls through its
 * timestamp check when the file it is checking has gone, because a document deleted under the user
 * has to have somewhere to land. So the file came back at the old path, and the user was left with
 * two copies of one document and a sidebar showing both.
 */
export function documentMovedTo(path: string): void {
  if (useDocument.getState().path === null) return;
  // The history entry goes with it. Where the user is standing in the back and forward list is the
  // document they are looking at, and this app is the thing that made the old spelling of it dead.
  useDocument.setState((s) => ({
    path,
    history: s.history.map((entry, at) => (at === s.historyIndex ? path : entry)),
  }));
}

/**
 * Something outside the app touched the open document. Clean buffers take the new bytes silently,
 * dirty ones are left exactly as they are and the UI is told there is a choice to make.
 */
export async function documentChangedOnDisk(path: string): Promise<void> {
  if (useDocument.getState().path !== path) return;

  let read: ReadResult;
  try {
    read = await fileRead(path);
  } catch {
    // Deleted, renamed out from under us, or unreadable. The buffer is now the only copy there is,
    // so it stays put. The bytes go, because there are none left to hold a write back, and the
    // document stays, because it is still the last one this module knew the file to hold and it is
    // what keeps a buffer nobody has typed into from turning dirty and putting the file back.
    // Resurrecting a file the user deleted is `keepBuffer`, and it is the user's word, not a
    // side effect of clicking into the editor afterwards. The refusal is carried over for the same
    // reason the document is: a save that left an edit behind still left it behind, and forgetting
    // that here would let the next keystroke work the buffer out as clean over bytes that never
    // held it.
    rememberDisk(null, diskDoc, refusedOnDisk);
    useDocument.setState({ externalChange: "changed-on-disk" });
    return;
  }

  const state = useDocument.getState();
  if (state.path !== path) return;
  if (read.modifiedMs === state.modifiedMs) return;
  if (read.text === diskText) {
    useDocument.setState({ modifiedMs: read.modifiedMs });
    return;
  }
  if (state.dirty) {
    // The buffer stays, but these are the file's bytes now and this module has just read them, so
    // it says so rather than going on remembering the ones the other writer replaced. It does not
    // parse them: the document on disk is somebody else's and no tree here is it, so the honest
    // answer to "is the buffer different from the file" is that we do not know, which is the answer
    // that keeps this dirty until the user picks a side.
    rememberDisk(read.text, null);
    useDocument.setState({ externalChange: "changed-on-disk" });
    return;
  }

  const { parse } = bridgeFor(path);
  apply(read, parse(read.text, read.path));
}

/**
 * What one pass of the link rewrite did to the open document.
 *
 * `held` is not a failure and not a no-op. It is this module saying the file was not the sweep's to
 * write at that moment, which the caller has to report rather than count as a file with nothing in
 * it to change.
 */
export type OpenRewrite =
  | { kind: "held" }
  | { kind: "unchanged" }
  | { kind: "rewritten" }
  | { kind: "failed"; reason: string };

/**
 * The open document's own file, rewritten by src/linkRewrite.ts after a move made the links in it
 * wrong, without going through the serializer and without going around the single writer above.
 *
 * `rewrite` is handed the bytes this module last saw and returns the bytes to put back, or null
 * when there was nothing in them to change. It is pure and it is synchronous, and that is the whole
 * design rather than a convenience. Every question about the buffer, the answer, and the write go
 * out in one run of the event loop, so there is no window between reading `dirty` and writing for a
 * keystroke to arrive in. A callback that could await would put the window straight back.
 *
 * The buffer takes the rewrite before the bytes leave rather than after they land. A keystroke
 * arriving while the write is on the wire then lands on top of the new links, and the save it arms
 * writes the user's own edit over a file that already agrees with what they are looking at. Doing
 * it the other way round is what put a conflict banner in front of somebody for a change this app
 * made itself: the write went out carrying the timestamp the buffer had from before they typed, and
 * the file they were looking at came back looking like somebody else's copy.
 *
 * It costs nothing that the success path was not already paying, because that path swaps the
 * editor's tree either way.
 */
export async function rewriteOpenDocument(
  path: string,
  rewrite: (text: string) => string | null,
): Promise<OpenRewrite> {
  const state = useDocument.getState();
  // A buffer with an edit in it is the only copy of that edit, and a write already on the wire owns
  // the file until it lands. Neither is this function's to write over.
  if (state.path !== path || state.document === null || state.dirty) return { kind: "held" };
  if (writeInFlight !== null || diskText === null || state.modifiedMs === null) {
    return { kind: "held" };
  }

  const was = { document: state.document, text: diskText, modifiedMs: state.modifiedMs };
  let prepared: { text: string; document: MarkdownDocument };
  try {
    const next = rewrite(was.text);
    if (next === null) return { kind: "unchanged" };
    prepared = { text: next, document: bridgeFor(path).parse(next, path) };
  } catch (e) {
    return { kind: "failed", reason: String(e) };
  }
  const { text, document } = prepared;

  apply({ path, text, modifiedMs: was.modifiedMs }, document);

  const run = async (): Promise<OpenRewrite> => {
    let result: WriteResult;
    try {
      result = await fileWrite(path, text, was.modifiedMs);
    } catch (e) {
      revert(path, was);
      return { kind: "failed", reason: String(e) };
    }
    // Switched away from while the write was in flight. The bytes did land, so this is not a
    // failure, and the buffer it would have been reconciled against is not on screen any more.
    if (useDocument.getState().path !== path) return { kind: "rewritten" };
    if (result.conflict) {
      revert(path, was);
      return { kind: "failed", reason: "it changed on disk part way through" };
    }
    useDocument.setState({ modifiedMs: result.modifiedMs });
    // Typed into while that write was on the wire, on top of the new links. The same belt and
    // braces `performSave` ends with, since an undo can pass the subscription while it is clean.
    if (useDocument.getState().dirty) scheduleSave();
    return { kind: "rewritten" };
  };

  const inFlight = run();
  writeInFlight = inFlight.then(() => undefined);
  const held = writeInFlight;
  try {
    return await inFlight;
  } finally {
    if (writeInFlight === held) writeInFlight = null;
  }
}

/**
 * Puts the buffer back to the document the file still holds, for a rewrite that was installed and
 * then did not land.
 *
 * The same object goes back into the store rather than a fresh parse of the same bytes, which is
 * what lets src/editor/Editor.tsx see the document it already had instead of a different file: it
 * stashes the caret by path on the way past and puts it back, so the user is left where they were
 * typing rather than at the top of a document that flickered.
 */
function revert(
  path: string,
  was: { document: MarkdownDocument; text: string; modifiedMs: number },
): void {
  const now = useDocument.getState();
  if (now.path !== path) return;
  if (now.dirty) {
    // Typed into while the write was on the wire, so the buffer holds an edit on top of the new
    // links and nothing here gets to throw it away. What is on disk is somebody else's copy this
    // module has not read, which is exactly what `performSave` says in the same situation. No
    // refusal is carried over: a null document already makes every question about the buffer come
    // back dirty, which is the whole of what the flag was holding up.
    rememberDisk(null, null);
    useDocument.setState({ externalChange: "changed-on-disk" });
    return;
  }
  // Whatever the watcher found while the write was out lives through this. `apply` says "synced"
  // because every other caller of it has just read the file, and this one has not: it is putting
  // back the document the file had before, which is the claim this module was already making when
  // the rewrite started, and it is not an answer to a change somebody else made in the meantime.
  const flagged = now.externalChange;
  apply({ path, text: was.text, modifiedMs: was.modifiedMs }, was.document);
  if (flagged !== "synced") useDocument.setState({ externalChange: flagged });
}
