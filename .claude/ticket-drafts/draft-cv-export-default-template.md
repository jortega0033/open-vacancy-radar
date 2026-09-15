## Goal
Let the user export a Tailored CV draft (`TailorCv.tsx`, issue #155) to a real file, rendered into a default, app-authored resume template -- not a reproduction of whatever template the user's original uploaded CV happened to use. "Similar to your own template is fine; it doesn't have to be identical" was the explicit framing this ticket comes from.

## Why now
`draft-cv-tailoring.md` (issue #155) deliberately shipped copy-to-clipboard only, calling out PDF/DOCX/file export as a non-goal for its first slice: *"A structured-document export is a separate, later scope if ever wanted."* This is that scope, pulled forward on direct request right after #155 shipped.

## What already exists to build on
`apps/desktop/src/components/letters/export.ts` already does exactly this job for Letters: `exportMarkdown`/`exportDocx`/`exportPdf`, all going through `window.system.saveFile` (the existing native-save-dialog IPC bridge), using the `docx` and `jspdf` packages already in `apps/desktop`'s dependencies. No new IPC channel, no new native module, no new package needed.

**But it's the wrong shape to reuse as-is.** `export.ts`'s `exportDocx`/`exportPdf` render a title plus prose paragraphs (`paragraphs()` splits on blank lines) -- exactly right for a letter, wrong for a resume. A resume needs real sections (contact header, experience entries, skills list, education) with actual visual structure, not one text blob split into paragraphs.

## The open design question this ticket needs answered before implementation
`TailorCv`'s prompt (`buildCvTailorPrompt`) currently outputs **plain reordered text**, matching the source CV's own structure loosely -- there's no guaranteed section boundary a template renderer could key off reliably. Two ways forward:
1. **Keep the prompt's plain-text output**, and have the template do best-effort visual formatting around it (a styled shell -- name/contact line if detectable, then the body as-is). Simpler, but the "template" is mostly just typography/margins around unstructured text, not real resume sections.
2. **Change `buildCvTailorPrompt` to emit structured data** (sections: contact, summary, experience entries, skills, education -- similar in spirit to how `CV_PROFILE_FIELD_ORDER`/`buildCvParsePrompt` already extract structured fields from a CV), then render that structure into an HTML template. Real sections, real template control, but changes the prompt's output contract from #155's shipped version and needs its own no-invention guardrails re-verified against the new shape.
This needs a decision (likely option 2, given the "own template" framing implies real section layout) before implementation starts -- flagging it rather than deciding it unilaterally here.

## Scope
- Design one default resume template (HTML-based, per the request), owned by this app, not attempting to visually match the user's uploaded CV's original formatting.
- Export path(s): at minimum PDF (the practical format for actually submitting to an employer); DOCX and Markdown are cheap to add alongside since `export.ts` already proves the pattern for both.
- Reuse `window.system.saveFile` exactly as `letters/export.ts` does -- no new native/IPC surface.
- Wire an "Export" action into `TailorCv.tsx` alongside its existing Copy-to-clipboard.

## Non-goals
- **Multiple selectable templates, or user-customizable template styling** -- that's `draft-custom-resume-templates.md`, deferred on purpose until this default template ships and gets real use.
- Not reproducing the user's original CV's exact visual template -- explicitly out of scope per the request framing ("even if similar to my template" was accepted as sufficient, not a requirement to match it exactly).
- Not touching `letters/export.ts` itself -- this is a parallel resume-shaped exporter, not a refactor of the letter one, unless implementation finds a clean shared base worth factoring out (a decision for whoever picks this up, not decided here).

## Acceptance criteria
- From `TailorCv.tsx`, a user can export the current tailored draft to at least PDF, via the existing native save dialog.
- The exported file reads as a resume, not a letter -- distinguishable visual structure, not one prose blob with a heading.
- The structured-vs-plain-text prompt-output decision above is made and recorded before implementation, not discovered mid-build.
- Whichever shape is chosen, `buildCvTailorPrompt`'s no-invention guarantee (the property #155's review pass treated as the single most important correctness requirement for this feature) survives the change intact -- if the prompt output is restructured, its grounding rules and tests (`cv-prompts.test.ts`'s shared loops) are updated in the same change, not left describing a shape the prompt no longer produces.

## Risk
Low-medium. The export plumbing itself is proven (reusing `letters/export.ts`'s pattern); the real risk is scope-creep into template design bikeshedding, and the open prompt-output-shape question above needs resolving deliberately rather than accidentally coupling this ticket to a `buildCvTailorPrompt` breaking change.
