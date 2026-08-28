// Whether a command may touch the document where the caret is. One rule, in one file, because
// every command that edits has to ask it and the answer is the same for all of them.
//
// There are two halves and they answer two different questions. The first half is about a NODE:
// can this thing go here. `fits` answers for a single position and is the rule itself, `placeable`
// asks it for a whole selection, which is the question a command actually has, and `place` is
// `placeable` and the insert together, so a command that goes through it cannot be written without
// the guard because there is no insert in it to forget to guard.
//
// The second half is about a COMMAND: may this edit happen here at all. That question had no
// answer here for two milestones and every bug in the file's history came out of the gap. A block
// conversion asks `setNode` whether the new type fits and never asks whether the old block was the
// user's own bytes, so the Heading tool reformatted a raw block into escaped markdown. A paste
// asks nothing at all unless it is carrying an image, so a plain Cmd+V split a table, a fence and
// a raw block open. `change`, `markable` and `breakable` are that missing half, and they are
// written the same way: the guard and the edit in one call, so the guard is not a line somebody
// adds afterwards.
//
// The three rules the second half enforces, every one of them somebody's file rather than a
// tidiness preference:
//
//   A raw block is refused every structural edit. Its bytes are the file's own and conventions.md
//   makes that an absolute guarantee, so a conversion, a wrap or a paste of blocks that would
//   reformat or split one does not happen. Typing in it is still an ordinary edit: the block is
//   shown as an editable field and the text content is what wins once the user has touched it.
//
//   An edit may not take away a wrapper whose edges the user cannot see. A callout carries its
//   kind and a toggle carries its summary as attributes, so lifting a paragraph out of one deletes
//   text that was never selected and never on screen as content. Rather than predict which command
//   will lift, `change` builds the transaction, looks at what it did and throws it away if a
//   wrapper went missing, which holds however TipTap chooses to implement the command next.
//
//   And nothing is left on screen that the file cannot write down. That one is the serializer's
//   answer rather than the schema's, and there are two constructs it is asked about. A line break,
//   which a table cell and a heading below the two underlined levels both swallow on the way to
//   disk, and which the two underlined levels swallow their own marker over when it is the last
//   thing in the heading. And a blank line, which every block here can hold except the one whose
//   bytes have nothing around them: a blank line is what ends an html block, so one inside a raw
//   block is the next open of the file finding pieces of prose where the preserved construct was.
//
// src/editor/fits.test.ts enumerates every entry point the running editor has, not just the
// inserts, and fails when one is added without an answer recorded for each hostile context. The
// enumeration is the point: this project has now shipped a shared guard wired into some of its
// callers and not others three times, and each time the callers that were missed were the ones
// nobody had thought to list.

import { CommandManager } from "@tiptap/core";
import type { ChainedCommands, Editor } from "@tiptap/core";
import type { MarkType, Node as ProseMirrorNode, NodeType, ResolvedPos, Slice } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

/**
 * The block that is the file's own bytes, named here because the whole of the second half turns on
 * it. src/model/schema.ts is frozen, so this string is a contract and not a guess.
 */
const RAW = "raw";

/**
 * The wrappers that carry text the user cannot select.
 *
 * A callout's kind is the `[!NOTE]` line and a toggle's summary is its title: both are on screen,
 * neither is content, and an edit that lifts a block out of one takes them with it without the
 * selection ever having covered them.
 */
const OPAQUE = ["callout", "toggle"] as const;

/** A line with nothing but spaces on it, which is what ends an html block in markdown. */
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * The rectangle of whole cells a drag across a table makes, named once so that the four questions
 * below and src/editor/blocks/tables.ts ask it in the same words.
 *
 * It is a selection of containers rather than of text, and that is what makes it dangerous: an
 * insert over one does not replace what is selected, it replaces the content of every cell in the
 * rectangle, so six cells of somebody's table become five empty ones and whatever arrived.
 */
export function overCells(state: EditorState): boolean {
  return state.selection instanceof CellSelection;
}

/**
 * True when a block of this type can go at this position without something being torn open to make
 * room for it.
 *
 * A table cell holds inline content and nothing else, and it is isolating. Asked to insert a block
 * there anyway, ProseMirror does the only thing left and splits the table in two around it, which
 * leaves a row with no cells behind and a table the serializer cannot write: on the next save that
 * empty table goes out as three blank lines and the round trip stops being stable. The raw block is
 * isolating for the same reason and a better one, since its whole job is handing back bytes nobody
 * has touched.
 *
 * A code block is not isolating and would take the insert: it would be cut in half and the new
 * block put between the pieces. That is somebody's code rewritten by a button that promised to add
 * something else, so a fence is a no as well.
 *
 * All of these are places a block cannot go, and the honest answer where a block cannot go is that
 * the button does nothing.
 */
export function fits($pos: ResolvedPos, type: NodeType): boolean {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth);
    const index = $pos.index(depth);
    if (node.canReplaceWith(index, index, type)) return true;
    if (node.type.spec.isolating || node.type.spec.code) return false;
  }
  return false;
}

/**
 * The same question asked of a whole selection, which is the one a command has.
 *
 * Both ends, because a selection can start somewhere a block fits and end somewhere it does not,
 * and an insert takes out everything between them.
 *
 * A cell selection is refused outright, whatever the type. It is the rectangle of whole cells a
 * drag across a table makes, and inserting over it does not put a block anywhere: it replaces the
 * content of every cell in the rectangle, so six cells of somebody's text become one node and five
 * empty cells. An inline formula passes `fits` in a cell perfectly happily, which is correct for a
 * caret and catastrophic for a drag, and that gap is how the same insert lost six cells of real
 * text in an editor whose block inserts were already guarded.
 */
export function placeable(state: EditorState, type: NodeType): boolean {
  if (overCells(state)) return false;
  return state.selection.ranges.every((range) => fits(range.$from, type) && fits(range.$to, type));
}

/**
 * The guard and the insert in one call: refuses where the node cannot go, and otherwise runs the
 * caller's own chain. True when the document actually changed.
 *
 * The chain is the caller's because the five inserts do five different things with it, from a rule
 * that is one node to a table that has to put the caret in its first cell afterwards. What they
 * share is this: focus first, ask before touching anything, and answer for what happened to the
 * document rather than for what the chain returned. A chain answers for `focus` as well, and focus
 * reports false in any editor that has no view, so a chain's own answer is false in every headless
 * test and in the app's first insert after a click on the toolbar.
 */
export function place(
  editor: Editor,
  type: NodeType,
  insert: (chain: ChainedCommands) => void,
): boolean {
  if (!placeable(editor.state, type)) return false;
  const before = editor.state.doc;
  const chain = editor.chain().focus();
  insert(chain);
  chain.run();
  return editor.state.doc !== before;
}

/**
 * What a structural edit does to the blocks it runs over, which is what decides where it may run.
 *
 * "convert" changes what a block IS and leaves it where it is: a heading becomes a paragraph, a
 * paragraph becomes a fence. Nothing it does is supposed to move a block out of what holds it, so
 * a wrapper going missing is that command failing rather than that command working.
 *
 * "wrap" puts blocks inside a wrapper. It changes nesting on purpose, but only its own: a list
 * button makes a list and a quote button makes a quote, and neither of them was pressed to take a
 * callout or a toggle away. A selection dragged from inside a toggle down into the paragraph under
 * it and then given to the Bulleted list button used to lift both out and delete the toggle, and
 * the title in its summary went with it: text on screen, never selected, gone from the file.
 *
 * "unwrap" is the one that may, and it is the button for that wrapper: the Toggle button pressed
 * inside a toggle removes it, the Callout menu's own entry turns a callout back into a quote, and
 * the summary or the label going with it is the edit the user asked for and can undo. Three values
 * and no more, because a vocabulary a caller can pick a fourth entry from is a vocabulary that
 * ends up meaning nothing.
 */
export type Change = "convert" | "wrap" | "unwrap";

/** Whether this position is inside the one block whose bytes are the file's own. */
function inRaw($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === RAW) return true;
  }
  return false;
}

/** Whether the selection is inside, or reaches across, a raw block. */
function touchesRaw(state: EditorState): boolean {
  return state.selection.ranges.some(({ $from, $to }) => {
    if (inRaw($from) || inRaw($to)) return true;
    let found = false;
    state.doc.nodesBetween($from.pos, $to.pos, (node) => {
      if (node.type.name === RAW) found = true;
      return !found;
    });
    return found;
  });
}

function countOf(doc: ProseMirrorNode, name: string): number {
  let total = 0;
  doc.descendants((node) => {
    if (node.type.name === name) total += 1;
  });
  return total;
}

/**
 * Whether a structural edit may run over this selection at all.
 *
 * A raw block is the file's own bytes and refuses all of them: converted, its source comes back as
 * escaped markdown, and wrapped, it comes back prefixed. Both are the exact thing conventions.md
 * says never happens.
 *
 * A cell selection is refused for the reason `placeable` gives, and for one more: a cell holds
 * inline content, so there is no block in a rectangle of them for a conversion to act on, and what
 * a conversion does when it cannot act is fall back to lifting, which takes the table apart.
 */
export function changeable(state: EditorState): boolean {
  if (overCells(state)) return false;
  return !touchesRaw(state);
}

/**
 * Whether the file can hold a line break inside this block.
 *
 * The only question in the file that the schema cannot answer, so it is the only one written
 * against the serializer instead. A hard break is inline content and both of the blocks below hold
 * inline content, so the schema is perfectly happy; markdown is not.
 *
 * A GFM cell is one line, and src/markdown/serialize.ts flattens a break inside one into the space
 * a cell can hold. A heading is one line too, except at the two levels that have a setext
 * spelling: `#### a` has nowhere to put the second line, so mdast writes the break out as a space,
 * while an underlined heading keeps it.
 *
 * Either way nothing is lost that the user typed, and either way the editor is drawing a line the
 * next open of the file will not have. An editor showing a construct the file silently swallows is
 * an editor lying about what was saved.
 */
function holdsBreak(parent: ProseMirrorNode): boolean {
  const role = parent.type.spec.tableRole;
  if (role === "cell" || role === "header_cell") return false;
  if (parent.type.name === "heading") return parent.attrs.level <= 2;
  return true;
}

/**
 * And whether the file can hold one with nothing after it, which is a different question and the
 * one that cost a heading.
 *
 * A break is written as a backslash and a line ending, so a block that ends with one ends with a
 * backslash on a line of its own. In prose that is a stray character the next thing the user types
 * takes back, which is why it is not counted below. In a heading it is not: the two levels that
 * can hold a break at all hold it because they have an underlined spelling, and the underline goes
 * under the LAST line of the heading. There is no last line after a trailing break, so mdast writes
 * no underline, and `# Title` with Shift+Enter pressed at the end of it goes to disk as `Title\`
 * with the marker gone and the backslash left in the user's words. Reopened, it is a paragraph.
 *
 * Confirmed by running it, at both levels and through the real serializer, rather than reasoned
 * about: "# Title\n\nprose\n" came back as "Title\\\n\n\n\nprose\n".
 */
function holdsTrailingBreak(parent: ProseMirrorNode): boolean {
  return parent.type.name !== "heading";
}

/**
 * The breaks in this document that the next save will swallow or spell wrong.
 *
 * A break with nothing after it in its block is usually not one of them: that is the half typed
 * line somebody is in the middle of, it has no spelling either, and the next character they type
 * makes it a real break. The exception is the heading above, where a trailing break does not wait
 * to be finished: it takes the heading's own marker with it on the very next save.
 */
function strandedBreaks(doc: ProseMirrorNode): number {
  let total = 0;
  doc.descendants((parent) => {
    const held = holdsBreak(parent);
    const trailing = holdsTrailingBreak(parent);
    if (held && trailing) return;
    parent.forEach((child, _offset, index) => {
      if (child.type.name !== "hardBreak") return;
      const last = index === parent.childCount - 1;
      if (last ? !trailing : !held) total += 1;
    });
  });
  return total;
}

/**
 * Builds what the caller's commands would do, without any of it reaching the document.
 *
 * The chain is given its own transaction, and a chain built that way is TipTap's own way of not
 * dispatching: the commands run, the steps land on the transaction, and nothing is handed to the
 * view. So the result can be looked at before it is a document rather than after, which is what
 * lets `change` answer for what a command did instead of predicting what it will do.
 */
function trial(editor: Editor, run: (chain: ChainedCommands) => void): Transaction {
  const manager = new CommandManager({ editor, state: editor.state });
  const tr = editor.state.tr;
  const chain = manager.createChain(tr);
  // Focus is in here rather than around it because it belongs to the same undo step as the edit,
  // and because a toolbar click has taken focus out of the document by the time this runs.
  chain.focus();
  run(chain);
  chain.run();
  return tr;
}

/**
 * The guard, the edit and the check afterwards in one call. True when the document changed.
 *
 * Refuses outright where `changeable` says no. Otherwise it builds the edit, and for everything
 * but the button that names the wrapper it also refuses the finished transaction when a callout or
 * a toggle came out of it that was there before. Two commands got there: the Heading menu's
 * Paragraph item, which TipTap answers by lifting the block out of everything holding it once the
 * block is already a paragraph, and the list buttons over a selection that starts inside a toggle
 * and ends outside it, which lift the same way. Both deleted a toggle and the words in its summary.
 *
 * Answering on the transaction rather than on the command is the point. There is no list here of
 * which commands lift and which do not, so a command that starts lifting in some later version of
 * TipTap is refused by this on the day it does, rather than on the day somebody notices a file has
 * lost a paragraph.
 */
export function change(
  editor: Editor,
  kind: Change,
  run: (chain: ChainedCommands) => void,
): boolean {
  if (!changeable(editor.state)) return false;

  const before = editor.state.doc;
  const tr = trial(editor, run);
  if (!tr.docChanged) return false;
  if (kind !== "unwrap" && OPAQUE.some((name) => countOf(tr.doc, name) < countOf(before, name))) {
    return false;
  }
  // And the block the content lands in has to be able to write down what is in it. A fence of two
  // lines turned into a heading is two lines in a heading, which only the two levels with an
  // underlined spelling can hold: the deeper four write the break out as a space, so the second
  // line would be on screen and gone from the file, which is `breakable` refusing Shift+Enter in
  // the same block, arrived at from the other direction.
  if (strandedBreaks(tr.doc) > strandedBreaks(before)) return false;

  editor.view.dispatch(tr);
  return true;
}

/**
 * Whether this mark can exist over the selection.
 *
 * A fence and a raw block both declare `marks: ""`, so a link in one is not a link the schema can
 * hold. ProseMirror already knows that and quietly drops the mark, which is the right answer for a
 * command that only adds a mark; it is the wrong answer for the Link tool with a collapsed caret,
 * because that one inserts the url as TEXT and then marks it, and the text lands whether the mark
 * does or not. That is how a fence gained the characters "https://x.test" on the end of somebody's
 * line of code.
 */
export function markable(state: EditorState, type: MarkType): boolean {
  return state.selection.ranges.every(
    ({ $from, $to }) => $from.parent.type.allowsMarkType(type) && $to.parent.type.allowsMarkType(type),
  );
}

/**
 * Whether the blocks the selection touches can hold this text.
 *
 * The second question here that the schema is perfectly happy about and the file is not. A raw
 * block is written out as its own bytes with nothing around them: no fence, no marker, nothing
 * that says where it ends. A blank line is what ends an html block in markdown, so a raw block
 * with one in it is not a raw block the next time the file is opened, it is however many pieces
 * the blank lines cut it into, and the construct it was preserving is gone with it.
 *
 * Measured rather than reasoned about: a Cmd+V of "# Pasted\n\n- one\n- two\n" with the caret in
 * `<Chart data={points} title="Sales" />` put those bytes through the middle of the tag, and the
 * file reopened as a heading, two paragraphs and a list with no raw block anywhere in it.
 *
 * Text with no blank line in it is fine everywhere, which is what the first line says: a fence and
 * a raw block are `whitespace: "pre"` so an ordinary newline stays a newline, and the serializer
 * writes a newline inside a table cell as the space a GFM cell can hold.
 */
export function holdsText(state: EditorState, text: string): boolean {
  if (!BLANK_LINE.test(text.replace(/\r\n?/g, "\n"))) return true;
  return state.selection.ranges.every(
    ({ $from, $to }) => $from.parent.type.name !== RAW && $to.parent.type.name !== RAW,
  );
}

/**
 * Whether the file can hold a line break where the selection is.
 *
 * Two questions rather than one, and the second is about the position and not the block. The break
 * lands where the selection starts and takes everything up to where it ends with it, so what
 * follows the break afterwards is whatever followed the selection's far end: nothing, when that end
 * is already at the end of its block. A break with nothing after it is the one `holdsTrailingBreak`
 * refuses, and refusing it is the whole of Shift+Enter at the end of a level 1 or 2 heading.
 */
export function breakable(state: EditorState): boolean {
  if (!placeable(state, state.schema.nodes.hardBreak)) return false;
  return state.selection.ranges.every(
    ({ $from, $to }) =>
      holdsBreak($from.parent) &&
      holdsBreak($to.parent) &&
      (holdsTrailingBreak($from.parent) || $to.parentOffset < $to.parent.content.size),
  );
}

/**
 * Whether putting this slice in the document would put a block boundary in with it.
 *
 * The question a paste and a drop have, and the one neither of them was asking. A slice of whole
 * blocks dropped where blocks do not fit is not refused by ProseMirror: it splits whatever it
 * landed in and puts the pieces either side, so a table becomes two tables around a stray
 * paragraph, a fence becomes two fences, and a raw block becomes two halves of somebody's html
 * with prose in the middle. All three were reachable with an ordinary Cmd+V.
 *
 * A slice open at both ends with one child in it is the shape the clipboard produces for a
 * fragment of a line, and it carries no boundary: it merges into the block it lands in, which is
 * what a paste of a few words into a cell should do. Anything else, a second block or an end that
 * is closed, is a boundary and belongs to the caller's guard.
 */
export function carriesBlocks(slice: Slice): boolean {
  const first = slice.content.firstChild;
  if (!first) return false;
  if (first.isInline) return false;
  return !(slice.content.childCount === 1 && slice.openStart > 0 && slice.openEnd > 0);
}
