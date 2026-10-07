# Claude Code instructions

@AGENTS.md

`AGENTS.md` is the single source of the repository's agent rules, and the full workflow is in [docs/AGENT_TEAM_PLAYBOOK.md](docs/AGENT_TEAM_PLAYBOOK.md). Read both before changing anything.

Claude Code specifics:

- A subagent receives this file but not the parent conversation. Put the task brief from the playbook in the subagent prompt, with the owning issue, owned paths, acceptance criteria, non-goals and the external content trust boundary.
- Do branch work in a worktree outside the main checkout, never in the main checkout.
- Product runtime sessions started by the daemon run with `--safe-mode` and an empty `--setting-sources`, so they do not read this file. Rules that must reach them belong in the prompt builders listed in the playbook.
