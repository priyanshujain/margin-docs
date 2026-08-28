import { call } from "../ipc";

/** Changes arrive on the `watch-event` event, never as a return value. */
export const watchStart = (rootId: string) => call<void>("watch_start", { rootId });

export const watchStop = (rootId: string) => call<void>("watch_stop", { rootId });
