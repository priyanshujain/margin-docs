// The corpus: real documents out of this project and its two siblings, hand written files that are
// deliberately awkward, and the fixtures each adversarial pass has left behind. The tests read
// whatever is in these folders, so adding a file that breaks the bridge is one `cp` away and needs
// no test written for it.
//
// The glob is every folder, not a list of them. It used to name `real` and `hand`, which is where
// the adversarial fixtures went when somebody made a folder for them: twenty files written to break
// this bridge, sitting inside the corpus, outside every gate that reads it, while the comment above
// said "every file". A folder is not a place a file can hide from the tests.
//
// Loaded through the bundler rather than through `node:fs` because there is no node type package
// here and the project's own type check covers the tests as well as the app.

export interface CorpusFile {
  /** "hand/gfm-table.md", used as the test name and as the path handed to the parser. */
  name: string;
  source: string;
}

const files = import.meta.glob("./*/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export function corpus(): CorpusFile[] {
  return Object.keys(files)
    .sort()
    .map((key) => ({ name: key.replace("./", ""), source: files[key] }));
}

export function corpusFile(name: string): CorpusFile {
  const source = files[`./${name}`];
  if (source === undefined) throw new Error(`no corpus file named ${name}`);
  return { name, source };
}
