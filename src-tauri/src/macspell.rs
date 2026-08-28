// The one file in this app that talks to AppKit, and the whole of spelling on macOS.
//
// Spelling is NSSpellChecker's rather than this app's. It is the same shared checker Mail, Notes
// and TextEdit correct into, so a word learned anywhere on the machine is a word this editor does
// not underline, the user's own configured languages come along for free, and nothing here ships a
// dictionary or holds an opinion about English. There is no custom word list beside it either:
// learning a word teaches it to the system, which is where every other Mac app puts it.
//
// Three things make this more than a one line binding.
//
// Offsets are the first. AppKit answers in NSRange, which counts UTF-16 code units, and the caller
// is a ProseMirror document, which counts code points. The two agree exactly until the paragraph
// holds an emoji or anything else outside the basic plane, and from that character onwards every
// later offset in the run is out by one per astral character. An underline drawn from a UTF-16
// offset onto a code point document sits under the wrong word, and a suggestion applied at that
// offset replaces the wrong characters, which is a silent edit to the user's file. `utf16_to_codepoint`
// is the whole of the fix, and this file is the only place in the app allowed to do that conversion
// so that there is exactly one thing to keep right.
//
// Which results to keep is the second. The checker is asked for Spelling and Link together and
// only the spelling results are returned. Link earns its place in the request because it makes the
// checker treat a URL as one span: without it `https://github.com/some-repo` is a run of tokens
// none of which are in any dictionary, and a paragraph carrying a link comes back with half of it
// underlined.
//
// The main thread is the third, and the answer is that none of this needs it. objc2 asks for a
// `MainThreadMarker` on exactly the panel accessors of NSSpellChecker (`spellingPanel`,
// `accessoryView`, `substitutionsPanel`), which this file never touches. The checking and learning
// calls carry no such requirement, and since each of them round trips to the system spell service
// over XPC, the caller deliberately runs them off the main thread.

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSSpellChecker;
use objc2_foundation::{NSRange, NSString, NSTextCheckingType};

use crate::dto::SpellIssue;

/// A context menu is a menu, not a dictionary page. The checker will happily offer thirty guesses
/// and the ones past the first few are noise the user has to read past to reach Learn Spelling.
const MAX_SUGGESTIONS: usize = 5;

/// Zero as the spell document tag, everywhere below. A tag buys a per-document session the checker
/// remembers ignored words against, and this app has no Ignore: a word is either learned for good
/// or it stays underlined, so there is no session to allocate.
const NO_DOCUMENT: isize = 0;

/// UTF-16 offset to code point offset, one entry per code unit of `text` plus a terminal entry, so
/// both ends of a half-open range are a lookup and neither is a special case.
///
/// A character outside the basic plane occupies two code units and one code point, so both of its
/// units map to the same code point index. An NSRange landing in the middle of a surrogate pair,
/// which the checker will not produce, therefore resolves to the start of that character rather
/// than to a position that does not exist.
fn utf16_to_codepoint(text: &str, utf16_len: usize) -> Vec<usize> {
    let mut map = Vec::with_capacity(utf16_len + 1);
    let mut cp = 0;
    for ch in text.chars() {
        for _ in 0..ch.len_utf16() {
            map.push(cp);
        }
        cp += 1;
    }
    map.push(cp);
    map
}

/// Every misspelling in one run of text, with half-open offsets in characters counted from the
/// start of that run.
///
/// The run is not split into words here. NSSpellChecker does that better than any rule this app
/// could write: it knows about contractions, hyphenation, proper nouns, capitalisation and
/// whichever languages the user has turned on, and it decides where a word begins in each of them.
pub fn check(text: &str) -> Vec<SpellIssue> {
    autoreleasepool(|_| {
        let checker = NSSpellChecker::sharedSpellChecker();
        let ns = NSString::from_str(text);
        let len = ns.length();
        let results = unsafe {
            checker.checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(
                &ns,
                NSRange {
                    location: 0,
                    length: len,
                },
                (NSTextCheckingType::Spelling | NSTextCheckingType::Link).bits(),
                None,
                NO_DOCUMENT,
                None,
                std::ptr::null_mut(),
            )
        };

        let map = utf16_to_codepoint(text, len);
        let chars: Vec<char> = text.chars().collect();
        let mut issues = Vec::new();
        for result in results.iter() {
            // Link results were asked for so the checker would recognise a URL as one span, not so
            // that anything would be reported about them.
            if result.resultType() != NSTextCheckingType::Spelling {
                continue;
            }
            let range = result.range();
            // Clamped to the length the map was built from. A range past the end would index out
            // of it and panic, and a panic here takes down a command the frontend runs on every
            // keystroke.
            let start = map[range.location.min(len)];
            let end = map[range.location.saturating_add(range.length).min(len)];

            // The word comes back out of `text` rather than from the checker, so the string the
            // frontend matches against is byte for byte the one it sent.
            let word: String = chars[start..end].iter().collect();

            // Asked in the checker's own coordinates, because this range indexes into `ns`.
            let mut suggestions = Vec::new();
            if let Some(guesses) = checker.guessesForWordRange_inString_language_inSpellDocumentWithTag(
                range,
                &ns,
                None,
                NO_DOCUMENT,
            ) {
                for guess in guesses.iter() {
                    suggestions.push(guess.to_string());
                    if suggestions.len() >= MAX_SUGGESTIONS {
                        break;
                    }
                }
            }

            // Reported even with nothing to suggest. NSSpellChecker regularly flags a typo it has
            // no guess for, and dropping those because the menu would have no replacements in it
            // is how a checker earns a reputation for missing things.
            issues.push(SpellIssue {
                start,
                end,
                word,
                suggestions,
            });
        }
        issues
    })
}

/// Teaches `word` to the system, for every app on this machine and not only for this one.
///
/// That is not a shortcut, it is what a checker borrowed from the OS does: `learnWord:` hands the
/// word to the system spell service, exactly where the "Learn Spelling" item in Mail or Pages puts
/// it, and every app on the machine stops underlining it from then on. This app deliberately keeps
/// no private word list beside that, because a second dictionary the rest of the system cannot see
/// is a word the user has to teach twice.
pub fn learn(word: &str) {
    autoreleasepool(|_| {
        NSSpellChecker::sharedSpellChecker().learnWord(&NSString::from_str(word));
    })
}

/// Undoes a `learn`, for a word taught by a slip of the hand. Also system wide, and the checker
/// treats unlearning a word it was never taught as nothing to do rather than as an error.
pub fn unlearn(word: &str) {
    autoreleasepool(|_| {
        NSSpellChecker::sharedSpellChecker().unlearnWord(&NSString::from_str(word));
    })
}
