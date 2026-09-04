# AGENTS.md - AI Agent Coding Guide

This guide is for AI coding agents working in the ai-space repository. Read it before changing code. Human contributors follow the same rules.

## Project Snapshot

ai-space is a workspace for AI-related experiments and tools, written in TypeScript and run with Bun. Bun handles dependency installation, running, testing, and building. The project is at an early stage; the directory layout will evolve as modules are added. Update the Repository Map below whenever you add a directory.

## Language

English is the default language of this repository. Write code identifiers, comments, documentation, commit messages, issues, and PR descriptions in English.

## Work Style

- Keep changes focused on one problem.
- Prefer existing patterns in the file or nearby module over new abstractions.
- Avoid unrelated formatting, renames, dependency changes, or broad rewrites.
- Add or update tests when behavior changes.
- Update docs when setup, commands, or user-facing behavior changes.
- For new features, larger refactors, new dependencies, or runtime changes, open an issue or state the motivation in the PR description before starting.
- Run the local checks in [Validation](#validation) before every push. Do not push unverified code.

## Stack And Conventions

- TypeScript with `strict` mode and ESM imports. Local imports include the `.ts` extension (`allowImportingTsExtensions`).
- Bun 1.3+ as runtime and package manager: `bun install`, `bun run`, `bun test`. Do not use npm, yarn, pnpm, node, ts-node, jest, or vitest.
- Prefer Bun built-in APIs (`Bun.serve`, `Bun.file`, `bun:sqlite`, `Bun.$`). See [CLAUDE.md](CLAUDE.md) for Bun-specific conventions.
- Dependencies are locked in `bun.lock`; commit it together with the change that touched it.
- Configuration and secrets go through environment variables or `.env` (ignored by git). Never commit credentials.
- Scripts and commands live in `package.json`, not only in chat history.

## Repository Map

- `src/` - source code. Entry point is `src/index.ts` (boots Space services and serves the Space API). Tests sit next to the code they test and are named `*.test.ts`.
- `src/space/` - Space layer services shared by every app. One directory per service. `workspace.ts` defines the `~/.ai-space` layout, creates it, discovers apps and loads the workspace `.env`.
- `src/space/scheduler/` - scheduled tasks: `types.ts` (data model), `schedule.ts` (at/every/cron next-run math), `store.ts` (bun:sqlite), `targets.ts` (http/command/agent runners), `manifest.ts` (`space.yaml` parsing), `scheduler.ts` (engine), `api.ts` (HTTP routes). Design notes in `docs/scheduler.md`.
- `src/space/storage/` - per-app storage: `types.ts` (data model), `db.ts` (open by URL on Bun's `SQL`, migrations), `spec.ts` (`storage:` manifest section), `storage.ts` (database and blob store provisioning, inventory, `space.env`), `api.ts` (HTTP routes). Design notes in `docs/storage.md`.
- `data/` - runtime data (SQLite), ignored by git.
- `docs/` - project documentation and diagrams. `docs/architecture.svg` is the architecture figure used in the README.
- `package.json` - scripts and dependencies; `bun.lock` is the lockfile.
- `tsconfig.json` - TypeScript configuration (strict, bundler mode, noEmit).
- `AGENTS.md` - this file, the agent working guide.
- `CLAUDE.md` - Bun usage conventions.
- `deploy/` - `ai-space.service` (user-level systemd unit), `install.sh` (installs the unit on a machine), `post-receive` (bare-repo hook for git-push deploys).
- `.env.example` - configuration template for `~/.ai-space/.env`.
- `.gitignore` - global ignore rules.

Add a line here when you add a directory.

## Commit Format

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

Rules:

- `type` is required; see the table below.
- `scope` is optional and names the affected module or area, for example `launcher`, `deps`, `release`, `typecheck`. Omit the parentheses when there is no clear scope.
- `subject` is in English, lowercase first letter, imperative mood, no trailing period, at most 72 characters.
- Append `(#123)` to the subject when the commit belongs to a PR or closes an issue.
- The body explains why, not what. Put breaking changes in the footer as `BREAKING CHANGE: ...`.
- Reverts use git's default format: `Revert "<original subject>"`.

| type        | use for                                                       |
| ----------- | ------------------------------------------------------------- |
| `feat`      | a new feature                                                 |
| `fix`       | a bug fix                                                     |
| `docs`      | documentation only                                            |
| `chore`     | build, release, dependency bumps, tooling config, housekeeping |
| `refactor`  | code change that neither fixes a bug nor adds a feature       |
| `perf`      | performance improvement                                       |
| `test`      | adding or updating tests                                      |
| `style`     | formatting only, no logic change                              |
| `ci`        | CI configuration and scripts                                  |
| `build`     | build system or external dependency changes                   |
| `hardening` | security hardening, permission tightening, path isolation     |
| `revert`    | reverting a commit (usually via git's `Revert "..."`)         |

Examples:

```
feat(zai): add GLM-5.3-Flash Coding Plan support (#2185)
fix(launcher): route direct Node launch paths through launcher
fix(deps): ship a zero-warning, minimal install (#1784)
chore(main): release 0.30.0 (#2165)
chore: centralize Bun version and refresh CI tool pins (#1123)
docs: add security policy
docs: tighten PR review expectations in CONTRIBUTING and AGENTS
hardening: isolate third-party paths and clean external-build inputs
Revert "fix(release): synchronize web changelog entries (#2100)"
```

Non-compliant examples:

```
update stuff              # missing type
Fix: Bug                  # capitalized type and subject, no information
feat(api): 添加登录接口。   # subject must be English, no trailing period
```

Agent-generated commits follow the same format and keep any tool-required trailer lines (such as `Co-Authored-By`) at the end of the body.

## Validation

Before every push, the following must pass:

```bash
bun install
bun run typecheck
bun test
```

Or run all of it with `bun run check`. While iterating, narrow the scope with `bun test ./src/path/to/file.test.ts`, but run the full check before pushing. Do not bypass failing checks. If a failure is pre-existing, verify it against the current base and document the evidence in the PR.

## Things To Avoid

- Do not switch the Bun runtime, package manager, or build tooling without prior agreement, and do not introduce Node-only toolchains.
- Do not add dependencies without clear project benefit.
- Do not skip tests for behavior changes.
- Do not commit `.env` files, secrets, tokens, or personal data.
- Do not overwrite remote branches with `git push --force`; use `--force-with-lease` when a rewrite is intended.
- Do not ignore review feedback. Decline out-of-scope suggestions with justification instead of silently dropping them.
- Do not surface-patch recurring review findings; repeated fix requests usually indicate a design issue, so find and fix the root cause.
