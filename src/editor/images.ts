// Pictures in the document, drawn from the file they point at.
//
// `![](assets/shot.png)` is relative to the document, and a webview resolves a bare `src` against
// the page instead, which is the app bundle. So a local picture is read through `file_bytes`, the
// same guarded read the picture viewer uses, and shown from a blob url. Anything with a scheme,
// `data:` included, is left for the webview as it was written.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { fileBytes } from "../api/files";
import { resolveRelative } from "../links";
import { mediaTypeForPath } from "../model/doc";
import { useDocument } from "../store/useDocument";

class ImageView implements NodeView {
  dom: HTMLImageElement;
  private src: string | null = null;
  private url: string | null = null;
  private ticket = 0;

  constructor(
    node: ProseMirrorNode,
    private readonly documentPath: () => string | null,
  ) {
    this.dom = document.createElement("img");
    this.render(node);
  }

  private render(node: ProseMirrorNode): void {
    const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
    if (alt === null) this.dom.removeAttribute("alt");
    else this.dom.alt = alt;
    if (title === null) this.dom.removeAttribute("title");
    else this.dom.title = title;
    if (src === this.src) return;
    this.src = src;

    const from = this.documentPath();
    const local = from === null ? null : resolveRelative(from, src);
    if (local === null) {
      this.release();
      this.dom.src = src;
      return;
    }
    const ticket = ++this.ticket;
    fileBytes(local)
      .then((bytes) => {
        if (ticket !== this.ticket) return;
        this.release();
        this.url = URL.createObjectURL(new Blob([bytes], { type: mediaTypeForPath(local) }));
        this.dom.src = this.url;
      })
      .catch(() => {
        if (ticket !== this.ticket) return;
        this.release();
        this.dom.removeAttribute("src");
      });
  }

  private release(): void {
    if (this.url !== null) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== "image") return false;
    this.render(node);
    return true;
  }

  destroy(): void {
    this.ticket += 1;
    this.release();
  }
}

/** The node view for `image`, attached to the generated node in src/editor/extensions.ts. */
export const imageView = (node: ProseMirrorNode): NodeView =>
  new ImageView(node, () => useDocument.getState().path);
