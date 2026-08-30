# Loop Budget — Open Vacancy Radar

## Daily limits

| Loop | Max runs/day | Max estimated tokens/day | Max subagent spawns/run |
|---|---:|---:|---:|
| Daily triage | 2 | 100,000 | 0 (L1) |

## Throttle

- At 80%: report-only, no subagents.
- At 100%: stop and record the event in `STATE.md`.
- When no actionable signal exists: exit early.

## Kill switch

Set `Kill switch: loop-pause-all` in `STATE.md`. Resume only after the human changes it back to `inactive`.
