# Marks inside marks

A strikethrough that spans a link and the words either side of it, in the spelling
the serializer settles on: ~~use&#x20;~~[~~the old API~~](./api.md)~~&#x20;here~~ now.

Strong inside a strikethrough, and a strikethrough inside strong:
~~a**b**c~~ and **a**~~**b**~~**c**.

Emphasis inside a link, and a link inside emphasis:
[a\_b\_c](./x.md) and _a_[_b_](./y.md)_c_.

Code inside a link, which is the only pair code takes:
[`code span`](./z.md) and [a`b`c](./w.md).

All four at once, over a boundary space:
**q**~~**&#x20;r&#x20;**~~**s**

A struck run whose edge is a tab:
&#x78;~~&#x9;t&#x9;~~&#x79;

A struck run that covers exactly one whole link, and one that covers two:
[~~all of it~~](./whole.md) and [~~a~~](./a.md)~~&#x20;and&#x20;~~[~~b~~](./b.md).

## Angle urls the bare form cannot carry

An underscore in the domain: <https://exa_mple.com/a>

A backslash in the path: <https://exa_mple.com/a\_b>

An entity shaped tail followed by a semicolon: <https://exa_mple.com/a&amp>; here

A host with no dot: <a@localhost>

A pipe, inside a table cell:

| url | note |
| --- | ---- |
| <https://exa_mple.com/c> | inside a cell |

- <https://exa_mple.com/d>
- [~~gone~~](./gone.md)~~&#x20;and more~~

> [!NOTE]
> [~~the old note~~](./old.md)~~&#x20;is gone~~ and <https://exa_mple.com/e> stays.
