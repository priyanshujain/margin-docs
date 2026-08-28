// Grammar, which is Harper's.
//
// The same shape as src/api/spell.ts on purpose: a run of text goes over, problems come back with
// offsets counted from the start of that run, and neither side knows a document exists. That is
// what lets the editor send one paragraph and add its own base offset afterwards, and it is why
// the two checkers can share a decoration pipeline instead of growing a second one.

import { call, type GrammarIssue } from "../ipc";

/**
 * Whether this build has a grammar engine behind it. False hides the underlines and the popover's
 * grammar half rather than offering a check that answers nothing, exactly as `spellAvailable` does.
 */
export const grammarAvailable = () => call<boolean>("grammar_available");

/** Every grammar problem in one run of text, with offsets in characters from the start of it. */
export const grammarCheck = (text: string) => call<GrammarIssue[]>("grammar_check", { text });
