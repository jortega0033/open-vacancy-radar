## Goal
Stop running two independent LLM extraction passes over the same raw CV text: once a candidate has a reviewed source CV, derive `CvProfile`'s 7 flat fields (title/years/location/etc.) from that structured source CV deterministically in code, instead of re-asking an LLM via `buildCvParsePrompt` (`prompts.ts:434`).

## Why now
Verified against the real prompt-building source this session: `prompts.ts:434` `buildCvParsePrompt` ("Parse with AI") extracts 7 flat `CvProfile` fields, and `prompts.ts:560` `buildSourceCvPrompt` ("Read source CV", `CV_SOURCE_JSON_SHAPE`) extracts a full structured employment/education history -- both from the same raw CV text, as two separate LLM calls. The source-CV pass's output is a strict superset of what the CvProfile pass needs: most-recent job title, years of experience computed from date ranges, and most-recent location are all mechanically derivable from the structured source CV once one exists. Both passes already run back-to-back in a real sequence (`CvDrawer.tsx:178,185`), so today's flow pays for two independent JSON extractions -- each with its own shape and its own independent chance to fail to parse -- to produce overlapping data from the same input.

## Scope
- Once a reviewed source CV exists for a candidate, compute `CvProfile`'s 7 fields from it in code: most recent job's title and location from the structured employment history, years of experience computed from the history's date ranges.
- Keep the `buildCvParsePrompt` ("Parse with AI") LLM call only as a fallback path for a candidate who has not yet produced a source CV.
- No change to the `CvDrawer` flow's product-visible behavior or ordering -- this only changes what backs the CvProfile fields once a source CV is available.

## Non-goals
- No change to `buildSourceCvPrompt` / `CV_SOURCE_JSON_SHAPE` or the source-CV extraction itself.
- No change to the CvDrawer UI or the two-step sequence a user experiences (`CvDrawer.tsx:178,185` keeps calling into both flows as before; only the CvProfile step's implementation changes for candidates with an existing source CV).
- No change to the fallback "Parse with AI" behavior or its prompt for candidates without a source CV.

## Acceptance criteria
- For a candidate with an existing, reviewed source CV, triggering the CvProfile fields path produces title/years/location deterministically from the source CV data, with no second LLM call made.
- For a candidate with no source CV yet, the existing `buildCvParsePrompt` LLM call still runs and populates CvProfile as before.
- The derived years-of-experience calculation is covered by tests against representative date-range shapes in the structured source CV (including open-ended/current roles).
- No regression in `CvDrawer.tsx`'s existing two-step call sequence at lines 178 and 185.

## Risk
Low-to-medium. The change is scoped to a derivation path with a deterministic, testable fallback (the source CV's own structured dates), and removes an LLM call class rather than adding one, so failure modes shrink rather than grow. The main risk is date-range edge cases in the source CV (missing end dates, overlapping roles, inconsistent formats) producing a wrong years-of-experience number silently instead of surfacing as an LLM-parse failure the user would previously have seen.
