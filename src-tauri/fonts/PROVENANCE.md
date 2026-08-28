# Where these faces came from

Nine static instances, cut from the four variable fonts in `public/fonts/` that the editor renders
with. Same designs, same licence, same bytes underneath: the only difference is that a weight axis
has been pinned rather than left open.

They exist because Typst does not support a variable axis. It warns that it does not, then lays the
text out at the default instance whatever weight was asked for, so a PDF set from the variable files
has its headings, its bold runs and its callout labels all at 400 and no visible hierarchy at all.

They live here rather than in `public/fonts/` because nothing in the webview loads them. Everything
under `public/` is copied into the frontend bundle, and these are compiled into the binary by
`src-tauri/src/pdf.rs`, so keeping them here ships them once instead of twice.

To regenerate after updating a variable font, with fonttools installed:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

font = TTFont("public/fonts/Literata-VF.ttf")
instancer.instantiateVariableFont(font, {"wght": 600, "opsz": 12}, inplace=True)
# then set name IDs 1, 2, 4, 6, 16 and 17 to the family and style, and save.
font.save("src-tauri/fonts/Literata-SemiBold.ttf")
```

Literata pins `opsz` to 12, which is its own default and the size the body text is set at. The
weights are 400, 600 and 700 upright and 400 and 700 italic for Literata, and 400 and 700 in both
slopes for Hanken Grotesk, which are the weights `src/export/typst.ts` asks for. Typst falls back to
the nearest weight it has, so a face that is missing is a heading that comes out too heavy rather
than an export that fails.
