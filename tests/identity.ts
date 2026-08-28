// Proof that the dev server on the port is serving this checkout, run once before any spec.
//
// playwright.config.ts sets `reuseExistingServer`, which is what makes the suite quick to run
// against a server that is already up, and it is also what lets the suite talk to a server another
// checkout left behind. A stale server serves that checkout, so every assertion afterwards is about
// code this working tree does not contain: a pass proves nothing and a failure sends you looking
// for a bug in a file you never changed. `bytes.spec.ts` has carried a check of its own for that
// since it caught one, but it was the only suite that had it, and the four beside it were happy to
// pass against anybody's copy.
//
// Vite serves any module with `?raw` as its own source, so the check is a byte comparison rather
// than a guess: read the file here, ask the server for the same file, and require the two to be
// the same string. The files are the load bearing ones, the schema the editor is built on, the save
// path, the writer, the fixture the specs read and the seam they mock, so a server old enough to
// matter differs in at least one of them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";

/** The repository root, resolved off this file rather than off the working directory. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const WITNESSES = [
  "src/model/schema.ts",
  "src/document.ts",
  "src/markdown/serialize.ts",
  "src/dev/fixture.ts",
  "src/ipc.ts",
];

/**
 * Reads back the string in `export default '...'`, which is the whole body of a `?raw` module.
 * Written out rather than evaluated, because the point of this file is that the server is not
 * trusted yet, and running what it sends to find out whether to trust it has the order wrong.
 */
function decode(module: string): string {
  const body = module
    // Vite appends an inline source map to the module it serves, which is a comment about the
    // module rather than part of it.
    .replace(/\n\/\/# sourceMappingURL=[\s\S]*$/, "")
    .trim()
    .replace(/^export default\s*/, "")
    .replace(/;$/, "");
  const quote = body[0];
  if ((quote !== "'" && quote !== '"') || body[body.length - 1] !== quote) {
    throw new Error(`the server answered ?raw with something that is not a string literal: ${body.slice(0, 80)}`);
  }

  let out = "";
  for (let i = 1; i < body.length - 1; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const escape = body[++i];
    if (escape === "n") out += "\n";
    else if (escape === "r") out += "\r";
    else if (escape === "t") out += "\t";
    else if (escape === "b") out += "\b";
    else if (escape === "f") out += "\f";
    else if (escape === "v") out += "\v";
    else if (escape === "0") out += "\0";
    else if (escape === "u" && body[i + 1] === "{") {
      const end = body.indexOf("}", i);
      out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16));
      i = end;
    } else if (escape === "u") {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (escape === "x") {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (escape === "\n") {
      // A line continuation stands for nothing at all.
    } else out += escape;
  }
  return out;
}

export default async function identity(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) throw new Error("no baseURL to check: playwright.config.ts stopped setting one.");

  for (const witness of WITNESSES) {
    const url = `${baseURL}/${witness}?raw`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        `${url} answered ${response.status}. Whatever is on this port is not the Vite dev server ` +
          `for this checkout. Stop it and let \`pnpm test:ui\` start its own.`,
      );
    }

    const served = decode(await response.text());
    const here = readFileSync(join(ROOT, witness), "utf8");
    if (served !== here) {
      throw new Error(
        `The dev server on this port is serving a different ${witness} from the one in this ` +
          `working tree, so it is serving somebody else's checkout and this suite would be ` +
          `testing their code. Stop that server and run \`pnpm test:ui\` again.`,
      );
    }
  }
}
