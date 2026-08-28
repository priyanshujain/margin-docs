// The "Linked from" section: the documents elsewhere on disk that point at the one on screen.
//
// Nothing here is content. A backlink exists because of bytes in somebody else's file, so it is
// never in the ProseMirror document, never serialized and never written; it is drawn after the last
// block and that is the whole of its existence. Which is why this is a sibling of the editor inside
// the sheet rather than a node at the end of it: it shares the paper and the measure with the
// document and shares nothing else, and a caret cannot land in a section that was never in the
// editable, nor can a select all inside the editor reach it.
//
// Silence is the default and it is the point. No section under a document nothing links to, and no
// section before the index has finished a pass, because "nothing links here" and "I have not looked
// yet" are different facts and only one of them has earned a heading.
//
// The open document and the index are read from their stores rather than passed in, so the mount in
// App.tsx is a bare tag. This component already has to watch the index to know whether its answer
// means anything, so it is subscribed either way, and a prop would only put half of what it needs
// through the shell while the other half went round it.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { backlinksFor } from "../api";
import type { Backlink } from "../ipc";
import { useDocument } from "../store/useDocument";
import { useIndex } from "../store/useIndex";
import { notify } from "../store/useToast";

interface Answer {
  /** The document these were asked for, kept with them so a slow reply about the file that was open
   *  a moment ago is never drawn under the file that is open now. */
  path: string;
  /** Null is "asked, and could not be told". It draws the same nothing an empty list does, and that
   *  is a decision rather than an accident: a writer cannot act on a failed index lookup, and a
   *  permanent error line under every document costs more attention than the feature is worth. The
   *  two are still not the same fact, so they are not the same value here, and this is the one place
   *  that could ever tell them apart. */
  links: Backlink[] | null;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * A snippet is the source line the link sits on, so the one construct every snippet is guaranteed
 * to contain is the link that made it a backlink, and an editor whose whole pitch is that markdown
 * syntax is never visible should not be the thing putting `](../thing.md)` on screen. The link is
 * unwrapped to its text and nothing else is: everything else a line might hold is not certain to be
 * there, and unwrapping it would be a second markdown reader living in a view.
 */
const readableSnippet = (snippet: string): string =>
  snippet.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").trim();

export function Backlinks() {
  const path = useDocument((s) => s.path);
  const open = useDocument((s) => s.open);
  const phase = useIndex((s) => s.phase);

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [active, setActive] = useState(0);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);

  // Two triggers, both of them in the dependencies: a different document to ask about, and a pass of
  // the index finishing. The second is what keeps the section true when somebody edits another file
  // and the watcher reindexes it, since `index-progress` lands in useIndex and comes out as a phase.
  //
  // Anything short of a completed pass is not asked at all, and mid-pass the previous answer is left
  // on screen: a reindex is not new information about this document, and blanking the section for
  // the duration would be a flicker that says something changed when nothing has.
  useEffect(() => {
    if (path === null || phase !== "ready") return;
    let cancelled = false;
    backlinksFor(path)
      .then((links) => {
        if (!cancelled) setAnswer({ path, links });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ path, links: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, phase]);

  // Matched against the open path at render rather than cleared in an effect, so switching documents
  // cannot paint one frame of the last one's links before the effect catches up.
  const links = answer !== null && answer.path === path ? answer.links : null;
  if (links === null || links.length === 0) return null;

  // Roving focus: the section is one stop in the tab order however many rows it has, and the arrows
  // move inside it. A row per tab stop would make tabbing out of a well linked document a chore
  // through chrome, and taking the rows out of the tab order entirely would leave them mouse only.
  const focused = active < links.length ? active : 0;

  const move = (delta: number) => {
    const next = Math.min(Math.max(focused + delta, 0), links.length - 1);
    setActive(next);
    rows.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  };

  const go = (target: string) => {
    open(target).catch((e) => notify(`Could not open ${baseName(target)}: ${String(e)}`));
  };

  return (
    <nav className="backlinks" aria-labelledby="backlinks-heading">
      {/* One document at a time and one of these, so a fixed id cannot collide with a second. */}
      <h2 className="nav-label" id="backlinks-heading">
        Linked from
      </h2>
      <ul className="backlinks-list" onKeyDown={onKeyDown}>
        {links.map((link, index) => (
          <li key={link.path}>
            <button
              className="backlinks-row"
              ref={(el) => {
                rows.current[index] = el;
              }}
              tabIndex={index === focused ? 0 : -1}
              // The title is a heading or a filename and two documents are allowed to share one, so
              // the path is what settles which of them this row is.
              title={link.path}
              onFocus={() => setActive(index)}
              onClick={() => go(link.path)}
            >
              {/* The index titles a document by its first heading and falls back to its filename,
                  so this only catches a row that would otherwise be a blank line to click. */}
              <span className="backlinks-title">{link.title || baseName(link.path)}</span>
              <span className="backlinks-snippet">{readableSnippet(link.snippet)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
