import { call, type FileNode, type RootInfo } from "../ipc";

export const rootsList = () => call<RootInfo[]>("roots_list");

/** `path` comes from the native folder picker. Opening a folder never writes anything into it. */
export const rootOpen = (path: string) => call<RootInfo>("root_open", { path });

export const rootClose = (rootId: string) => call<void>("root_close", { rootId });

/** The whole tree for one root, root node included. */
export const treeRead = (rootId: string) => call<FileNode>("tree_read", { rootId });

/**
 * Every markdown document in one root, for the link rewrite sweep rather than for the tree.
 *
 * It walks past a .gitignore, which the tree does not, because a link inside an ignored draft is
 * still a link that breaks when the file it points at moves, and a sidebar's reasons for hiding a
 * file are not reasons to leave its links wrong. More than `limit` paths coming back means the root
 * holds more documents than the sweep is willing to read.
 */
export const sweepDocuments = (rootId: string, limit: number) =>
  call<string[]>("sweep_documents", { rootId, limit });

export const revealInFinder = (path: string) => call<void>("reveal_in_finder", { path });

/** Hands a file to whatever macOS opens it with. The only way to open a non-editable file. */
export const openExternal = (path: string) => call<void>("open_external", { path });
