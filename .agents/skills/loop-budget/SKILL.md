---
name: loop-budget
description: Check the local Loop Engineering budget and recent run log before and after a loop run. Use with loop-triage to self-throttle or exit when no useful work exists.
---

# Loop budget guard

At the start of a loop run:

1. Read `loop-budget.md` and the last 24 hours of `loop-run-log.md`.
2. If `loop-pause-all` is active or the daily cap is exhausted, stop and record a one-line note in `STATE.md`.
3. At 80% of the daily cap, remain report-only and spawn no subagents.
4. If there is no actionable signal, exit without spawning subagents.

At the end, append one JSON object using the format in `loop-run-log.md`. Use the best available token estimate; label it as an estimate. Never exceed the configured subagent limit.
