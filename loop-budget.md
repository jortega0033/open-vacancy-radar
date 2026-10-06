# Loop Budget: Open Vacancy Radar

## Daily limits

| Loop | Max runs/day | Max estimated tokens/day | Max subagent spawns/run |
|---|---:|---:|---:|
| Daily triage | 2 | 100,000 | 0 |
| L2 fix | 2 | 250,000 (shared across the day) | 3 (one specialist or implementer, one verifier, one reviewer) |

L2 fix limits: max 1 fix per run and 120,000 estimated tokens per run. These are starting values, to be tuned after the first measured runs.

## Throttle

- At 80% of the daily budget: report-only, no subagents, no fixes.
- At 100%: stop and record the event in `STATE.md`.
- When no actionable signal exists: exit early.

## Kill switch

Set `Kill switch: loop-pause-all` in `STATE.md`. Resume only after the human changes it back to `inactive`.
