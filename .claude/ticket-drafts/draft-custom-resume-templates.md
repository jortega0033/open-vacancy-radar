## Goal
Let a user choose between multiple resume export templates, or customize one (layout, section order, styling), instead of the single default template issue #156 ships.

## Why this is deferred, not built now
Explicitly sequenced this way on request: ship one default, app-authored template first (issue #156), and only build template *choice*/*customization* once that default exists and has been used for real. Building multiple templates or a customization system before a single one has shipped and been validated is designing in a vacuum.

## What would need to be true before this is worth building
1. Issue #156 has shipped, including its structured-vs-plain-text prompt-output decision -- template customization only makes sense once there's a real data shape (plain text vs structured sections) to vary the presentation of.
2. A real reason the default template doesn't fit some use case -- e.g. a user wanting a different section order, a more/less compact layout, or a visually distinct style for a specific industry -- rather than customization for its own sake.

## Scope (when picked up)
Not designed yet on purpose. Likely candidates once picked up: a small set of curated templates (not open-ended styling) reusing whatever rendering approach the default template settled on, kept consistent with this project's existing discipline of shipping one well-reviewed default before adding configurability (the same shape as the CV-profile-bridge / search-profile precedent: ship the grounded default first, add flexibility only once there's a real need for it).

## Non-goals
Do not build a template editor, arbitrary CSS/branding upload, or more than a small curated set of templates even when picked up -- that's a much larger surface (arbitrary user-supplied HTML/CSS rendered into an exported document is also a real injection/rendering-safety question that would need its own review, not assumed safe by default).

## Risk
Low to defer. Once picked up: medium, mainly around scope creep (how many templates is "enough") and the safety question above if "customization" is ever allowed to mean arbitrary user-authored markup rather than picking from curated options.
