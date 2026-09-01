# ADR: AgentDock v1 provenance and the v2 upgrade boundary

This repository is not an independent implementation of the AgentDock runtime: `apps/daemon`,
`packages/shared`, `packages/client`, and `packages/agent-runtime` are a copy-derived fork of the
upstream [`jortega0033/agentdock`](https://github.com/jortega0033/agentdock) project, taken at a
point in that project's history and then evolved independently ever since. Issues #119-#127
("ADI-01" through "ADI-09") plan to port a "v2" architecture from that same upstream project into
this repo's copy. Before any of that port work starts, this ADR records exactly what was copied,
from where, how far it has since drifted, and which of that drift is safe to overwrite versus must
be preserved. This is the artifact ADI-01 (issue #119) commits to producing; ADI-02 onward will cite
it rather than re-deriving these facts.

## Upstream reference points

- **Upstream repository:** `jortega0033/agentdock`
- **v2 target commit:** `5bc0b679…` (the commit the ADI tickets cite as the v2 architecture to port)
- **Nearest upstream baseline to this repo's fork point:** `751341bcb452d2b5711d0d4c1f4d099bfb1d5b49`
  ("chore: remove unused zod devDependency from apps/desktop") — confirmed by cloning upstream and
  checking out this commit directly; it exists and checks out cleanly.
- **This repo's initial commit:** `624247d60ce7d897303e40eb451451eae2df2504`
  ("feat: initial OpenVacancyRadar desktop app", 2026-08-29) — the point this repo's history starts
  from; it already contains the copy-derived packages, so the fork happened before this repo's own
  history begins.

## The copy-derived boundary

Diffing this repo's file tree against the upstream baseline commit identifies exactly which
directories are copy-derived, by finding the largest set of paths that exist verbatim (by path) in
both trees:

| Directory | File count |
|---|---|
| `apps/daemon` | 18 |
| `packages/shared` | 10 |
| `packages/client` | 8 |
| `packages/agent-runtime` | 45 |
| **Total** | **81** |

This 81-file set is the "core" this ADR and the ADI tickets treat as copy-derived and in scope for
provenance tracking. Four more files — `apps/desktop/electron/{main.ts, preload.ts,
resolve-daemon-entry.ts, send-to-renderer.ts}` — also exist verbatim by path in the upstream tree,
but are **excluded** from the 81-file core: they diverge far more heavily (whole new IPC
namespaces, vacancy-radar-specific wiring) than the 81-file set does, so folding them in would blur
a genuinely different kind of file under one number. Everything under `packages/vacancy-engine` and
`apps/desktop/{src,assets,e2e,scripts}` is pure product code with no upstream counterpart at all.

## Two valid, differently-scoped comparison numbers

Diffing the 81-file core against upstream produces **two different, both-correct answers**,
depending on which local commit you diff against — and conflating them would misstate what's
actually shipped:

**At this repo's fork point (`624247d`, the initial commit):**

```
TOTAL=81  IDENTICAL=69  MODIFIED=12  ADDED=0  DELETED=0  LINES=+84/-6
```

The 12 modified files at this point are exactly the Claude model-selection feature (see below) —
nothing else had touched the copy yet. This is the number issue #119 originally cited, and it is
accurate as a description of **provenance at the fork point**.

**At current `master` (HEAD, as of this ADR):**

```
TOTAL=81  IDENTICAL=32  MODIFIED=49  ADDED=0  DELETED=0  LINES=+410/-159
```

Nothing was added or deleted from the 81-path set in either case (every upstream path still exists
locally), but 17 more files have been modified since the fork, roughly quadrupling the line delta.
**This ADR treats the current-state number as the actual, load-bearing provenance record** — it is
what ADI-02 onward must diff the v2 target against — while keeping the fork-time number here as
historical context for how issue #119 arrived at its original "81/69/12" claim.

## What changed since the fork, and why

Four same-day commits (2026-08-30, the day before issue #119 was filed) account for the full
divergence between the two snapshots above:

1. **`4f4f611` — "feat(mcp): add policy-gated vacancy source foundation".** Adds a vacancy-source
   MCP client/connection-manager foundation: `apps/daemon/src/mcp/{cache, credential-store, manager,
   sdk-connector, types}.ts`, `apps/daemon/src/routes/mcp.ts`, `packages/shared/src/mcp.ts`, plus
   matching tests. These are net-new files *inside* the copy-derived directories but *outside* the
   81-path set, so they don't appear in the "modified" count above — they only affect the small
   number of core files that wire the new manager in (`apps/daemon/src/index.ts`,
   `apps/daemon/src/server.ts`, `packages/shared/src/index.ts`, `packages/client/src/client.ts`).
2. **`a6b7233` (PR #54) — "chore(copy): normalize project language".** A repo-wide sweep removing
   em dashes from comments and docs across nearly every core file, including many with no logic
   change at all. This single commit accounts for the bulk of the "modified file count" jump between
   the two snapshots: 29 of the 49 currently-modified core files differ from upstream in comments or
   docstrings only, with zero behavioral difference.
3. **`44adc81` — "fix: address CodeQL alerts…" (issue #39 Phase 1).** Rate-limiting-finding dismissal
   comments in `apps/daemon/src/routes/{providers,sessions}.ts`, and a real fix in
   `packages/client/src/client.ts` replacing a ReDoS-shaped regex with `stripTrailingSlashes`.
4. **`ca68c37` — "fix: repair packaged-app daemon crash and vacancy-engine path resolution".** Further
   `apps/daemon` packaging/build-script changes (`package.json`, `scripts/build.mjs`).

Of the 49 currently-modified core files, only **20 carry an actual behavioral difference** from
upstream; the other 29 are comment-only (mostly from the em-dash sweep). The 20 real changes fall
into three feature threads, none of which is a later, unrelated drift — all three were present by
the fork-time snapshot or added in the four commits above:

- **Claude model selection** (present since the fork): `packages/agent-runtime/src/providers/claude/
  {build-args,capabilities,detect}.ts` (adds a `--model` flag and a `CLAUDE_MODELS`/
  `availableModels` list), `packages/agent-runtime/src/types.ts` (`StartSessionOptions.model`),
  `packages/shared/src/{provider,schemas,session}.ts` (the schema/type surface for it),
  `apps/daemon/src/{routes/sessions,session-manager}.ts` (passthrough to the provider).
- **MCP vacancy-source foundation** (added `4f4f611`): the daemon/client wiring for the new MCP
  manager described above.
- **CodeQL remediation** (added `44adc81`): the ReDoS fix and rate-limit comment updates described
  above.

## The MCP foundation ships dormant, on purpose

`apps/daemon/src/index.ts` builds its `McpConnectionManager` (via the exported `buildMcpManager()`
factory) with an **empty policy array**, on purpose: provider-specific policies (starting with #29)
will inject an `OAuthClientProvider` there, and keeping the registry empty until then means an OAuth
server can never be contacted before its redirect URI, PKCE/token persistence, terms, tool, and
retention policy have all been reviewed together (see the comment on `buildMcpManager` itself for
the full reasoning — it isn't repeated here to avoid this ADR drifting out of sync with the code it
describes).

The manager, SDK connector, credential store, and routes are fully built and unit-tested against
fabricated policies, but **zero MCP providers are wired into the shipped daemon today** — this is
scaffolding with the gate deliberately closed, not an oversight. This ADR records the decision that
follow-on ADI work must respect: **treat the empty policy array as a real, shipped product
invariant**, not a temporary state to silently fill in as a side effect of some other change. A
regression test (`apps/daemon/test/index.test.ts`) now pins this by constructing the real manager via
`buildMcpManager()` and asserting `providerIds()` is empty, rather than pattern-matching `index.ts`'s
source text, so the test keeps working across any refactor that preserves the actual invariant.

## Preload surface vs. documentation (now reconciled)

`apps/desktop/electron/preload.ts` exposes five `contextBridge` namespaces, only one of which
(`agentDock`) is upstream-derived; the other four (`vacancyRadar`, `workspace`, `cv`, `system`) are
product-specific additions. `docs/architecture.md`, `docs/client-sdk.md`, and `docs/electron.md`
previously all claimed "seven narrow IPC capabilities" — accurate for `agentDock` at the fork point,
but stale now that `agentDock` alone has 11 methods (4 added by the MCP foundation) and the other
four namespaces (33 more methods across them) were never documented at all. All three docs have been
corrected as part of this ADR to describe the real, current five-namespace surface; see
[electron.md](electron.md#the-preload-bridge) for the authoritative list.

## Golden/regression coverage added or confirmed for this ADR

| Area | Status before this ADR | Action taken |
|---|---|---|
| v1 routes, SSE streaming, cancellation | Already covered (`apps/daemon/test/server.test.ts`) | None needed |
| Claude model propagation | Covered at the schema/manager layer only; no full-HTTP-route test | Added a `POST /sessions` route-level test in `server.test.ts` asserting a `model` field in the request body reaches the provider's `startedOptions` |
| Compiled vacancy-source MCP | Manager/routes/SDK-connector logic covered; the shipped-empty invariant was unpinned | Added `apps/daemon/test/index.test.ts` pinning the empty policy array |
| Preload key allowlist | `agentDock`/`vacancyRadar`/`workspace`/`cv` covered; `system` had zero coverage | Added an exact-allowlist test for `system` in `apps/desktop/test/preload.test.ts` |
| Payload validation, safe external URLs, product database schemas | Already covered | None needed |
| Packaged resources | Path-resolution logic (`resolve-daemon-entry`, `resolve-vacancy-engine-paths`, `resolve-window-icon`) covered; nothing checked that `electron-builder.yml`'s `extraResources` actually matches what those resolvers expect | Added `apps/desktop/test/electron-builder-resources.test.ts`, a one-directional static check that the YAML declares the paths the resolvers expect. It cannot catch drift starting on the resolver side (a path literal renamed there without a matching yaml edit), since neither resolver exports its path segments as a constant this test could share instead of hardcoding its own copy — closing that direction is a real gap this ADR leaves open, not one it claims to close |

One gap is explicitly **not** closed by this ADR and is called out for whoever picks it up: there is
no automated check that `apps/desktop/electron/workspace/schema.ts` and
`packages/vacancy-engine/src/db/schema.ts` stay in sync with their respective Drizzle migration
folders — only manual `drizzle-kit generate` catches drift today. This is a real gap, but adding
migration-diffing CI is a larger, separately-scoped change and out of bounds for ADI-01.

## Reproducible asset-validation environment

`pnpm run assets:validate` (`scripts/assets/validate_assets.py`, Pillow + CairoSVG) already has a
documented, pinned Python environment in [assets.md](assets.md) (`python -m venv .venv-assets`,
`scripts/assets/requirements.txt`). While verifying this criterion, a real, pre-existing bug was
found and fixed: the validator's exact-file-set check for `assets/app-icons/` had not been updated
after PR #89 added `installer.nsh` and `vc_redist.x64.exe` to that directory, so the validator
failed on an unrelated, correct state. `check_exact_files` now accepts an `allow_extra` parameter,
and the `ICON_ROOT` check allowlists those two files.

## ADI-04: the v2 session supervisor over the v1 one-shot transport

ADI-04 (issue #122) adds a v2 "session supervisor" that wraps the existing v1 provider adapters
without changing them. Like ADI-03's `model-select.ts`, the supervisor itself ships with **no
daemon caller** — nothing in `apps/daemon/src/session-manager.ts` constructs one, so no live
session goes through it, and wiring it in is a later ticket. `session-manager.ts` does carry one
small, deliberate change unrelated to the supervisor: `cancel()`, `remove()`, and `cancelAll()` now
isolate a rejecting `handle.cancel()` (which can happen since `ProviderSessionHandle.cancel()` now
awaits a confirmed process-tree reap, see below, rather than always resolving once it merely
initiated termination) so one session's reap-confirmation timeout can never abort another session's
cancellation, crash the daemon's shutdown handler, or turn a cancel/delete HTTP request into an
unhandled 500. This is the one place ADI-04 touches existing v1 daemon code, and it is a strict
robustness fix, not a behavior change to any session's actual lifecycle.

### What was ported, and from which upstream commit

| Ported into | From upstream | Fidelity |
|---|---|---|
| `apps/daemon/native/windows/AgentDock.JobHost.cs` | `8d0d9ef`, same path | Near-verbatim; only a provenance header comment added |
| `packages/agent-runtime/src/process/windows-job-host.ts` | `8d0d9ef`, same path | Near-verbatim; comments expanded, logic unchanged |
| `packages/agent-runtime/src/process/spawn-process.ts` | `8d0d9ef`, same path | Near-verbatim rewrite of this repo's existing file |
| `apps/daemon/scripts/build-windows-job-host.mjs` | `8d0d9ef`, same path | Near-verbatim |
| `test/fixtures/fake-orphaning-{leader,intermediate}.mjs`, `fake-marker-writer.mjs` | `8d0d9ef`, same paths | Verbatim |
| `packages/agent-runtime/test/spawn-process.test.ts` | `8d0d9ef`, same path | Adapted, plus a Windows negative-control test not present upstream |
| `packages/agent-runtime/src/providers/compatibility-manifest.ts` | `7aec0f1`, same path | Subsetted and re-pinned (see below) |

The Windows Job Object host is the one genuinely hard piece here, and it was taken as-is on purpose.
Windows has no process group that outlives its leader, so `taskkill /T` — which walks the *live*
parent-PID chain — cannot reach a grandchild whose intermediate parent has already exited. That
grandchild is not merely hard to find; it is no longer in the tree at all. The host closes this by
creating the provider inside an unnamed Job Object at process-creation time (via
`PROC_THREAD_ATTRIBUTE_JOB_LIST`, suspended then resumed, so there is no window in which the
provider exists outside the job) with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and by holding the only
handle to that job. Killing the host closes the handle, and the kernel terminates every job member
atomically, orphans included.

That this gap is real in *this* repo, and not merely in upstream's, is pinned by a **negative
control** test that upstream does not have: `spawn-process.test.ts` runs the same orphan fixture
chain through a plain `child_process.spawn` plus `taskkill /pid <pid> /T /F` — the mechanism this
repo used before ADI-04 — and asserts the orphan **survives**. Without that control, the passing
Job Host test could have been passing for a trivial reason.

The host is compiled by `apps/daemon/scripts/build-windows-job-host.mjs` through PowerShell's
`Add-Type -OutputType ConsoleApplication`, which drives the in-box .NET Framework C# compiler, so
building the daemon does not require a .NET SDK. It is written to `apps/daemon/dist/`, which
`apps/desktop/electron-builder.yml` already ships wholesale to `resources/daemon` as an
`extraResources` entry — the same ride-along the `@napi-rs/keyring` native binding gets — so **no
new packaging entry was needed**.

### The three-way scope split

Upstream's v2 work divides into three parts, and only the first is in scope for this ticket:

1. **Legacy-supervisor-compatible core (ported).** The compatibility manifest, accepted-work
   boundaries, launch-scope freezing, the fallback-authorization gate, the bounded unknown-frame
   ledger, and process-tree-aware cancellation. All of it is meaningful over a one-shot CLI
   transport, which is the only transport this repo has.
2. **App-server / SDK-specific (not ported).** `providers/codex/app-server/**`,
   `providers/claude/sdk/**`, and the interactive-transport machinery they exist to serve. This
   repo has no interactive transport, and AD-21 (see [providers.md](providers.md)) already records
   the standing decision to stay on `codex exec --json`.
3. **Durable persistence / execution-graph store (not ported).** That is ADI-05's scope.

### This supervisor is not upstream's supervisor

Upstream's `session-supervisor.ts` is ~1,398 lines built around rich interactive transports,
mid-turn commands, approval round-trips, and a durable execution graph. Porting it would have meant
importing — and then maintaining — a large amount of machinery with no reachable caller in this repo.
`packages/agent-runtime/src/providers/common/session-supervisor.ts` is instead a new, much smaller
supervisor written to the same *contracts* over the one transport that exists here. **ADI-06+ will
replace its internals when rich transports land**; the exported shapes are the part intended to
survive that, which is why they are exported from `index.ts` despite having no caller yet.

Its one hard constraint is that the supervised event stream is byte-identical to the unsupervised
one: no event is added, dropped, reordered, or rewritten. This is proven, not asserted —
`test/support/supervisor-contract.ts` deep-equals the full `AgentEvent[]` from a bare
`provider.startSession()` against the one from `superviseProviderSession()` for the same fixture,
per provider. Everything the supervisor learns, it learns either by reading events it is passing
through anyway, or through an `@internal`, optional `launchProbe` seam on `StartSessionOptions`.

That seam was added rather than approximated. The alternative considered was treating "first
observed event" as the acceptance signal, which needs no new field — but it collapses both
accepted-work boundaries into one heuristic, making the Claude/Codex distinction decorative. With
the probe, the boundaries genuinely differ at runtime: Claude's `'accepted'` follows the stdin
flush, Codex's follows the spawn attempt itself (an argv-embedded prompt is delivered unconditionally
the instant the process exists), and the conformance suite asserts both reach `'accepted'`, not that
one of them settles for the weaker `'unknown'` — `AcceptedWorkState` measures delivery, not whether
the CLI has acted on the prompt yet, and delivery is certain in both cases, just observed at a
different moment. An earlier draft of this mechanism read the accepted-work timing off the
manifest's `acceptedWorkBoundary` field instead of the probe's own `viaStdin` evidence, and got this
exact case wrong (marking Codex `'unknown'`) before an adversarial review caught it — see the note
directly below for why that approach was replaced.

### Fixed: a manifest hit can fail open where a manifest miss fails closed

The compatibility manifest's `acceptedWorkBoundary` field is a fact about a *specific, fixture-verified
CLI build* — it does not, and structurally cannot, track whether this repo's own adapter code still
transports the prompt the way that build was verified against. If an adapter's `promptViaStdin`
config were ever changed (e.g. `build-args.ts` switched a provider from argv to stdin) without the
manifest being updated to match, the manifest lookup would still find its entry (the CLI version
didn't change) and confidently report the *old* boundary — a **hit that fails open**, which is worse
than a miss: `acceptedWorkBoundaryFor(undefined)` already fails closed for an unrecognized version,
but a recognized version with a stale boundary claim had no equivalent protection. Concretely, a
`'first-prompt-byte-to-stdin'`-classified session whose adapter actually embeds the prompt in argv
would sit at `'not_accepted'` for the session's entire life, even after definitely delivering the
prompt — the exact "safe to retry" answer for work that already ran.

The fix (see `SessionLaunchProbe.onSpawnAttempt`'s `evidence.viaStdin` in `types.ts`, and
`session-supervisor.ts`'s launch-probe wiring) drives the accepted-work decision from
`runProviderSession`'s own, real `promptViaStdin` flag, reported at the exact call site that also
decides whether to write stdin — not from a separately-maintained manifest field. This makes the
drift structurally impossible: there is only one flag governing both what the adapter actually does
and what the supervisor assumes it did. The manifest's `acceptedWorkBoundary` column remains useful
documentation (see `docs/providers.md`) and drives fixture-set classification, but is no longer the
safety-critical input.

### Limitation: accepted-work state is in memory only

`AcceptedWorkLatch` lives in the supervisor object. **A daemon crash or restart loses it**, and a
session recovered after such a crash has no way to learn whether its provider had already accepted
work. That is a real gap, not a theoretical one: it is precisely the window in which an automatic
retry could duplicate a side effect in the user's working directory. Persisting acceptance across
restarts is **ADI-05's job**, and the ticket that does it should treat this paragraph as the
requirement.

**Closed by ADI-05.** `apps/daemon/src/session-lineage-store.ts` now persists accepted-work state
across a restart, driven by the same `SessionLaunchProbe` seam described above, and
`session-manager.ts` wires that seam on every session. See
[ADI-05's section below](#adi-05-durable-session-state-active-session-limits-and-the-v2-read-surface)
for what it records and for the one deliberate narrowing it makes: `'not_accepted'` is never written
to disk, because it is a positive safety claim that stops being provable the moment a record exists
at all.

### Limitation: `accountEvidence: 'cli_owned'` is not an account fingerprint

`FrozenLaunchScope` carries the literal `accountEvidence: 'cli_owned'`. This is a documented
limitation marker, not a capability. The strongest identity claim this repo can make is "the same
CLI binary, at the same version, reporting the same auth state", because `ProviderStatus`
(`packages/shared/src/provider.ts`) has no account identifier, no `authSource` discriminator, and
no `accountFingerprint` — and this repo's adapters never read a provider's credential storage, by
design (see [SECURITY.md](../SECURITY.md)).

Concretely: the scope **cannot** distinguish "the same CLI, still logged into the same account"
from "the same CLI, logged out and logged back into a *different* account between two launches".
Closing that needs new `ProviderStatus` fields that do not exist yet. The literal type keeps the gap
visible at every use site rather than letting a reader assume the scope binds to an account.

### The fallback gate is provably always-deny in the shipped configuration

`FallbackGate.authorize()` denies with `no_alternate_transport` whenever `alternateTransportIds` is
empty, and **nothing in this repo registers a second transport id**: `compatibility-manifest.ts`
defines exactly one (`legacy-one-shot`) and both adapters use it. So every reachable call today
denies. This is enforced by code and pinned by a test, not merely asserted in a comment:
`test/fallback-gate.test.ts` exhausts the full `AcceptedWorkState x ProviderDeliveryState x terminal`
product (18 cases) against an empty alternate list and requires a denial for every one. The rest of
the gate's rules are implemented and tested anyway, so that the ticket introducing a second transport
turns the gate on against already-reviewed logic rather than writing safety rules under deadline.

### One behavioral change that is not purely additive

`ProviderSessionHandle.cancel()` previously resolved once a kill signal had been *sent*, so a caller
that immediately cleaned up the working directory was racing a still-running process tree. It now
resolves only once the owned tree is **confirmed** reaped (POSIX polls the process group until
`ESRCH`; Windows waits on the Job Host's exit) and rejects on a reap timeout. The supervisor catches
that rejection and reports it as `SupervisedOutcome.reaped: false` rather than rethrowing, so a
caller learns the working directory may still be occupied instead of receiving an exception it is
likely to log and discard. Every pre-existing test in `packages/agent-runtime/test/`,
`apps/daemon/test/`, and `apps/desktop/test/` passes unchanged against this.

## ADI-05: durable session state, active-session limits, and the v2 read surface

ADI-05 (issue #123) is the ticket the ADI-04 limitation note above pointed at: it makes
accepted-work state survive a daemon restart. It also adds the first v2 HTTP surface this repo has,
and the first admission control on session creation.

Unlike ADI-03 and ADI-04, **this ticket is wired in**. `apps/daemon/src/index.ts` constructs the
store and the limiter, `session-manager.ts` uses both on every session, and the v2 routes are
registered whenever the store opened successfully. This is the first ADI change that alters the
behavior of a live session, and the shipped-dormant pattern the previous two used no longer applied:
a persistence layer with no caller persists nothing.

### What was ported, and what was reinvented smaller

| Area | Provenance |
|---|---|
| `apps/daemon/src/state-directory.ts` | **Ported in shape** from upstream's state-directory resolution (env override, then platform-native per-app-id root, 0700 creation). The product-database overlap guard is this repo's own: upstream has no `workspace.db`/`vacancy-engine.db` to collide with. App-id validation reuses `discovery-file.ts`'s existing `sanitizeAppId` rather than adding a second rule |
| `apps/daemon/src/durable-store/atomic-fs.ts` | **Ported in shape**: the temp-write / fsync / rename / fsync-parent sequence and the quarantine-never-delete rule are upstream's mechanics. The short-write retry loop and the `assertContainedIn` traversal guard are additions |
| `apps/daemon/src/session-lineage-store.ts` | **Reinvented, much smaller.** Upstream's equivalent is an execution-graph store built around interactive transports, mid-turn commands, and approval round-trips. This is a lineage-of-sessions store over the one transport this repo has, with the same durability contract and none of the graph |
| `apps/daemon/src/persisted-session-schema.ts` | **New.** There is no upstream counterpart: upstream persists richer event payloads, and this repo's rule is that no event content reaches the disk at all |
| `apps/daemon/src/active-session-limiter.ts` | **New.** Upstream's concurrency control is bound up with its session facade; this is a standalone, synchronous admission gate |
| `apps/daemon/src/routes/v2-providers.ts`, `routes/v2-sessions.ts`, `v2-legacy-provider.ts` | **Reinvented, much smaller.** Read-only projections over v1 data, with none of upstream's capability catalog |
| `packages/shared/src/session-v2.ts` | **New**, and deliberately not a port of upstream's `protocol-v2.ts` (see below) |

### What was explicitly deferred, and why

- **`POST /v2/sessions`.** Creating a session over v2 means accepting a capability-negotiation
  request schema. This repo has `capabilities-v2.ts` and `negotiation-v2.ts` from ADI-02, but no
  reviewed *request* shape for "start a session with these negotiated capabilities" — and inventing
  one inside a persistence ticket would freeze a public contract nobody scoped. Session creation
  stays on `POST /sessions` (v1), which now carries an optional `protocolVersion` internally so a
  future v2 create path shares one active-session budget with v1 rather than getting its own.
- **`v2-session-facade.ts` and `provider-v2.ts`.** Both exist upstream to mediate between rich
  transports and the store. With exactly one transport (`legacy-one-shot`) there is nothing to
  mediate, and `v2-legacy-provider.ts` — roughly seventy lines mapping a `ProviderStatus` plus a
  compatibility-manifest lookup into a read view — covers everything a read-only client can act on.
- **Upstream's `protocol-v2.ts`.** `session-v2.ts` models only the *read view* the five shipped
  routes return. Importing upstream's full v2 protocol would have brought a session-creation
  vocabulary with no producer, no consumer, and no test able to distinguish a correct implementation
  from a plausible one.

### ADI-04's accepted-work handoff is now closed

The "Limitation: accepted-work state is in memory only" section above records the gap this ticket
was asked to close: `AcceptedWorkLatch` lived in the supervisor object, and a crash lost it, leaving
a recovered session unable to say whether its provider had already been handed the prompt.

That is now resolved, with one deliberate narrowing. On disk, `acceptedWork` has only **two**
values, not three: `'unknown'` and `'accepted'`. `'not_accepted'` is structurally absent, and its
absence is the safety property. `'not_accepted'` is a positive claim that nothing was delivered and
retrying is safe, and the only moment that claim is provable is *before the record exists at all* --
by the time a record is on disk the daemon has already committed to launching, and a crash in the
next microsecond leaves nobody able to prove the prompt did not reach the CLI. So a record is
created `'unknown'` (fail-closed) and the single permitted transition is `unknown -> accepted`,
driven by the same `SessionLaunchProbe` seam ADI-04 added. Recovery carries the value across
verbatim and never downgrades it.

`session-manager.ts` wires the probe directly rather than going through
`superviseProviderSession()`. The supervisor's remaining machinery — the fallback gate, the frozen
scope comparison — still has no daemon-side consumer, and routing every live session through it to
reach one latch would have changed far more of the running system than this ticket needed. Wiring
the full supervisor in remains a later ticket; the seam it introduced is what made this one small.

The unknown-frame ledger is the one piece of that machinery the daemon does now consume, and it
consumes it the same way: `SessionManager` builds its own `UnknownFrameLedger` per session and
feeds it from the probe's `onUnknownFrame` callback, then writes `ledger.entries()` into the record
immediately before finalizing it. That keeps the persisted `unknownFrames` field honest (it was
otherwise designed, schema'd, and served by the v2 read routes while being permanently empty)
without a second copy of the bounding and hashing rules that make the field safe to store at all.

### Two stop conditions, both proven rather than asserted

1. **No event content on disk.** Enforced three ways: a `never` check in `redactEnvelope`'s default
   branch (a new `AgentEvent` variant without a redaction rule is a compile error), a runtime test
   that extracts the literal `type` values out of `agentEventEnvelopeSchema` and requires the
   redactor's covered set to match exactly, and `.strict()` Zod schemas that reject a record
   carrying `prompt` or `error`. A sentinel sweep fills every string field of every variant with a
   unique marker, runs it through the real store, and greps the entire on-disk tree.

   Digesting is not the only mechanism, because not every kept field *can* be digested. `model`,
   `providerSessionId`, and `toolCallId` are identifiers a reader acts on, so they are kept — and
   therefore **byte-capped at 256**, everywhere they are copied, exactly as `status` and `toolName`
   already were. A field that is kept verbatim and unbounded is a place to put content, however
   short its legitimate values are; the sentinel sweep covers these three too, asserting the
   oversized value is truncated to its cap rather than merely absent.
2. **A future schema version mutates nothing.** The store's constructor runs a read-only preflight
   before creating a directory or opening any file for writing.
   `session-lineage-store.schema.test.ts` asserts this with a recursive content+mtime snapshot
   *and* with `node:fs` spies showing zero write, rename, or unlink calls — including in the case
   where corruption is present alongside the future version, where the corrupt file must be left
   un-quarantined because quarantining is itself a mutation.

   The preflight's coverage is defined by what the *rest of startup* would touch, not by what is
   convenient to parse: the manifest, every record, every tombstone, every stray `.tmp`, every
   `events/*.jsonl`, and everything staged under `.trash/`. The last two are the ones a
   `schemaVersion`-only sweep misses. An event log carries `v` per line rather than a top-level
   `schemaVersion`, and a newer build's lines would fail *this* build's line schema — which
   `#repairEventLog` would read as a torn tail and rewrite. A `.trash/` entry is an eviction the
   newer build had not committed, which recovery either renames back into `lineages/` or deletes
   outright. Both are mutations on state belonging to software this build does not understand, so
   both are now scanned first. Lines that merely fail to parse, or that carry no numeric `v`, are
   deliberately *not* treated as a version conflict: that is ordinary corruption, and the corruption
   path is where it belongs.

### The event counter keeps its meaning past the truncation cap

`eventCount` is documented to answer "how many events did this session emit", which is a different
question from "how many lines are on disk" — the pair `eventCount: 40000, eventsTruncated: true`
means something a line count cannot say. Below the 5,000-line cap the record is only checkpointed
(at the truncation flip, accepted-work, scope refinement, finalization) and recovery reconciles with
`max(persisted eventCount, lines on disk)`, because the log is durable per line and can speak for
the counter.

Above the cap that stops being true: no line is appended, so `max(...)` would freeze at exactly
5,000 forever no matter how many more events arrived, collapsing the distinction back into the line
count. So every *suppressed* event now checkpoints the record. The cost lands only on a session that
has already persisted 5,000 events, and it replaces an append to a growing log with a replace of one
small fixed-size record; the common case is untouched.

### Known limitation: the state-directory overlap guard is not enforced for the daemon's own default

`resolveStateDirectory` refuses a state root that overlaps `workspace.db` or `vacancy-engine.db` --
but only for a caller that can name those paths. The daemon cannot: both live under Electron's
`app.getPath('userData')`, which is not resolvable from a plain Node process. What actually keeps
them apart in the shipped app is `apps/desktop/electron/main.ts` setting `AGENT_DOCK_STATE_DIR` to a
dedicated `agentdock-state/` subdirectory. `open-durable-store.ts` passes no reserved paths and says
so in a comment rather than inventing a check against guessed paths, which would look like
protection while verifying nothing. Closing this properly needs the desktop app to pass its database
paths to the daemon explicitly; that is a real gap this ticket leaves open, not one it claims to
close.
