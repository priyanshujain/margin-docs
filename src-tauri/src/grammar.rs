// Grammar, which is Harper's.
//
// Deliberately not a port of the sibling's proofing.rs. That file checks spelling and grammar
// together because it had to ship its own speller; here NSSpellChecker already does the spelling
// in spell.rs and macspell.rs, and Harper's own spell rule stays off for the same reason: the
// system checker knows the user's names, their languages and every word they have ever taught
// their Mac, and a second opinion from a bundled dictionary is a worse one.
//
// The engine is built once and kept. Building it reads a curated dictionary and a part of speech
// model out of the binary, which is far too much work to repeat per paragraph, and this module
// keeps it in a static rather than in `tauri::Manager` state because a `LintGroup` is not the kind
// of thing the rest of the crate has any business reaching. Built on the first check rather than
// at launch, so a window opens without waiting for a model nobody has asked a question of yet.
//
// Nothing here is on the main thread. `grammar_check` is a `#[tauri::command(async)]`, so a long
// paragraph does not hold the window still while it is linted, which matters here for the same
// reason it matters in spell.rs: this runs while the user is typing.

use std::sync::{Arc, LazyLock, Mutex};

use harper_core::linting::{LintGroup, Linter, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};

use crate::dto::GrammarIssue;

/// What the popover offers, which is what the spelling menu beside it offers.
const MAX_SUGGESTIONS: usize = 5;

/// The linter and the dictionary it was built against, which `Document` needs as well.
struct Harper {
    linter: LintGroup,
    dict: Arc<FstDictionary>,
}

/// Built on first use and kept for the life of the process. The `Mutex` is not about sharing: it
/// is that linting takes `&mut self`, and two paragraphs arriving at once would otherwise have
/// nowhere to queue.
static ENGINE: LazyLock<Mutex<Harper>> = LazyLock::new(|| Mutex::new(build_harper()));

fn build_harper() -> Harper {
    let dict = FstDictionary::curated();
    let mut linter = LintGroup::new_curated(dict.clone(), Dialect::American);
    // The system checker does the spelling, and it does it better: see the note at the top.
    linter.config.set_rule_enabled("SpellCheck", false);
    Harper { linter, dict }
}

/// Whether this build has a grammar engine behind it.
///
/// A compile-time fact, answered the way `spell_available` answers its own: harper-core is a
/// dependency of this crate or it is not, and on a build where it is there is no runtime state in
/// which the engine has gone missing. Deliberately does not touch `ENGINE`, because the frontend
/// asks this once at launch and forcing the model load here would put the whole of it in front of
/// the first window for an answer that is already known.
#[tauri::command]
pub fn grammar_available() -> Result<bool, String> {
    Ok(true)
}

/// Every grammar problem in one run of text, with offsets in characters counted from the start of
/// that run.
///
/// Like `spell_check`, it is told about a paragraph and answers about that paragraph: it has no
/// idea a document exists, and the caller adds its own base offset afterwards. Harper counts in
/// characters already, so unlike the spelling path there is no conversion here and nowhere for one
/// to go wrong.
#[tauri::command(async)]
pub fn grammar_check(text: String) -> Result<Vec<GrammarIssue>, String> {
    let mut engine = ENGINE.lock().map_err(|e| e.to_string())?;
    Ok(collect_grammar(&mut engine, &text))
}

fn collect_grammar(harper: &mut Harper, text: &str) -> Vec<GrammarIssue> {
    let chars: Vec<char> = text.chars().collect();
    let doc = Document::new_plain_english(text, harper.dict.as_ref());

    let mut issues = Vec::new();
    for lint in harper.linter.lint(&doc) {
        // Clamped end first and then start against it, so a span this side never indexes past the
        // text and never comes out inverted. Harper should not hand back either, but this is a
        // foreign engine walking the user's prose and a slice with a bad pair of bounds is a panic
        // rather than a wrong underline.
        let end = lint.span.end.min(chars.len());
        let start = lint.span.start.min(end);
        let existing: String = chars[start..end].iter().collect();

        // A lint about nothing but whitespace is dropped, and Harper does produce them: two spaces
        // between sentences are "French spaces" to it, and the suggestion is one space. There is
        // nothing worth drawing there. An underline over characters that are not visible is not
        // visible either, it cannot be clicked to reach the offer behind it, and on the caller's
        // side those spaces are frequently not the user's at all: src/editor/proofing.ts blanks
        // inline code spans and leaf nodes into runs of spaces of the same width so that the words
        // either side keep their positions, and a checker underlining those would be underlining
        // exactly the thing that file went to the trouble of refusing to send.
        if existing.trim().is_empty() {
            continue;
        }

        let mut suggestions = Vec::new();
        for suggestion in &lint.suggestions {
            match suggestion {
                Suggestion::ReplaceWith(replacement) => {
                    suggestions.push(replacement.iter().collect())
                }
                // An insertion is offered as the whole of what the span would become, because the
                // popover replaces the underlined text with whatever is chosen and knows nothing
                // about the shape of the edit behind it.
                Suggestion::InsertAfter(insertion) => {
                    suggestions.push(format!("{existing}{}", insertion.iter().collect::<String>()))
                }
                Suggestion::Remove => suggestions.push(String::new()),
            }
        }
        suggestions.truncate(MAX_SUGGESTIONS);

        issues.push(GrammarIssue {
            start,
            end,
            // Harper's own name for the category the rule falls into, which is what the popover
            // shows above the message so a correction can be judged before it is taken.
            kind: format!("{:?}", lint.lint_kind),
            message: lint.message,
            suggestions,
        });
    }
    issues
}
