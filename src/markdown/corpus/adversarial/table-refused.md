# Tables the editor has no model for

A cell holding inline html:

| a |
| - |
| <b>x</b> |

A cell holding a link with no text, whose destination would go with it:

| a |
| - |
| [](./nothing.md) |

A cell holding a footnote reference:

| a |
| - |
| note[^n] |

[^n]: The note.

A cell holding a link inside a link:

| a |
| - |
| [see <https://x.example> more](./y.md) |
