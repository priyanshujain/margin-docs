// The recursive half of the sidebar: rows, twisties, indentation and drop indicators, and nothing
// else. Selection, the keyboard, the drag gesture and every action a row can perform live one
// level up in Sidebar.tsx, because all of those span every open root and a recursive renderer only
// ever sees one subtree.

import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useEscapeLayer } from "../escape";
import { MARKDOWN_EXTENSIONS } from "../model/doc";
import type { TreeNode } from "../store/useWorkspace";
import { Icon } from "./Icon";
import { RowMenu, type RowMenuEntry } from "./RowMenu";

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const FOLDER_OPEN = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H7l-4 8z M3 17V7";
const DOCUMENT = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5";
const FOREIGN = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 17l2.5-3 2 2.2 1.5-1.7";

/**
 * The extension a row hides. Markdown is the app's own format and `.md` on every second row is
 * noise, but everything else keeps its extension: two rows both reading "notes", for `notes.md`
 * and `notes.txt`, would be a worse lie than the clutter it saved.
 */
export function splitExtension(name: string, isDir = false): { base: string; hidden: string } {
  if (isDir) return { base: name, hidden: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, hidden: "" };
  const ext = name.slice(dot + 1).toLowerCase();
  if (!(MARKDOWN_EXTENSIONS as readonly string[]).includes(ext)) return { base: name, hidden: "" };
  return { base: name.slice(0, dot), hidden: name.slice(dot) };
}

export const prettyName = (node: TreeNode): string => splitExtension(node.name, node.isDir).base;

export interface TreeRow {
  node: TreeNode;
  depth: number;
  /** The directory the row sits in, empty for a root. Where a "drop above this row" resolves to. */
  parentPath: string;
}

/** The rows the user can actually see, in the order they appear, which is what the arrow keys walk. */
export function flattenTree(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentPath = "",
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth, parentPath });
    if (node.isDir && expanded.has(node.path) && node.children?.length)
      rows.push(...flattenTree(node.children, expanded, depth + 1, node.path));
  }
  return rows;
}

/**
 * Every drop resolves to exactly one destination directory, because a filesystem has no row order
 * to insert into. The mode is only how the pointer said it: "into" is the folder under the cursor,
 * "before" and "after" are the folder that row already lives in.
 */
export type DropMode = "before" | "after" | "into";

export interface DropTarget {
  dir: string;
  mode: DropMode;
  /** The row the indicator draws on, which for "into" is the destination folder itself. */
  row: string;
}

export interface TreeViewState {
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  /** The one row in the whole sidebar that is in the tab order. */
  tabStopPath: string | null;
  draggingPath: string | null;
  dropTarget: DropTarget | null;
  renamingPath: string | null;
  /** The document currently open in the editor, which is a different thing from the selected row. */
  openPath: string | null;
}

export interface TreeHandlers {
  onActivate: (node: TreeNode) => void;
  onToggle: (node: TreeNode) => void;
  onKeyDown: (e: KeyboardEvent, row: TreeRow) => void;
  onPointerDown: (e: PointerEvent, row: TreeRow) => void;
  onContextMenu: (e: MouseEvent, row: TreeRow) => void;
  onMenuOpenChange: (path: string, open: boolean) => void;
  menuItems: (row: TreeRow) => readonly RowMenuEntry[];
  onRenameCommit: (node: TreeNode, base: string) => void;
  onRenameCancel: () => void;
}

interface TreeProps {
  nodes: readonly TreeNode[];
  depth: number;
  parentPath: string;
  state: TreeViewState;
  handlers: TreeHandlers;
}

export function FileTree({ nodes, depth, parentPath, state, handlers }: TreeProps) {
  return (
    <ul className="tree" role={depth === 0 ? "tree" : "group"}>
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          row={{ node, depth, parentPath }}
          state={state}
          handlers={handlers}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  row,
  state,
  handlers,
}: {
  row: TreeRow;
  state: TreeViewState;
  handlers: TreeHandlers;
}) {
  const { node, depth } = row;
  const { base, hidden } = splitExtension(node.name, node.isDir);
  const open = node.isDir && state.expanded.has(node.path);
  const renaming = state.renamingPath === node.path;
  const drop = state.dropTarget?.row === node.path ? state.dropTarget.mode : null;
  const foreign = !node.isDir && !node.editable;

  return (
    <li className="tree-item">
      <div
        className="tree-row"
        role="treeitem"
        style={{ "--tree-depth": depth } as CSSProperties}
        data-path={node.path}
        data-parent={row.parentPath}
        data-dir={node.isDir}
        data-root={depth === 0}
        data-foreign={foreign}
        data-selected={state.selectedPath === node.path}
        data-current={state.openPath === node.path}
        data-dragging={state.draggingPath === node.path}
        data-drop-before={drop === "before"}
        data-drop-after={drop === "after"}
        data-drop-into={drop === "into"}
        aria-expanded={node.isDir ? open : undefined}
        aria-selected={state.selectedPath === node.path}
        aria-level={depth + 1}
        tabIndex={state.tabStopPath === node.path ? 0 : -1}
        onClick={() => handlers.onActivate(node)}
        onKeyDown={(e) => handlers.onKeyDown(e, row)}
        onPointerDown={(e) => handlers.onPointerDown(e, row)}
        onContextMenu={(e) => handlers.onContextMenu(e, row)}
      >
        {node.isDir ? (
          <button
            className="tree-twisty"
            tabIndex={-1}
            title={open ? "Collapse" : "Expand"}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handlers.onToggle(node);
            }}
          >
            <Icon d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} size={13} />
          </button>
        ) : (
          <span className="tree-twisty" aria-hidden="true" />
        )}

        <span className="tree-glyph" aria-hidden="true">
          <Icon d={node.isDir ? (open ? FOLDER_OPEN : FOLDER) : foreign ? FOREIGN : DOCUMENT} size={15} />
        </span>

        {renaming ? (
          <RenameField
            value={base}
            onCommit={(next) => handlers.onRenameCommit(node, next)}
            onCancel={handlers.onRenameCancel}
          />
        ) : (
          <span className="tree-name" title={node.name}>
            {base}
            {hidden && <span className="tree-ext">{hidden}</span>}
          </span>
        )}

        <RowMenu
          label={node.isDir ? "Folder options" : "File options"}
          items={() => handlers.menuItems(row)}
          onOpenChange={(isOpen) => handlers.onMenuOpenChange(node.path, isOpen)}
        />
      </div>

      {open && node.children?.length ? (
        <FileTree
          nodes={node.children}
          depth={depth + 1}
          parentPath={node.path}
          state={state}
          handlers={handlers}
        />
      ) : null}
    </li>
  );
}

/**
 * Blur commits, the way Finder does, so the escape layer lives here rather than in the sidebar:
 * unmounting a focused input can fire a blur on the way out, and a cancel that arrived from
 * outside would otherwise be overtaken by the commit it was trying to avoid.
 */
function RenameField({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = (next: string) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(next);
  };

  useEscapeLayer(true, () => {
    settled.current = true;
    onCancel();
  });

  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={value}
      spellCheck={false}
      autoComplete="off"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit(e.currentTarget.value);
      }}
    />
  );
}
