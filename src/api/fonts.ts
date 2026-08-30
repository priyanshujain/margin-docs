// The machine's font book, for the half of the font picker this app does not ship.

import { call } from "../ipc";

/**
 * Every family installed on this machine, sorted and deduplicated by the backend.
 *
 * Answers with an empty list rather than rejecting when there is no backend to ask, because the
 * picker's bundled half works perfectly well without this one and an empty "System" group is the
 * honest way to say the machine was not asked. The list is worth caching in the caller: it walks
 * several directories on the Rust side and cannot change while the app is running.
 */
export const fontsListSystem = (): Promise<string[]> =>
  call<string[]>("fonts_list_system").catch(() => []);
