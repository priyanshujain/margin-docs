import { call, type WindowRequest } from "../ipc";

/** What this window was opened to show, asked once as the page loads. */
export const windowInit = () => call<WindowRequest | null>("window_init");

/** A new window, opening `folder` when there is one and empty otherwise. */
export const windowCreate = (folder?: string) => call<void>("window_create", { folder });

/** Calls off a quit, because this window could not save and is staying open. */
export const windowCloseRefused = () => call<void>("window_close_refused");

/**
 * Asks to open `path` in this window. False means another window already has it open and has been
 * brought forward instead.
 */
export const documentClaim = (path: string) => call<boolean>("document_claim", { path });

/** Tells the backend which document this window is showing now, or that it shows none. */
export const documentSet = (path: string | null) => call<void>("document_set", { path });

/** Opens a Markdown file in a window of its own, or focuses the window that already has it. */
export const documentOpen = (path: string) => call<void>("document_open", { path });

/** Links `mdocs` into /usr/local/bin. Resolves with a sentence to show the user. */
export const cliInstall = () => call<string>("cli_install");

/** Makes this app the default for Markdown files. Resolves with a sentence to show the user. */
export const defaultAppSet = () => call<string>("default_app_set");
