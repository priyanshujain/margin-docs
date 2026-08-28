// What arrives from the clipboard.
//
// Two paths. Text pasted with Cmd+Shift+V comes in as plain text, one paragraph per blank line and
// a hard break for every single newline, which is the path margin's editor already had.
//
// An image is the path that had to change. Margin reads the file into a base64 data URL and puts
// that in the document, which is fine when the document is a row in a database. Here the document
// is a markdown file somebody else will open in another editor, and a few hundred kilobytes of
// base64 wedged into a line of it is not markdown anybody wants to receive. The bytes go to Rust,
// which writes them into an assets/ folder beside the document, and what lands in the file is an
// ordinary relative image link. Base64 never reaches a .md file.
//
// Both paths put nodes into the document, so both ask the same guard every other insert in the
// editor asks. A paste is the one insert the user does not aim: the caret is wherever it was left,
// and it is left inside a fence or a raw block often enough that an unguarded paste is how somebody
// discovers their shell script has stopped being code.
//
// The third path is every other paste, and it is the one that was missed twice. Cmd+Shift+V asked
// the guard and the image paste asked the guard, and an ordinary Cmd+V went to ProseMirror's own
// handler with nothing asked at all, because this file claimed image clipboards and returned false
// for the rest. ProseMirror does not refuse a paste that does not fit: it splits whatever the caret
// was in and puts the pieces either side of it, so two pasted paragraphs turned one table into two
// tables with a row destroyed between them, one fence into two fences, and a raw block into two
// halves of somebody's html. A drop is the same insert arriving by a different route and had no
// handler at all.
//
// And the fourth thing that was missed is not a path at all, it is a position in a list. A guard
// written, documented and tested here still never ran, because a paste is offered to the plugins in
// order and the first one to answer wins: prosemirror-tables came ninth and this came fifteenth, so
// a Cmd+V over a rectangle of dragged cells was answered by the library, which replaced the content
// of every cell in the rectangle with whatever was on the clipboard. Four cells of somebody's table
// for one paste of one word. `priority` below is what puts this in front of it, and
// src/editor/fits.test.ts asserts the resulting order rather than trusting the number.
//
// And the fifth is the one this file was sure it had already answered. Text was treated as the
// spelling that fits anywhere, because a fence, a raw block and a cell all hold text and all hold
// newlines. A raw block does not hold a BLANK line: nothing marks where its bytes end, and a blank
// line is what ends an html block, so a paste of two paragraphs into one wrote them through the
// middle of a preserved `<Chart ... />` and the file came back as a heading, two paragraphs and a
// list with no raw block in it. `holdsText` in src/editor/fits.ts is that question.
//
// And the sixth is that question asked of the wrong string. It read the clipboard and not the block
// the clipboard was going into, so a paste of whole lines, which carries the line ending they were
// copied with, put its newline against the newline already at the end of the line it landed on: no
// blank line in the payload, a blank line in the raw block, nothing refused and no toast. A drop
// was worse and asked nothing at all, and it is the one route that cannot be talked round, since a
// drop is the dragged content itself rather than something reparsed against where it lands.

import { Extension } from "@tiptap/core";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { __pastedCells as pastedCells, isInTable } from "@tiptap/pm/tables";
import { assetWrite } from "../api/files";
import { carriesBlocks, fits, holdsText, inRaw, place, placeable, touchesRaw } from "./fits";

/**
 * This app's own paste handler, named so that a test can find it in the plugin list and say where
 * in that list it is.
 *
 * Worth naming because it is not the only one: prosemirror-tables installs a paste handler of its
 * own, so which plugin answers a given paste is a real question and not an implementation detail.
 * It is the question that cost four cells of a table, and the answer has to be this one.
 */
export const pasteKey = new PluginKey("clipboard");

/**
 * High enough to be asked first, and asserted rather than believed.
 *
 * TipTap collects plugins by reversing the extension array and then sorting it by priority, so a
 * number above every other extension's puts this file's handlers at the head of the list whatever
 * order src/editor/extensions.ts lists them in. 101 is the highest any extension in the tree
 * currently asks for, which is exactly the kind of fact that stops being true without anybody
 * noticing: src/editor/fits.test.ts reads the built plugin list and fails if anything with a
 * handlePaste or a handleDrop of its own ends up in front of this.
 */
const FIRST = 1000;

export interface PasteContext {
  /** The open document, which is what a pasted image is written beside. */
  documentPath: () => string | null;
  onError: (message: string) => void;
}

function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files).filter((f) => f.type.startsWith("image/"));
  if (files.length) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
}

function plainContent(text: string): JSONContent[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => {
      const content: JSONContent[] = [];
      block.split("\n").forEach((line, i) => {
        if (i > 0) content.push({ type: "hardBreak" });
        if (line) content.push({ type: "text", text: line });
      });
      return content.length ? { type: "paragraph", content } : { type: "paragraph" };
    });
}

/**
 * What the user is told when a paste is refused, said once because two routes refuse it: the one
 * where this file inserts the clipboard's own text, and the one where it stands aside and lets
 * ProseMirror insert the slice.
 */
const BLANK_LINE = "A blank line cannot go inside a raw block, so nothing was pasted.";

/** The words a slice would put in the document: a blank line per block, a newline per break. */
function sliceText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, "\n\n", "\n");
}

/**
 * The same paste, spelled the way a fence, a raw block or a table cell can hold it.
 *
 * Those three take text and not paragraphs, so a paragraph pasted into a fence splits it and leaves
 * the user with two fences and their lines sitting as prose between them, and one pasted into a
 * cell splits the table exactly the way an unguarded block insert does. Text is what all three do
 * take, and a paste of text into them is neither a refusal nor a rewrite: a fence and a raw block
 * are whitespace: pre so the newlines stay newlines, and the serializer already writes a newline
 * inside a cell as the space a GFM cell can hold.
 *
 * All of which is true of a newline and none of which is true of a BLANK line, which is what the
 * guard is for. A fence has ``` at each end and a cell has its pipes, so both of them can hold an
 * empty line and still be one block on the next open of the file. A raw block has nothing at
 * either end but its own bytes, and a blank line is exactly what ends an html block, so a paste
 * carrying one turns the preserved construct into however many pieces of prose it was cut into.
 * The paste is refused rather than reflowed: taking the blank lines out would be this handler
 * quietly rewriting what the user copied in order to make it fit.
 */
function pasteAsText(editor: Editor, text: string, onError: (message: string) => void): boolean {
  const value = text.replace(/\r\n?/g, "\n");
  if (!holdsText(editor.state, value)) {
    onError(BLANK_LINE);
    return false;
  }
  editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (dispatch) dispatch(tr.insertText(value).scrollIntoView());
      return true;
    })
    .run();
  return true;
}

/** Where the caret is, are paragraphs something the document can take there. */
function takesBlocks(state: EditorState): boolean {
  return placeable(state, state.schema.nodes.paragraph);
}

/**
 * And if not, is text. False over a rectangle of table cells, which is the one selection where
 * inserting anything at all empties every cell in it rather than replacing what is selected.
 */
function takesText(state: EditorState): boolean {
  return placeable(state, state.schema.nodes.text);
}

/**
 * The same paste as one string, for the places that take text and not blocks.
 *
 * The clipboard's own text/plain is what the user copied and is preferred where there is one. A
 * drop has no text/plain of its own when it is content dragged from inside the document, so the
 * slice is read instead: a blank line between blocks and a newline for a break, which is the
 * spelling plainContent above reads back.
 */
function textOf(slice: Slice, data: DataTransfer | null): string {
  const plain = data?.getData("text/plain") ?? "";
  if (plain) return plain.replace(/\r\n?/g, "\n");
  return sliceText(slice);
}

async function insertImages(
  editor: Editor,
  files: File[],
  docPath: string,
  onError: (message: string) => void,
): Promise<void> {
  for (const file of files) {
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const asset = await assetWrite(docPath, bytes, file.name || "image.png");
      const placed = place(editor, editor.schema.nodes.image, (chain) =>
        chain.insertContent({ type: "image", attrs: { src: asset.relPath, alt: null, title: null } }),
      );
      // Asked a second time because the write is a round trip to disk and the caret is the user's
      // in the meantime: it can have moved into a fence between the paste and the bytes landing.
      // The file is already written and stays written, which is the harmless half of the two.
      if (!placed) {
        onError(`${asset.relPath} was saved, but an image cannot go where the cursor is.`);
        return;
      }
    } catch (e) {
      onError(`Could not save the pasted image: ${String(e)}`);
      return;
    }
  }
}

export function createPaste(context: PasteContext): Extension {
  return Extension.create({
    name: "clipboard",
    priority: FIRST,

    addKeyboardShortcuts() {
      const editor = this.editor;
      return {
        "Mod-Shift-v": () => {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (!text) return;
              if (takesBlocks(editor.state)) {
                editor.chain().focus().insertContent(plainContent(text)).run();
                return;
              }
              if (takesText(editor.state)) pasteAsText(editor, text, context.onError);
            })
            .catch(() => {});
          return true;
        },
      };
    },

    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin({
          key: pasteKey,
          props: {
            handlePaste(view, event, slice) {
              // The one paste this file stands aside for, and it stands aside because being first
              // in the list is not the same as being right about everything. Cells copied out of a
              // table and pasted into a table are prosemirror-tables' own edit: it lays them out
              // over the rectangle, grows the table when there are more of them than there is room
              // for, and keeps every cell boundary the user copied. Turning that into a line of
              // text would be this handler destroying a paste in order to guard it.
              if (isInTable(view.state) && pastedCells(slice)) return false;

              const files = imageFiles(event.clipboardData);
              const docPath = files.length ? context.documentPath() : null;
              // Asked before the write, not after it. An image that cannot go where the caret is
              // leaves the clipboard alone and the assets folder alone: writing the bytes first
              // would put a file on disk beside the user's document that nothing in it ever
              // refers to.
              if (docPath && placeable(view.state, view.state.schema.nodes.image)) {
                event.preventDefault();
                void insertImages(editor, files, docPath, context.onError);
                return true;
              }

              // An image that has nowhere to go falls through to the three questions below rather
              // than answering false here, which is what it used to do. False is not "nothing
              // happens": it is the paste being offered to the next plugin along, and an image
              // clipboard carries no text and no html, so what that plugin is handed is an empty
              // slice. prosemirror-tables takes an empty slice over a rectangle of cells and
              // empties every one of them, which is a PNG on the clipboard deleting a table.

              // Everything else. Claimed only where ProseMirror's own handler would do damage,
              // because its handler is better than this one at every paste that fits: it keeps
              // marks, lists and tables, and this one is a fallback that keeps only the words.
              //
              // Damage includes a blank line, which is why this branch asks before standing
              // aside. The clipboard is parsed against the block the caret is in, so a paste into
              // a raw block arrives as one text node with the newlines still in it and no block
              // boundary anywhere: `carriesBlocks` says no, the insert is ProseMirror's, and the
              // bytes it writes end the html block halfway through the user's tag.
              //
              // A raw block never stands aside, whatever the slice looks like. "Better" above
              // means marks, lists and tables kept, and a raw block holds text and nothing else,
              // so what is better there is a hard break put into a node whose content is `text*`
              // and a mark applied where `marks` is "", neither of which ProseMirror refuses: an
              // inline slice carrying one break turned somebody's `<div>` into two raw blocks with
              // a stray backslash written into the file. What this branch measures is
              // `sliceText`, which is only what ProseMirror inserts when the slice is a bare text
              // node, so standing aside on the strength of it is answering for a different insert
              // from the one that happens. The text path below is the only one that leaves the
              // block whole, and a raw target falls through to it.
              if (!carriesBlocks(slice) && takesText(view.state) && !touchesRaw(view.state)) {
                if (holdsText(view.state, sliceText(slice))) return false;
                event.preventDefault();
                context.onError(BLANK_LINE);
                return true;
              }
              if (takesBlocks(view.state)) return false;
              // Nowhere for anything to go, which is the rectangle of cells a drag across a table
              // makes: a paste over one replaces the content of every cell in it. Nothing is put
              // anywhere and the event is claimed so that nothing else puts it there either.
              if (!takesText(view.state)) {
                event.preventDefault();
                return true;
              }
              event.preventDefault();
              pasteAsText(editor, textOf(slice, event.clipboardData), context.onError);
              return true;
            },

            /**
             * The same insert arriving by a different route, and the reason this is not a line
             * inside handlePaste: a drop lands where the pointer is rather than where the caret
             * is, so it is a different position being asked about.
             *
             * A drop that does not fit is refused outright rather than turned into text. Refusing
             * costs nothing, since a drop of the document's own content that nobody claims leaves
             * the content where it was, and there is no second guess to make about what the user
             * meant by pointing at the middle of a fence.
             */
            handleDrop(view: EditorView, event: DragEvent, slice: Slice) {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              const $at = view.state.doc.resolve(at.pos);
              // A drop into a raw block is refused whatever it carries, and refused before the
              // slice is looked at. A paste is reparsed against the block the caret is in, so one
              // that lands in a raw block arrives as text; a drop is not, it is the dragged
              // content itself, so an inline one carries hard breaks and marks into a node whose
              // content is text and nothing else, and a plain text one carries whatever blank
              // lines were in it. The block is the file's own bytes and a drop is a pointer
              // gesture with nothing to ask, so nothing goes in.
              if (inRaw($at)) {
                event.preventDefault();
                return true;
              }
              if (!carriesBlocks(slice)) return false;
              if (fits($at, view.state.schema.nodes.paragraph)) return false;
              event.preventDefault();
              return true;
            },
          },
        }),
      ];
    },
  });
}
