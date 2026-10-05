// Highlighting is paint, and the tests that matter are the ones that prove it stayed paint: the
// text of a fence, the attributes on it and the bytes it serializes to are the same whether or not
// a grammar was ever run over it. The rest is about the two ways a highlighter goes wrong in a real
// editor. It can throw or misalign on input it did not expect, which is answered here by fences
// nobody has a grammar for, and it can be slow, which is answered by counting how much of the
// document it walks when one character is typed.
//
// The last group is about neither, and is here because the block is: the two arrows that get a
// caret back out of a fence with nothing beyond it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Plugin, Transaction } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";

// The highlighter is private to code.ts, deliberately, so the only place left to watch how often it
// runs is underneath it. Everything the real lowlight does still happens; the wrapper only records
// the text it was handed.
const { highlighted } = vi.hoisted(() => ({ highlighted: [] as string[] }));

vi.mock("lowlight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lowlight")>();
  return {
    ...actual,
    createLowlight(...created: Parameters<typeof actual.createLowlight>) {
      const instance = actual.createLowlight(...created);
      return {
        ...instance,
        highlight(...call: Parameters<typeof instance.highlight>) {
          highlighted.push(call[1]);
          return instance.highlight(...call);
        },
      };
    },
  };
});

const { createEditorExtensions } = await import("../extensions");
const { setCodeLanguage } = await import("./code");
const { parseMarkdown, serializeMarkdown } = await import("../../markdown");

const extensions = () =>
  createEditorExtensions({ documentPath: () => "/notes/a.md", onError: () => {} });

function editorFor(source: string): Editor {
  return new Editor({
    element: null,
    injectCSS: false,
    extensions: extensions(),
    content: parseMarkdown(source, "/notes/a.md").doc.toJSON(),
  });
}

/**
 * The document with the highlighting plugin over it, and nothing else.
 *
 * An editor cannot be mounted without a DOM and an unmounted one's state carries no plugins at all,
 * so the plugin is lifted out of the extension manager and given a state of its own. What it sees
 * there is what it sees in the app: a real state over a real parsed document, and transactions
 * applied to it one at a time. Only the view is missing, and a decoration is computed without one.
 */
function stateFor(source: string): EditorState {
  const editor = editorFor(source);
  const plugin = editor.extensionManager.plugins.find((candidate: Plugin) =>
    String((candidate as unknown as { key: string }).key).startsWith("codeHighlighting"),
  );
  if (!plugin) throw new Error("the code highlighting plugin is not in the extension list");
  const state = EditorState.create({ doc: editor.state.doc, plugins: [plugin] });
  editor.destroy();
  return state;
}

interface Block {
  pos: number;
  node: ProseMirrorNode;
}

function codeBlocks(doc: ProseMirrorNode): Block[] {
  const found: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    found.push({ pos, node });
    return false;
  });
  return found;
}

function decorations(state: EditorState): Decoration[] {
  for (const plugin of state.plugins) {
    const set = plugin.getState(state) as DecorationSet | undefined;
    if (set) return set.find();
  }
  return [];
}

/** A decoration is the copy control rather than a span of colour when it carries the chrome's key. */
function isChrome(decoration: Decoration): boolean {
  return decoration.spec.key === "code-copy";
}

/**
 * The highlighter's own spans.
 *
 * The lane puts two unrelated things in one decoration set, because a plugin has one, so every test
 * below about where a grammar's colour landed asks for this rather than for the whole set. The copy
 * control is a widget: it has no width, it is over nobody's characters, and a test that measured it
 * as a span would fail on a fence with no highlighting at all, which was how the chrome announced
 * itself here the first time. The chrome has assertions of its own further down.
 */
function spans(state: EditorState): Decoration[] {
  return decorations(state).filter((decoration) => !isChrome(decoration));
}

function classOf(decoration: Decoration): string {
  return (decoration as unknown as { type: { attrs: { class: string } } }).type.attrs.class;
}

/** The text a span was cut from, which is the only thing that says it landed in the right place. */
function textOf(state: EditorState, decoration: Decoration): string {
  return state.doc.textBetween(decoration.from, decoration.to);
}

function spanWith(state: EditorState, className: string): string | undefined {
  const found = spans(state).find((decoration) => classOf(decoration).includes(className));
  return found && textOf(state, found);
}

function fence(language: string, ...lines: string[]): string {
  return ["```" + language, ...lines, "```", ""].join("\n");
}

/**
 * The same document with the extensions' ProseMirror plugins in its state, which is what TipTap
 * builds when it mounts a view and what a keystroke has to be offered to.
 */
function mounted(source: string): Editor {
  const editor = editorFor(source);
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return editor;
}

const KEY_CODES: Record<string, number> = { ArrowUp: 38, ArrowDown: 40 };

/**
 * One key, offered to the plugins in the order the view would offer it and stopping at the first
 * that claims it.
 *
 * The walk is the real one rather than a call into the binding this file is about, because which
 * plugin answers is half the question: the code lane's keymap is asked ahead of the gap cursor's
 * and of the table lane's, and a key it claims by mistake is a key one of those never sees.
 */
function press(editor: Editor, key: string): boolean {
  const event = {
    key,
    keyCode: KEY_CODES[key] ?? 8,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
  const view = editor.view as unknown as EditorView;

  for (const plugin of editor.state.plugins) {
    const handler = plugin.props?.handleKeyDown;
    if (handler && handler.call(plugin, view, event)) return true;
  }
  return false;
}

/**
 * `body`, run with the editor's view answering one question the way a browser would.
 *
 * Whether the caret is on the outer line of its fence is a question about laid out text, and the
 * headless stand-in TipTap gives an unmounted editor throws for it. A keymap binding runs its
 * command against `editor.view` rather than against the view the keydown arrived on, so the
 * stand-in is swapped for the length of the body rather than handed to `press`. Everything else on
 * it is what TipTap's own stand-in has, so a key that moves the caret moves it for the assertions
 * afterward. tests/blocks.spec.ts presses the same keys against a real view.
 */
function atEdge(editor: Editor, edge: boolean, body: () => void): void {
  const host = editor as unknown as {
    editorView: EditorView | null;
    editorState: EditorState;
    dispatchTransaction(tr: Transaction): void;
  };
  host.editorView = {
    get state() {
      return host.editorState;
    },
    updateState: (state: EditorState) => {
      host.editorState = state;
    },
    dispatch: (tr: Transaction) => host.dispatchTransaction(tr),
    endOfTextblock: () => edge,
    composing: false,
    dragging: null,
    editable: true,
    isDestroyed: false,
  } as unknown as EditorView;
  try {
    body();
  } finally {
    host.editorView = null;
  }
}

/** What this document would be written to disk as, which is the half the user keeps. */
function written(editor: Editor): string {
  const doc = editor.state.doc;
  return serializeMarkdown({ frontmatter: null, doc, source: "", path: "/notes/a.md" }, doc);
}

beforeEach(() => {
  highlighted.length = 0;
});

describe("the highlighter", () => {
  it("colours the four languages this repo's own docs are written in", () => {
    const sources: Record<string, string> = {
      rust: fence("rust", "fn main() {}"),
      toml: fence("toml", "[package]", 'name = "margin-docs"'),
      swift: fence("swift", "let x = 1"),
      kotlin: fence("kotlin", "val x = 1"),
    };

    for (const [language, source] of Object.entries(sources)) {
      const state = stateFor(source);
      expect([language, spans(state).length > 0]).toEqual([language, true]);
    }
  });

  it("puts every span over the characters it was cut from", () => {
    const state = stateFor(fence("rust", 'fn main() { let x = "hi"; }', "// a comment"));
    const [block] = codeBlocks(state.doc);
    const from = block.pos + 1;
    const to = from + block.node.content.size;

    const found = spans(state);
    expect(found.length).toBeGreaterThan(3);
    for (const decoration of found) {
      expect(decoration.from).toBeGreaterThanOrEqual(from);
      expect(decoration.to).toBeLessThanOrEqual(to);
      expect(decoration.from).toBeLessThan(decoration.to);
    }

    expect(spanWith(state, "hljs-keyword")).toBe("fn");
    expect(spanWith(state, "hljs-string")).toBe('"hi"');
    expect(spanWith(state, "hljs-comment")).toBe("// a comment");
  });

  it("keeps its offsets over text that is not one code unit per character", () => {
    const state = stateFor(fence("ts", 'const flag = "🇬🇧 ok";', "\tconst tabbed = 1;"));

    expect(codeBlocks(state.doc)[0].node.textContent).toBe(
      'const flag = "🇬🇧 ok";\n\tconst tabbed = 1;',
    );
    expect(spanWith(state, "hljs-string")).toBe('"🇬🇧 ok"');
  });

  it("leaves a fence tagged with a language nobody has plain, and loses nothing", () => {
    const source = fence("nosuchlanguage", "this is not code in any language", "  indented  ");
    const parsed = parseMarkdown(source, "/notes/a.md");
    const state = stateFor(source);

    expect(spans(state)).toEqual([]);
    expect(codeBlocks(state.doc)[0].node.textContent).toBe(
      "this is not code in any language\n  indented  ",
    );
    expect(serializeMarkdown(parsed, state.doc)).toBe(source);
  });

  it("leaves a bare fence plain", () => {
    const state = stateFor(fence("", "just some text"));

    expect(codeBlocks(state.doc)[0].node.attrs.language).toBe(null);
    expect(spans(state)).toEqual([]);
    expect(highlighted).toEqual([]);
  });

  it("leaves a mermaid fence to the lane that draws it", () => {
    const state = stateFor(fence("mermaid", "graph TD;", "  a-->b;"));

    expect(spans(state)).toEqual([]);
    expect(highlighted).toEqual([]);
  });

  it("does not throw on code that is broken in its own language", () => {
    const source = fence("json", "{ this is not, json: ]]", '"neither" is "this"');
    const parsed = parseMarkdown(source, "/notes/a.md");
    const state = stateFor(source);

    expect(codeBlocks(state.doc)[0].node.textContent).toBe(
      '{ this is not, json: ]]\n"neither" is "this"',
    );
    expect(serializeMarkdown(parsed, state.doc)).toBe(source);
    for (const decoration of spans(state)) {
      expect(textOf(state, decoration).length).toBeGreaterThan(0);
    }
  });

  it("leaves a fence too long to be read as code plain, and keeps every character", () => {
    const line = "const x = 1; // a line of code that is being repeated a great many times\n";
    const long = line.repeat(1000);
    expect(long.length).toBeGreaterThan(50_000);

    const state = stateFor(fence("ts", long.trimEnd()));

    expect(spans(state)).toEqual([]);
    expect(highlighted).toEqual([]);
    expect(codeBlocks(state.doc)[0].node.textContent).toBe(long.trimEnd());
  });

  it("does not write to the document it is painting over", () => {
    const source = ["# Notes", "", fence("rust twoslash", "fn main() {}"), "Prose.", ""].join("\n");
    const parsed = parseMarkdown(source, "/notes/a.md");
    const state = stateFor(source);

    expect(state.doc.toJSON()).toEqual(parsed.doc.toJSON());
    expect(codeBlocks(state.doc)[0].node.attrs).toEqual({ language: "rust", meta: "twoslash" });
    expect(serializeMarkdown(parsed, state.doc)).toBe(source);
  });
});

describe("what a keystroke costs", () => {
  const twoBlocks = () =>
    stateFor(
      [fence("ts", "const first = 1;"), fence("ts", "const second = 2;"), "Prose.", ""].join("\n"),
    );

  const endOf = (block: Block) => block.pos + 1 + block.node.content.size;

  it("re-highlights only the block the edit landed in", () => {
    const state = twoBlocks();
    const blocks = codeBlocks(state.doc);
    expect(blocks).toHaveLength(2);
    expect(highlighted).toEqual(["const first = 1;", "const second = 2;"]);

    highlighted.length = 0;
    state.apply(state.tr.insertText("2", endOf(blocks[1])));

    expect(highlighted).toEqual(["const second = 2;2"]);
  });

  it("carries the untouched block's spans forward, still over their own characters", () => {
    const before = twoBlocks();
    const state = before.apply(before.tr.insertText("// ", codeBlocks(before.doc)[0].pos + 1));

    const second = codeBlocks(state.doc)[1];
    const inSecond = spans(state).filter((decoration) => decoration.from > second.pos);
    expect(inSecond.length).toBeGreaterThan(0);
    for (const decoration of inSecond) {
      expect("const second = 2;").toContain(textOf(state, decoration));
    }

    const keyword = spans(state).find(
      (decoration) =>
        decoration.from > second.pos && classOf(decoration).includes("hljs-keyword"),
    );
    expect(keyword && textOf(state, keyword)).toBe("const");
  });

  it("re-highlights a block whose language changed, and no other", () => {
    const before = twoBlocks();
    const block = codeBlocks(before.doc)[0];

    highlighted.length = 0;
    const state = before.apply(
      before.tr.setNodeMarkup(block.pos, null, { ...block.node.attrs, language: "rust" }),
    );

    expect(highlighted).toEqual(["const first = 1;"]);
    expect(spanWith(state, "hljs-keyword")).toBe("const");
  });

  it("drops the spans of a block that was deleted, and highlights nothing again", () => {
    const before = twoBlocks();
    const block = codeBlocks(before.doc)[1];

    highlighted.length = 0;
    const state = before.apply(
      before.tr.delete(block.pos, block.pos + block.node.nodeSize),
    );

    expect(highlighted).toEqual([]);
    expect(codeBlocks(state.doc)).toHaveLength(1);
    for (const decoration of spans(state)) {
      expect("const first = 1;").toContain(textOf(state, decoration));
    }
  });

  it("highlights a block that was inserted after the document loaded, and no other", () => {
    const before = twoBlocks();
    const at = codeBlocks(before.doc)[1].pos;

    highlighted.length = 0;
    const state = before.apply(
      before.tr.insert(
        at,
        before.doc.type.schema.nodes.codeBlock.create({ language: "rust", meta: null }, [
          before.doc.type.schema.text("fn main() {}"),
        ]),
      ),
    );

    expect(highlighted).toEqual(["fn main() {}"]);
    expect(codeBlocks(state.doc)).toHaveLength(3);
    expect(spanWith(state, "hljs-keyword")).toBe("const");
  });

  it("does not run at all for a transaction that changed no text", () => {
    const before = twoBlocks();

    highlighted.length = 0;
    const state = before.apply(before.tr.setMeta("nothing", true));

    expect(highlighted).toEqual([]);
    expect(spans(state).length).toBeGreaterThan(0);
  });
});

describe("setCodeLanguage", () => {
  function editorAtFence(source: string): Editor {
    const editor = editorFor(source);
    editor.commands.setTextSelection(codeBlocks(editor.state.doc)[0].pos + 1);
    return editor;
  }

  it("writes the language and leaves the meta the user wrote alone", () => {
    const source = fence("ts twoslash", "const x = 1;");
    const parsed = parseMarkdown(source, "/notes/a.md");
    const editor = editorAtFence(source);

    expect(setCodeLanguage(editor, "rust")).toBe(true);
    expect(codeBlocks(editor.state.doc)[0].node.attrs).toEqual({
      language: "rust",
      meta: "twoslash",
    });
    const written = serializeMarkdown(parsed, editor.state.doc);
    expect(written).toBe(fence("rust twoslash", "const x = 1;"));

    editor.destroy();
  });

  it("clears the fence back to a bare one", () => {
    const source = fence("ts", "const x = 1;");
    const parsed = parseMarkdown(source, "/notes/a.md");
    const editor = editorAtFence(source);

    expect(setCodeLanguage(editor, null)).toBe(true);
    expect(codeBlocks(editor.state.doc)[0].node.attrs.language).toBe(null);
    expect(serializeMarkdown(parsed, editor.state.doc)).toBe(fence("", "const x = 1;"));

    editor.destroy();
  });

  it("treats a blank language as a bare fence", () => {
    const editor = editorAtFence(fence("ts", "const x = 1;"));

    expect(setCodeLanguage(editor, "   ")).toBe(true);
    expect(codeBlocks(editor.state.doc)[0].node.attrs.language).toBe(null);

    editor.destroy();
  });

  it("refuses a language with a space in it, which the fence would read back as two things", () => {
    const source = fence("ts", "const x = 1;");
    const parsed = parseMarkdown(source, "/notes/a.md");
    const editor = editorAtFence(source);

    expect(setCodeLanguage(editor, "ts twoslash")).toBe(false);
    expect(codeBlocks(editor.state.doc)[0].node.attrs).toEqual({ language: "ts", meta: null });
    expect(serializeMarkdown(parsed, editor.state.doc)).toBe(source);

    editor.destroy();
  });

  it("does nothing when the block already says that, so nothing is dirtied", () => {
    const editor = editorAtFence(fence("ts", "const x = 1;"));
    const before = editor.state.doc.toJSON();

    expect(setCodeLanguage(editor, "ts")).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);

    editor.destroy();
  });

  it("does nothing outside a code block", () => {
    const editor = editorFor(["Just a paragraph.", ""].join("\n"));
    const before = editor.state.doc.toJSON();

    expect(setCodeLanguage(editor, "rust")).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);

    editor.destroy();
  });
});

// The keys that get a caret back out of a fence, which are this lane's own for exactly one case.
// A code block is a textblock, so the browser walks the caret down it a line at a time and out of
// it into the block below, and every one of those is left alone here and asserted to be left alone.
// The case with no answer anywhere else is a fence with nothing at all beyond it, which is what a
// code block made from the toolbar in an empty document is: measured in Chromium, ArrowDown at the
// end of the only block in the document moved nothing, dispatched nothing and drew no gap cursor,
// and the caret stayed in the fence for as long as the key was pressed.
describe("the arrows out of a fence", () => {
  const startOf = (editor: Editor) => codeBlocks(editor.state.doc)[0].pos + 1;

  const endOf = (editor: Editor) => {
    const block = codeBlocks(editor.state.doc)[0];
    return block.pos + 1 + block.node.content.size;
  };

  it("ArrowDown off the end of a fence that ends the document makes a paragraph to land in", () => {
    const editor = mounted(fence("ts", "const x = 1;"));
    const before = written(editor);

    atEdge(editor, true, () => {
      editor.commands.setTextSelection(endOf(editor));
      expect(press(editor, "ArrowDown")).toBe(true);

      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
      expect(editor.state.selection.$from.parent).toBe(editor.state.doc.lastChild);
      // An empty paragraph is nothing to the serializer, so the file is untouched by the key.
      expect(written(editor)).toBe(before);
    });

    editor.destroy();
  });

  it("ArrowUp off the top of a fence that starts the document makes a paragraph to land in", () => {
    const editor = mounted(fence("ts", "const x = 1;"));
    const before = written(editor);

    atEdge(editor, true, () => {
      editor.commands.setTextSelection(startOf(editor));
      expect(press(editor, "ArrowUp")).toBe(true);

      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
      expect(editor.state.selection.$from.parent).toBe(editor.state.doc.firstChild);
      expect(written(editor)).toBe(before);
    });

    editor.destroy();
  });

  // The gesture from the bug report, which is the same fence with nothing typed into it yet.
  it("gives the caret back out of an empty fence, which is what the toolbar makes", () => {
    const editor = mounted(fence(""));
    expect(codeBlocks(editor.state.doc)).toHaveLength(1);

    atEdge(editor, true, () => {
      editor.commands.setTextSelection(startOf(editor));
      expect(press(editor, "ArrowDown")).toBe(true);
      expect(editor.state.selection.$from.parent).toBe(editor.state.doc.lastChild);
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    });

    editor.destroy();
  });

  it("leaves the key alone when there is a block on that side already", () => {
    const editor = mounted(["Over.", "", fence("ts", "const x = 1;"), "Under.", ""].join("\n"));
    const before = editor.state.doc.toJSON();

    atEdge(editor, true, () => {
      editor.commands.setTextSelection(endOf(editor));
      expect(press(editor, "ArrowDown")).toBe(false);

      editor.commands.setTextSelection(startOf(editor));
      expect(press(editor, "ArrowUp")).toBe(false);
    });

    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  // A rule is not a block a caret can stand in, and prosemirror-view answers this one by selecting
  // the node. Declining is what leaves it able to: the walk in `press` reaches this lane first, and
  // a paragraph made here would be a paragraph in the file between the fence and the rule.
  it("leaves a fence with a rule under it to the library that selects one", () => {
    const editor = mounted([fence("ts", "const x = 1;"), "---", ""].join("\n"));
    const before = editor.state.doc.toJSON();

    atEdge(editor, true, () => {
      editor.commands.setTextSelection(endOf(editor));
      expect(press(editor, "ArrowDown")).toBe(false);
    });

    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it("leaves a middle line of the fence to the browser", () => {
    const editor = mounted(fence("ts", "const x = 1;", "const y = 2;", "const z = 3;"));
    const before = editor.state.doc.toJSON();

    atEdge(editor, false, () => {
      const at = startOf(editor) + "const x = 1;".length;
      editor.commands.setTextSelection(at);
      expect(press(editor, "ArrowDown")).toBe(false);
      expect(press(editor, "ArrowUp")).toBe(false);
      expect(editor.state.selection.from).toBe(at);
    });

    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it("does not answer for a selection with two ends", () => {
    const editor = mounted(fence("ts", "const x = 1;"));
    const before = editor.state.doc.toJSON();

    atEdge(editor, true, () => {
      editor.commands.setTextSelection({ from: startOf(editor), to: endOf(editor) });
      expect(press(editor, "ArrowDown")).toBe(false);
      expect(press(editor, "ArrowUp")).toBe(false);
    });

    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it("does nothing anywhere but in a fence", () => {
    const editor = mounted(["The only paragraph.", ""].join("\n"));
    const before = editor.state.doc.toJSON();

    atEdge(editor, true, () => {
      editor.commands.setTextSelection(1);
      expect(press(editor, "ArrowDown")).toBe(false);
      expect(press(editor, "ArrowUp")).toBe(false);
    });

    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });
});
