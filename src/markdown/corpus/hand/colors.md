# Colour

Markdown has no colour, so this file is the two spellings this editor writes and the only two it
reads back: a <span style="color: #c4453a">text colour</span> and a
<mark style="background-color: #977927">highlight</mark>.

The two nest, and the highlight is always the outer one:
<mark style="background-color: #3a8982"><span style="color: #b8622a">warm on teal</span></mark>.

A colour is written outside everything except a link, so
<span style="color: #4079c0">**bold**, _slanted_, ~~struck~~ and `code`</span> all keep their own
spelling inside it, and a colour inside a link covers
[<span style="color: #8a68c6">the whole label</span>](./emphasis.md).

## Where a colour can go

- <span style="color: #4f8b45">A green item.</span>
- An item with a <mark style="background-color: #bf625d">highlighted</mark> word in it.

| Colour | Where |
| - | - |
| <span style="color: #bb4f8e">Magenta</span> | in a cell, which is always one line |
| <mark style="background-color: #5580b2">Blue</mark> | in the cell under it |

> [!NOTE]
> A colour reads the same inside a callout as it does
> <span style="color: #9a7b1e">anywhere else</span>, because the callout is a quote and the colour
> is in the paragraph.
