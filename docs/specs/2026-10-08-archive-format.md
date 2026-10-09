# Spec: the archive format in code

Slice 1 of the build order in [architecture.md](../architecture.md). Written 2026-10-08. Once the slice has shipped this file is history and is not kept up to date.

## Goal

Put the contract from [archive-format.md](../archive-format.md) into code, as pure functions with tests, and regenerate the synthetic archive in the new layout. After this slice the dashboard has a realistic archive to be built against, and the sync and the import have a merge to call.

Nothing in this slice talks to a bank, reads an exported file, or has a command line.

## What gets built

### Workspaces

The repository becomes npm workspaces, as laid out in [architecture.md](../architecture.md): `shared` is created here, and the root keeps the tooling. `sync`, `api` and `app` are created by the slices that fill them. The test for the dependency rule lands with `shared`, and so does `npm run check:workspaces`, wired in as the first step of `npm run typecheck` ([testing.md](../testing.md)).

### `shared/src/archive/`

| Module         | Does                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `record.ts`    | The record types for both sources, and validation of a parsed year file.                               |
| `merge.ts`     | `merge(stored, incoming, now)`: new, unchanged, changed (into `revisions`). Returns warnings.          |
| `files.ts`     | Records to year files and back: partitioning by booking year, ordering, exact formatting.              |
| `normalise.ts` | A record to a normalised transaction, for API records and, given a format, import records.             |
| `view.ts`      | All records of an archive to the normalised view, leaving out import records the API covers.           |
| `store.ts`     | The only I/O: read an archive directory, write year files atomically. Exposed as `@money/shared/node`. |

Everything except `store.ts` is pure. `merge` takes the current time as an argument.

`merge` needs each incoming transaction's identity and booking date before it can store it. It gets them from a small function per source, so it stays unaware of what `raw` looks like.

### `shared/src/config/`

The configuration file from [sync.md](../sync.md): its types, and a validator that returns every problem it finds, each as a message a person can act on. This slice needs it because normalising an import record requires its import format.

Checked at least: account keys match `[a-z0-9-]+`; every account names a bank that exists; every account has an `iban` or an `import_id`; no two accounts share one; every import format has its required fields; `encoding` is one of the three allowed names; `decimal` is `.` or `,`; date formats are ones the code supports.

### Continuous integration

The first workflow, `.github/workflows/ci.yml`, as [testing.md](../testing.md) describes it. It runs on every push and every pull request.

| Job               | Runs                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `static-analysis` | `npm run typecheck` (which starts with the link check), lint, format check |
| `tests`           | `npm test`                                                                 |

- The same commands as the pre-commit hook, on the whole repository, with no separate path.
- Node comes from the `engines` field, and dependencies from `npm ci`.
- The workflow declares `permissions: contents: read` and pins every third-party action to a commit SHA. It holds no secret.
- No image is built yet. The build and push job arrives with the first slice that has something to run, and will depend on these two.

With CI in place, the rule in `CLAUDE.md` about watching the run after a push takes effect.

### Fixtures

`fixtures/generate.ts` is rewritten around the same invented household, and now writes:

```text
fixtures/
  config.json
  archive/
    <account key>/<source>/<year>.json
```

The story it tells, so that every rule in the format is exercised by data:

- **Two made-up banks**, `bnka` and `bnkb`, so that nothing can quietly assume there is only one. `bnkb` is added partway through, in 2026.
- **Five accounts at each:** personal, joint, personal savings, joint savings, and a credit card.
- **Savings accounts and cards are import-only**, as they often are in reality. A card has no IBAN and is recognised by its `import_id`.
- **History before the API.** The `bnka` current accounts have import records from 2021, and API records from early 2025. The two overlap for a few months, so the view has something to leave out.
- **A closed account.** One account is marked `closed` partway through and receives nothing further.
- **Transfers appear on both sides**: current to savings, the monthly card settlement, and from an account at one bank to an account at the other.
- **Two made-up import formats**, one with a sequence number and a counterparty, one for cards with neither a counterparty nor an IBAN. Amounts use a decimal comma.

The awkward cases the current archive has are kept: revised transactions, identical-looking pairs, foreign currency, missing counterparties, merchant names that vary, and nights without a sync.

The generator imports its record types from `shared` and builds every file through `merge` and `files.ts`. The fixtures then cannot drift from the format, and the generator is one more test of the real code.

## Tests

Tier 1, with factories in `shared/testing/`:

- `merge`: new, unchanged, changed, and the same identity arriving twice in one batch; two transactions identical in everything but `id` stay two.
- `files`: a round trip is lossless; output is byte-stable; a record in the wrong year's file fails validation.
- `normalise`: sign and counterparty for debits and credits; amounts with comma and point decimals, with and without a leading sign; missing optional fields give null; an unparseable amount or date is an error that names the record.
- `view`: import records on or after the API start are left out; an account with no API records keeps all of them; an account with no import records is unaffected.
- `config`: one test per rule above, and a valid file passes.

Tier 2, property-based: for a random set of API and import records, the view is the same whatever order they were merged in, and merging the same batch twice changes nothing.

Fixtures: the existing freshness and invariant tests, updated for the new layout. New assertions: every configured account has a directory; import-only accounts have no `api/`; the overlap exists and the view hides it; `fixtures/config.json` passes validation.

## Not in this slice

- Reading an exported file: delimiters, quoting and character encodings. That is the import slice. Here, import records are built directly as objects.
- The inbox, the fetch window, the Enable Banking client, and any command.
- Rules and categories.

## Done when

- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test` pass.
- `npm run fixtures` reproduces the committed archive byte for byte.
- The CI run for the slice's last commit is green, and was watched.
- The status note in [architecture.md](../architecture.md) and the "Development data" section of the README describe the new layout.

## What moved while it was built

The record and merge:

- **The record gained a `date` field.** A record has to be filed under a year when it is written, and a file has to be checkable against its own name without interpreting `raw`. Recorded in [archive-format.md](../archive-format.md).
- **A timestamp must have a real time of day**, so `T99:99:99Z` is rejected.
- **Timestamps are UTC in whole seconds**, `YYYY-MM-DDTHH:MM:SSZ`: a fraction of a second is rejected in a record, and `merge` refuses a current time in any other notation.
- **`format` on an import record is a key** and must match the key pattern.
- **`merge` reports `added`, `revised` and `unchanged`** instead of a list of warnings. A stored record missing from a fetch can only be noticed by something that knows the fetch window, which is the sync slice's.
- **The same id twice in one batch** is stored once when the two are identical, and is an error when they differ.
- **The same id twice in what is already stored** is an error: `merge` refuses to continue rather than drop one.

Year files and the store:

- **`store.ts` is a separate, Node-only entry**, `@money/shared/node`, so the main entry stays free of I/O. Recorded in [architecture.md](../architecture.md).
- **Writes are planned by a pure function**, `planWrites`, in `writes.ts`, so that no file loses a record before it is on disk in another file. Recorded in [archive-format.md](../archive-format.md).
- **The store refuses any write after which a stored identity would be gone**, an empty set over an existing account included, so no record is deleted through it. It does not compare revisions, and a year file is removed only when every record it held now lives in another file.
- **The store never repeats a name that failed its pattern**: a stray in the archive, a bad account or a bad source is described by what and where it is, without its name.
- **The writer validates the account key, the source, every file name and every file's text before touching the disk**, and the reader validates account and source.
- **The guarantee has stated limits**: it covers a process crash, relies on the filesystem for power loss, can leave a record in two year files that reading then reports, and assumes one writer per account and source.

Configuration:

- **Bank keys and import format keys must match `[a-z0-9-]+`**, like account keys.
- **An `iban` or `import_id` that is present must be a non-empty text**, even when the other identifier is valid.
- **Messages never contain a value from the file**: an unknown bank is reported without its name, and an entry with a malformed key is named by its position. Recorded in [sync.md](../sync.md).

The normalised view:

- **A currency and an original currency must be exactly three capital letters**, because the number of decimals depends on it.
- **For API records** the amount and the instructed amount carry no sign, a value date must be a real date, and an instructed amount with a currency but no readable value is an error.
- **Description cells are read defensively**, and `original_amount` takes the sign of `amount`.
- **An original amount and an original currency come together or not at all**; one without the other is an error, for both sources.

Tests:

- **The convergence property is stated over a changing bank history**, synced on a random schedule of nights applied in time order and ending in a full sync. A second property keeps the any-order claim for histories without revisions; the claim that revisions may arrive in any order was dropped, because it was never true.
- **The overlap property computes its expected result from the generated data**, not from the code under test, and checks the visible set exactly.
- **Each property was shown to fail by a named deliberate break** before it was trusted. Recorded in [testing.md](../testing.md).

Fixtures:

- **The generator is three files**, not one: `household.ts`, `world.ts` and `generate.ts`, plus `dates.ts`.
- **The archive is 6,006 records in 33 year files**, ten accounts at two made-up banks.
- **Three accounts are closed, not one**: the joint account, its savings account and the card at the first bank all stop on the day the second bank is added.
- **Savings interest is paid only on a positive balance.**
- **Every counterparty that named a real bank or a bank-owned brand was replaced** with an invented one, and a test fails if either returns. A payment scheme and a cash-machine network keep their real names, because neither is a bank.
- **Every payment institution among the counterparties is invented too**: the three that remained were replaced in the final review.
- **The forbidden-strings test became an allow-list**: the generated archive is held to one committed list of known counterparties, `fixtures/counterparties.ts`, so no test spells a name that must not appear.
- **The generator writes its files with plain `node:fs`** after removing the directory, not through the store, because the store refuses to delete.

CI:

- **`.github/workflows/ci.yml` exists with two jobs** and has not yet run. It first runs when the branch is integrated and pushed.
