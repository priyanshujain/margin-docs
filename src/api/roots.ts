import { call, type FileNode, type RootInfo } from "../ipc";

export const rootsList = () => call<RootInfo[]>("roots_list");

/** `path` comes from the native folder picker. Opening a folder never writes anything into it. */
export const rootOpen = (path: string) => call<RootInfo>("root_open", { path });

export const rootClose = (rootId: string) => call<void>("root_close", { rootId });

/** The whole tree for one root, root node included. */
export const treeRead = (rootId: string) => call<FileNode>("tree_read", { rootId });

export const revealInFinder = (path: string) => call<void>("reveal_in_finder", { path });

/** Hands a file to whatever macOS opens it with. The only way to open a non-editable file. */
export const openExternal = (path: string) => call<void>("open_external", { path });
