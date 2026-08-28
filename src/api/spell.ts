// Spelling, which is the system's and not this app's.
//
// Everything here goes to NSSpellChecker, the same checker Mail and Notes correct into, so a word
// learned anywhere on the machine is a word this editor does not underline and the user's own
// languages are already configured. Nothing in this app ships a dictionary or has an opinion about
// English.
//
// The checker is asked about a run of text and answers about that run. It has no idea a document
// exists, which is what keeps the caller free to send it a paragraph, a visible screenful or one
// sentence, and to decide for itself what a stale answer is worth.

import { call, type SpellIssue } from "../ipc";

/**
 * Every misspelling in one run of text, with offsets in characters counted from the start of that
 * run. The caller adds its own base offset; this never sees a document position.
 */
export const spellCheck = (text: string) => call<SpellIssue[]>("spell_check", { text });

/**
 * Teaches the word to the system, for every app on the machine and not only this one. That is the
 * honest behaviour for a checker borrowed from the OS, and it is what the "Learn Spelling" item in
 * every other Mac app does.
 */
export const spellLearn = (word: string) => call<void>("spell_learn", { word });

/** Undoes a `spellLearn`, for a word taught by a slip of the hand. */
export const spellUnlearn = (word: string) => call<void>("spell_unlearn", { word });

/**
 * Whether the machine has a checker at all. False on a build that is not macOS, where the answer
 * to every check is an empty list rather than an error, and the UI hides itself rather than
 * offering a menu that cannot do anything.
 */
export const spellAvailable = () => call<boolean>("spell_available");
