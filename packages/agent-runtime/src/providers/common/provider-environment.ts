/**
 * The environment a spawned provider CLI is allowed to see (ADI-15, issue #159).
 *
 * Before this module, `spawnProcess` defaulted to `env: opts.env ?? process.env`: every `claude`
 * and `codex` child inherited the daemon's **entire** environment. That was written down as a
 * deliberate tradeoff (SECURITY.md's former "Environment inheritance (a deliberate tradeoff, not an
 * oversight)" section, now replaced by "Environment allowlist for spawned provider processes"), and
 * the reasoning was real -- a CLI that cannot find its own config reports a false "not authenticated",
 * which is a worse failure than an over-broad environment. What the tradeoff was missing is that
 * the safe subset was never actually *measured*: it was assumed to be hard to get right, so it was
 * never attempted. It is measured now, against the real installed binaries, and it works.
 *
 * ## The two-list model
 *
 * The same shape `providers/claude/build-args.ts` already uses for tool restriction: a positively
 * stated allowlist, plus a deny list applied independently of it.
 *
 * 1. **Required allowlist** -- the platform and provider-config variables a CLI genuinely needs to
 *    locate its own executable, config, credentials, and temp storage. Stated positively so that a
 *    variable introduced by some future dependency is not granted by default. The failure mode of
 *    drift is therefore fail-closed (something we did not anticipate goes missing, visibly) and
 *    never fail-open (something we never reviewed reaches a provider child).
 *
 * 2. **Always-enforced deny list** -- a name must be allowlisted *and* not denied, so a
 *    credential-shaped variable can never reach a child even if a later edit adds an overlapping
 *    name to the allowlist. Note this is a conjunction, not an evaluation order: "deny wins" is a
 *    statement about the result, and there is no observable difference between testing deny first
 *    or second. Nothing on the allowlist matches the deny list today, which means the deny branch
 *    never fires in production and its veto cannot be observed by ordinary use --
 *    `denyOverridesAllowlist` in the tests constructs the overlap on purpose so the veto is
 *    exercised rather than merely asserted.
 *
 * ## What this does and does not protect
 *
 * This bounds what the **daemon hands a child**. It deliberately does not touch what the CLI reads
 * from its own on-disk state once running (OAuth session files, keychain entries), which remains
 * the CLI's own business per this repo's standing "never read a provider credential" invariant.
 * A provider CLI still authenticates exactly as it did before -- verified, not assumed; see the
 * measurement note on `WINDOWS_REQUIRED_VARIABLES`.
 *
 * The concrete exposure this closes in *this* product is not hypothetical. `packages/vacancy-
 * engine/src/config.ts` reads this product's own vacancy-source credentials (`AI_API_KEY`,
 * `BRAVE_SEARCH_API_KEY`, `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`, `JOOBLE_API_KEY`, `REED_API_KEY`,
 * `JOBSPIPE_API_KEY`) straight out of `process.env`, and `apps/desktop/electron/main.ts` spawns the
 * daemon with `{ ...process.env, ... }`. So on a machine where those are exported, they reached the
 * daemon and then every provider child verbatim. (The daemon's *keyring*-backed MCP credential
 * store, `apps/daemon/src/mcp/credential-store.ts`, was checked and is **not** part of this
 * exposure: it never places a secret in any environment. The env-backed vacancy-source keys are the
 * real path, and `ADZUNA_APP_ID` is a good illustration of why the allowlist is the load-bearing
 * half -- it matches none of the credential-shaped deny patterns and is excluded only because it
 * was never granted.)
 */

/** The result of applying the two-list policy to a parent environment. */
export interface ProviderEnvironment {
  /** The environment to hand the child. Null-prototype, so a variable literally named `__proto__`
   * is an ordinary key rather than an assignment to the object's prototype. */
  env: NodeJS.ProcessEnv;
  /**
   * The **names** of the variables this policy removed, sorted, for logging and debugging.
   *
   * Names only, never values: a dropped variable's value is exactly the thing most likely to be a
   * secret, so this type gives a caller no way to log one by accident.
   *
   * Read this as "dropped by policy", not "absent from the child": on Windows the process runtime
   * re-injects a fixed set of platform variables regardless of what is passed here (see
   * `WINDOWS_RUNTIME_INJECTED_VARIABLES`), so a few names can appear in both this list and the
   * child. None of them are credential-shaped, and the deny list is checked against that set by
   * test, but overstating the guarantee here would be the wrong kind of documentation.
   */
  dropped: string[];
}

/**
 * Windows platform variables a provider CLI needs.
 *
 * **Measured, not asserted** -- this is the claim the old tradeoff reasoning could not make. On a
 * real Windows 11 machine against the real installed binaries (`claude` 2.1.228 at
 * `C:\Users\<user>\.local\bin\claude.exe`, `codex-cli` 0.147.0 at
 * `...\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`), an environment restricted to exactly
 * this list left all of the following succeeding, byte-identical to a full-inheritance run:
 *
 * - `where claude` / `where codex` (the PATH lookup `detect-executable.ts` itself performs)
 * - `claude --version`, `codex --version`
 * - `claude auth status --json` -> `{"loggedIn": true, "authMethod": "claude.ai", ...}`
 * - `codex login status` -> `Logged in using ChatGPT`
 *
 * That last pair is the important one: **OAuth** authentication is unaffected, resolving through the
 * CLI's own on-disk state with no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` present -- which is the
 * arrangement this repo wants. A per-variable removal sweep additionally showed `PATHEXT` to be
 * independently load-bearing (without it `where` cannot match `claude.exe` and executable detection
 * fails outright).
 *
 * State the limit of that claim precisely, because "authentication is unaffected" full stop would be
 * an overclaim: what was measured is OAuth. **Environment-variable-based authentication is
 * deliberately no longer supported** -- see `PROVIDER_ENVIRONMENT_DENY_PATTERNS` for which
 * configurations that covers and why the tradeoff is taken knowingly rather than by omission.
 *
 * The sweep found the remaining entries individually removable *for those specific checks*. They
 * are kept anyway, deliberately: a version/auth probe is a small fraction of what a real session
 * does (update checks, cache and config writes, MCP config reads), these are non-secret platform
 * paths rather than anything sensitive, and the stop condition on this work is explicitly that
 * over-restriction causing a false "not authenticated" is a real regression. Minimality is not the
 * goal; *reviewed* breadth is.
 *
 * ## A consequence worth stating outright: this bounds the session's tools too
 *
 * A provider CLI is not the only thing running under this environment. Everything the agent invokes
 * *inside* a session -- build commands, test runners, `git`, an MCP server it starts -- inherits it
 * as well, because those are descendants of the child this module bounds. `PATH` survives, so most
 * ordinary tooling still resolves, but toolchain variables do not: `JAVA_HOME`, `CARGO_HOME`,
 * `GOPATH`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `PYENV_ROOT`, `NVM_DIR`, `ANDROID_HOME`, `NODE_OPTIONS`
 * and friends are all dropped, and `SSH_AUTH_SOCK` is denied outright, so agent-forwarded `git push`
 * over SSH will not work from inside a session.
 *
 * That is the intended posture -- an SSH agent socket handed to a process that reads untrusted
 * scraped job postings is exactly the kind of authority this ticket exists to withdraw -- but it is
 * a real behavior change for a toolchain-heavy workspace, and it fails in ways that will not look
 * like an environment problem. Written down here so it is a named consequence rather than a
 * discovery.
 *
 * Re-verify by hand when `compatibility-manifest.ts`'s pinned CLI versions change -- the same
 * discipline `CLAUDE_HARDENED_TOOLS` already requires, and for the same reason: this repo's test
 * suites deliberately never install a provider CLI, so CI cannot re-run this measurement.
 */
export const WINDOWS_REQUIRED_VARIABLES = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE',
] as const;

/**
 * POSIX platform variables a provider CLI needs.
 *
 * Marked honestly: unlike the Windows list above, this one was **not** empirically re-verified --
 * no macOS or Linux machine was available while this was written, exactly the caveat SECURITY.md
 * already carries for the POSIX process-group termination path. It is the direct structural
 * analogue of the verified Windows list (`HOME` for `~/.claude` and `~/.codex`, `TMPDIR` for temp
 * storage, the XDG roots the CLIs honor on Linux), so treat it as documented intent pending a
 * first-run verification on those platforms.
 *
 * `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are here for one specific reason rather than for
 * completeness: on Linux a credential lookup through libsecret/gnome-keyring goes over the session
 * D-Bus, and without both of these that lookup fails and the CLI reports itself not logged in. That
 * is the exact false "not authenticated" this work's stop condition names, and it is the most likely
 * concrete way the unverified-POSIX caveat above would have bitten. Neither carries a secret; they
 * are a socket directory and a bus address.
 *
 * `TERM` is excluded on purpose rather than overlooked: it is what a CLI keys off to decide whether
 * to emit ANSI control sequences, and this repo parses provider stdout as JSONL. Leaving it out
 * keeps that stream plain, and stdout is a pipe here in any case.
 */
export const POSIX_REQUIRED_VARIABLES = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

/**
 * Each provider's own documented config-namespace variable, plus the network-reachability
 * variables both need on a managed network.
 *
 * `CODEX_HOME` and `CLAUDE_CONFIG_DIR` relocate where a CLI looks for its own config and
 * credentials. Dropping them would not be "safer": it would silently point an intentionally
 * relocated CLI at the default directory and produce precisely the false "not authenticated" this
 * work's stop condition names.
 *
 * The proxy and CA variables are a **named residual**, not an oversight. Without them a provider
 * CLI behind a corporate proxy or a TLS-inspecting gateway cannot reach its own auth endpoint at
 * all -- again a false "not authenticated". The cost is that a proxy URL is one of the few
 * non-credential-shaped values that can legitimately embed credentials
 * (`http://user:pass@proxy.example`), and no name-based deny pattern can see that. That is stated
 * here rather than left implicit: the alternative is breaking every proxied install, and the
 * daemon has no way to tell the two cases apart from the variable name.
 *
 * `ALL_PROXY` is included alongside the HTTP pair because Codex is a Rust binary and reqwest honors
 * it -- omitting it would silently break exactly one population (a SOCKS proxy) while the reasoning
 * above claims to cover proxied installs generally.
 */
export const PROVIDER_CONFIG_VARIABLES = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/**
 * The variables the Windows process runtime adds to **every** child regardless of what environment
 * is handed to it. Not a policy decision of this module -- libuv's `make_program_env` merges its
 * `required_vars` list in from the real parent environment, so `spawn(..., { env: {} })` still
 * produces a child with exactly these eleven.
 *
 * Verified directly on this machine rather than taken from the source: spawning
 * `node -e "process.stdout.write(JSON.stringify(process.env))"` with `env: {}` returned precisely
 * these names and nothing else.
 *
 * Recorded here because a test asserting "the child's keys are a subset of the allowlist" would
 * otherwise be quietly wrong on Windows, and padding the allowlist with these to make that test
 * pass would hide a real platform fact behind a green check. None is credential-shaped, all carry
 * the parent's real values, and `deniedNamesAreDisjointFromRuntimeInjected` in the tests keeps that
 * true: if a future deny pattern ever started matching one of these, the runtime would silently
 * re-add it and the deny would be a fiction. The test fails instead.
 */
export const WINDOWS_RUNTIME_INJECTED_VARIABLES = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const;

/**
 * Name patterns that are dropped no matter what: a granted name must clear the allowlist *and* this
 * list, so a match here vetoes a grant.
 *
 * Two groups, kept separate because they justify themselves differently:
 *
 * - **Credential-shaped**, by convention rather than by any registry: the substrings and vendor
 *   prefixes that real-world tooling overwhelmingly uses for secrets. This is a backstop, not the
 *   primary control -- the allowlist is what actually bounds the environment. A pattern list alone
 *   would be a denylist, and a denylist is exactly the thing this module is not.
 * - **This product's own internals**: `AGENT_DOCK_*` (`AGENT_DOCK_STATE_DIR`, `AGENT_DOCK_APP_ID`,
 *   `AGENT_DOCK_PORT`, `AGENT_DOCK_LOG_LEVEL`), Electron's own injections, and the vacancy-source
 *   credential names from `packages/vacancy-engine/src/config.ts`. None of these would pass the
 *   allowlist anyway. They are listed regardless because "a provider child never sees the daemon's
 *   own state" should be an explicit, tested guarantee rather than a lucky consequence of the
 *   allowlist happening to be narrow -- if someone later widens the allowlist, this still holds.
 *
 * ## What this deliberately breaks
 *
 * Denying `^ANTHROPIC_` and `^OPENAI_` is not free, and calling it free would be the overclaim this
 * module is otherwise careful to avoid. Three real configurations stop working, none of them
 * recoverable by the user, since a name must clear both lists and no allowlist entry can re-enable a
 * denied one:
 *
 * - **API-key auth.** A user who authenticated the CLI with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
 *   rather than OAuth. That this is a real configuration is visible in this repo already:
 *   `parseCodexLoginStatus` recognizes a "Logged in using API key" state.
 * - **Bedrock routing** (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `AWS_*`).
 * - **Vertex routing** (`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`,
 *   `GOOGLE_APPLICATION_CREDENTIALS`).
 *
 * Taken knowingly. A long-lived API key or a set of cloud credentials handed to a process that reads
 * untrusted scraped job postings and can reach the network is precisely the authority this ticket
 * exists to withdraw, and this product's whole premise is the CLI's own on-disk OAuth session. But
 * an affected user's symptom is a false "not authenticated", so it is recorded here and in
 * SECURITY.md rather than left for them to rediscover. Re-enabling any of it is a deliberate policy
 * decision to be made here, in review -- not a flag.
 *
 * Note on the discovery token specifically: it is **not** an environment variable at all. It is
 * generated per launch and written to a `0600` discovery file (`apps/daemon/src/discovery-file.ts`),
 * read back by Electron and held in memory. It was checked for, and there is nothing here to deny.
 * `AGENT_DOCK_*` is denied on its own merits, not as a proxy for the token.
 */
export const PROVIDER_ENVIRONMENT_DENY_PATTERNS: readonly RegExp[] = [
  // Credential-shaped by convention.
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /PRIVATE_KEY/i,
  /API_?KEY/i,
  /_KEY$/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^GOOGLE_APPLICATION_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^NPM_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^SSH_/i,
  /^VAULT_/i,
  // This daemon's and this product's own internals.
  /^AGENT_DOCK_/i,
  /^ELECTRON_/i,
  /^OVR_/i,
  /^VITE_/i,
  /^AI_/i,
  /^BRAVE_SEARCH_/i,
  /^ADZUNA_/i,
  /^JOOBLE_/i,
  /^REED_/i,
  /^JOBSPIPE_/i,
];

/** True when a variable name must be dropped regardless of any allowlist. */
export function isDeniedProviderEnvironmentName(name: string): boolean {
  return PROVIDER_ENVIRONMENT_DENY_PATTERNS.some((pattern) => pattern.test(name));
}

/** The full set of names granted on a platform, before the deny list is applied. */
export function providerEnvironmentAllowlist(platform: NodeJS.Platform): readonly string[] {
  const platformVariables =
    platform === 'win32' ? WINDOWS_REQUIRED_VARIABLES : POSIX_REQUIRED_VARIABLES;
  return [...platformVariables, ...PROVIDER_CONFIG_VARIABLES];
}

export interface BuildProviderEnvironmentOptions {
  /** Test seam only. Production reads the real platform. */
  platform?: NodeJS.Platform;
  /**
   * Test seam only. Replaces the allowlist so the deny list's veto over a granted name can be
   * exercised, which is the whole reason this seam exists: the two lists are disjoint in the shipped
   * configuration, so the deny branch never fires and without this its effect could only be
   * asserted. The deny list still applies to whatever is passed here -- that is the property under
   * test, and it is why this seam cannot be used to widen the policy.
   */
  allowlistOverride?: readonly string[];
}

/**
 * Applies the two-list policy to a parent environment and returns what a provider child may see.
 *
 * Matching is platform-correct in one direction and deliberately stricter in the other. Windows
 * environment variables are case-insensitive, so the allowlist is matched case-insensitively there
 * and case-sensitively on POSIX, where `Path` and `PATH` really are two different variables. The
 * deny list is matched case-insensitively on **every** platform: a lowercase `aws_secret_access_key`
 * on Linux should be dropped whether or not this repo's allowlist would ever have granted it, and
 * fail-closed is the correct asymmetry for the list whose job is to be a backstop.
 *
 * Original key casing is preserved rather than canonicalized: rewriting `ProgramFiles` to
 * `PROGRAMFILES` would be a gratuitous behavior change on a platform that does not care, and a
 * breaking one on a platform that does.
 */
export function buildProviderEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  options: BuildProviderEnvironmentOptions = {},
): ProviderEnvironment {
  const platform = options.platform ?? process.platform;
  const allowlist = options.allowlistOverride ?? providerEnvironmentAllowlist(platform);
  const caseInsensitiveAllow = platform === 'win32';
  const allowed = new Set(
    allowlist.map((name) => (caseInsensitiveAllow ? name.toLowerCase() : name)),
  );

  const env = Object.create(null) as NodeJS.ProcessEnv;
  const dropped: string[] = [];

  for (const [name, value] of Object.entries(parentEnv)) {
    // An explicitly-unset variable is not a value to forward, and forwarding it as `undefined`
    // would land in the child as the literal string "undefined" on some paths.
    if (value === undefined) continue;
    const isAllowed = allowed.has(caseInsensitiveAllow ? name.toLowerCase() : name);
    // A conjunction, not an evaluation order: a name must be granted *and* not denied. "Always
    // enforced" means the deny list cannot be escaped by being on the allowlist, not that it is
    // tested at a particular moment.
    if (isAllowed && !isDeniedProviderEnvironmentName(name)) {
      env[name] = value;
    } else {
      dropped.push(name);
    }
  }

  dropped.sort();
  return { env, dropped };
}
