# Spec: the archive format in code

Slice 1 of the build order in [architecture.md](../architecture.md). Retired once built.

## Goal

Put the contract from [archive-format.md](../archive-format.md) into code, as pure functions with tests, and regenerate the synthetic archive in the new layout. After this slice the dashboard has a realistic archive to be built against, and the sync and the import have a merge to call.

Nothing in this slice talks to a bank, reads an exported file, or has a command line.

## What gets built

### `src/archive/`

| Module         | Does                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| `record.ts`    | The record types for both sources, and validation of a parsed year file.                      |
| `merge.ts`     | `merge(stored, incoming, now)`: new, unchanged, changed (into `revisions`). Returns warnings. |
| `files.ts`     | Records to year files and back: partitioning by booking year, ordering, exact formatting.     |
| `normalise.ts` | A record to a normalised transaction, for API records and, given a format, import records.    |
| `view.ts`      | All records of an archive to the normalised view, leaving out import records the API covers.  |
| `store.ts`     | The only I/O: read an archive directory, write year files atomically.                         |

Everything except `store.ts` is pure. `merge` takes the current time as an argument.

`merge` needs each incoming transaction's identity and booking date before it can store it. It gets them from a small function per source, so it stays unaware of what `raw` looks like.

### `src/config/`

The configuration file from [sync.md](../sync.md): its types, and a validator that returns every problem it finds, each as a message a person can act on. This slice needs it because normalising an import record requires its import format.

Checked at least: account keys match `[a-z0-9-]+`; every account names a bank that exists; every account has an `iban` or an `import_id`; no two accounts share one; every import format has its required fields; `encoding` is one of the three allowed names; `decimal` is `.` or `,`; date formats are ones the code supports.

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

The generator imports its record types from `src/archive/` and builds every file through `merge` and `files.ts`. The fixtures then cannot drift from the format, and the generator is one more test of the real code.

## Tests

Tier 1, with factories in `test/support/`:

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
- The status note in [architecture.md](../architecture.md) and the "Development data" section of the README describe the new layout.
- This spec is deleted.
