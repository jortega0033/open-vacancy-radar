## Goal
Port the grounded fact-selection pattern that `application-cover-letter.ts` already uses for the unattended cover-letter path (enumerated source facts, ID-based selection, hard-validated parse, template assembly) into the two interactive letter-generation paths -- `buildLetterPrompt` in `letters/prompt.ts:96` (driving `CoverLetter.tsx`) and the dedicated `LetterGenerator.tsx` -- so both categories of letter carry the same fabrication-risk guarantee before either one is sent to an employer.

## Why now
From the audit's AI/agent architecture review: the unattended path (`application-cover-letter.ts:93`) never lets the model write free prose. It selects 1-6 fact IDs from an enumerated source-facts list, hard-validates the selection (`parseSelectedFactIds` throws on invalid shape or unknown ids), and template-assembles the letter deterministically -- "structurally eliminating fabrication risk" per the audit's own inventory. The two interactive paths (`letters/prompt.ts:96` `buildLetterPrompt`, and `LetterGenerator.tsx`) instead produce free-form plain text with no malformed-output handling at all, and that text is displayed raw. Both categories produce the same real-world artifact -- a letter actually sent to an employer -- with materially different fabrication risk, even though the safer, already-tested pattern already exists in this codebase. This is "use the pattern you already built," not new design work; leaving it unaddressed means the riskier path is also the one a user interacts with and edits directly, which is the opposite of where the stronger guardrail should sit.

## Scope
- Extend (or extract into a shared module) the fact-selection contract from `application-cover-letter.ts:93` -- enumerated source facts, ID selection, `parseSelectedFactIds`-style validated parse, template assembly -- so it can be driven by the interactive paths, not only the unattended one.
- Rework `buildLetterPrompt` (`letters/prompt.ts:96`) to request a fact-ID selection instead of free prose, and validate the model's response the same way the unattended path does before any text reaches `CoverLetter.tsx`.
- Rework `LetterGenerator.tsx`'s generation flow the same way, including adapting its tone/length controls to operate on the fact-selection + template-assembly model rather than steering raw prose generation -- this adaptation is expected to be the main effort of the ticket.
- Add malformed-output handling to both interactive paths matching the unattended path's throw-on-invalid-shape/unknown-id behavior, with a user-facing failure state instead of a silent pass-through of bad output.

## Non-goals
- No change to the unattended path itself (`application-cover-letter.ts`) beyond whatever shared extraction is needed to reuse its logic -- it is already correct.
- No new fact sources or changes to what counts as a valid source fact; this ticket only ports the selection/validation/assembly mechanism to new call sites.
- No redesign of the interactive UI's layout beyond what's needed to fit the tone/length controls onto the new model.

## Acceptance criteria
- Both `CoverLetter.tsx` (via `buildLetterPrompt`) and `LetterGenerator.tsx` produce letters assembled from a validated fact-ID selection, not free-form model prose.
- Malformed or invalid model output (bad shape, unknown fact ids) is caught and surfaced as a handled failure in both interactive paths, mirroring `parseSelectedFactIds`'s behavior on the unattended path -- never displayed raw to the user.
- Existing tone/length controls in the interactive UI still function, now operating against the fact-selection + template-assembly model.
- Tests cover: a valid fact selection producing an assembled letter, and a malformed/invalid selection being rejected, for both interactive paths.

## Risk
Medium. This touches a user-facing, actively-edited generation flow (interactive letters are read and adjusted by the user before sending, unlike the unattended path), so the main risk is behavior change: template-assembled letters may read more rigid than today's free prose, and the tone/length controls need genuine rework rather than a cosmetic pass-through to stay meaningful under the new model. The upside -- eliminating fabrication risk on the path the user directly interacts with -- is the same guarantee already proven safe on the unattended path, so the pattern itself is not in question, only its adaptation to interactive controls.
