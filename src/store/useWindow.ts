// Whether this window was opened for one Markdown file on its own. A standalone window has no
// folder, so no sidebar and no start screen, and it never becomes a folder window: Open Folder from
// it opens a new one.

import { create } from "zustand";

interface WindowState {
  standalone: boolean;
}

export const useWindow = create<WindowState>(() => ({ standalone: false }));
