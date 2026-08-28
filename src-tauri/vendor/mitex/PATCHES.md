# Local changes to mitex 0.2.5

This copy is not stock. mitex is vendored rather than fetched through Typst's package system so
that an export needs no network, which also means an update is a manual copy and a patch applied
here is a patch that can be silently lost. Anyone replacing this directory has to re-apply what is
listed below, or re-check that it is no longer needed.

Upstream is https://github.com/mitex-rs/mitex, Apache-2.0, and LICENSE beside this file is theirs.

## specs/latex/standard.typ: `\hspace`, `\vspace` and `\raisebox` no longer evaluate their argument

Those three handlers passed the text between the braces to `eval`, which runs it as Typst code.
The text is whatever the author typed, so a markdown file containing
`$\hspace{range(999999999).len()*1pt}$` is a program rather than a formula. Typst is hermetic, so
this is not a way to read a file or reach the network, but the compiler runs inside the editor's
own process: measured, that document took nine gigabytes resident before the process died, and it
would have taken any unsaved buffer with it.

The three handlers now go through `mitex-safe-length`, which evaluates the argument only when it is
a plain length literal and answers `0pt` otherwise. `src-tauri/tests/pdf.rs` pins both halves.
