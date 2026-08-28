// What the grammar checker promises the frontend, asserted against the real engine.
//
// Three things, and the first is the one that would be invisible everywhere else. Offsets are in
// characters, and src/editor/proofing.ts adds a ProseMirror position to them without converting
// anything, so an engine that counted bytes would draw its underlines further and further to the
// left of the words they are about for every non-ASCII character earlier in the paragraph. That is
// a bug nobody writing in English would ever see and everybody writing in French or Polish would
// see immediately, and no other test in this repository is in a position to notice it: the Rust
// suite otherwise asserts about files, and the browser suite talks to the fixture in
// src/dev/mockIpc.ts rather than to Harper.
//
// The second is that Harper's own spell rule is off. It is turned off in src-tauri/src/grammar.rs because
// NSSpellChecker already does the spelling and knows the user's own names and languages, and a
// second dictionary underlining "Yoshinari" would be exactly the noise that gets a checker switched
// off for good. Left on, everything would still be green: there would just be spelling issues
// arriving through the grammar command, drawn in the grammar colour, with no Learn item on them.
//
// The third is that the engine survives being asked twice. It is a static built on first use and a
// `LintGroup` that lints through `&mut self`, so a second call is the one that would find a lock
// held or a state left dirty by the first.

use margin_docs_lib::dto::GrammarIssue;
use margin_docs_lib::grammar::{grammar_available, grammar_check};

/// The text a lint is about, sliced the way the frontend slices it: by character.
fn flagged(text: &str, issue: &GrammarIssue) -> String {
    text.chars()
        .skip(issue.start)
        .take(issue.end - issue.start)
        .collect()
}

fn check(text: &str) -> Vec<GrammarIssue> {
    grammar_check(text.to_string()).expect("the checker answered")
}

#[test]
fn a_build_with_harper_in_it_says_so() {
    assert!(grammar_available().expect("availability answered"));
}

#[test]
fn a_repeated_word_is_found_and_can_be_corrected() {
    let issues = check("I put the the book down.");
    let repeat = issues
        .iter()
        .find(|issue| flagged("I put the the book down.", issue).contains("the the"))
        .expect("the repeated word was found");

    assert!(!repeat.kind.is_empty(), "a lint carries the rule's category");
    assert!(!repeat.message.is_empty(), "and something to show the reader");
    assert!(
        repeat.suggestions.iter().any(|s| s.trim() == "the"),
        "with the correction on it: {:?}",
        repeat.suggestions
    );
}

#[test]
fn offsets_are_characters_and_not_bytes() {
    // Every character before the mistake is three bytes in UTF-8, so a checker counting bytes would
    // report a span three times too far along and the assertion below would slice the wrong words.
    let text = "Zażółć gęślą jaźń, and then I put the the book down.";
    let issues = check(text);
    let repeat = issues
        .iter()
        .find(|issue| flagged(text, issue).contains("the the"))
        .expect("the repeated word was found after a run of non-ASCII text");

    assert_eq!(flagged(text, repeat), "the the");
    assert!(
        repeat.end <= text.chars().count(),
        "and it ends inside the run it was told about"
    );
}

#[test]
fn spelling_is_left_to_the_system_checker() {
    // Not a word in any dictionary, and Harper's curated one included. Nothing may come back about
    // it, because the only rule that would have is the one src-tauri/src/grammar.rs turns off.
    let text = "The flurbulent maglifter needs oiling.";
    for issue in check(text) {
        assert_ne!(
            issue.kind, "Spelling",
            "the grammar checker reported a spelling issue: {issue:?}"
        );
    }
}

#[test]
fn nothing_to_say_about_nothing() {
    assert!(check("").is_empty());
}

/// Harper flags two spaces between sentences as "French spaces", and src-tauri/src/grammar.rs drops every
/// lint whose whole span is whitespace for the reasons written there: an underline nobody can see
/// or click on, and, when the spaces are the ones src/editor/proofing.ts writes in place of an
/// inline code span, an underline over the one thing that file went out of its way not to send.
///
/// These two inputs are the ones that reach the filter, so taking the filter out fails this test
/// rather than leaving it green. What it cannot see is a future Harper that stops raising the lint
/// at all, which would leave the guard unreached and this file none the wiser.
#[test]
fn a_lint_about_nothing_but_spaces_is_not_reported() {
    assert!(
        check("This is fine.  Two spaces there.").is_empty(),
        "the two spaces between the sentences were reported"
    );
    // The shape src/editor/proofing.ts produces from a blanked inline code span.
    assert!(
        check("The value        is nine.").is_empty(),
        "a blanked code span was reported as a run of spaces"
    );
}

#[test]
fn the_engine_is_kept_and_answers_the_same_way_twice() {
    let text = "I put the the book down.";
    let first = check(text);
    let second = check(text);
    assert_eq!(first.len(), second.len());
    assert_eq!(
        first.first().map(|i| (i.start, i.end)),
        second.first().map(|i| (i.start, i.end))
    );
}
