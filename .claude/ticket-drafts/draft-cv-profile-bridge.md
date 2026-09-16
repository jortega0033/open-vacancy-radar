## Goal
Let a user prefill their search profile (`SearchProfileSection.tsx`) from a CV already in their CV Library, instead of retyping identity/skills fields by hand. This is scoped narrower than the original pitch after review: it bridges only fields a CV actually states as fact, and deliberately does **not** touch the profile's forward-looking preference fields.

## Why now
`buildCvParsePrompt` (`apps/desktop/src/components/cv/prompts.ts`) already does this exact extraction pattern -- free CV text to structured JSON, reviewed in the CV drawer before saving -- for a different profile (`cvDocuments.profile`). `SearchProfileSection.tsx` is a fully separate, fully manual form that never syncs with it, even though several fields overlap (current role, years of experience, location, skills). A fresh user who has already uploaded a CV still sees the "search profile isn't set up yet" empty state and has to retype everything scoring depends on.

## Scope
- New prompt (mirroring `buildCvParsePrompt`'s structure) mapping CV text to: `strongestSkills`, `additionalSkills`, `currentRole`, `experienceYears`, `location`, `constraints.professionalLanguage`.
- Route through `useAgentRun` + the existing `vacancy:save-search-profile` IPC, validated by the existing `vacancy-profile-validate.ts` allow-list.
- Review-before-save UI, matching the established CV-parse pattern -- nothing is written to the profile without the user confirming it first.

## Non-goals (deliberately excluded after review)
- **Do not auto-fill `targetRoles`, `consideredRoles`, `excludedRoleFamilies`, `constraints.primaryCountry`, or `constraints.minimumMonthlyBaseEur`.** These are forward-looking preference/aspiration fields a CV (a record of the past) cannot honestly state -- filling them requires the model to guess, which is exactly the kind of implicit steering the project's existing no-default-role/country/salary-bias precedent (candidate-profile-v1.json shipping these fields empty, per issues #56/#64) was written to keep out of this config. That precedent is about shipped defaults specifically, not per-user autofill in general -- but autofilling *these particular* fields from an inference rather than a stated fact reintroduces the same problem per-user instead of as a shipped default. Leave them for the user to type themselves.
- Does not change how CV parsing itself works, or the existing `cvDocuments.profile` feature.

## Acceptance criteria
- A user with an uploaded CV can trigger "Fill from CV," review the extracted identity/skills fields, edit if needed, and save -- without ever having typed them manually.
- `targetRoles`/`consideredRoles`/`primaryCountry`/`minimumMonthlyBaseEur` are never touched by this feature; profile scoring's existing bias-prevention discipline is unaffected.
- Existing `SearchProfileSection`/`vacancy-profile-validate` tests unaffected; new tests cover the extraction-to-review-to-save path and confirm the excluded fields are never written by this path even if a malformed model response includes them.

## Risk
Low, provided the field-scoping above is enforced at the schema/validation layer (not just prompt instructions) -- the model must not be able to smuggle a value into an excluded field even if it tries.
