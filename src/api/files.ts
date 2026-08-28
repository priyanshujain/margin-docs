import { call, type AssetResult, type FileNode, type ReadResult, type WriteResult } from "../ipc";

export const fileRead = (path: string) => call<ReadResult>("file_read", { path });

/**
 * Writes through a temporary file and a rename, so a crash mid-write leaves the old document
 * whole. Pass the `modifiedMs` the buffer was read at: if the file has moved on since, nothing is
 * written and the result comes back with `conflict`.
 */
export const fileWrite = (path: string, text: string, expectedModifiedMs?: number) =>
  call<WriteResult>("file_write", { path, text, expectedModifiedMs });

/** `name` is a suggestion. A taken name gets a suffix, and the node returned carries the real one. */
export const fileCreate = (parentPath: string, name: string) =>
  call<FileNode>("file_create", { parentPath, name });

export const fileFolderCreate = (parentPath: string, name: string) =>
  call<FileNode>("file_folder_create", { parentPath, name });

export const fileRename = (path: string, name: string) =>
  call<FileNode>("file_rename", { path, name });

export const fileMove = (path: string, destDir: string) =>
  call<FileNode>("file_move", { path, destDir });

export const fileDuplicate = (path: string) => call<FileNode>("file_duplicate", { path });

/** To the system Trash, never an unlink. Deleting a document is undoable in Finder. */
export const fileTrash = (path: string) => call<void>("file_trash", { path });

/**
 * A pasted image, into an `assets/` folder beside the document. `bytes` is the clipboard payload
 * and `name` the filename it suggested, which is usually `image.png` and usually already taken.
 */
export const assetWrite = (docPath: string, bytes: number[], name: string) =>
  call<AssetResult>("asset_write", { docPath, bytes, name });
