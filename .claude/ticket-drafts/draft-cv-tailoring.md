## Goal
Add CV tailoring: a per-vacancy draft that reorders and re-emphasizes what's actually on the user's real CV to fit one specific job description, the same way `CoverLetter.tsx` already drafts a motivation letter -- but for the CV content itself. This is the one piece of the auto-apply research (`draft-auto-apply-research.md`) that isn't blocked on anything: it needs no browser automation, no submit gate, no upstream `agent-browser` pull, just the same text-generation pattern this app already ships twice.

## Why now
`CvAssistant.tsx` already runs two AI features off the same loaded CV + selected vacancy: `GapAnalysis` (reports strengths/gaps, doesn't touch the CV) and `CoverLetter` (drafts new text). Tailoring is the missing third leg -- confirmed missing, not just unwired, while researching `draft-auto-apply-research.md`. Unlike that ticket's form-fill/submit stage, this piece is self-contained: same `useAgentRun` pattern, same bounded-input/no-invention prompt discipline already proven in `prompts.ts`, same "draft to review, not a final artifact" UX `CoverLetter` already established. Nothing about it depends on `agent-browser` or the AgentDock upstream pull.

## Scope
- `buildCvTailorPrompt(cv, vacancy)` in `apps/desktop/src/components/cv/prompts.ts`, reusing `GROUNDING_RULES`, `clamp`/`field`, and the same untrusted-vacancy-text framing `buildCoverLetterPrompt`/`buildGapAnalysisPrompt` already use. Output is a tailored CV *draft*: reordered/re-emphasized real content only -- the no-invention rule already shared across every prompt in this file applies here without exception (no new employer, title, date, skill, or metric that isn't in the source CV).
- `TailorCv.tsx`, mirroring `CoverLetter.tsx`'s shape exactly: `useAgentRun`, streamed `AiOutput`, Draft/Regenerate/Cancel/Copy-to-clipboard, and the same class of disclaimer text ("a tailored draft to review, not a replacement CV").
- Wire `<TailorCv cv={cv} vacancy={vacancy} .../>` into `CvAssistant.tsx` alongside the existing `GapAnalysis`/`CoverLetter` cards.

## Non-goals
- No auto-apply, form fill, upload, or submit -- that's `draft-auto-apply-research.md`'s scope, deliberately deferred and gated on a browser-automation capability this ticket does not need.
- Does not overwrite or modify the CV stored in the CV Library -- the tailored draft is separate output the user reviews and incorporates themselves, exactly like a cover letter draft today.
- No PDF/DOCX generation or downloadable file in this first slice -- plain streamed text plus copy-to-clipboard, matching `CoverLetter`'s current UX. A structured-document export is a separate, later scope if ever wanted.
- No `SaveCvToLibrary`-style persistence of the tailored output; nothing is written to disk or the workspace by this feature.

## Acceptance criteria
- With a loaded CV and a selected vacancy, a user can generate a tailored CV draft, reviewed as streamed text, that reorders/re-emphasizes real CV content for that specific posting.
- The output never contains a fact absent from the source CV (employer, title, date, skill, certification, metric) -- enforced by the same grounding rules already proven for `GapAnalysis`/`CoverLetter`, tested the same way (prompt-construction assertions; the existing suite has no dedicated component tests for `CoverLetter`/`GapAnalysis` either, so this stays consistent with that, plus a `useAgentRun`-level test matching `useAgentRun.test.tsx`'s existing pattern).
- Existing `CvAssistant`/`GapAnalysis`/`CoverLetter` behavior is unaffected by adding the third card.

## Risk
Low. Same shape as the already-shipped `CoverLetter` feature: no new infrastructure, no held credentials (runs on the user's own authenticated CLI, per `CvAssistant`'s existing disclaimer), no write path, no auto-apply dependency.
