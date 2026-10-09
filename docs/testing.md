# Testing

How this project is tested. Adapted from foerier's testing reference, for a nightly sync and a file import that merge bank transactions into an append-only JSON archive, and later a dashboard that categorises that archive by rules.

This is a permanent reference: it stays up to date as the approach evolves.

## Philosophy

Testing is about confidence, not coverage numbers. Catch regressions as cheaply as possible: a test belongs at the lowest tier whose tools can catch the failure.

**Tests must test real behaviour.** A test that cannot be wrong provides no confidence and is noise. Anything that crosses a boundary (the clock, the filesystem, `fetch`, randomness) is injected and replaced with a **real, minimal fake implementation of the interface**, never a mocking-framework mock. The code is already shaped for this: logic is pure functions, and I/O is passed in at the edges.

**The risk here is silent data loss.** A crash is loud and the next night repairs it. A merge that drops, duplicates or overwrites a transaction is quiet, and after two years the bank no longer has the original. The tiers in bold are where that risk is caught.

## The pyramid

```text
[T5] E2E smoke            later    one journey through the deployed dashboard
[T4] Contract             later    the deployment, and the real Enable Banking sandbox
[T3] Component            later    only if the dashboard grows client-side UI
[T2s] Server integration  later    the dashboard over HTTP, against the synthetic archive
[T2] SYNC CONVERGENCE     now      any sequence of fetches converges; nothing is ever lost
[T1] UNIT                 now      merge, normalise, fetch window, import, rules
[T0] Static analysis      now      tsc, lint, format, fixture freshness, pre-commit
```

Only tiers 0 to 2 are needed for the sync. The rest arrive with the dashboard and the deployment, and are sketched at the end so their place is known.

## Tier 0: static analysis

**Charter:** catch type, syntax and style errors, and drifted generated files, before any behavioural test runs.

- **`npm run check:workspaces`, first and cheapest.** It asserts that every `@money/*` package resolves inside this working tree. A git worktree without its own install resolves them up into the main checkout instead, and then every tier below judges the wrong source tree without erroring. It is the first step of `npm run typecheck`, so the hook and CI both run it. It arrives with the workspaces.
- **`tsc --noEmit`.** Node strips types and never checks them, so this is the only thing that does. `erasableSyntaxOnly` also rejects syntax Node cannot strip.
- **ESLint** with `typescript-eslint`, for correctness rules: unused variables, floating promises, unreachable code. A floating promise matters more than usual here, because an unawaited write is a partial write.
- **Prettier**, formatting only.
- **The dependency rule.** A test reads every workspace's `package.json` and fails if `shared`, `sync` or `api` lists a runtime dependency that is not another workspace ([architecture.md](architecture.md)).
- **Fixture freshness.** A test regenerates the synthetic archive in memory and fails if the committed files differ. A hand-edited fixture, or a generator change committed without its output, cannot slip through.

**Whole repo, never just the changed files**, both in the pre-commit hook and in CI. LLM-authored changes tend to leave unrelated files unformatted, and a staged-files-only check would miss that.

**Pre-commit hook:** a plain script in `.githooks/`, enabled with `git config core.hooksPath .githooks`, which the `prepare` script runs on `npm install`. It runs typecheck, lint, format check and the tests, the same commands as CI, with no separate fast path. No Husky: it would be a dependency for one line of configuration.

## Tier 1: unit tests

**Charter:** pure logic, no I/O. The majority of tests, and the first thing written for any new logic.

Covers:

- **the fetch window**: first run, a normal night, missed nights catching up, the two-year clamp, the year boundary, and UTC date handling;
- **merge**: new, known and unchanged, known and changed (the old version moves to `revisions`), the same id twice in a batch or in storage, and a timestamp without a real time of day;
- **identity**: account, source and `id`, and nothing else. Two transactions that look identical on the same day stay two transactions;
- **partitioning and ordering**: per account and source, by `booking_date` into years, sorted by date and `id`, with a missing booking date as an error;
- **the normalised view**: for API records and for import records through an import format, including the sign of amounts, decimal notation, and which counterparty is the other side;
- **source overlap**: import records on or after an account's API start are left out of the view, whatever order things were done in;
- **import**: a file with an unknown account, a missing identifier or a repeated one is rejected whole, and importing the same file twice changes nothing;
- **import encodings**: each allowed encoding decodes a file of known bytes to the right text, and each mismatch that can be detected is rejected (UTF-8 declared single-byte, single-byte declared UTF-8, a byte order mark, control characters, a missing header);
- **configuration**: every way the configuration file can be wrong stops startup with a message that names the problem;
- **validation at the boundary**: each unexpected API shape fails with a clear message instead of being guessed at;
- **JWT construction**: header, claims and TTL, signed with a throwaway key generated in the test;
- **consent**: the warning window and the expired case;
- later, **categorising**: first match wins, rule order decides, every condition type, no match gives `uncategorised`, and an invalid regular expression is refused;
- later, the dashboard's **filter, sort and group** functions.

**Tooling:** `node:test` and `node:assert/strict`, as `*.test.ts` next to the code under test. That covers `shared`, `sync` and `api`. The `app` workspace picks its own test tooling with its libraries, in its slice's spec. The clock is an injected function returning a fixed instant. No test reads the real time or the network.

**The timezone is pinned.** `npm test` sets `TZ=Europe/Amsterdam`. Bank dates are calendar dates in UTC, and the people reading them are an hour or two ahead of it. Under UTC, a test of that boundary passes against the very bug it exists to catch: a transaction booked on the 1st showing up on the 31st, or the other way round. Pinned to a zone that differs from UTC, the assertion means something. Tests that are about this boundary say so, and use instants just before and after midnight in both zones.

**Logging is behaviour, so it is tested.** Logs may hold counts, dates and keys only, and job output leaves the production host on every run (see [infra.md](infra.md)). A unit test runs a sync over transactions with recognisable amounts, IBANs, names and descriptions, captures everything logged, and asserts none of those values appear.

## Tier 2: sync convergence

**Charter: the signature tier.** It runs the real `sync`, end to end, against a fake bank and a real temporary directory, and proves the two properties the whole project rests on:

1. **Convergence.** However the nights fall, the archive ends up the same. Any sequence of overlapping fetch windows over the same bank history produces byte-identical files.
2. **Nothing is lost.** Every transaction the bank ever returned is in the archive, either as the current version or in `revisions`.

In the archive-format slice these are stated over the pure core, before any sync exists, in `shared/src/archive/convergence.test.ts`:

- **Convergence under revisions.** A bank history whose transactions change over time is synced on a random schedule of nights, applied in time order and ending in a full sync. The result must show the same as one sync of the final state. Revisions are not claimed to converge when they arrive in any order; they do not.
- **Any order without revisions.** For histories whose transactions never change, overlapping batches in any order give the same view, and merging a batch again changes nothing.
- **Source overlap.** The expected visible set is computed from the generated data, never from the code under test, and the view must match it exactly.

These are expressed **property-based**: generate a random bank history and a random schedule of runs (skipped nights, repeated runs, runs on both sides of a year boundary, windows of different lengths, imports of overlapping files in between), run them, and compare the result against a single run over the full history. The normalised view must come out the same whatever the order. The generator is a small seeded PRNG, so a failure prints its seed and replays exactly. No property-testing library is needed for this.

**A property test is not trusted until it has failed.** Before relying on one, break the code under test in a named way (for example, drop the revision, ignore the date, take the first of two duplicates) and see the property fail. Keep that habit for every new property.

Named scenarios pin the edges a generator reaches only by luck:

- a second run with nothing new leaves every file **byte-for-byte identical**;
- pagination: `continuation_key` is followed to the end, and a page that fails halfway writes nothing;
- a transaction changes at the bank between two runs;
- a transaction disappears from a window it falls inside: kept, and warned about (the merge cannot see this; the sync, which knows the window, does);
- a run that dies between the temporary write and the rename leaves the previous file intact;
- a run that dies after receiving pages and before merging is finished from the inbox by the next run, without asking the bank again;
- a backfill that dies halfway keeps the pages it received;
- one bank's consent has expired: the other banks are synced in full, and the run still exits non-zero;
- state is written after data, so a crash between the two is repaired by the next run and never skips a window;
- an expired consent exits non-zero, says to run `auth`, and writes nothing;
- no PSU headers are sent, asserted on the requests the fake bank received.

**The fake bank** is a real implementation of the Enable Banking endpoints the sync uses, held in memory and handed to the code as its `fetch`. It holds a transaction history, serves pages with continuation keys, and records the requests it received. It can be told to fail on the nth call. It is not a table of canned responses: the sync asks it questions and it answers from its state, which is what lets the property tests generate histories freely.

**A slice that adds a behaviour to the sync adds it to the generator, not only to the scenarios.** A case absent from the generator has no property coverage, however many scenarios name it.

**What this tier cannot prove** is that the fake matches the real API. Validation at the boundary limits the damage, since an unexpected shape fails loudly instead of being stored wrong. Closing the gap properly is Tier 4's job.

## Test data

Three kinds, never mixed, and **never real**. This repo does not hold real bank data in any form: not in files, not in fixtures, not in a test's inline literals. That includes the shape of a real bank's export file: import tests use a made-up format for a made-up bank.

- **Tiers 1 and 2: factory functions** with defaults and overrides, in `shared/testing/`. A test reads as `aTransaction({ booking_date: "2025-12-31" })`: the field under test and nothing else. The library grows one function at a time.
- **Tier 2: generated histories**, from the seeded generator described above.
- **Dashboard development and its later tiers: the synthetic archive** in `fixtures/archive/`, about 6,000 transactions in 33 year files over ten accounts at two made-up banks, both sources, written by the generator (`fixtures/household.ts`, `world.ts` and `generate.ts`) through the real merge, in the same format production writes. Three accounts are closed, and savings interest is paid only on a positive balance. It deliberately contains the awkward cases: revised transactions, identical-looking pairs, foreign currency, missing counterparties, merchant names that vary in spelling, transfers that appear on both accounts, and nights where the sync was down.

Change the archive by changing the generator and running `npm run fixtures`. Never edit a year file by hand.

Every counterparty is invented. None names a real bank or a bank-owned brand, and a test fails if one returns; a payment scheme and a cash-machine network keep their real names, because neither is a bank. The generator writes its files with plain `node:fs` after emptying the directory, not through the store, because the store refuses to delete.

Every generated IBAN has check digits `00`, which no valid IBAN can have, so no generated account number can belong to anyone. A test asserts this.

The archive's `raw` shape is the `Transaction` schema from Enable Banking's API reference, not an observed bank response. That reference requires only the amount, the credit/debit indicator and the status; every other field is optional, `entry_reference` and `booking_date` included. Fields the generator has no basis to invent are null throughout, so nothing can come to depend on them, and the contents of the remittance lines and transaction codes are invented. When a redacted real sample exists, the generator is corrected to match its shape, by hand and without copying values.

## Stored-format compatibility

The archive outlives every version of the code, and nothing in it is ever rewritten wholesale. So the record format must stay readable forever.

When the record format changes, the old format gets a small frozen fixture under `shared/fixtures/formats/`, and a Tier 1 test asserts the current code still reads it and merges into it correctly. Capture the fixture in the same change that alters the format; one taken later is taken from a format that has already drifted.

## Later tiers

Not built yet. One line each, so their charter is settled before they are needed:

- **Tier 2s, server integration.** The real dashboard server over HTTP, reading `fixtures/archive/` and a rules directory in a temporary folder: routing, login and session handling, rate limiting, query results, saving rules, and refusing a save based on an outdated version.
- **Tier 3, component.** Only if the dashboard grows client-side UI that is worth testing apart from the server.
- **Tier 4, contract.** Two targets. The Enable Banking sandbox, to prove the fake bank still matches the real API. And the deployed dashboard after each deploy, to prove what a local run cannot: the front door, the login through it, the read-only mount.
- **Tier 5, E2E smoke.** One journey in a real browser: log in, filter, group, read a chart.

No tier ever runs against production bank data. The deployed tiers use the dashboard's own surface and a dedicated login.

## CI

On every push and pull request, and gating the image build:

| Tier    | Job                                                   |
| ------- | ----------------------------------------------------- |
| 0       | `static-analysis`: typecheck, lint, format check      |
| 1 and 2 | `tests`: `npm test`, which includes fixture freshness |

## Running everything locally

```sh
npm run typecheck && npm run lint && npm run format:check   # Tier 0
npm test            # Tiers 1 and 2, and fixture freshness; pins the timezone
npm run fixtures    # regenerate fixtures/archive/ after changing the generator
```

## Status

| Piece                                    | State                                                   |
| ---------------------------------------- | ------------------------------------------------------- |
| `tsc --noEmit`, ESLint, Prettier         | in place                                                |
| Fixture freshness and archive invariants | in place (`fixtures/archive.test.ts`)                   |
| Pre-commit hook                          | in place (`.githooks/pre-commit`, set by `npm install`) |
| Pinned test timezone                     | in place (`npm test`)                                   |
| Workspace-link check, dependency rule    | in place                                                |
| CI                                       | in place, first run pending                             |
| Tier 1 and Tier 2 suites                 | arrive with the code they test                          |
