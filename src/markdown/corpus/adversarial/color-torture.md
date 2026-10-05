# Colour, attacked

<span style="color: #2f8a83">A colour that spans a line the author wrapped by hand
keeps the wrap</span>, because the closing tag is written where the document puts it and not after
the space mdast swaps a line ending in front of inline html for.

A colour goes outside every mark but the link, so the four are
<span style="color: #4079c0">`a code span`</span>,
<span style="color: #4079c0">_emphasis_</span>,
<span style="color: #4079c0">~~a strikethrough~~</span> and
[<span style="color: #4079c0">a label</span>](./nested-marks.md), and a colour inside a highlight
is <mark style="background-color: #ab688d">a highlight around
<span style="color: #b8622a">a colour</span> and some words</mark>.

- <span style="color: #b8622a">A colour opening an item.</span>
- An item whose colour <mark style="background-color: #5d8844">closes where the item does.</mark>

| Cell | Note |
| - | - |
| <span style="color: #4f8b45">A colour in a cell</span> | which is always one line |
| <mark style="background-color: #ab688d">A highlight in a cell</mark> | and the same |

Everything below this line describes the same documents as everything above it and is written the
other way round, so none of it is modelled and every block of it is the source it was read as.

**<span style="color: #c4453a">A strong outside a colour</span>** is the nesting this app does not
write, so the paragraph holding it keeps its bytes rather than being handed back with the tags
moved outside the asterisks.

An unbalanced <span style="color: #c4453a">opening tag has nothing to pair with in the paragraph
it was opened in.

A closing tag</span> with nothing in front of it that opened one is no better, and a colour that
opens <mark style="background-color: #977927">in one paragraph

and closes in the next</mark> is two blocks, each of them holding half of a pair.

<span style="color:#C4453A">The hex in upper case with no space after the colon</span>, and neither
is <span class="colour">a span carrying a class</span>, <span>a bare span</span> or
<mark>a mark with no colour on it</mark>.

<span style="color: #c4453a"><mark style="background-color: #977927">The two nested the wrong way
round</mark></span>, which is the same document as the highlight outside and not the same bytes.

- **<span style="color: #c4453a">One item spelled the wrong way round</span>** takes the whole
  list with it.
- Because a construct that cannot be modelled fails its parent all the way up to the top level
  block, which here is the list.
