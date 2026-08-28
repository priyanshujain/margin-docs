// Where the caret and the scroller were, per document, so reopening a file lands where you left
// it rather than at the top.
//
// Margin keys this by book and then by chapter because a book is a folder of many small documents
// that are read as one. Here there is no such nesting: a document is a file, a file has an
// absolute path, and that path is the whole key. Two roots holding a same-named file are two
// different paths and two different entries, which is the point.

export interface DocumentPosition {
  from: number;
  to: number;
  scroll: number;
}

const KEY = "margindocs-positions";

/** Old entries fall off the end rather than growing a map nobody ever prunes. */
const LIMIT = 200;

type Store = Record<string, DocumentPosition>;

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeAll(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    return;
  }
}

export function loadPosition(path: string): DocumentPosition | null {
  return readAll()[path] ?? null;
}

export function savePosition(path: string, position: DocumentPosition): void {
  const store = readAll();
  // Deleting before setting moves the key to the end, which is what makes insertion order a
  // recency order and lets the trim below drop the documents nobody has opened in a long time.
  delete store[path];
  store[path] = position;
  const paths = Object.keys(store);
  for (const stale of paths.slice(0, Math.max(0, paths.length - LIMIT))) delete store[stale];
  writeAll(store);
}
