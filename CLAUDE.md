# CLAUDE.md

Nightly sync of the user's own bank transactions, from one or more banks, via the Enable Banking API, into per-account JSON files; an import for exported files; and later a dashboard that categorises the archive by rules.

Read docs/architecture.md first. The design lives in docs/ (archive-format.md, sync.md, dashboard.md, infra.md, testing.md). This file holds rules for working in the repo, and does not repeat the design.

## Data protection: hard rules

The production system handles real bank data. That data must stay in the EU, so it must never reach git, this directory, your context, or anything you send elsewhere.

- **This directory never holds real data.** No real archive, session state, private key or production config lives here, so there are no `data/`, `state/` or `secrets/` folders. If one ever appears, or a file looks like real bank data, stop and tell the user. Do not open it, with any tool, Bash included.
- **Never touch production.** Do not SSH to the host, run the CLI against production credentials, or read production logs, backups or the infra vault. Production runs, including `auth`, are done by the user.
- **All data here is synthetic.** `fixtures/archive/` is written by `fixtures/generate.ts` and is safe to read. Never derive a fixture, a test literal or an example from real data. If you need the shape of real data, ask the user for a redacted sample, and copy its shape by hand, never its values.
- **Every invented IBAN uses check digits `00`** (`NL00...`), which can never be valid. A test enforces this for the archive.
- **Sandbox runs** use `.env.sandbox` with the Enable Banking sandbox application, and `DATA_DIR`/`STATE_DIR` under `tmp/sandbox/`.
- **Logs contain counts, dates and keys only.** No amounts, IBANs, names or descriptions. In production, job output is sent to an external monitoring service.
- **This repository is public.** Nothing that names the production host, and no credential of any kind, sandbox included, may be committed.
- **No bank is named, anywhere.** Not in code, docs, tests, fixtures, commit messages or examples. That includes the column headers of a real bank's export file, which identify the bank. Examples use made-up banks (`bnka`, `Example Bank`). Real banks, accounts, import formats and category rules are production configuration.
- Never weaken `.gitignore` or `.claude/settings.json`.

## Commands

- `npm test`: run all tests, with the timezone pinned
- `npm run typecheck`: type-check (`tsc --noEmit`)
- `npm run lint`: ESLint. `npm run format`: Prettier, writing. `npm run format:check`: Prettier, checking.
- `npm run fixtures`: regenerate `fixtures/archive/` after changing the generator. Never edit the year files by hand; a test fails if they drift from the generator.
- The pre-commit hook (`.githooks/pre-commit`) runs typecheck, lint, format check and tests on the whole repo. Never bypass it with `--no-verify`.
- Once `sync` exists: `node --env-file=.env.sandbox sync/src/cli.ts <auth <bank> | sync | status | import <format> <file>>`, against the sandbox only.

## Code conventions

- **Functional style.** All logic (fetch window, merge, partitioning, validation) is pure functions over immutable data. I/O stays at the edges and is passed in, including the clock, so tests need no mocks.
- **Readability first.** Small modules, explicit names, no cleverness.
- **No silent error handling.** No empty `catch`, no defaults that paper over missing data, no partial writes. Fail loudly and exit non-zero.
- **Validate at the boundary.** Check API responses on arrival and fail on unexpected shapes, rather than guessing.
- **Dependencies follow docs/architecture.md.** `shared`, `sync` and `api` have no runtime dependencies beyond other workspaces; a test enforces it. `app` may have a few, each chosen deliberately. Ask before adding any dependency, runtime or development, anywhere; prefer FOSS.
- **Development dependencies today:** `typescript`, `@types/node`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `prettier`. `typescript` stays on 6.x until `typescript-eslint` supports 7.

## TypeScript without a build step

Node strips types and runs `.ts` files directly; it never type-checks. This applies to everything Node runs. Only `app` is bundled.

- Erasable syntax only: no `enum`, `namespace`, parameter properties or `import =`.
- Relative imports include the `.ts` extension. Type-only imports use `import type`.
- `package.json` sets `"type": "module"`. `tsconfig.json` sets `strict`, `noEmit`, `module: "nodenext"`, `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`.
- `tsc --noEmit` must pass.

## Configuration

Defined in docs/sync.md and docs/dashboard.md. In short: secrets and paths come from environment variables (documented in `.env.example`), and banks, accounts and import formats from one JSON file at `CONFIG_PATH`. Production config exists only on the host. Sandbox config lives in `.env.sandbox` and `tmp/`, both gitignored. Every command validates its configuration at startup and fails if anything is missing or wrong.

## Layout

npm workspaces, each a package named `@money/<name>`. The reasoning is in docs/architecture.md.

```text
shared/            pure core: archive format, merge, normalised view,
                   configuration, categorising
sync/              the command line: auth, sync, status, import
api/               the dashboard's server
app/               the dashboard's interface, in the browser
fixtures/
  household.ts     what the invented household did
  world.ts         its accounts, and how each reaches the archive
  dates.ts         date helpers for the generator
  generate.ts      feeds it through the real merge
  archive/         generated
  config.json      generated
scripts/           repository checks
docs/              durable design docs, flat
  specs/           one dated spec per slice
tmp/               gitignored: sandbox data, state and key
```

Tests sit next to the code as `*.test.ts`.

## Testing

docs/testing.md is the reference. In short:

- **Tier 0:** `tsc --noEmit`, ESLint, Prettier, and the fixture-freshness test.
- **Tier 1:** unit-test every pure function with `node:test`: merge, the normalised view, the fetch window, import, categorising. Write these first.
- **Tier 2:** run the real `sync` against the in-memory fake bank and a temporary directory. Property-based: any sequence of fetch windows converges to the same files, and nothing is ever lost.
- **Fakes, not mocks.** Inject the clock, `fetch` and the filesystem root; replace them with small real implementations.
- **Tests run with `TZ=Europe/Amsterdam`**, set by `npm test`. Run tests through it, not with a bare `node --test`.
- Higher tiers (dashboard over HTTP, the sandbox, the deployment) come later. A given bank may not be available in the sandbox, so bank-specific behaviour is covered by the fake bank.

## Scope

- Build order and status are in docs/architecture.md.
- The infra repo owns the host; this repo must not contain a compose file, reverse-proxy config, hostname, network name, volume name or host path.
- Out of scope: payments.

## Working conventions

- **Conventional commits:** `type(scope): message`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `security`. Scope is the workspace (`shared`, `sync`, `api`, `app`) or the component (`fixtures`, `tooling`), and is left out when a change spans several.
- **After a push, watch the run.** `gh run watch <id> --exit-status`, and on a failure `gh run view <id> --log-failed`. "The suite passed locally" is not a claim about `main`. A red run left unwatched is worse than a red run: the next commit lands on top of it and the cause moves. This applies from the day CI exists.
- **A decision made while building goes into the durable doc, not only the spec.** A dated spec is history once its slice ships, and nobody designing the next slice reads it. Whatever a slice settles or changes, including where the code departed from its own spec, is written into the flat doc that owns the subject before the slice is called done. The spec itself is not rewritten; it gets a closing section saying what moved.
- **Merge via rebase + fast-forward only. Never create a merge commit.** Before integrating a branch: `git rebase main`, then `git checkout main && git merge --ff-only <branch>`. History stays linear, so `git log` reads as the order work actually landed rather than something to untangle from a merge bubble.
- **The ff-merge happens locally, and the suite runs on the merged `main` before anything is pushed.** In order: rebase onto `main`, `git merge --ff-only` into the local `main`, run the **full suite there**, and only then `git push`. Never push a branch straight onto the remote `main`, including by `git push origin HEAD:main`, which lands the same commits and skips the only run that proves what `main` will actually be. A suite that passed on the branch passed on the branch; the rebase is exactly where a resolution can be green in isolation and wrong once integrated.
  **From a worktree this needs one extra step, and it is not optional.** A worktree cannot check out `main`, because it is checked out in the main checkout, and `git push . HEAD:main` is refused for the same reason (`branch is currently checked out`). So **leave the worktree first, keeping it**, do the ff-merge and the suite run in the main checkout, push from there, and return to the worktree if there is more to do. Pushing `HEAD:main` from inside the worktree is the shortcut this rule exists to forbid: it also leaves the maintainer's own `main` behind the remote, needing a pull to catch up to work that was supposedly merged locally.
- **Squash a small slice; keep a large one's history.** A slice lands as one reviewable unit, and for a slice of a few hundred lines that is one commit. Past roughly a thousand lines it inverts: one commit stops being reviewable and its message stops being able to carry the reasoning, so squashing destroys the record instead of tidying it. So: **fast-forward is absolute; squashing is a judgement.** Squash when the slice is small enough that one commit can still be read and explained. Keep the history when it is not, and let `git log --oneline main..<branch>` be the review surface instead. Either way the branch is linear and no merge commit appears.
- **Working in a git worktree: run `npm ci` in it, first thing.** A fresh worktree has no `node_modules`, so Node's resolver walks up and finds the main checkout's. With workspaces that means `@money/shared` resolves to the main checkout's `shared/`, and code in the worktree is tested against the other tree without any error. `npm run check:workspaces` (the first step of `npm run typecheck`, so the pre-commit hook and CI both run it) turns that silence into an error that names the fix.
- **Doc paths: two shelves, and the date is what separates them.** A **perpetually relevant** doc, one that is kept true as the code evolves, lives flat in `docs/`, named for what it is and never dated: `docs/architecture.md`, `docs/testing.md`. A **feature spec**, the design for one slice or feature, retired once it has shipped, lives in `docs/specs/YYYY-MM-DD-<slug>.md`, dated because its value is historical the moment it lands. Never date a durable doc, and never put a feature spec on the flat shelf where it will quietly rot. A spec's implementation plan sits in `docs/plans/` under the same name.
- **Never use `superpowers` in a folder name** for docs, specs, designs or plans.
