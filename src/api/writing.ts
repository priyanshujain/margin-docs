// Writing Tools, which is Apple's and not this app's.
//
// There is no API behind these two calls in the way there is behind spelling: the Rust side finds
// the system's own menu item and performs it, and the rewrite that follows lands in the webview by
// itself. Nothing here returns the new text, because nothing here is told what it is.

import { call } from "../ipc";

/**
 * Whether this machine can run a Writing Tool at all. It needs macOS 15.1 with Apple Intelligence
 * turned on, which is a much newer Mac than this app's minimum, so false is an ordinary answer and
 * the caller turns it into a toast rather than a button that does nothing.
 */
export const writingAvailable = () => call<boolean>("writing_available");

/** Fires one item on the system's Writing Tools submenu, by its English title. */
export const writingRun = (tool: string) => call<void>("writing_run", { tool });
