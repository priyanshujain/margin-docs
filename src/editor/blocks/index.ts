// The seam the block lanes plug into, and the only file that knows all five of them exist.
//
// extensions.ts generates one TipTap extension per entry in the frozen schema, which covers what a
// node IS. What a node DOES, its ProseMirror plugins, its node views, its keymap and its input
// rules, has no place on a mechanically generated extension, and five unrelated blocks sharing one
// file would mean five reasons to edit it and five chances to break somebody else's block while
// doing so. So each lane is one Extension in one file, listed here once. extensions.ts spreads this
// array without knowing what is in it, and nothing else imports the lane files.
//
// A lane may add plugins, node views, keyboard shortcuts and input rules. It may not add, remove or
// alter a node or a mark. The schema is src/model/schema.ts, the markdown bridge is written against
// it, and an editor whose schema has drifted from the contract is an editor that cannot hold a
// document the bridge just parsed, which is somebody's file lost on the next save.

import type { Extensions } from "@tiptap/core";
import { CodeHighlighting, setCodeLanguage } from "./code";
import { MathRendering, insertMath } from "./math";
import { MermaidRendering, insertMermaid } from "./mermaid";
import { Tables, tableCommand } from "./tables";
import { Toggles } from "./toggle";

/**
 * In precedence order, lowest first. TipTap reverses the extension list before it collects
 * ProseMirror plugins, so the last entry here contributes the first plugin the view asks, and for a
 * node view the first plugin asked is the one that gets the node. Mermaid is last because a mermaid
 * diagram is a codeBlock: it and the highlighter are looking at the same node type, and the diagram
 * is the more specific of the two.
 *
 * Position is the weaker of the two levers, and it is worth knowing which because the stronger one
 * is now in use. TipTap sorts the reversed list by each extension's `priority` before it collects
 * anything, so a higher priority beats any position in this array; every lane here leaves it at the
 * default and is ordered by position alone. src/editor/paste.ts is the one that does not, and it
 * says why: its handlers guard the document against every other plugin's, so being ahead of the
 * table plugins below cannot be left to where two arrays happen to put it.
 *
 * Toggles goes first rather than beside the lane it reads most like. The toggle node is claimed by
 * nobody else, so where it sits changes nothing about which plugin gets that node view, and the
 * four below it are in an order that was argued over: put anywhere else it would move one of them
 * and leave the sentence above no longer true of the array under it.
 */
export const BLOCK_EXTENSIONS: Extensions = [
  Toggles,
  Tables,
  MathRendering,
  CodeHighlighting,
  MermaidRendering,
];

/**
 * What the editor handle's block commands delegate to. Each returns false when it has nothing to
 * act on where the cursor is, which is what a toolbar button pressed in the wrong place should do,
 * and each is responsible for its own focus the way every other command in the handle is.
 */
export { insertMath, insertMermaid, setCodeLanguage, tableCommand };
