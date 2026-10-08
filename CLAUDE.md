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

- `node --env-file=.env.sandbox src/cli.ts auth <bank>`: start or renew consent (interactive)
- `node --env-file=.env.sandbox src/cli.ts sync`: fetch, merge and write
- `node --env-file=.env.sandbox src/cli.ts status`: consent expiry and last successful sync
- `node --env-file=.env.sandbox src/cli.ts import <format> <file>`: merge an exported file
- `npm test`: run tests (`node --test 'test/**/*.test.ts'`)
- `npm run typecheck`: type-check (`tsc --noEmit`)
- `npm run lint`: ESLint. `npm run format`: Prettier, writing. `npm run format:check`: Prettier, checking.
- The pre-commit hook (`.githooks/pre-commit`) runs typecheck, lint, format check and tests on the whole repo. Never bypass it with `--no-verify`.
- `npm run fixtures`: regenerate `fixtures/archive/` after changing the generator. Never edit the year files by hand; a test fails if they drift from the generator.

## Code conventions

- **Functional style.** All logic (fetch window, merge, partitioning, validation) is pure functions over immutable data. I/O stays at the edges and is passed in, including the clock, so tests need no mocks.
- **Readability first.** Small modules, explicit names, no cleverness.
- **No silent error handling.** No empty `catch`, no defaults that paper over missing data, no partial writes. Fail loudly and exit non-zero.
- **Validate at the boundary.** Check API responses on arrival and fail on unexpected shapes, rather than guessing.
- **No runtime dependencies.** Dev dependencies are `typescript`, `@types/node`, and the lint and format tooling (`eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `prettier`). `typescript` stays on 6.x until `typescript-eslint` supports 7. Ask before adding anything; prefer FOSS.

## TypeScript without a build step

Node strips types and runs `.ts` files directly; it never type-checks.

- Erasable syntax only: no `enum`, `namespace`, parameter properties or `import =`.
- Relative imports include the `.ts` extension. Type-only imports use `import type`.
- `package.json` sets `"type": "module"`. `tsconfig.json` sets `strict`, `noEmit`, `module: "nodenext"`, `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`.
- `tsc --noEmit` must pass.

## Configuration

Defined in docs/sync.md and docs/dashboard.md. In short: secrets and paths come from environment variables (documented in `.env.example`), and banks, accounts and import formats from one JSON file at `CONFIG_PATH`. Production config exists only on the host. Sandbox config lives in `.env.sandbox` and `tmp/`, both gitignored. Every command validates its configuration at startup and fails if anything is missing or wrong.

## Layout

```text
src/
  cli.ts           auth | sync | status | import
  archive/         record format, merge, normalised view, atomic writes
  enablebanking/   JWT, HTTP client, pagination, API types
  sync/            fetch window, inbox, per-account fetch
  import/          import formats, file parsing
  web/             phase 2: the dashboard, rules and categorising
test/              mirrors src/
  support/         factories and the fake bank
fixtures/
  generate.ts      seeded generator for the synthetic archive
  archive/         generated: <year>.json, in the format sync writes
docs/              the design; specs/ holds one short spec per slice being built
tmp/               gitignored: sandbox data, state and key
```

## Testing

docs/testing.md is the reference. In short:

- **Tier 0:** `tsc --noEmit`, ESLint, Prettier, and the fixture-freshness test.
- **Tier 1:** unit-test every pure function with `node:test`: merge, the normalised view, the fetch window, import, categorising. Write these first.
- **Tier 2:** run the real `sync` against the in-memory fake bank and a temporary directory. Property-based: any sequence of fetch windows converges to the same files, and nothing is ever lost.
- **Fakes, not mocks.** Inject the clock, `fetch` and the filesystem root; replace them with small real implementations.
- Higher tiers (dashboard over HTTP, the sandbox, the deployment) come later. A given bank may not be available in the sandbox, so bank-specific behaviour is covered by the fake bank.

## Scope

- Build order and status are in docs/architecture.md. Each slice gets a short spec in `docs/specs/<topic>.md` (no date prefix) before it is built.
- The infra repo owns the host; this repo must not contain a compose file, reverse-proxy config, hostname, network name, volume name or host path.
- Out of scope: payments.
