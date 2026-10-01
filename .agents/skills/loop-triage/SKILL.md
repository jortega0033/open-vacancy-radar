---
name: loop-triage
description: Triage recent project changes, failures, issues, and current state into a concise L1 report. Use when the user asks to run Loop Engineering, daily triage, or update loop state; never auto-fix source code.
---

# Loop triage

Produce signal for a human-maintained engineering loop.

## Required order

1. Read `AGENTS.md`, `loop-constraints.md`, `loop-budget.md`, and `STATE.md`.
2. Inspect only data available in the current session or explicitly authorized connectors.
3. Classify findings as High Priority, Watch, or Noise.
4. Update `STATE.md` and append one entry to `loop-run-log.md` only when the user authorized a loop run.

## Report format

For each High Priority or Watch item, give a one-line description, impact, suggested next action, and rough effort. Keep Noise brief. Record durable facts under State Updates.

## Rules

- L1 is report-only: do not edit source, auto-fix, push, create or merge PRs, close tickets, or mutate external systems.
- Do not invent missing CI, issue, chat, or connector data. State which sources were unavailable.
- Put uncertain items in Watch, not High Priority.
- Propose narrow next actions, never architectural overhauls.
- If nothing is actionable, return a concise no-op and stop.
