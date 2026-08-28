// The four spelling commands, and the only place in this crate that knows whether the machine has
// a checker at all.
//
// Everything real happens in macspell.rs, which is compiled on macOS alone. This module exists so
// that the frontend gets the same four commands on every platform: it picks a checker at compile
// time and each command below has one body rather than a cfg in the middle of it.
//
// A run with no misspellings and a build with no checker both answer with an empty list, and that
// is deliberate. Returning an error from `spell_check` on a platform without NSSpellChecker would
// put a permanent failure toast in front of a user whose actual situation is "this build cannot
// check spelling", which is not a failure and is not something they can act on. `spell_available`
// is where that fact belongs, because it is the one answer the UI can do something with: it hides
// the underlines and the menu rather than offering a menu that does nothing.
//
// There is no state here and no dictionary file. The system holds the learned words, so there is
// nothing for this module to load at launch, nothing to keep in sync and nothing to migrate.

use crate::dto::SpellIssue;

#[cfg(target_os = "macos")]
use crate::macspell as checker;
#[cfg(not(target_os = "macos"))]
use self::no_checker as checker;

/// Spelling on a platform this app has no system checker for: every call succeeds and does
/// nothing. The alternative is a cfg inside each of the three commands that touch a checker, and
/// three chances to get the non-macOS answer subtly different from each other.
#[cfg(not(target_os = "macos"))]
mod no_checker {
    use crate::dto::SpellIssue;

    pub fn check(_text: &str) -> Vec<SpellIssue> {
        Vec::new()
    }

    pub fn learn(_word: &str) {}

    pub fn unlearn(_word: &str) {}
}

/// Every misspelling in one run of text.
///
/// Offsets are half-open and counted in characters from the start of the run that was passed in,
/// never from the start of a document. The checker is told about a paragraph and answers about that
/// paragraph; it has no idea a document exists, which is what leaves the caller free to send a
/// paragraph, a visible screenful or one sentence, and to add its own base offset afterwards.
///
/// Runs off the main thread. The call reaches the system spell service over XPC and a long
/// paragraph is enough work that a window held still for the length of it would be visible, which
/// matters more here than elsewhere because this is called while the user is typing.
#[tauri::command(async)]
pub fn spell_check(text: String) -> Result<Vec<SpellIssue>, String> {
    Ok(checker::check(&text))
}

/// Teaches a word to the system dictionary, for every app on the machine and not only for this
/// one.
///
/// That is the honest behaviour of a checker borrowed from the OS, and it is exactly what the
/// "Learn Spelling" item in every other Mac app does. This app ships no dictionary of its own and
/// keeps no private word list, so there is nowhere else for the word to go and nothing that would
/// need teaching twice.
///
/// A blank word is nothing to learn rather than an error: the frontend takes the word from
/// whatever the user right clicked, and an empty selection is a mis-click, not a failure worth a
/// toast.
#[tauri::command(async)]
pub fn spell_learn(word: String) -> Result<(), String> {
    let word = word.trim();
    if word.is_empty() {
        return Ok(());
    }
    checker::learn(word);
    Ok(())
}

/// Undoes a `spell_learn`, for a word taught by a slip of the hand. System wide in the same way,
/// and unlearning a word that was never learned is nothing to do rather than an error.
#[tauri::command(async)]
pub fn spell_unlearn(word: String) -> Result<(), String> {
    let word = word.trim();
    if word.is_empty() {
        return Ok(());
    }
    checker::unlearn(word);
    Ok(())
}

/// Whether this build has a checker behind it. Answered from the target rather than by asking
/// AppKit anything: NSSpellChecker is part of macOS itself, so on a build that has it there is no
/// failure mode where it is absent, and on any other build there is nothing to ask.
#[tauri::command]
pub fn spell_available() -> Result<bool, String> {
    Ok(cfg!(target_os = "macos"))
}
