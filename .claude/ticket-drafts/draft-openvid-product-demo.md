## Goal
Use the forked `openvid` (browser-based demo/3D mockup creator) to produce a short product demo video of the Open Vacancy Radar desktop app, for the README and/or a future landing page -- once there is a stable flow worth showing.

## Why now (or rather, why not yet)
`openvid` itself has no technical relationship to this project's agent runtime, daemon, or desktop app -- it's a standalone content-creation tool, used the same way a screen recorder would be, not integrated as a dependency. The blocker isn't the tool, it's the product: the desktop app's core flow is still mid-build (ADI-05 through ADI-13 landed provider/session stores, workspace trust, concurrent AI Workspace, and `/v2/sessions` in the last few weeks alone), so a demo recorded today would be stale within another couple of ADI tickets. This is explicitly a "later" ticket.

## Scope (when picked up)
- Identify the 2-3 flows worth showing: creating/trusting a workspace, running a job-search agent session end to end, reviewing and acting on a result (e.g. the CV-profile-bridge fill-and-review pattern once it ships).
- Record those flows using `openvid` to produce a polished demo (screen capture plus whatever mockup/3D presentation openvid adds on top).
- Publish the output (video/GIF) referenced from the project README.

## Non-goals
- Not integrating `openvid` into the app itself -- it's an external content tool, used once, not a runtime dependency.
- Not blocking any current ADI work on this; this ticket stays unscheduled until the maintainer decides the app's flow is stable enough to film.
- Not a substitute for real user-facing documentation -- this is marketing/onboarding collateral, not the docs themselves.

## Acceptance criteria
- A published demo video/GIF exists and is linked from the README.
- The flows shown match what the app actually does at the time of recording (re-record rather than let it drift stale).

## Risk
Low. Entirely additive, no code changes to this repo required, easy to defer indefinitely with no cost.
