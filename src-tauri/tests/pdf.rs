// The exporter compiles a document nobody has checked, so the tests here are about what it refuses
// and what it survives rather than about the typesetting: a formula reaches mitex instead of the
// page as source, an image outside every open folder is never read, and neither a broken link nor a
// formula the converter choked on costs the user the whole PDF.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use margin_docs_lib::dto::ImageInput;
use margin_docs_lib::pdf::compile;
use tempfile::TempDir;

/// A real 4x4 PNG, so an image that is meant to be read is one Typst can actually decode, and one
/// the placeholder cannot be mistaken for.
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGO8I2LDAANMcBZeDgA8PAE0qLfS9QAAAABJRU5ErkJggg==";

/// The shape of what src/export/typst.ts puts at the top of a document with a formula in it: the
/// mitex import, which is the contract between the converter and this module, and set rules that
/// name neither the monospace nor the maths face, because which of those exist is the backend's
/// business and a family named hopefully is a warning per export about fonts nobody chose. A
/// document set rule after the preamble pdf.rs prepends is part of what these fixtures prove.
const PREAMBLE: &str = r#"#import "/mitex/lib.typ": mitex, mi
#set document(title: "Fixture")
#set page(paper: "a4", margin: 2cm)
#set text(size: 11pt, lang: "en")
"#;

fn png_bytes() -> Vec<u8> {
    STANDARD.decode(PNG).unwrap()
}

fn root() -> (TempDir, Vec<String>) {
    let dir = TempDir::new().expect("a temp dir");
    let paths = vec![dir.path().to_string_lossy().into_owned()];
    (dir, paths)
}

fn kinds<'a>(warnings: &'a [margin_docs_lib::dto::PdfWarning], kind: &str) -> Vec<&'a str> {
    warnings
        .iter()
        .filter(|w| w.kind == kind)
        .map(|w| w.message.as_str())
        .collect()
}

#[test]
fn a_document_with_an_image_and_a_formula_compiles() {
    let (dir, roots) = root();
    let photo = dir.path().join("photo.png");
    std::fs::write(&photo, png_bytes()).unwrap();

    let source = format!(
        "{PREAMBLE}
= Fixture

Inline #mi(\"a^2 + b^2 = c^2\") in a sentence.

#mitex(\"\\\\frac{{1}}{{2}} \\\\int_0^1 x^2 dx\")

#image(\"{}\")

Diagram: #image(\"diagram.svg\")
",
        photo.display()
    );

    let images = vec![
        ImageInput {
            path: photo.to_string_lossy().into_owned(),
            data: None,
        },
        // How a mermaid diagram arrives: rendered to SVG in the webview, with no file behind it.
        ImageInput {
            path: "diagram.svg".to_string(),
            data: Some(STANDARD.encode(
                br##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#333"/></svg>"##,
            )),
        },
    ];

    let (bytes, warnings) = compile(source, &images, &roots).expect("the fixture compiles");

    assert_eq!(&bytes[..4], b"%PDF", "the answer is a PDF");
    assert!(
        kinds(&warnings, "image").is_empty(),
        "no image was worked around: {:?}",
        kinds(&warnings, "image")
    );
    assert!(
        kinds(&warnings, "math").is_empty(),
        "no formula was worked around: {:?}",
        kinds(&warnings, "math")
    );
}

#[test]
fn a_formula_typesets_through_mitex_rather_than_falling_back_to_source() {
    let (_dir, roots) = root();

    // Only the wasm plugin can turn `\frac{a}{b}` into Typst's own `frac(a, b )`, so asserting on
    // what came back out of it proves the whole path resolved: the import, the relative imports
    // underneath it, the specs and the plugin. An `assert` inside the document makes a wrong answer
    // a compile error rather than a difference in bytes nobody would notice.
    let source = format!(
        "{PREAMBLE}#import \"/mitex/lib.typ\": mitex-convert
#assert.eq(mitex-convert(\"\\\\frac{{a}}{{b}}\"), \"frac(a ,b )\")
#mi(\"\\\\alpha + \\\\beta\")
"
    );

    let (bytes, warnings) = compile(source, &[], &roots).expect("mitex loads and converts");
    assert_eq!(&bytes[..4], b"%PDF");
    assert!(
        kinds(&warnings, "math").is_empty(),
        "the formula typeset without a workaround: {:?}",
        kinds(&warnings, "math")
    );
}

#[test]
fn the_mitex_files_are_the_only_thing_the_compiler_can_import() {
    let (_dir, roots) = root();

    let source = format!("{PREAMBLE}#import \"/etc/passwd\": *\n");
    let error = compile(source, &[], &roots).expect_err("nothing outside the vendored files loads");
    assert!(
        error.contains("file not found"),
        "the compiler has no filesystem: {error}"
    );
}

#[test]
fn an_image_outside_every_open_folder_is_never_read() {
    let (dir, roots) = root();
    // Somewhere the user did not open, which is what `![](../../../.ssh/id_rsa)` resolves to.
    let elsewhere = TempDir::new().expect("a temp dir");
    let secret = elsewhere.path().join("id_rsa");
    std::fs::write(&secret, "PRIVATE KEY").unwrap();
    let _ = dir;

    let source = format!(
        "{PREAMBLE}#image(\"{}\")\n",
        secret.display()
    );
    let images = vec![ImageInput {
        path: secret.to_string_lossy().into_owned(),
        data: None,
    }];

    let (bytes, warnings) = compile(source, &images, &roots).expect("the export still happens");
    assert_eq!(&bytes[..4], b"%PDF");

    let refused = kinds(&warnings, "image");
    assert_eq!(refused.len(), 1, "one image was worked around: {refused:?}");
    assert!(
        refused[0].contains("outside every open folder"),
        "the root guard is what refused it: {}",
        refused[0]
    );
    assert!(
        !String::from_utf8_lossy(&bytes).contains("PRIVATE KEY"),
        "nothing from the file reached the page"
    );
}

#[test]
fn one_broken_image_does_not_cost_the_whole_export() {
    let (dir, roots) = root();
    let missing = dir.path().join("gone.jpg");

    let source = format!(
        "{PREAMBLE}#image(\"{0}\")\n\n#image(\"{0}\")\n",
        missing.display()
    );
    let images = vec![
        ImageInput {
            path: missing.to_string_lossy().into_owned(),
            data: None,
        },
        ImageInput {
            path: missing.to_string_lossy().into_owned(),
            data: None,
        },
    ];

    let (bytes, warnings) = compile(source, &images, &roots).expect("the export still happens");
    assert_eq!(&bytes[..4], b"%PDF");

    // Two broken links to one file are one problem with a number on it, not two toasts.
    let counted: Vec<u32> = warnings
        .iter()
        .filter(|w| w.kind == "image")
        .map(|w| w.count)
        .collect();
    assert_eq!(counted, vec![2]);
}

#[test]
fn a_formula_nothing_can_typeset_does_not_cost_the_export() {
    let (_dir, roots) = root();

    // Unbalanced braces, which is what somebody halfway through typing a formula has. mitex cannot
    // parse it and says so by stopping the compile, and the whole page of notes would go with it.
    let source = format!("{PREAMBLE}#mi(\"\\\\frac{{\")\n");

    let (bytes, warnings) = compile(source, &[], &roots).expect("the export still happens");
    assert_eq!(&bytes[..4], b"%PDF");
    assert_eq!(
        kinds(&warnings, "math"),
        vec!["a formula could not be typeset, so every formula is shown as the source it was written in"]
    );
}

#[test]
fn an_ordinary_document_says_nothing_at_all() {
    let (_dir, roots) = root();

    // Every construct that has ever made this module warn about its own furniture rather than about
    // the document: the bundled variable fonts, the font families the preamble names, and mitex's
    // own deprecations. A user who wrote none of that should see no toast.
    let source = format!(
        "{PREAMBLE}
= Heading

A paragraph with `inline code` and #mi(\"a^2 + b^2\") in it.

```rust
fn main() {{}}
```
"
    );

    let (bytes, warnings) = compile(source, &[], &roots).expect("the fixture compiles");
    assert_eq!(&bytes[..4], b"%PDF");
    assert!(warnings.is_empty(), "nothing to say: {warnings:?}");
}

#[test]
fn a_broken_link_is_worked_around_in_every_format_the_editor_writes() {
    let (dir, roots) = root();

    // Typst decides how to decode an image from the extension and not from the bytes, so the
    // stand-in for a file that could not be read has to be a real image of the format the link
    // claimed. A png in place of a jpg is a decode error, which is the failure being avoided.
    for extension in ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"] {
        let missing = dir.path().join(format!("gone.{extension}"));
        let source = format!("{PREAMBLE}#image(\"{}\")\n", missing.display());
        let images = vec![ImageInput {
            path: missing.to_string_lossy().into_owned(),
            data: None,
        }];

        let (bytes, warnings) = compile(source, &images, &roots)
            .unwrap_or_else(|e| panic!("a missing .{extension} still exports: {e}"));
        assert_eq!(&bytes[..4], b"%PDF");
        assert_eq!(kinds(&warnings, "image").len(), 1);
    }
}

/// mitex's `\hspace`, `\vspace` and `\raisebox` handlers used to hand the text between the braces
/// to Typst's `eval`, which ran it as code. The text is whatever the author typed, so a markdown
/// file was a program, and the compiler runs in this process rather than beside it: the payload
/// vendor/mitex/PATCHES.md names took nine gigabytes and the app with it.
///
/// That payload is deliberately not the fixture here. A test that brings down the machine when it
/// fails is not a test anybody can run, and the property underneath it is smaller and exact: a
/// length literal is evaluated and nothing else is. `2cm*2` is the whole difference, because it is
/// arithmetic rather than a literal, and under `eval` it was four centimetres.
///
/// Proved by what lands on the page rather than by reading the guard, which needs one control: the
/// same source twice is the same bytes, so two documents differing only in a spacing command and
/// differing in bytes is that spacing command doing something.
#[test]
fn a_spacing_command_takes_a_length_and_never_an_expression() {
    let (_dir, roots) = root();
    let page = |length: &str| {
        let source = format!("{PREAMBLE}x#mi(\"a\\\\hspace{{{length}}}b\")x\n");
        compile(source, &[], &roots).expect("a spacing command typesets").0
    };

    assert_eq!(page("0pt"), page("0pt"), "the compiler is deterministic");
    assert_ne!(page("0pt"), page("4cm"), "4cm moved nothing on the page");
    assert_eq!(page("0pt"), page("2cm*2"), "an expression reached eval");
}

/// Every weight src/export/typst.ts asks for has to be a face of its own, or the hierarchy the
/// author sees on screen is not in the PDF.
///
/// This is what the static instances in src-tauri/fonts are for. Typst does not lay out a variable
/// axis: it takes the default instance, and every weight comes out at 400. There is no way to read a
/// weight back out of a PDF here, so the assertion is that the same word at two weights is two
/// different documents, which stops being true the moment two weights resolve to one face.
#[test]
fn every_weight_the_converter_asks_for_has_a_face_of_its_own() {
    let (_dir, roots) = root();
    let page = |markup: &str| {
        let source = format!("{PREAMBLE}{markup}\n");
        compile(source, &[], &roots).expect("a weight typesets").0
    };

    let cuts = [
        "#text(weight: 400)[Margin]",
        "#text(weight: 600)[Margin]",
        "#text(weight: 700)[Margin]",
        "#text(weight: 400, style: \"italic\")[Margin]",
        "#text(weight: 700, style: \"italic\")[Margin]",
        "#text(font: \"Hanken Grotesk\", weight: 400)[Margin]",
        "#text(font: \"Hanken Grotesk\", weight: 700)[Margin]",
    ];

    for (i, one) in cuts.iter().enumerate() {
        for two in &cuts[i + 1..] {
            assert_ne!(page(one), page(two), "{one} and {two} are the same face");
        }
    }
}
