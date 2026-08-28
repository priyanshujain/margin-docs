import { call, type Backlink, type IndexStatus, type QuickOpenHit, type SearchHit } from "../ipc";

/** Rescans every open root. Progress arrives on the `index-progress` event. */
export const indexRebuild = () => call<IndexStatus>("index_rebuild");

export const indexStatus = () => call<IndexStatus>("index_status");

/** Fuzzy match over paths relative to their root, across every open root. */
export const searchQuickOpen = (query: string, limit: number) =>
  call<QuickOpenHit[]>("search_quick_open", { query, limit });

export const searchText = (query: string, limit: number) =>
  call<SearchHit[]>("search_text", { query, limit });

/** Which documents link to this one, for the section at the end of the document. */
export const backlinksFor = (path: string) => call<Backlink[]>("backlinks_for", { path });
