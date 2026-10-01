---
name: loop-constraints
description: Load and enforce binding rules from loop-constraints.md before any Loop Engineering run. Use before loop-budget and loop-triage.
---

# Loop constraints enforcer

Before other loop work:

1. Read `loop-constraints.md` and `STATE.md` completely.
2. Count and load the active rules.
3. If `STATE.md` sets `Kill switch: loop-pause-all`, exit immediately.
4. Start with `Constraints loaded from loop-constraints.md: N rules active.`

The constraints bind every later loop action. Missing constraints never authorize source edits, pushes, merges, test disabling, or external mutations. At L1, only `STATE.md` and `loop-run-log.md` may change.
