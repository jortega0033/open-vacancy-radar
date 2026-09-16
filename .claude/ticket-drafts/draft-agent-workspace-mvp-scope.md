# Agent Workspace trust-class scope -- product decision needed (P2)

## Goal
Get an explicit product decision on whether "Agent Workspace" -- the general-purpose, full-filesystem-tool-access LLM call site (`apps/desktop/electron/main.ts:1065`, `apps/desktop/electron/main.ts:692`, `apps/desktop/electron/agent-workspace-ipc.ts`, `apps/desktop/electron/workspace/session-manager.ts:335-452`) -- is meant to ship as user-facing MVP product surface for Open Vacancy Radar, or whether it is upstream scaffolding that should stay out of this product's UI (behind a flag, or simply not wired into the shell navigation) until that decision is made. No UI or scope change should land until this is answered.

## Why now
From this session's AI/agent architecture audit: of the 13 LLM call sites in the app, rows 1-12 are narrow, single-purpose, structured-or-markdown generation calls (CV parsing, cover letters, and similar). Row 13 -- Agent Workspace -- is categorically different: it grants full filesystem tool access under a workspace lease, which is a materially different trust class from everything else in the product. Its presence in the same `session-manager.ts` hardening path as every CV/letter call is what forces the `toolProfile`/hardened branching to exist at all in that file, and it is the one call class carrying Bash/PowerShell-adjacent capability review weight in what is otherwise a narrow job-search product.

That review weight is recurring, not a one-time cost: every future change to `session-manager.ts`'s hardening path has to account for a Bash-capable trust class alongside the narrow generation calls, for as long as Agent Workspace stays wired into the shared path.

This also collides with an existing repo convention: per this repo's own agentdock-upstream-fork-workflow rule, runtime-level features belong in the upstream `jortega0033/agentdock` fork first, with this repo only pulling them in afterward. Agent Workspace reads like exactly that kind of inherited upstream capability riding along in the product, rather than something the job-application workflow itself asked for or needs. Nobody has actually made the call on whether it belongs in the shipped product surface at all.

## Scope
- Lay out the question for the product owner: is Agent Workspace (general-purpose agent with filesystem tool access, `main.ts:1065`/`main.ts:692`, `agent-workspace-ipc.ts`, `session-manager.ts:335-452`) intended as a user-facing MVP feature of Open Vacancy Radar, or upstream-only scaffolding?
- Lay out the stakes of each answer:
  - If it ships: the Bash-capable trust class stays a permanent part of this product's security surface and its ongoing hardening-review cost, and it should be documented and scoped like any other first-class feature (its own threat model, its own review cadence).
  - If it does not ship (yet): it should be hidden from user-facing surface -- e.g. behind a feature flag, or not exposed in the shell navigation -- while the underlying capability can still live in `session-manager.ts` for upstream/agentdock purposes without being reachable from the product UI.
- Capture the decision (and its rationale) in a form future contributors and reviewers can find, so the next hardening-path change to `session-manager.ts` doesn't have to re-litigate why a Bash-capable call site is in there.

## Non-goals
- No code change, flag addition, or navigation change as part of this ticket -- it is a decision-tracking ticket only.
- No re-evaluation of the other 12 LLM call sites; they are already correctly scoped as narrow, structured-or-markdown generation and are not in question here.
- No attempt to redesign Agent Workspace's lease/tool-access model; the question here is exposure (should it be user-facing), not its internal design.

## Acceptance criteria
- Product owner has explicitly decided: Agent Workspace ships as user-facing MVP surface, or it is hidden from the shell navigation/gated behind a flag pending further scoping.
- The decision and its rationale are recorded somewhere durable (this ticket, an ADR, or equivalent) and referenced from `session-manager.ts` or nearby so the next person touching the hardening path understands why the Bash-capable branch exists.
- If the decision is "hide it," a follow-up implementation ticket is opened separately -- this ticket does not do that work itself.
- If the decision is "ship it," a follow-up ticket to formally document and scope Agent Workspace's own threat model/review process is opened separately.

## Risk
Low as a ticket (it authorizes no code change), but the underlying exposure it is tracking is not low: shipping a full-filesystem-access agent inside a job-search product, without an explicit decision that this is intended, means the product is currently carrying real Bash/PowerShell-adjacent attack surface and an ongoing review burden that nobody has signed off on. Leaving this undecided indefinitely is itself the risk this ticket exists to close off.
