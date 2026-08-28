// A .txt file. Not markdown, so nothing here parses any: a line reading "# heading" is that
// literal text on screen and those literal bytes on disk, and the only thing between the two is a
// textarea.
//
// The document shape mirrors the bridge's `parsePlainText` exactly, one line to one paragraph,
// which is what makes splitting and joining on the newline exact inverses and the round trip byte
// identical down to a missing final newline.
//
// Find has no ProseMirror decorations to draw here, since a textarea has no tree to decorate. What
// it has is a native selection, which is the one highlight a textarea can show, so a match is
// found by selecting it and scrolling it into view rather than by painting a span around it. The
// state that search.ts keeps in a plugin lives in a ref instead, published through the same
// `DocumentFind` shape src/editor/index.ts declares for the markdown surface, so FindBar.tsx never
// has to know which editor it is talking to.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import {
  EMPTY_PLAIN_SEARCH,
  recomputePlainSearch,
  replaceAllMatches,
  replaceMatch,
  sameQuery,
  type PlainSearchState,
  type SearchMatch,
} from "./plainFind";
import type { DocumentFind, PlainTextProps } from "./index";

function textOf(doc: ProseMirrorNode): string {
  const lines: string[] = [];
  doc.forEach((block) => lines.push(block.textContent));
  return lines.join("\n");
}

function docOf(text: string): ProseMirrorNode {
  const lines = text.split("\n");
  const blocks = lines.map((line) =>
    schema.nodes.paragraph.create(null, line ? schema.text(line) : null),
  );
  return schema.nodes.doc.create(null, blocks);
}

/** The properties a mirror div needs to copy for its line wrapping, and so the vertical position
 * it measures, to match the textarea's own. Only what wrapping and line height depend on: nothing
 * about colour or the caret. */
function copyWrappingStyle(mirror: HTMLDivElement, field: HTMLTextAreaElement): void {
  const style = getComputedStyle(field);
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.width = `${field.clientWidth}px`;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.fontStyle = style.fontStyle;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.textTransform = style.textTransform;
  mirror.style.wordSpacing = style.wordSpacing;
  mirror.style.tabSize = style.tabSize;
  mirror.style.whiteSpace = style.whiteSpace;
  mirror.style.wordBreak = style.wordBreak;
  mirror.style.overflowWrap = style.overflowWrap;
}

/** Where a character offset lands inside the textarea's own box, found the only way a plain
 * textarea allows: rendering the same text in an invisible twin under the same font and width and
 * reading back where a marker after it fell. There is no scroll of its own to subtract, since the
 * field is always exactly as tall as its text (see the layout effect below). */
function caretOffset(field: HTMLTextAreaElement, index: number): { top: number; height: number } {
  const mirror = window.document.createElement("div");
  copyWrappingStyle(mirror, field);
  mirror.textContent = field.value.slice(0, index);
  const marker = window.document.createElement("span");
  marker.textContent = field.value.slice(index, index + 1) || ".";
  mirror.appendChild(marker);
  window.document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const height = marker.offsetHeight;
  window.document.body.removeChild(mirror);
  return { top, height };
}

function scrollerOf(field: HTMLTextAreaElement): HTMLElement | null {
  for (let node = field.parentElement; node; node = node.parentElement) {
    if (node.classList.contains("editor-pane")) return node;
  }
  return null;
}

/** The textarea has no scrollbar of its own, so bringing a match into view means scrolling the
 * pane around it instead, the same "roughly centred" placement search.ts asks the pane for. */
function scrollMatchIntoView(field: HTMLTextAreaElement, match: SearchMatch): void {
  const pane = scrollerOf(field);
  if (!pane) return;
  const { top, height } = caretOffset(field, match.from);
  const fieldTop = field.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  const target = fieldTop + top - pane.clientHeight / 2 + height / 2;
  pane.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

const findListeners = new Set<() => void>();
let currentPlainFind: DocumentFind | null = null;

function subscribePlainFind(listener: () => void): () => void {
  findListeners.add(listener);
  return () => {
    findListeners.delete(listener);
  };
}

function announcePlainFind(): void {
  for (const listener of findListeners) listener();
}

const plainFindSnapshot = () => currentPlainFind;

/**
 * Find and replace for the .txt surface, published the same way Editor.tsx publishes the markdown
 * one, so src/editor/index.ts can hand `useDocumentFind` whichever of the two is actually on
 * screen without either side knowing the other exists.
 */
export function usePlainTextFind(): DocumentFind | null {
  return useSyncExternalStore(subscribePlainFind, plainFindSnapshot, plainFindSnapshot);
}

export function PlainTextEditor({
  document,
  onChange,
  editable = true,
}: PlainTextProps): ReactElement {
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => textOf(document.doc));
  const source = useRef(document);
  const textRef = useRef(text);
  textRef.current = text;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const search = useRef<PlainSearchState>(EMPTY_PLAIN_SEARCH);
  const publishRef = useRef<() => void>(() => {});

  // Set when the open file is replaced by a newer read of itself, which is what an external edit
  // to a clean buffer looks like from here. Editor.tsx stashes and restores the ProseMirror
  // selection across the same event; a textarea has no selection of its own to survive a value
  // change, so it has to be carried by hand or the caret lands at the end of the file.
  const carry = useRef<{ start: number; end: number } | null>(null);

  if (source.current !== document) {
    const reload = source.current.path === document.path;
    const el = field.current;
    carry.current = reload && el ? { start: el.selectionStart, end: el.selectionEnd } : null;
    source.current = document;
    const next = textOf(document.doc);
    setText(next);
    textRef.current = next;
    // A new file has nothing to do with whatever was being searched for in the last one, and its
    // matches would point at the wrong offsets anyway. A reload of the same file is the same
    // story: the offsets are against text that has just been replaced.
    search.current = EMPTY_PLAIN_SEARCH;
  }

  const methods = useRef<Omit<DocumentFind, "state"> | null>(null);

  // Only a new object when the count or the position in it actually moved, the same guard
  // Editor.tsx's own `push` keeps: FindBar re-issues `setQuery`/`clear` on every render it is open
  // for, and a new object on every one of those, whether anything changed or not, is what a
  // `useSyncExternalStore` subscriber reads as new state to render, which is what that repeated
  // call turns into an infinite loop rather than the no-op it is meant to be.
  const publish = () => {
    const count = search.current.matches.length;
    const current = search.current.current;
    if (!currentPlainFind || currentPlainFind.state.count !== count || currentPlainFind.state.current !== current) {
      currentPlainFind = { state: { count, current }, ...methods.current! };
    }
    announcePlainFind();
  };
  publishRef.current = publish;

  if (!methods.current) {
    // Collapses whatever is selected without moving the caret: the closest a textarea has to
    // "no decoration", for the moment a query stops matching anything or find closes altogether.
    const deselect = () => {
      const el = field.current;
      if (!el) return;
      el.setSelectionRange(el.selectionStart, el.selectionStart);
    };

    const land = (next: PlainSearchState) => {
      search.current = next;
      const match = next.matches[next.current];
      if (match) {
        const el = field.current;
        if (el) {
          el.setSelectionRange(match.from, match.to);
          scrollMatchIntoView(el, match);
        }
      } else {
        deselect();
      }
      publishRef.current();
    };

    methods.current = {
      setQuery: (query, options) => {
        if (sameQuery(search.current, query, options)) return;
        land(recomputePlainSearch(textRef.current, query, options, 0));
      },
      clear: () => {
        search.current = EMPTY_PLAIN_SEARCH;
        deselect();
        publishRef.current();
      },
      next: () => {
        const s = search.current;
        if (!s.matches.length) return;
        land({ ...s, current: (s.current + 1) % s.matches.length });
      },
      prev: () => {
        const s = search.current;
        if (!s.matches.length) return;
        land({ ...s, current: (s.current - 1 + s.matches.length) % s.matches.length });
      },
      replaceCurrent: (replacement) => {
        const s = search.current;
        if (!s.matches.length) return;
        const match = s.matches[s.current];
        const nextText = replaceMatch(textRef.current, match, replacement);
        textRef.current = nextText;
        setText(nextText);
        onChangeRef.current(docOf(nextText));
        land(recomputePlainSearch(nextText, s.query, s.options, s.current));
      },
      replaceAll: (replacement) => {
        const s = search.current;
        if (!s.matches.length) return;
        const nextText = replaceAllMatches(textRef.current, s.matches, replacement);
        textRef.current = nextText;
        setText(nextText);
        onChangeRef.current(docOf(nextText));
        land(recomputePlainSearch(nextText, s.query, s.options, s.current));
      },
      focus: () => {
        field.current?.focus();
      },
    };
  }

  useEffect(() => {
    field.current?.focus();
  }, [document.path]);

  // Republished after every render that changed which document is open, which is what carries the
  // reset above (a new file means no active search) out to whatever is drawing the find bar. The
  // functions themselves close over refs and read them fresh on every call, so nothing here needs
  // rebuilding when only the text or the search changes, just the announcing of it.
  useLayoutEffect(() => {
    publishRef.current();
  }, [document]);

  // Unregistering is a real unmount only, not a document change: switching files keeps this
  // component and its handle in place, and only leaving the plain text surface entirely (the
  // document closes, or a markdown file replaces it) should hand `useDocumentFind` back to null.
  useEffect(() => {
    return () => {
      currentPlainFind = null;
      announcePlainFind();
    };
  }, []);

  // The pane is the scroller for every other document, and a textarea with its own scrollbar
  // inside that pane would be two of them, one of which puts the last line under the chrome with
  // no way to scroll it clear. So the field is always exactly as tall as its text.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;

    // Clamped, because the edit that arrived from outside may well be shorter than what was on
    // screen. Landing at the end of a file that shrank under you is the same complaint as landing
    // at the end of one that grew.
    const want = carry.current;
    carry.current = null;
    if (!want) return;
    const end = Math.min(want.end, el.value.length);
    el.setSelectionRange(Math.min(want.start, end), end);
  }, [text]);

  return (
    <textarea
      ref={field}
      className="plain-text"
      value={text}
      readOnly={!editable}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        textRef.current = next;
        onChange(docOf(next));
        // A search still running when the text under it changes stays running, against the new
        // text, the same way search.ts recomputes on every transaction that changes the document.
        if (search.current.query) {
          search.current = recomputePlainSearch(
            next,
            search.current.query,
            search.current.options,
            search.current.current,
          );
          publishRef.current();
        }
      }}
    />
  );
}
