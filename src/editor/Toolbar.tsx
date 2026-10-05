// The app's only formatting surface: a sticky glass pill at the bottom of the editor pane. There
// is no slash menu and there are no drag handles, by product decision, so every control a document
// can be shaped with lives here.
//
// This component drives itself off `useEditorHandle()`, the declared surface in `./index`, and
// nothing else about the editor: no TipTap instance, no ProseMirror import, no reach into
// extensions.ts. Save state does not come from a store here on purpose: what the pill has to show
// is a conflict, and a conflict is `useDocument`'s `externalChange` rather than its `savePhase`,
// so reading one field would report the wrong thing half the time. `saveState` and `document`
// arrive as props instead, the same way `editor` arrived as a prop in the margin version this is
// ported from, and src/App.tsx is the one place the two fields are folded into one answer.
//
// Ported from ../../../margin/src/editor/FloatingToolbar.tsx: the tool() helper, the onMouseDown
// preventDefault on every button (without it, a click steals the selection before the command that
// reads it runs), the .tool-wrap plus conditional backdrop plus popover idiom, and a
// useEscapeLayer per popover so Escape unwinds them in order. The forceUpdate-on-"transaction"
// subscription from that version is not ported: `useEditorHandle()` is a hook that itself returns
// a new `active` object on every relevant change, per its own doc comment, so calling it is the
// replacement for that subscription, not an addition to it.
//
// M2 brought four block families and one hard constraint: the pill is one row and it has to fit
// the app's 880px minimum window beside a 248px sidebar, which leaves 632px of pane. Three tools
// are added, which is what M1 left room for, and everything else expands out of one of them: the
// table tool's popover is a size picker outside a table and the twelve table ops inside one, the
// callout tool's is the five kinds, the insert tool's is math and mermaid, and the language for a
// fence hangs off the code block tool that was already there, since a control the cursor has to be
// inside a fence to want is a control the pill cannot afford to carry permanently.
//
// The toggle tool is the one added since, and it is a plain button rather than a fourth popover for
// the reason the quote button is: everything a toggle needs beyond existing, its summary and
// whether it is open, is edited on the block itself. It does cost the row its last 32px at the
// minimum window, where the pill was already 4px over and living on the tightened separators in
// toolbar.css.
//
// Colour is the newest and it sits with the four inline marks, because that is what it is. It is a
// popover rather than two tools because there are two rows of it and the pill has room for one
// button, and it carries no chord: Google Docs has none for colour either, and a chord here is a
// row in the matrix src/editor/fits.test.ts builds over every hostile context in the editor.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { useEscapeLayer } from "../escape";
import { PRIMARY_LABEL, keyLabel, keysFor } from "../keys/bindings";
import { onCommand } from "../keys/commands";
import { assetWrite } from "../api/files";
import { notify } from "../store/useToast";
import { CALLOUT_KINDS, type MarkdownDocument } from "../model/doc";
import { HIGHLIGHT_COLORS, TEXT_COLORS } from "../model/colors";
import { HEADING_LEVELS } from "../model/schema";
import { useEditorHandle, type EditorActiveState, type TableOp } from "./index";

// An empty paragraph in an ordinary document, which is what the pill draws before there is an
// editor to ask. The four permissions say yes for the same reason the block says paragraph: this is
// the shape of a document with nothing in the way, and nothing is on screen to press anyway, since
// no editor is the first thing `disabled` is true for.
const DEFAULT_ACTIVE: EditorActiveState = {
  marks: [],
  block: "paragraph",
  headingLevel: null,
  callout: null,
  inTable: false,
  codeLanguage: null,
  canMark: true,
  canPlace: true,
  canPlaceInline: true,
  canConvert: true,
};

/** The size picker's ceiling. Anything bigger is a table nobody builds from a grid of squares. */
const PICKER_ROWS = 6;
const PICKER_COLUMNS = 8;

/**
 * The languages worth one click. Deliberately short and deliberately not the highlighter's list:
 * an info string is free text, so the input beside these takes anything, and a fence the file
 * already carried keeps whatever it says whether it appears here or not.
 */
const LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "json",
  "yaml",
  "bash",
  "sql",
  "html",
  "css",
  "markdown",
  "mermaid",
];

export type ToolbarSaveState = "idle" | "saving" | "conflict";

export interface ToolbarProps {
  /** The open document, needed only for the path a pasted image is written beside. Asset writes
   * are disabled while this is null. */
  document: MarkdownDocument | null;
  /** Idle shows nothing on the right of the pill, saving shows a quiet pulse, conflict shows a
   * small clickable warning. Defaults to idle so the pill renders sensibly before whoever owns the
   * document store has a real phase to report. */
  saveState?: ToolbarSaveState;
  /** Only read while saveState is "conflict". */
  onResolveConflict?: () => void;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^(https?:\/\/|mailto:|tel:|#|\/)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * A fence's info string is a language and then `meta`, the user's own text after it, which this
 * editor has no model for and never invents. Anything typed past the first space would be written
 * into the fence and read back as meta, so the picker keeps the first word and leaves the rest of
 * the info string to whatever the file already said.
 */
function normalizeLanguage(value: string): string | null {
  const first = value.trim().split(/\s+/)[0] ?? "";
  return first || null;
}

/** Capitalised for a menu. The label on disk is upper case and belongs to the serializer. */
function calloutLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * A chord in the glyphs the shortcuts sheet prints, from the form TipTap's keymap writes it in.
 *
 * The pill is the only place most of these are named. src/keys/bindings.ts holds the app's own
 * chords and there is a sheet listing them, but the formatting chords are not in that table: they
 * live in src/editor/shortcuts.ts as a TipTap keymap, because the editor rather than the window is
 * what has to receive them. So the two surfaces cannot share a function, and this one exists to
 * make sure they still share an answer: same glyphs, same order, and the primary modifier read off
 * the same place rather than spelled with a literal command sign in an app that also builds for a
 * browser.
 *
 * `keyLabel` is the one it cannot be. That function reads the house combo form, where Shift is
 * carried by an upper case letter rather than named, and four of the chords here are Shift over a
 * digit, which has no upper case to carry it.
 */
function chordLabel(chord: string): string {
  const parts = chord.split("-");
  const key = parts.pop() ?? "";
  const mods =
    (parts.includes("Mod") ? PRIMARY_LABEL : "") +
    (parts.includes("Alt") ? "⌥" : "") +
    (parts.includes("Shift") ? "⇧" : "");
  return `${mods}${key.toUpperCase()}`;
}

/** Link's chord is the one the pill shares with the rest of the app, so it is read rather than written. */
const LINK_CHORD = keysFor("insert-link").map(keyLabel)[0];

/**
 * Whether the caret is in a toggle's title, which is chrome rather than content.
 *
 * The title is a node view's own editable island, so ProseMirror's selection stays wherever it was
 * in the document the whole time somebody is typing in there. src/editor/blocks/toggle.ts refuses
 * every document-changing transaction while that is true, because otherwise a button pressed here
 * edits a paragraph the user is not looking at. That refusal is the safety net; this is the half
 * that has to agree with it, since a tool that draws itself live and then does nothing is the pill
 * lying about what it can do.
 *
 * Asked of the page rather than of a subscription, because clicking into a title dispatches no
 * transaction and there is nothing in the editor's own state to watch. Focus events bubble, so one
 * pair on the window covers every toggle on screen and every one added later.
 */
function useCaretInToggleTitle(): boolean {
  const [inTitle, setInTitle] = useState(false);

  useEffect(() => {
    const read = () => {
      const active = window.document.activeElement;
      setInTitle(active instanceof Element && active.closest("[data-toggle-summary]") !== null);
    };
    read();
    window.addEventListener("focusin", read);
    window.addEventListener("focusout", read);
    return () => {
      window.removeEventListener("focusin", read);
      window.removeEventListener("focusout", read);
    };
  }, []);

  return inTitle;
}

/**
 * `label` is the action, `chord` is what it answers to on the keyboard, and the two are held apart
 * on the button.
 *
 * The tooltip is data-tip and src/styles/toolbar.css draws it, because a native title in a macOS
 * webview is a second of waiting and then system chrome in a font that belongs to no theme this app
 * has. What a title still did well was carry the button's accessible name, since every tool here is
 * a glyph with no text in it, so that job moves to aria-label rather than being lost. Only one of
 * the two attributes says the chord: a screen reader announcing "Bold ⌘B" is reading a picture of a
 * key out loud, and the chord is drawn for the eye that is already on the button.
 */
function tool(
  active: boolean,
  onClick: () => void,
  label: string,
  content: ReactNode,
  disabled = false,
  chord?: string,
): ReactElement {
  return (
    <button
      className="tool"
      data-on={active}
      data-tip={chord ? `${label} (${chord})` : label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

const BOLD_D = "M7 5v14M7 5h5.5a3.5 3.5 0 0 1 0 7H7M7 12h6a3.5 3.5 0 0 1 0 7H7";
const ITALIC_D = "M10 5h6M6 19h6M13 5l-4 14";
const STRIKETHROUGH_D =
  "M5 12h14M8 7.5c0-1.5 1.6-2.5 4-2.5s4 1 4 2.5M8 16.5c0 1.5 1.6 2.5 4 2.5s4-1 4-2.5";
const CODE_D = "M9 6l-5 6 5 6M15 6l5 6-5 6";
// The H used to run from x=5 to x=13 in a 24 unit box, so it sat left of centre in a round button
// that every other glyph here is centred in.
const HEADING_D = "M7 5v14M7 12h10M17 5v14";
const BULLET_LIST_D = "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01";
const ORDERED_LIST_D =
  "M10 6h11M10 12h11M10 18h11M4 4v4M3 4h2M4 10.5h1.5a1 1 0 1 1 0 2H4h1.5a1 1 0 1 1 0 2H4M4 20.5l1.4-1.7a1 1 0 1 0-1.4-1.6";
const TASK_LIST_D = "M4 5h4v4H4zM5.5 7l1 1 2-2M4 15h4v4H4zM5 17l1 1 2-2M11 7h9M11 17h9M11 12h9";
const BLOCKQUOTE_D = "M7 8h4v4a4 4 0 0 1-4 4M14 8h4v4a4 4 0 0 1-4 4";
const TOGGLE_D = "M5 7l4 5-4 5M12 9h7M12 15h7";
const CODE_BLOCK_D = "M4 6h16v12H4zM7 10l3 2-3 2";
const LINK_D =
  "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1";
const REMOVE_D = "M18 6L6 18M6 6l12 12";
// The mark on the row a menu's current value is on. Nothing else in the pill draws one.
const CHECK_D = "M5 12.5l4.5 4.5L19 7";
const HR_D = "M5 12h5M14 12h5";
const IMAGE_D = "M4 5h16v14H4zM4 16l4.5-4.5 3 3L16 10l4 4";
const ALERT_D = "M12 3l10 18H2zM12 9v5M12 17h.01";
const CALLOUT_D = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v5M12 8h.01";
const TABLE_D = "M4 5h16v14H4zM4 10h16M10 10v9M15 10v9";
const INSERT_D = "M12 5v14M5 12h14";
// An A over a bar, which is what every editor draws for this and what people look for. The
// crossbar meets the strokes where they really are at that height rather than at a round number.
const COLOR_D = "M6 15l6-11 6 11M8.2 11h7.6M5 20h14";

export function Toolbar({ document, saveState = "idle", onResolveConflict }: ToolbarProps): ReactElement {
  const editor = useEditorHandle();
  const active = editor?.active ?? DEFAULT_ACTIVE;
  const inTitle = useCaretInToggleTitle();
  const disabled = !editor || saveState === "conflict" || inTitle;

  // And the four that are about where the caret is rather than about the document as a whole. Each
  // is `disabled` plus one of the editor's own answers, named here rather than inlined so that a
  // tool's line says which permission it needs and so that two tools needing the same one cannot
  // drift apart. src/editor/index.ts is where each answer comes from and why.
  //
  // The three tools with a second job when the caret is already inside what they make are the only
  // ones that read more than one field. The code block tool configures a fence from inside one and
  // the table tool edits a table from inside one, so neither is dark in the block it is dark for
  // making; the image tool asks the inline question, because a picture goes into a table cell that
  // refuses every block on the bar.
  const markDisabled = disabled || !active.canMark;
  const placeDisabled = disabled || !active.canPlace;
  const inlineDisabled = disabled || !active.canPlaceInline;
  const convertDisabled = disabled || !active.canConvert;

  const [headingOpen, setHeadingOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [calloutOpen, setCalloutOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [languageValue, setLanguageValue] = useState("");
  // What the size grid is hovering over, which is the picker's whole state: nothing is inserted
  // until a square is clicked.
  const [size, setSize] = useState<{ rows: number; columns: number } | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const languageInputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Every popover in the pill is mutually exclusive already, since each one lays a fixed backdrop
  // over the other tools, so opening one closes the rest rather than letting a second live menu
  // exist behind an invisible sheet.
  const closePopovers = () => {
    setHeadingOpen(false);
    setColorOpen(false);
    setLinkOpen(false);
    setCalloutOpen(false);
    setTableOpen(false);
    setInsertOpen(false);
    setLanguageOpen(false);
  };

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus();
  }, [linkOpen]);

  useEffect(() => {
    if (languageOpen) languageInputRef.current?.focus();
  }, [languageOpen]);

  // The backdrop cannot be the whole click-away story here the way it is for the titlebar's menu.
  // .editor-toolbar carries a backdrop-filter, and that makes it the containing block for a fixed
  // position child, so `inset: 0` on the backdrop resolves to the pill and not to the window: it
  // covers the other tools, which is what makes a second press of the open one close it, and
  // nothing else. A click in the document went behind it and left the menu standing, which was
  // survivable with two small popovers and is not with six. Nothing is prevented, so the click
  // still lands where it was aimed.
  useEffect(() => {
    if (!(headingOpen || colorOpen || linkOpen || calloutOpen || tableOpen || insertOpen || languageOpen)) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(".editor-toolbar")) return;
      closePopovers();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingOpen, colorOpen, linkOpen, calloutOpen, tableOpen, insertOpen, languageOpen]);

  // A conflict disables every tool, and a popover left open over a disabled pill would still have
  // live items in it. The file on disk has already moved by then, so nothing here gets to write to
  // the buffer until the user has said which copy wins. Only the seven setState functions are read,
  // and those are stable, so the closure this captures is never the stale one.
  useEffect(() => {
    if (disabled) closePopovers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  // And a menu left standing over a tool that has just gone dark, which is the same thing one tool
  // at a time. The caret can move under an open popover without a pointer going anywhere near it,
  // since every button in the pill prevents the press that would take focus out of the document, so
  // an arrow key with the Insert menu up walks into a table cell that refuses everything in it. Any
  // of the four permissions moving at all means the caret is somewhere materially different from
  // where the menu was opened, and a menu about the block somebody has left is not one to leave up.
  useEffect(() => {
    closePopovers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.canMark, active.canPlace, active.canPlaceInline, active.canConvert]);

  useEscapeLayer(linkOpen, () => {
    setLinkOpen(false);
    editor?.focus();
  });
  useEscapeLayer(headingOpen, () => setHeadingOpen(false));
  useEscapeLayer(colorOpen, () => setColorOpen(false));
  useEscapeLayer(calloutOpen, () => setCalloutOpen(false));
  useEscapeLayer(tableOpen, () => setTableOpen(false));
  useEscapeLayer(insertOpen, () => setInsertOpen(false));
  useEscapeLayer(languageOpen, () => {
    setLanguageOpen(false);
    editor?.focus();
  });

  // One gesture, one colour, and the menu closes: a swatch is a choice rather than a knob, which is
  // how the heading and callout items behave and not how the table ops do.
  const applyColor = (which: "setTextColor" | "setHighlight", color: string | null) => {
    if (which === "setTextColor") editor?.setTextColor(color);
    else editor?.setHighlight(color);
    setColorOpen(false);
    editor?.focus();
  };

  const applyLink = () => {
    if (!editor) return;
    const href = normalizeUrl(linkValue);
    editor.setLink(href || null);
    setLinkOpen(false);
    editor.focus();
  };

  const removeLink = () => {
    if (!editor) return;
    editor.setLink(null);
    setLinkOpen(false);
    editor.focus();
  };

  const openLink = () => {
    const wasOpen = linkOpen;
    closePopovers();
    if (wasOpen) return;
    setLinkValue("");
    setLinkOpen(true);
  };

  // Cmd+K arrives here as a command rather than as a key: src/keys/bindings.ts owns the chord in
  // the document context and this is a panel subscribing to its own command, the way quick open
  // and the shortcuts sheet do. Nothing in this file listens for a keystroke any more, and that is
  // the whole gain: the keymap already knows whether an overlay has the keyboard, that a chord may
  // fire with the caret in an input, and that one chord belongs to exactly one thing, none of
  // which a window listener reading `defaultPrevented` can know.
  //
  // Not subscribed while the pill is disabled, so a save conflict or a caret in a toggle title
  // leaves the chord as inert as the greyed tool beside it. `linkOpen` is a dependency because the
  // handler toggles on it, and resubscribing is what keeps that closure honest.
  useEffect(() => {
    if (disabled) return;
    return onCommand("insert-link", openLink);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, linkOpen]);

  // The code block tool converts into a fence from outside one and configures the fence from
  // inside it. Turning one back into a paragraph moves into the foot of that popover rather than
  // staying on a second press of the tool, because the pill has no room for a language control of
  // its own and the tool for the block you are in is where you would look for one anyway.
  const onCodeBlock = () => {
    if (active.block !== "codeBlock") {
      closePopovers();
      editor?.setBlock("codeBlock");
      return;
    }
    const wasOpen = languageOpen;
    closePopovers();
    if (wasOpen) return;
    setLanguageValue(active.codeLanguage ?? "");
    setLanguageOpen(true);
  };

  const setLanguage = (language: string | null) => {
    if (!editor) return;
    editor.setCodeLanguage(language);
    setLanguageOpen(false);
    editor.focus();
  };

  // Row and column ops leave the popover up: adding three rows is three clicks in the same place,
  // and the command has already put the cursor back in the table by the time the next one runs.
  const runTable = (op: TableOp) => {
    editor?.tableCommand(op);
  };

  const onImageChosen = async (file: File) => {
    if (!editor || !document) return;
    // Asked before the bytes go anywhere. The picture has to be on disk before there is a path to
    // put in the document, so a cursor in a table cell or a fenced block, where the insert is
    // refused, would otherwise leave a file in the user's assets folder that nothing refers to.
    if (!editor.canInsertImage()) {
      notify("An image cannot go where the cursor is.");
      return;
    }
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await assetWrite(document.path, bytes, file.name || "image.png");
      const alt = file.name.replace(/\.[^./]+$/, "") || null;
      editor.insertImage(result.relPath, alt);
      editor.focus();
    } catch (e) {
      notify(String(e));
    }
  };

  return (
    <div className="editor-toolbar">
      {tool(
        active.marks.includes("strong"),
        () => editor?.toggleMark("strong"),
        "Bold",
        <Icon d={BOLD_D} />,
        markDisabled,
        chordLabel("Mod-b"),
      )}
      {tool(
        active.marks.includes("em"),
        () => editor?.toggleMark("em"),
        "Italic",
        <Icon d={ITALIC_D} />,
        markDisabled,
        chordLabel("Mod-i"),
      )}
      {tool(
        active.marks.includes("strikethrough"),
        () => editor?.toggleMark("strikethrough"),
        "Strikethrough",
        <Icon d={STRIKETHROUGH_D} />,
        markDisabled,
        chordLabel("Mod-Shift-x"),
      )}
      {tool(
        active.marks.includes("code"),
        () => editor?.toggleMark("code"),
        "Inline code",
        <Icon d={CODE_D} />,
        markDisabled,
        chordLabel("Mod-e"),
      )}
      {/* Beside the other four inline marks, since that is what it is, and with no chord: Google
          Docs has none for colour either, and the pill's chords are enumerated by
          src/editor/fits.test.ts rather than listed, so one added here would be one more thing to
          prove about every hostile context for a control nobody reaches for from the keyboard. */}
      <span className="tool-wrap">
        {tool(
          colorOpen || active.marks.includes("textColor") || active.marks.includes("highlight"),
          () => {
            const wasOpen = colorOpen;
            closePopovers();
            if (!wasOpen) setColorOpen(true);
          },
          "Colour",
          <Icon d={COLOR_D} />,
          markDisabled,
        )}
        {colorOpen && (
          <>
            <div className="link-pop-backdrop" onMouseDown={() => setColorOpen(false)} />
            <div className="color-pop" onMouseDown={(e) => e.stopPropagation()}>
              {/* No pressed swatch on either row. `active.marks` carries mark names and not their
                  attributes, so the pill can say that the caret is in a colour and cannot say
                  which one; drawing the wrong swatch pressed would be worse than drawing none. */}
              <span className="pop-label">Text</span>
              <div className="swatch-row">
                {TEXT_COLORS.map((color) => (
                  <button
                    key={color.hex}
                    className="swatch"
                    // The one place in the app a colour is not a token: it is the document's, out of
                    // src/model/colors.ts, and it is what the swatch is for.
                    style={{ background: color.hex }}
                    title={color.label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyColor("setTextColor", color.hex)}
                  />
                ))}
                <button
                  className="swatch-none"
                  title="No text colour"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyColor("setTextColor", null)}
                >
                  <Icon d={REMOVE_D} size={12} />
                </button>
              </div>
              <span className="pop-label">Highlight</span>
              <div className="swatch-row">
                {HIGHLIGHT_COLORS.map((color) => (
                  <button
                    key={color.hex}
                    className="swatch"
                    style={{ background: color.hex }}
                    title={color.label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyColor("setHighlight", color.hex)}
                  />
                ))}
                <button
                  className="swatch-none"
                  title="No highlight"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyColor("setHighlight", null)}
                >
                  <Icon d={REMOVE_D} size={12} />
                </button>
              </div>
            </div>
          </>
        )}
      </span>
      <span className="tool-sep" />
      <span className="tool-wrap">
        {tool(
          headingOpen || active.block === "heading",
          () => {
            const wasOpen = headingOpen;
            closePopovers();
            if (!wasOpen) setHeadingOpen(true);
          },
          "Heading",
          <Icon d={HEADING_D} />,
          convertDisabled,
        )}
        {headingOpen && (
          <>
            <div className="link-pop-backdrop" onMouseDown={() => setHeadingOpen(false)} />
            {/* The seven chords the pill has nowhere else to put. Mod-Alt-0 and Mod-Alt-1 through 6
                are bound in src/editor/shortcuts.ts and every one of them is a row in here, since
                the tool itself is a menu and has no single key of its own to name in a tooltip. */}
            <div className="heading-pop" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className="pop-item"
                data-on={active.block === "paragraph"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor?.setHeading(null);
                  setHeadingOpen(false);
                  editor?.focus();
                }}
              >
                Paragraph
                <span className="pop-chord">{chordLabel("Mod-Alt-0")}</span>
                <Icon d={CHECK_D} size={14} />
              </button>
              {HEADING_LEVELS.map((level) => (
                <button
                  key={level}
                  className="pop-item"
                  data-on={active.block === "heading" && active.headingLevel === level}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor?.setHeading(level);
                    setHeadingOpen(false);
                    editor?.focus();
                  }}
                >
                  {`Heading ${level}`}
                  <span className="pop-chord">{chordLabel(`Mod-Alt-${level}`)}</span>
                  <Icon d={CHECK_D} size={14} />
                </button>
              ))}
            </div>
          </>
        )}
      </span>
      <span className="tool-sep" />
      {tool(
        active.block === "bulletList",
        () => editor?.setBlock("bulletList"),
        "Bulleted list",
        <Icon d={BULLET_LIST_D} />,
        convertDisabled,
        chordLabel("Mod-Shift-8"),
      )}
      {tool(
        active.block === "orderedList",
        () => editor?.setBlock("orderedList"),
        "Numbered list",
        <Icon d={ORDERED_LIST_D} />,
        convertDisabled,
        chordLabel("Mod-Shift-7"),
      )}
      {tool(
        active.block === "taskList",
        () => editor?.setBlock("taskList"),
        "Task list",
        <Icon d={TASK_LIST_D} />,
        convertDisabled,
        chordLabel("Mod-Shift-9"),
      )}
      {tool(
        active.block === "blockquote",
        () => editor?.setBlock("blockquote"),
        "Quote",
        <Icon d={BLOCKQUOTE_D} />,
        convertDisabled,
        chordLabel("Mod-Shift-b"),
      )}
      {/* The third of the three wrapping commands, beside the two it behaves like: one press puts
          the block inside a <details>, a second takes it back out. The summary is typed into the
          toggle itself rather than asked for here, because it is the one part of a block in this
          pill that is a piece of the document and not a setting. */}
      {tool(active.block === "toggle", () => editor?.setBlock("toggle"), "Toggle", <Icon d={TOGGLE_D} />, convertDisabled)}
      <span className="tool-wrap">
        {tool(
          calloutOpen || active.block === "callout",
          () => {
            const wasOpen = calloutOpen;
            closePopovers();
            if (!wasOpen) setCalloutOpen(true);
          },
          "Callout",
          <Icon d={CALLOUT_D} />,
          convertDisabled,
        )}
        {calloutOpen && (
          <>
            <div className="link-pop-backdrop" onMouseDown={() => setCalloutOpen(false)} />
            <div className="callout-pop" onMouseDown={(e) => e.stopPropagation()}>
              {CALLOUT_KINDS.map((kind) => (
                <button
                  key={kind}
                  className="pop-item"
                  data-on={active.callout === kind}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor?.setCallout(kind);
                    setCalloutOpen(false);
                    editor?.focus();
                  }}
                >
                  {calloutLabel(kind)}
                  <Icon d={CHECK_D} size={14} />
                </button>
              ))}
              {/* Under a rule, because it is not a sixth kind. The five above choose what the
                  callout is and this one says it should stop being one, which is the same shape of
                  row the language menu's own last item is, and the rule is what stops it reading as
                  another thing to pick. Separators inside a popover only: the pill's own row is
                  fixed. */}
              {active.block === "callout" && (
                <>
                  <div className="menu-sep" />
                  <button
                    className="pop-item"
                    title="Leave the blockquote it is on disk, without the marker"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      editor?.setCallout(null);
                      setCalloutOpen(false);
                      editor?.focus();
                    }}
                  >
                    Plain quote
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </span>
      <span className="tool-wrap">
        {tool(
          languageOpen || active.block === "codeBlock",
          onCodeBlock,
          active.block === "codeBlock"
            ? `Code block: ${active.codeLanguage ?? "no language"}`
            : "Code block",
          <Icon d={CODE_BLOCK_D} />,
          active.block === "codeBlock" ? disabled : convertDisabled,
          chordLabel("Mod-Alt-c"),
        )}
        {languageOpen && (
          <>
            <div className="link-pop-backdrop" onMouseDown={() => setLanguageOpen(false)} />
            <div className="lang-pop" onMouseDown={(e) => e.stopPropagation()}>
              <div className="lang-row">
                <input
                  ref={languageInputRef}
                  className="link-input"
                  value={languageValue}
                  placeholder="Language"
                  spellCheck={false}
                  onChange={(e) => setLanguageValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setLanguage(normalizeLanguage(languageValue));
                    }
                  }}
                />
                <button
                  className="link-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setLanguage(normalizeLanguage(languageValue))}
                >
                  Apply
                </button>
                {active.codeLanguage !== null && (
                  <button
                    className="link-btn ghost"
                    title="Leave a bare fence"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setLanguage(null)}
                  >
                    <Icon d={REMOVE_D} size={14} />
                  </button>
                )}
              </div>
              <div className="lang-chips">
                {LANGUAGES.map((name) => (
                  <button
                    key={name}
                    className="lang-chip"
                    data-on={active.codeLanguage === name}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setLanguage(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              {/* Everything above sets the fence's language and this ends the fence, so it sits
                  under a rule rather than reading as one more chip in the cloud. */}
              <div className="menu-sep" />
              <button
                className="pop-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor?.setBlock("codeBlock");
                  setLanguageOpen(false);
                  editor?.focus();
                }}
              >
                Turn into a paragraph
              </button>
            </div>
          </>
        )}
      </span>
      <span className="tool-sep" />
      <span className="tool-wrap">
        {tool(active.marks.includes("link") || linkOpen, openLink, "Link", <Icon d={LINK_D} />, markDisabled, LINK_CHORD)}
        {linkOpen && (
          <>
            <div className="link-pop-backdrop" onMouseDown={() => setLinkOpen(false)} />
            <div className="link-pop" onMouseDown={(e) => e.stopPropagation()}>
              <input
                ref={linkInputRef}
                className="link-input"
                value={linkValue}
                placeholder="https://..."
                spellCheck={false}
                onChange={(e) => setLinkValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyLink();
                  }
                }}
              />
              <button className="link-btn" onMouseDown={(e) => e.preventDefault()} onClick={applyLink}>
                Apply
              </button>
              {active.marks.includes("link") && (
                <button
                  className="link-btn ghost"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={removeLink}
                  title="Remove link"
                >
                  <Icon d={REMOVE_D} size={14} />
                </button>
              )}
            </div>
          </>
        )}
      </span>
      <span className="tool-sep" />
      {tool(false, () => editor?.insertRule(), "Horizontal rule", <Icon d={HR_D} />, placeDisabled)}
      {tool(false, () => fileRef.current?.click(), "Insert image", <Icon d={IMAGE_D} />, inlineDisabled || !document)}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImageChosen(file);
          e.currentTarget.value = "";
        }}
      />
      <span className="tool-sep" />
      <span className="tool-wrap">
        {tool(
          tableOpen || active.inTable,
          () => {
            const wasOpen = tableOpen;
            closePopovers();
            if (wasOpen) return;
            setSize(null);
            setTableOpen(true);
          },
          active.inTable ? "Table" : "Insert table",
          <Icon d={TABLE_D} />,
          active.inTable ? disabled : placeDisabled,
        )}
        {tableOpen && (
          <>
            <div className="link-pop-backdrop" onMouseDown={() => setTableOpen(false)} />
            <div
              className="table-pop"
              data-mode={active.inTable ? "edit" : "insert"}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {active.inTable ? (
                <>
                  <span className="pop-label">Row</span>
                  <div className="pop-row">
                    <button
                      className="pop-btn"
                      title="Insert a row above this one"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("addRowBefore")}
                    >
                      Above
                    </button>
                    <button
                      className="pop-btn"
                      title="Insert a row below this one"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("addRowAfter")}
                    >
                      Below
                    </button>
                    <button
                      className="pop-btn danger"
                      title="Delete this row"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("deleteRow")}
                    >
                      Delete
                    </button>
                  </div>
                  <span className="pop-label">Column</span>
                  <div className="pop-row">
                    <button
                      className="pop-btn"
                      title="Insert a column to the left"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("addColumnBefore")}
                    >
                      Left
                    </button>
                    <button
                      className="pop-btn"
                      title="Insert a column to the right"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("addColumnAfter")}
                    >
                      Right
                    </button>
                    <button
                      className="pop-btn danger"
                      title="Delete this column"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("deleteColumn")}
                    >
                      Delete
                    </button>
                  </div>
                  {/* Markdown has no per cell alignment, so these set the whole column the cursor
                      is in, which is what the delimiter row on disk can say. */}
                  <span className="pop-label">Align column</span>
                  <div className="pop-row">
                    <button
                      className="pop-btn"
                      title="Align this column left"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("alignLeft")}
                    >
                      Left
                    </button>
                    <button
                      className="pop-btn"
                      title="Align this column centre"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("alignCenter")}
                    >
                      Centre
                    </button>
                    <button
                      className="pop-btn"
                      title="Align this column right"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("alignRight")}
                    >
                      Right
                    </button>
                    <button
                      className="pop-btn"
                      title="Leave this column unaligned"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runTable("alignClear")}
                    >
                      None
                    </button>
                  </div>
                  {/* No header row control. A GFM table has one header row, it is the first one,
                      and there is no spelling for a table without one, so the button would offer an
                      edit the file cannot hold. See TableOp in src/editor/index.ts. */}
                  <span className="pop-label">Table</span>
                  <button
                    className="pop-item danger"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      runTable("deleteTable");
                      setTableOpen(false);
                    }}
                  >
                    Delete table
                  </button>
                </>
              ) : (
                <>
                  <div className="size-grid" onMouseLeave={() => setSize(null)}>
                    {Array.from({ length: PICKER_ROWS * PICKER_COLUMNS }, (_, i) => {
                      const rows = Math.floor(i / PICKER_COLUMNS) + 1;
                      const columns = (i % PICKER_COLUMNS) + 1;
                      return (
                        <button
                          key={i}
                          className="size-cell"
                          data-on={size !== null && rows <= size.rows && columns <= size.columns}
                          title={`${rows} by ${columns} table`}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setSize({ rows, columns })}
                          onFocus={() => setSize({ rows, columns })}
                          onClick={() => {
                            editor?.insertTable(rows, columns);
                            setTableOpen(false);
                            editor?.focus();
                          }}
                        />
                      );
                    })}
                  </div>
                  <span className="size-label">
                    {size === null ? "Pick a size" : `${size.rows} x ${size.columns}`}
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </span>
      <span className="tool-wrap">
        {tool(
          insertOpen,
          () => {
            const wasOpen = insertOpen;
            closePopovers();
            if (!wasOpen) setInsertOpen(true);
          },
          "Insert",
          <Icon d={INSERT_D} />,
          placeDisabled,
        )}
        {insertOpen && (
          <>
            <div className="link-pop-backdrop" onMouseDown={() => setInsertOpen(false)} />
            <div className="insert-pop" onMouseDown={(e) => e.stopPropagation()}>
              {/* The other five popovers say what they are about, either in a heading like this one
                  or in the shape of what is in them, and this one was three sentences in a box. */}
              <span className="pop-label">Insert</span>
              <button
                className="pop-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor?.insertMath(false);
                  setInsertOpen(false);
                  editor?.focus();
                }}
              >
                Inline formula
              </button>
              <button
                className="pop-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor?.insertMath(true);
                  setInsertOpen(false);
                  editor?.focus();
                }}
              >
                Display formula
              </button>
              <button
                className="pop-item"
                title="A fenced block with mermaid as its language"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor?.insertMermaid();
                  setInsertOpen(false);
                  editor?.focus();
                }}
              >
                Mermaid diagram
              </button>
            </div>
          </>
        )}
      </span>
      <div className="toolbar-status" data-phase={saveState}>
        {saveState === "saving" && <span className="toolbar-status-dot" aria-hidden="true" />}
        {saveState === "conflict" && (
          <button
            className="toolbar-status-conflict"
            title="This file changed on disk. Click to resolve."
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onResolveConflict?.()}
          >
            <Icon d={ALERT_D} size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
