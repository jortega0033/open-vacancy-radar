# Move landing-page cloud ownership to the new account

Date: 2026-11-01, Europe/Amsterdam. Owner-requested migration, independent of the passive L1 loop.

## Decision and scope

Move the existing GCP/Firebase project intact from `ortegavialeigh@gmail.com` to `vialeighortega@gmail.com`, in organization `772038913203`. Preserve project ID `ovr-landing` (662399741047), user Hosting site `ovr` at `https://ovr.web.app`, and default site `ovr-landing`. The project originally had no parent organization and no billing account. Preserve its free Spark/no-billing setup.

The migration does not move desktop SQLite workspaces, vacancy data, desktop releases, installed Claude/Codex authentication or personal API keys. `apps/landing` is a static four-file website; no desktop build is necessary to deploy it. Firebase target `landing` selects site `ovr`. No custom domain is configured and no DNS update is needed.

Resource Manager v3 accepted move operation `operations/rm.4641980264433121232`, and it completed with parent `organizations/772038913203`. This changes the project's parent rather than copying Hosting resources. Google's no-organization migration cannot be reversed to no organization without Cloud Customer Care.

## Repeatable operations

Use `pnpm deploy:landing`; it pins project, target and account. Terraform in the private `jortega0033/cloud-infrastructure` repository adopts the existing project/Firebase/sites and manages a dedicated deployment service account and repository/branch-restricted GitHub OIDC. Hosting content remains managed by Firebase CLI. No personal Firebase token or service-account key is stored in GitHub.

Terraform code is intentionally kept out of this public application repository. Its private repository documents the remote-state backend and its administrative dependency, so this Spark project does not need paid storage or billing enabled. Credentials, state and plans are never committed to either repository.

## Verification and cleanup

Cloud account migration is complete. The new account accepted Owner access and deployed all four landing-page files successfully with the pinned `pnpm deploy:landing` command. HTTPS checks for the homepage, stylesheet, script and favicon all returned HTTP 200. Both Hosting sites remain present. Billing remains disabled, with no account attached.

Private Terraform adoption completed across two applies: four existing resources imported, ten identity/API resources added, one project-label update in place, zero resources destroyed. The follow-up plan reports no changes. A transient IAM propagation failure while creating the identity pool was resolved without weakening organization policies.

The old account's Owner and temporary Project Mover project grants, plus temporary destination-organization Project Creator/Project Mover grants, were removed. After propagation, its project list excludes `ovr-landing`; testIamPermissions returns no permissions for project view/delete/IAM changes or Hosting updates. The only human project Owner is the new account. Old CLI logins remain available for other projects awaiting migration.

The public workflow/instruction changes are in PR #724. The protected default branch requires one independent approval and the repository's existing checks before merge. Consequently the new GitHub OIDC workflow has not yet deployed from `master`; its first post-merge run must be checked separately. This does not block the already verified account transfer/direct deployment. Never delete this production project as cleanup: no separate old copy exists.

Pre-existing edits to `STATE.md`, `loop-run-log.md`, and untracked `.claude/settings.local.json` are outside migration scope and must remain untouched.

## Evidence

[Google migration special cases](https://docs.cloud.google.com/resource-manager/docs/handle-special-cases), source/final URL match; retrieved 2026-11-01T20:22:48.623Z via crawl4ai-podman. Evidence `dcfbc111950bfbbae52a98c0fe30280d4bbd85d6ec9191c468f7e840fc3d4e29`; SHA-256 `a3208fb70d1d797065eec1ab5ca4b65170a10d3db392a5ea2f25f119a541e0a7`.
