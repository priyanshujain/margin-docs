# Tables

Escaped pipes, which are the one character a cell cannot hold plainly:

| pipe     |    code |
| -------- | ------: |
| `a \| b` |  \| raw |
| x        | `` ` `` |

A link whose text carries a pipe, and two urls that are their own text:

| link                                    |
| --------------------------------------- |
| [a \| b](./x.md)                        |
| <https://example.com>                   |
| https://example.com                     |

Rows that are not the width of the header:

| a | b |
| - | - |
| 1 | 2 | 3 |
| 4 |

Rows shorter than the header, which GFM already renders as blank cells:

| a | b | c |
| - | - | - |
| 1 |
| 2 | 3 |

A header with nothing in it:

|  |  |
| - | - |
| 1 | 2 |

A table with no body rows at all:

| only | header |
| ---- | ------ |

Alignment, with the dashes counted differently in every column:

| a | b | c | d |
| :- | :---: | ----: | - |
| 1 | 2 | 3 | 4 |

Marks and images inside cells:

| a          | b                 |
| ---------- | ----------------- |
| **bold**   | _em_              |
| ~~struck~~ | [link](./y.md)    |
| `code`     | ![alt](./i.png)   |
