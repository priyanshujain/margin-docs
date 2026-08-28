// What can be asserted about a toggle without a browser, which is the half that costs somebody a
// file.
//
// vite.config.ts runs vitest in the node environment, so there is no page here and nothing a
// browser does with one is on trial: the arrow's drawing, the caret's travel through a title and
// the placeholder on an untitled one belong to the Playwright suite. What belongs here is
// everything that reaches disk. The two attributes a toggle carries are the two things this lane
// writes, and both of them go out through an html block that the bridge will only read back if it
// is spelled one exact way, so a title the editor mangles on the way in is a `<details>` that opens
// as a raw block the next time the file is looked at.
//
// The node view is built here all the same, against the page written out at the bottom of this
// file, because two of the things it decides reach disk as surely as the attributes do: which
// clicks on the summary write `open`, and which commands are allowed to run while the caret is
// somewhere the document's selection is not. Both were bugs a green suite did not see, and neither
// is a question about a browser. They are questions about what these handlers do with what a
// browser sends them.
//
// The entity group is the one to keep. A summary holding `&`, `<` or `>` is escaped by the
// serializer and unescaped by the parser, and the parser refuses to model any toggle those two do
// not agree about character for character. An extra round of escaping would not throw, would not
// fail a type check and would not lose the document: it would grow another `amp;` in somebody's
// heading on every save.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Plugin, Transaction } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { createEditorExtensions } from "../extensions";
import { parseMarkdown, serializeMarkdown } from "../../markdown";
import { Toggles, setToggleOpen, setToggleSummary } from "./toggle";

const PATH = "/notes/writing.md";

const extensions = () => createEditorExtensions({ documentPath: () => PATH, onError: () => {} });

const EMPTY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/**
 * An editor with the lanes' plugins in its state.
 *
 * TipTap only installs them when it mounts a view and there is no DOM here to mount into, so the
 * state is rebuilt with them the way src/editor/Editor.tsx installs every document it opens. It
 * matters more here than it does for a keymap: this lane's plugin also appends a transaction, and a
 * plugin that is not in the state is never asked to.
 */
function makeEditor(content: JSONContent = EMPTY): Editor {
  const editor = new Editor({ element: null, injectCSS: false, extensions: extensions(), content });
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return editor;
}

function editorFor(source: string): Editor {
  return makeEditor(parseMarkdown(source, PATH).doc.toJSON());
}

/** What the bridge would write for the document as it stands now. */
function written(source: string, editor: Editor): string {
  return serializeMarkdown(parseMarkdown(source, PATH), editor.state.doc);
}

/** Where the first toggle in the document is, and what it holds. */
function toggleIn(editor: Editor): { pos: number; open: boolean; summary: string; body: string } {
  let found: { pos: number; open: boolean; summary: string; body: string } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || node.type.name !== "toggle") return !found;
    found = {
      pos,
      open: node.attrs.open as boolean,
      summary: node.attrs.summary as string,
      body: node.textContent,
    };
    return false;
  });
  if (!found) throw new Error("no toggle in the document");
  return found;
}

/** The plugins offering a node view for the toggle node, found the way the view finds them. */
function nodeViewPlugins(editor: Editor): Plugin[] {
  return editor.extensionManager.plugins.filter(
    (plugin) => plugin.props.nodeViews?.toggle !== undefined,
  );
}

const SUMMARY = "Tom &amp; Jerry &lt;3&gt;";
const PLAIN = "Tom & Jerry <3>";

const DOC = [
  "# Writing",
  "",
  "<details>",
  `<summary>${SUMMARY}</summary>`,
  "",
  "No em dashes.",
  "",
  "</details>",
  "",
  "After.",
  "",
].join("\n");

describe("the toggle extension", () => {
  it("is the one the registry names", () => {
    expect(Toggles.name).toBe("toggles");
  });

  it("adds no node and no mark, so the bridge and the editor still agree", () => {
    const plain = new Editor({
      element: null,
      injectCSS: false,
      extensions: extensions().filter((extension) => extension.name !== "toggles"),
      content: EMPTY,
    });
    const withToggles = makeEditor();

    expect(Object.keys(withToggles.schema.nodes)).toEqual(Object.keys(plain.schema.nodes));
    expect(Object.keys(withToggles.schema.marks)).toEqual(Object.keys(plain.schema.marks));

    plain.destroy();
    withToggles.destroy();
  });

  // The node view is the whole feature: without one the browser's own disclosure takes the click,
  // the open attribute never moves and a keystroke aimed at the title lands in the body. Two
  // plugins claiming the node would be the same bug from the other end, since ProseMirror takes the
  // first one asked and the other never runs.
  it("is the only plugin in the build that claims the toggle node view", () => {
    const editor = makeEditor();

    expect(nodeViewPlugins(editor)).toHaveLength(1);
    editor.destroy();
  });
});

describe("a <details> read off disk", () => {
  it("arrives as a toggle carrying its summary as text, not as entities", () => {
    const editor = editorFor(DOC);
    const toggle = toggleIn(editor);

    expect(toggle.summary).toBe(PLAIN);
    expect(toggle.open).toBe(false);
    expect(toggle.body).toBe("No em dashes.");
    editor.destroy();
  });

  it("is written back byte for byte when nothing was edited", () => {
    const editor = editorFor(DOC);

    expect(written(DOC, editor)).toBe(DOC);
    editor.destroy();
  });

  it("keeps the whole file byte identical when only the summary is edited", () => {
    const editor = editorFor(DOC);
    const { pos } = toggleIn(editor);

    expect(setToggleSummary(pos, "Tom & Jerry <4>")(editor.state, editor.view.dispatch)).toBe(true);
    expect(written(DOC, editor)).toBe(DOC.replace("&lt;3&gt;", "&lt;4&gt;"));
    editor.destroy();
  });

  // The failure this is shaped to catch is invisible: an editor that put the escaped form on the
  // node would write `&amp;amp;` here, the file would still parse, and the title would grow a word
  // every time the document was saved.
  it("does not escape the ampersand it already escaped once", () => {
    const editor = editorFor(DOC);
    const { pos } = toggleIn(editor);

    // The one keystroke: a character on the end of a title that already holds all three of the
    // characters the serializer has to spell as entities.
    setToggleSummary(pos, `${PLAIN}!`)(editor.state, editor.view.dispatch);
    const once = written(DOC, editor);
    expect(once).toBe(DOC.replace(SUMMARY, `${SUMMARY}!`));

    // And back through the bridge, which is where a second round of escaping would show up.
    const again = makeEditor(parseMarkdown(once, PATH).doc.toJSON());
    expect(toggleIn(again).summary).toBe(`${PLAIN}!`);
    expect(written(once, again)).toBe(once);
    again.destroy();
    editor.destroy();
  });

  it("writes the open marker on to the tag, and takes it off again", () => {
    const editor = editorFor(DOC);
    const { pos } = toggleIn(editor);

    expect(setToggleOpen(pos, true)(editor.state, editor.view.dispatch)).toBe(true);
    expect(written(DOC, editor)).toBe(DOC.replace("<details>", "<details open>"));

    expect(setToggleOpen(pos, false)(editor.state, editor.view.dispatch)).toBe(true);
    expect(written(DOC, editor)).toBe(DOC);
    editor.destroy();
  });

  it("leaves the body alone whatever happens to the two attributes", () => {
    const editor = editorFor(DOC);
    const { pos, body } = toggleIn(editor);

    setToggleSummary(pos, "Something else")(editor.state, editor.view.dispatch);
    setToggleOpen(pos, true)(editor.state, editor.view.dispatch);

    expect(toggleIn(editor).body).toBe(body);
    expect(editor.state.doc.textContent).toBe(editorFor(DOC).state.doc.textContent);
    editor.destroy();
  });
});

describe("the two commands", () => {
  it("decline a position that is not a toggle, and one that already reads that way", () => {
    const editor = editorFor(DOC);
    const { pos, summary } = toggleIn(editor);
    const before = editor.state.doc.toJSON();

    expect(setToggleOpen(0, true)(editor.state, editor.view.dispatch)).toBe(false);
    expect(setToggleSummary(0, "x")(editor.state, editor.view.dispatch)).toBe(false);
    expect(setToggleOpen(pos, false)(editor.state, editor.view.dispatch)).toBe(false);
    expect(setToggleSummary(pos, summary)(editor.state, editor.view.dispatch)).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  // A closed <details> does not draw its children, so a caret left in one is a caret nobody can see
  // and the next keystroke goes somewhere invisible.
  it("bring the caret out of a body that is being closed", () => {
    const editor = editorFor(DOC);
    const { pos } = toggleIn(editor);
    setToggleOpen(pos, true)(editor.state, editor.view.dispatch);

    const inside = pos + 2;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, inside)));
    expect(editor.state.selection.from).toBe(inside);

    setToggleOpen(pos, false)(editor.state, editor.view.dispatch);
    const node = editor.state.doc.nodeAt(pos)!;
    expect(editor.state.selection.from >= pos + node.nodeSize).toBe(true);
    editor.destroy();
  });

  it("leave the caret where it is when it was never inside", () => {
    const editor = editorFor(DOC);
    const { pos } = toggleIn(editor);
    setToggleOpen(pos, true)(editor.state, editor.view.dispatch);
    editor.commands.setTextSelection(2);

    setToggleOpen(pos, false)(editor.state, editor.view.dispatch);
    expect(editor.state.selection.from).toBe(2);
    editor.destroy();
  });
});

// What the pill's Toggle button runs, which is `toggleWrap("toggle")` in setBlock in
// src/editor/Editor.tsx. A toggle takes the attribute's own default, which is closed, so without
// the plugin's appended transaction the paragraph the user just wrapped is behind an arrow and
// reads as a deletion.
describe("wrapping a block in a toggle", () => {
  const PROSE: JSONContent = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this visible." }] }],
  };

  it("leaves it open, with the block still on screen inside it", () => {
    const editor = makeEditor(PROSE);
    editor.commands.setTextSelection(2);

    expect(editor.chain().toggleWrap("toggle").run()).toBe(true);
    const toggle = toggleIn(editor);
    expect(toggle.open).toBe(true);
    expect(toggle.summary).toBe("");
    expect(toggle.body).toBe("Keep this visible.");
    editor.destroy();
  });

  it("makes something the bridge writes and reads back as the same toggle", () => {
    const editor = makeEditor(PROSE);
    editor.commands.setTextSelection(2);
    editor.chain().toggleWrap("toggle").run();
    setToggleSummary(toggleIn(editor).pos, "House style")(editor.state, editor.view.dispatch);

    const source = written("Keep this visible.\n", editor);
    expect(source).toBe(
      ["<details open>", "<summary>House style</summary>", "", "Keep this visible.", "", "</details>", ""].join("\n"),
    );

    const reopened = makeEditor(parseMarkdown(source, PATH).doc.toJSON());
    const toggle = toggleIn(reopened);
    expect([toggle.open, toggle.summary, toggle.body]).toEqual([true, "House style", "Keep this visible."]);
    reopened.destroy();
    editor.destroy();
  });

  it("takes it back out on a second press, which is what the same button means", () => {
    const editor = makeEditor(PROSE);
    editor.commands.setTextSelection(2);
    editor.chain().toggleWrap("toggle").run();

    expect(editor.chain().toggleWrap("toggle").run()).toBe(true);
    expect(editor.state.doc.toJSON()).toEqual(PROSE);
    editor.destroy();
  });
});

// The guard on the appended transaction, and the reason it is written the way it is. Opening a
// document restores the caret it was last left at, and that is a selection with no edit behind it:
// a toggle opened by one would be a byte written into a file nobody has touched.
describe("a caret that moves without an edit", () => {
  it("never opens the toggle it lands in, and never dirties the document", () => {
    const editor = editorFor(DOC);
    const { pos } = toggleIn(editor);
    const before = editor.state.doc.toJSON();

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 2)),
    );

    expect(toggleIn(editor).open).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(written(DOC, editor)).toBe(DOC);
    editor.destroy();
  });
});

/**
 * The few parts of a page the node view reaches for, written out rather than depended on.
 *
 * A DOM implementation is not a dependency this project has, and the handful of calls the node view
 * makes into one does not earn it: it creates elements, hangs listeners on them, asks which one the
 * page thinks has the caret, and asks for a frame. What a browser does with an element is
 * Playwright's question. What the handlers in toggle.ts do with what a browser sends them is this
 * file's, and that is the whole of what these model.
 */
interface PageEvent {
  type: string;
  target: PageElement;
  key?: string;
  isComposing?: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

class PageElement {
  className = "";
  contentEditable = "inherit";
  textContent = "";
  parent: PageElement | null = null;

  private readonly attributes = new Set<string>();
  private readonly listeners = new Map<string, ((event: PageEvent) => void)[]>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: Page,
  ) {}

  /** Only ever asked whether there is one, which is how a leftover <br> in a title is found. */
  get firstChild(): object | null {
    return this.textContent === "" ? null : { nodeName: "#text" };
  }

  setAttribute(name: string, _value: string): void {
    this.attributes.add(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  toggleAttribute(name: string, on: boolean): void {
    if (on) this.attributes.add(name);
    else this.attributes.delete(name);
  }

  appendChild(child: PageElement): void {
    child.parent = this;
  }

  append(...children: PageElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  contains(other: PageElement | null): boolean {
    for (let element = other; element; element = element.parent) if (element === this) return true;
    return false;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
    this.fire("focus");
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    this.fire("blur");
  }

  addEventListener(type: string, listener: (event: PageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: PageEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((one) => one !== listener));
  }

  /** Bubbling, because the row's listeners are what an event on the title inside it reaches. */
  fire(type: string, extra: Partial<PageEvent> = {}): PageEvent {
    const event: PageEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
      ...extra,
    };
    for (let element: PageElement | null = this; element; element = element.parent) {
      for (const listener of element.listeners.get(type) ?? []) listener(event);
    }
    return event;
  }
}

class Page {
  activeElement: PageElement | null = null;
  readonly created: PageElement[] = [];

  private readonly frames: (() => void)[] = [];

  readonly defaultView = {
    requestAnimationFrame: (run: () => void): number => this.frames.push(run),
  };

  createElement(tagName: string): PageElement {
    const element = new PageElement(tagName, this);
    this.created.push(element);
    return element;
  }

  /** Nothing here models a caret inside a title, only which element holds one. */
  getSelection(): null {
    return null;
  }

  /** The frame a browser would run next, which is also where TipTap's own focus call lands. */
  runFrames(): number {
    const queued = this.frames.splice(0);
    for (const run of queued) run();
    return queued.length;
  }
}

interface Mounted {
  page: Page;
  details: PageElement;
  summary: PageElement;
  title: PageElement;
  destroy: () => void;
}

/** The node view for the toggle at `pos`, built the way the editor's view builds one. */
function mount(editor: Editor, pos: number): Mounted {
  const page = new Page();
  const view = {
    dom: page.createElement("div"),
    get state(): EditorState {
      return editor.state;
    },
    dispatch: (tr: Transaction) => editor.view.dispatch(tr),
    editable: true,
    focus: () => {},
  } as unknown as EditorView;

  const build = nodeViewPlugins(editor)[0]?.props.nodeViews?.toggle;
  const node = editor.state.doc.nodeAt(pos);
  if (!build || !node) throw new Error("nothing to build a node view from");
  const nodeView = build(node, view, () => pos, [], DecorationSet.empty);

  const find = (match: (element: PageElement) => boolean): PageElement => {
    const element = page.created.find(match);
    if (!element) throw new Error("the node view did not build that element");
    return element;
  };

  return {
    page,
    details: find((element) => element.tagName === "details"),
    summary: find((element) => element.tagName === "summary"),
    title: find((element) => element.hasAttribute("data-toggle-summary")),
    destroy: () => nodeView.destroy?.(),
  };
}

/** Where the text of this block ends, which is where a click in it leaves the caret. */
function endOf(editor: Editor, text: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock && node.textContent === text) found = pos + 1 + node.content.size;
    return found === null;
  });
  if (found === null) throw new Error(`no block reading ${text}`);
  return found;
}

const PAGE_DOC = [
  "# Doc",
  "",
  "First paragraph.",
  "",
  "Second paragraph.",
  "",
  "<details open>",
  "<summary>My title</summary>",
  "",
  "Toggle body.",
  "",
  "</details>",
  "",
].join("\n");

// A `<details>` is a disclosure control and the browser works one from the keyboard whether this
// file wants it to or not: a space typed anywhere inside the summary sends the row a click of its
// own. Taken as a press, that closed the toggle under the caret on every other space of a title and
// wrote the flip to the file each time.
describe("a space typed in a title", () => {
  it("leaves the toggle as it was, and the space in the title", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);

    ui.title.focus();
    ui.title.fire("keydown", { key: " " });
    // The character the browser puts in the element, and then the click it sends the row after it.
    ui.title.textContent = "My title ";
    ui.title.fire("input");
    ui.summary.fire("click");

    const toggle = toggleIn(editor);
    expect(toggle.open).toBe(true);
    expect(toggle.summary).toBe("My title ");
    expect(written(PAGE_DOC, editor)).toBe(PAGE_DOC.replace("My title", "My title "));
    ui.destroy();
    editor.destroy();
  });

  it("does not find a press that never became a click waiting for it", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);

    // Pressed on the row, and then the pointer left and no click ever came of it.
    ui.summary.fire("mousedown");
    ui.title.focus();
    ui.title.fire("keydown", { key: " " });
    ui.summary.fire("click");

    expect(toggleIn(editor).open).toBe(true);
    ui.destroy();
    editor.destroy();
  });
});

describe("a press on the summary row", () => {
  it("still flips the toggle and writes it, which is what the arrow is for", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);

    ui.summary.fire("mousedown");
    ui.summary.fire("click");

    expect(toggleIn(editor).open).toBe(false);
    expect(written(PAGE_DOC, editor)).toBe(PAGE_DOC.replace("<details open>", "<details>"));
    ui.destroy();
    editor.destroy();
  });

  it("flips it from the keyboard when the row itself is what has focus", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);

    ui.page.activeElement = ui.summary;
    ui.summary.fire("click");

    expect(toggleIn(editor).open).toBe(false);
    ui.destroy();
    editor.destroy();
  });
});

// The caret in a title is not in the document: ProseMirror's selection is still wherever it was
// when the caret went in there, so a toolbar button pressed while a title is being typed runs its
// command against a paragraph the user is not looking at.
describe("a command aimed at the document while the caret is in a title", () => {
  it("changes nothing, and the file with it", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);
    editor.commands.setTextSelection(endOf(editor, "Second paragraph."));
    ui.title.focus();
    const before = editor.state.doc.toJSON();

    // What the pill's Horizontal rule runs, less the focus() in front of it, which wants a browser.
    editor.commands.insertContent({ type: "horizontalRule" });

    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(written(PAGE_DOC, editor)).toBe(PAGE_DOC);
    ui.destroy();
    editor.destroy();
  });

  it("leaves the caret in the title, so a second press is refused like the first", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);
    editor.commands.setTextSelection(endOf(editor, "Second paragraph."));
    ui.title.focus();
    const before = editor.state.doc.toJSON();

    editor.commands.insertContent({ type: "horizontalRule" });
    // TipTap's focus command queues a view.focus() for the next frame, and it lands behind the
    // refusal: without the caret being put back, the second press of the same button has a caret in
    // the document again and edits the place the first press was refused for.
    ui.title.blur();
    expect(ui.page.runFrames()).toBe(1);
    expect(ui.page.activeElement).toBe(ui.title);

    editor.commands.insertContent({ type: "horizontalRule" });
    expect(editor.state.doc.toJSON()).toEqual(before);
    ui.destroy();
    editor.destroy();
  });

  it("is taken back the moment the caret leaves the title", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);
    editor.commands.setTextSelection(endOf(editor, "Second paragraph."));
    ui.title.focus();
    ui.title.blur();
    const before = editor.state.doc.toJSON();

    editor.commands.insertContent({ type: "horizontalRule" });

    expect(editor.state.doc.toJSON()).not.toEqual(before);
    ui.destroy();
    editor.destroy();
  });

  it("is never the title's own writing, which is the one edit that is where the caret is", () => {
    const editor = editorFor(PAGE_DOC);
    const ui = mount(editor, toggleIn(editor).pos);
    ui.title.focus();

    ui.title.textContent = "Renamed";
    ui.title.fire("input");

    expect(toggleIn(editor).summary).toBe("Renamed");
    expect(written(PAGE_DOC, editor)).toBe(PAGE_DOC.replace("My title", "Renamed"));
    ui.destroy();
    editor.destroy();
  });
});

const TWO_TOGGLES = [
  "<details>",
  "<summary>Closed</summary>",
  "",
  "Hidden body.",
  "",
  "</details>",
  "",
  "<details open>",
  "<summary>My title</summary>",
  "",
  "Toggle body.",
  "",
  "</details>",
  "",
].join("\n");

/** Every toggle in the document, in the order they are written. */
function togglesIn(editor: Editor): { pos: number; open: boolean; summary: string }[] {
  const found: { pos: number; open: boolean; summary: string }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "toggle") return true;
    found.push({ pos, open: node.attrs.open as boolean, summary: node.attrs.summary as string });
    return true;
  });
  return found;
}

// The plugin opens the collapsed toggle the caret ends an edit inside, because a caret behind a
// closed arrow is one nobody can see. The caret in a title is not in the document at all, so the
// selection that rule reads is stale and the toggle it names is one nobody is in.
describe("typing in a title while the selection is left inside another toggle", () => {
  it("does not open the toggle it is left in, and writes no byte into that one", () => {
    const editor = editorFor(TWO_TOGGLES);
    const [closed, titled] = togglesIn(editor);
    const ui = mount(editor, titled.pos);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, closed.pos + 3)),
    );
    ui.title.focus();

    ui.title.textContent = "Renamed";
    ui.title.fire("input");

    expect(togglesIn(editor)[0].open).toBe(false);
    expect(written(TWO_TOGGLES, editor)).toBe(TWO_TOGGLES.replace("My title", "Renamed"));
    ui.destroy();
    editor.destroy();
  });
});

// src/markdown/parse.ts pairs `<details>` among the root's own children and nowhere else, so a
// toggle anywhere but the top level of the document goes to disk as something the next open of the
// file reads back as one raw block: the bytes are kept and both constructs stop being editable.
describe("a toggle the bridge could not read back", () => {
  const CALLOUT = "> [!NOTE]\n> Callout body.\n";

  it("is not made inside a callout", () => {
    const editor = editorFor(CALLOUT);
    editor.commands.setTextSelection(endOf(editor, "Callout body."));
    const before = editor.state.doc.toJSON();

    editor.chain().toggleWrap("toggle").run();

    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(written(CALLOUT, editor)).toBe(CALLOUT);
    editor.destroy();
  });

  it("is not made inside another toggle", () => {
    const editor = editorFor(PAGE_DOC);
    editor.commands.setTextSelection(endOf(editor, "Toggle body."));
    const before = editor.state.doc.toJSON();

    // Attributes the toggle already there does not carry, because that is the call that nests:
    // TipTap's isNodeActive wants them to match before it takes a second press as taking one out,
    // so anything else wraps a second toggle around the inside of the first.
    editor.chain().toggleWrap("toggle", { open: false }).run();

    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(written(PAGE_DOC, editor)).toBe(PAGE_DOC);
    editor.destroy();
  });

  // The rule is about a toggle being put somewhere, and an edit inside one that is already there
  // reaches into the same node without moving it. Reading that as a toggle being nested would
  // refuse every keystroke in every toggle body in the document.
  it("does not stand in the way of an edit inside a toggle that is already there", () => {
    const editor = editorFor(PAGE_DOC);
    editor.commands.setTextSelection(endOf(editor, "Toggle body."));

    editor.commands.insertContent({ type: "text", text: " More." });

    expect(toggleIn(editor).body).toBe("Toggle body. More.");
    expect(written(PAGE_DOC, editor)).toBe(PAGE_DOC.replace("Toggle body.", "Toggle body. More."));
    editor.destroy();
  });

  it("is still made at the top level, where it is read back as itself", () => {
    const editor = editorFor(PAGE_DOC);
    editor.commands.setTextSelection(endOf(editor, "First paragraph."));

    expect(editor.chain().toggleWrap("toggle").run()).toBe(true);
    expect(togglesIn(editor)).toHaveLength(2);
    const source = written(PAGE_DOC, editor);
    expect(parseMarkdown(source, PATH).doc.childCount).toBe(editor.state.doc.childCount);
    editor.destroy();
  });
});
