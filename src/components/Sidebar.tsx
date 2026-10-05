// The open folder, one tree. This component owns everything that is about the tree as a whole:
// which row is selected, which row holds the tab stop, the arrow-key walk over the visible rows,
// the drag gesture and the menus. FileTree.tsx below it only draws.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { openExternal } from "../api/roots";
import { commandLabel, runCommand } from "../keys/commands";
import { viewerKindForPath } from "../model/doc";
import { useDocument } from "../store/useDocument";
import { notify } from "../store/useToast";
import { useViewer } from "../store/useViewer";
import { useWorkspace, type TreeNode } from "../store/useWorkspace";
import { openDocumentHere } from "../windows";
import { movePath } from "../workspace";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  FileTree,
  flattenTree,
  splitExtension,
  type DropTarget,
  type TreeHandlers,
  type TreeRow,
  type TreeViewState,
} from "./FileTree";
import { Icon } from "./Icon";
import { ResizeHandle } from "./ResizeHandle";
import { RowMenuAt, type RowMenuEntry } from "./RowMenu";
import { shortcutTitle } from "./Titlebar";

const EXPANDED_KEY = "margindocs-expanded";

/** How far the pointer travels before a press on a row becomes a drag rather than a click. */
const DRAG_SLOP = 4;
/** How long a drag hovers a closed folder before it springs open, the way Finder does. */
const SPRING_MS = 650;

// A folder with its flap out, which is the app's one picture of Open Folder: the closed
// folder with a cross in it belongs to New Folder, and this button is not that.
const OPEN_FOLDER = "M3 19V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2 M3 19l2.9-8h15.3l-2.9 8z";
const NEW_DOC_ICON = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M12 12v5 M9.5 14.5h5";
const NEW_FOLDER_ICON = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 11v6 M9 14h6";
const RENAME_ICON = "M4 20h4L20 8l-4-4L4 16z M14 6l4 4";
const DUPLICATE_ICON = "M9 9h11v11H9z M6 15V5h9";
const REVEAL_ICON = "M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4 M15 3h6v6 M10 14L21 3";
const OPEN_OUTSIDE_ICON = "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 9h18 M6 6h.01";
const COPY_PATH_ICON = "M8 4h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 2h6v4H9z";
const TRASH_ICON = "M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10 11v6M14 11v6";
const CLOSE_ICON = "M18 6L6 18M6 6l12 12";

function readList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, values: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // A webview with storage denied still works, it just forgets the shape of the tree.
  }
}

/**
 * Where the pointer says the dragged row should land.
 *
 * A filesystem has no row order to insert into, so all three answers are one destination
 * directory: the middle of a folder means that folder, and the edges of any row mean the folder
 * that row already lives in. Reading the answer off the DOM rather than off the row array is what
 * keeps this working while the tree scrolls under the pointer.
 */
function dropAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;

  const row = el.closest<HTMLElement>(".tree-row");
  if (row?.dataset.path) {
    const path = row.dataset.path;
    const parent = row.dataset.parent ?? "";
    const rect = row.getBoundingClientRect();
    const at = (y - rect.top) / rect.height;
    if (row.dataset.dir === "true") {
      if (!parent || (at > 0.25 && at < 0.75)) return { dir: path, mode: "into", row: path };
      return { dir: parent, mode: at <= 0.25 ? "before" : "after", row: path };
    }
    if (!parent) return null;
    return { dir: parent, mode: at < 0.5 ? "before" : "after", row: path };
  }

  // The indent gutter of a nested list belongs to the folder that owns the list, not to the root.
  const owner = el
    .closest<HTMLElement>(".tree-item")
    ?.querySelector<HTMLElement>(":scope > .tree-row");
  if (owner?.dataset.path) return { dir: owner.dataset.path, mode: "into", row: owner.dataset.path };

  const section = el.closest<HTMLElement>(".tree-section");
  if (section?.dataset.root) return { dir: section.dataset.root, mode: "into", row: section.dataset.root };
  return null;
}

/** A drop that would not move anything, or would move a folder inside itself, is not a drop. */
function usableDrop(target: DropTarget | null, path: string, parent: string): DropTarget | null {
  if (!target) return null;
  if (target.dir === parent) return null;
  if (target.dir === path || target.dir.startsWith(`${path}/`)) return null;
  return target;
}

const sameDrop = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a?.dir === b?.dir && a?.mode === b?.mode && a?.row === b?.row;

export function Sidebar() {
  const root = useWorkspace((s) => s.root);
  const expanded = useWorkspace((s) => s.expanded);
  const selectedPath = useWorkspace((s) => s.selectedPath);
  const select = useWorkspace((s) => s.select);
  const toggleExpanded = useWorkspace((s) => s.toggleExpanded);
  const newFolder = useWorkspace((s) => s.newFolder);
  const renameEntry = useWorkspace((s) => s.renameEntry);
  const duplicateEntry = useWorkspace((s) => s.duplicateEntry);
  const deleteEntry = useWorkspace((s) => s.deleteEntry);
  const revealInFinder = useWorkspace((s) => s.revealInFinder);
  const closeFolder = useWorkspace((s) => s.closeFolder);
  const documentPath = useDocument((s) => s.path);
  const viewFile = useViewer((s) => s.open);
  const viewedPath = useViewer((s) => s.path);

  // One of the two is always null: opening either closes the other. The row that is drawn as the
  // current one is whichever of them the pane is actually showing.
  const openPath = documentPath ?? viewedPath;

  const [hydrated, setHydrated] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [menuOpenPath, setMenuOpenPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: TreeRow } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const gesture = useRef<{ path: string; parent: string; x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const dropRef = useRef<DropTarget | null>(null);
  const spring = useRef<number | null>(null);

  useEffect(() => {
    const already = useWorkspace.getState().expanded;
    for (const path of readList(EXPANDED_KEY)) if (!already.has(path)) toggleExpanded(path);
    setHydrated(true);
  }, [toggleExpanded]);

  useEffect(() => {
    if (!hydrated) return;
    writeList(EXPANDED_KEY, [...expanded]);
  }, [hydrated, expanded]);

  useEffect(
    () => () => {
      if (spring.current !== null) clearTimeout(spring.current);
    },
    [],
  );

  const rootNode: TreeNode | null = useMemo(
    () =>
      root === null
        ? null
        : { path: root.path, name: root.name, isDir: true, editable: false, children: root.tree },
    [root],
  );

  const rows = useMemo(
    () => (rootNode === null ? [] : flattenTree([rootNode], expanded, 0, "")),
    [rootNode, expanded],
  );

  const tabStopPath =
    rows.find((r) => r.node.path === selectedPath)?.node.path ?? rows[0]?.node.path ?? null;

  const focusRow = (path: string) =>
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`)?.focus();
    });

  const moveFocus = (row: TreeRow | undefined) => {
    if (!row) return;
    select(row.node.path);
    focusRow(row.node.path);
  };

  const activate = (node: TreeNode) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    select(node.path);
    if (node.isDir) {
      toggleExpanded(node.path);
      return;
    }
    if (node.editable) {
      openDocumentHere(node.path).catch((e) => notify(`Could not open: ${String(e)}`));
      return;
    }
    // A picture or a PDF opens here, read only, rather than being handed to macOS. Open in Default
    // App is still on the row menu, because a PDF somebody wants to annotate belongs in Preview and
    // this app has no business standing in the way of that.
    if (viewerKindForPath(node.path) !== null) {
      viewFile(node.path);
      return;
    }
    openExternal(node.path).catch((e) => notify(`Could not open: ${String(e)}`));
  };

  const onKeyDown = (e: KeyboardEvent, row: TreeRow) => {
    const at = rows.findIndex((r) => r.node.path === row.node.path);
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        activate(row.node);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(rows[at + 1]);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(rows[at - 1]);
        break;
      case "Home":
        e.preventDefault();
        moveFocus(rows[0]);
        break;
      case "End":
        e.preventDefault();
        moveFocus(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!row.node.isDir) break;
        if (!expanded.has(row.node.path)) toggleExpanded(row.node.path);
        else moveFocus(rows[at + 1]);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row.node.isDir && expanded.has(row.node.path)) toggleExpanded(row.node.path);
        else if (row.parentPath) moveFocus(rows.find((r) => r.node.path === row.parentPath));
        break;
      default:
        break;
    }
  };

  const setDrop = (target: DropTarget | null) => {
    if (sameDrop(dropRef.current, target)) return;
    dropRef.current = target;
    setDropTarget(target);
    if (spring.current !== null) {
      clearTimeout(spring.current);
      spring.current = null;
    }
    if (target?.mode !== "into") return;
    const dir = target.dir;
    if (useWorkspace.getState().expanded.has(dir)) return;
    spring.current = window.setTimeout(() => {
      spring.current = null;
      if (dropRef.current?.dir === dir) useWorkspace.getState().toggleExpanded(dir);
    }, SPRING_MS);
  };

  const onPointerMove = (e: globalThis.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (!g.active) {
      if (Math.abs(e.clientX - g.x) < DRAG_SLOP && Math.abs(e.clientY - g.y) < DRAG_SLOP) return;
      g.active = true;
      setDragPath(g.path);
    }
    setDrop(usableDrop(dropAt(e.clientX, e.clientY), g.path, g.parent));
  };

  // The disk half of a drop. Everything it does now lives in src/workspace.ts beside renamePath,
  // which is where it belonged: refreshing both folders, following the selection, and rewriting the
  // relative links the move broke. Calling fileMove from here would move the bytes and leave every
  // link pointing at the old path.
  const moveInto = async (path: string, dir: string) => {
    await movePath(path, dir);
  };

  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    const g = gesture.current;
    gesture.current = null;
    const target = dropRef.current;
    if (g?.active) {
      suppressClick.current = true;
      if (target) moveInto(g.path, target.dir).catch((e) => notify(`Could not move: ${String(e)}`));
    }
    setDragPath(null);
    setDrop(null);
  };

  const onPointerDown = (e: PointerEvent, row: TreeRow) => {
    suppressClick.current = false;
    if (e.button !== 0 || renamingPath === row.node.path || menuOpenPath === row.node.path) return;
    // A root is where its folder lives on disk, not a row inside a tree, so it does not move.
    if (!row.parentPath) return;
    const target = e.target as HTMLElement;
    if (target.closest(".row-menu-btn") || target.closest(".tree-twisty")) return;
    gesture.current = { path: row.node.path, parent: row.parentPath, x: e.clientX, y: e.clientY, active: false };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onContextMenu = (e: MouseEvent, row: TreeRow) => {
    e.preventDefault();
    e.stopPropagation();
    select(row.node.path);
    setContextMenu({ x: e.clientX, y: e.clientY, row });
  };

  // Nothing is created here any more. New Document opens the setup panel, which is where the name
  // and the faces are chosen and the only thing that writes the file, so all a row has to do is
  // say where: the selection is what `targetDir` in src/keys/commands.ts reads. Going through
  // the command is also what keeps the sidebar and the title bar opening one panel rather than two.
  const createDocument = (at: string) => {
    select(at);
    runCommand("new-doc");
  };

  const createFolder = (dir: string) => {
    newFolder(dir)
      .then((path) => {
        select(path);
        setRenamingPath(path);
      })
      .catch((e) => notify(`Could not create the folder: ${String(e)}`));
  };

  const copyPath = (path: string) => {
    navigator.clipboard
      .writeText(path)
      .then(() => notify("Path copied"))
      .catch(() => notify("Could not copy the path"));
  };

  const menuItems = (row: TreeRow): readonly RowMenuEntry[] => {
    const node = row.node;
    const dir = node.isDir ? node.path : row.parentPath;
    const isRoot = !row.parentPath;
    const items: RowMenuEntry[] = [
      {
        id: "new-doc",
        label: "New Document",
        icon: NEW_DOC_ICON,
        run: () => createDocument(node.path),
      },
      { id: "new-folder", label: "New Folder", icon: NEW_FOLDER_ICON, run: () => createFolder(dir) },
    ];
    if (!isRoot) {
      items.push("sep");
      items.push({
        id: "rename",
        label: "Rename",
        icon: RENAME_ICON,
        run: () => setRenamingPath(node.path),
      });
      items.push({
        id: "duplicate",
        label: "Duplicate",
        icon: DUPLICATE_ICON,
        run: () =>
          duplicateEntry(node.path).catch((e) => notify(`Could not duplicate: ${String(e)}`)),
      });
    }
    items.push("sep");
    items.push({
      id: "reveal",
      label: "Reveal in Finder",
      icon: REVEAL_ICON,
      run: () =>
        revealInFinder(node.path).catch((e) => notify(`Could not reveal in Finder: ${String(e)}`)),
    });
    if (!node.isDir)
      items.push({
        id: "open-outside",
        label: "Open in Default App",
        icon: OPEN_OUTSIDE_ICON,
        run: () =>
          openExternal(node.path).catch((e) => notify(`Could not open: ${String(e)}`)),
      });
    items.push({ id: "copy-path", label: "Copy Path", icon: COPY_PATH_ICON, run: () => copyPath(node.path) });
    items.push("sep");
    if (isRoot)
      items.push({
        id: "close-folder",
        label: "Close Folder",
        icon: CLOSE_ICON,
        run: () => closeFolder(),
      });
    else
      items.push({
        id: "delete",
        label: "Delete",
        icon: TRASH_ICON,
        danger: true,
        run: () => setPendingDelete(node),
      });
    return items;
  };

  const view: TreeViewState = {
    expanded,
    selectedPath,
    tabStopPath,
    draggingPath: dragPath,
    dropTarget,
    renamingPath,
    openPath,
  };

  const handlers: TreeHandlers = {
    onActivate: activate,
    onToggle: (node) => {
      select(node.path);
      toggleExpanded(node.path);
    },
    onKeyDown,
    onPointerDown,
    onContextMenu,
    onMenuOpenChange: (path, open) =>
      setMenuOpenPath((current) => (open ? path : current === path ? null : current)),
    menuItems,
    // The row hides the extension, so the rename has to put back the one it took away rather than
    // quietly turning notes.md into a file with no extension at all.
    onRenameCommit: (node, typed) => {
      setRenamingPath(null);
      const { base, hidden } = splitExtension(node.name, node.isDir);
      const trimmed = typed.trim();
      if (!trimmed || trimmed === base) return;
      renameEntry(node.path, `${trimmed}${hidden}`).catch((e) =>
        notify(`Could not rename: ${String(e)}`),
      );
    },
    onRenameCancel: () => setRenamingPath(null),
  };

  return (
    <>
      <aside className="sidebar" aria-label="Folders">
        <div className="sidebar-head">
          <span className="nav-label">Folders</span>
          <div className="sidebar-actions">
            <button
              className="icon-button"
              title={shortcutTitle("open-folder")}
              aria-label={commandLabel("open-folder")}
              onClick={() => runCommand("open-folder")}
            >
              <Icon d={OPEN_FOLDER} />
            </button>
            <button
              className="icon-button"
              title={shortcutTitle("new-doc")}
              aria-label={commandLabel("new-doc")}
              onClick={() => runCommand("new-doc")}
            >
              <Icon d={NEW_DOC_ICON} />
            </button>
          </div>
        </div>

        <div className="nav-scroll">
          {rootNode && (
            <div className="tree-section" data-root={rootNode.path}>
              <FileTree
                nodes={[rootNode]}
                depth={0}
                parentPath=""
                state={view}
                handlers={handlers}
              />
            </div>
          )}
        </div>
      </aside>

      <ResizeHandle />

      {contextMenu && (
        <RowMenuAt
          x={contextMenu.x}
          y={contextMenu.y}
          items={() => menuItems(contextMenu.row)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={pendingDelete.isDir ? "Delete folder" : "Delete file"}
          message={
            <>
              Move <strong>{pendingDelete.name}</strong> to the Trash? You can put it back from
              Finder.
            </>
          }
          confirmLabel="Move to Trash"
          onConfirm={() => {
            const path = pendingDelete.path;
            setPendingDelete(null);
            deleteEntry(path).catch((e) => notify(`Could not delete: ${String(e)}`));
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
