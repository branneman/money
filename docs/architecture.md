# Architecture

The whole picture on one page. Each part has its own document; this one says how they fit.

> **Status.** This describes the target. Built so far: the synthetic archive generator, and its tests. The fixtures still use the earlier single-directory layout and are regenerated in the first slice below.

## Parts

```text
banks                      bank websites
  |                             |
  | Enable Banking API          | exported files
  v                             v
+------+                   +--------+
| sync |                   | import |
+------+                   +--------+
  |                             |
  +-------------+---------------+
                |
                v
         archive (JSON files)
                |
                | read-only
                v
         +-----------+
         | dashboard | <----> rules
         +-----------+
                ^
                |
             browser
```

| Part          | Does                                                                 | Document                               |
| ------------- | -------------------------------------------------------------------- | -------------------------------------- |
| **sync**      | Fetches booked transactions from every bank, nightly.                | [sync.md](sync.md)                     |
| **import**    | Merges files exported by hand, for history and unreachable accounts. | [sync.md](sync.md)                     |
| **archive**   | Per-account JSON files. The only thing the parts share.              | [archive-format.md](archive-format.md) |
| **dashboard** | Shows the archive, and categorises it by ordered rules.              | [dashboard.md](dashboard.md)           |

Hosting is in [infra.md](infra.md), testing in [testing.md](testing.md).

## Who writes what

Every piece of stored data has exactly one writer.

| Data                   | Written by | Read by                 | Backed up     |
| ---------------------- | ---------- | ----------------------- | ------------- |
| `<account>/api/`       | sync       | dashboard               | yes           |
| `<account>/import/`    | import     | dashboard               | yes           |
| Session and sync state | sync       | sync                    | no            |
| Rules                  | dashboard  | dashboard               | yes           |
| Configuration          | the host   | sync, import, dashboard | with the host |

Two consequences:

- **The dashboard cannot damage bank data**, and the sync cannot damage rules. Neither can reach the other's files for writing.
- **Everything derived is recomputed, never stored.** The normalised view comes from `raw`; categories come from rules. Fixing a rule or an import format changes what is shown and rewrites nothing.

## Principles

- **The archive is the source of truth.** Banks forget: their APIs reach back a limited time. What is in the archive may exist nowhere else.
- **Never delete, never deduplicate on content.** Identity is the bank's own identifier.
- **No bank is special.** Nothing in the code or in this repository names or assumes a particular bank. Which banks and accounts are connected is configuration.
- **Fail loudly.** An unexpected response, a missing identifier or a bad configuration stops the run with a clear message. Nothing is guessed.
- **Pure core, I/O at the edges.** Merging, normalising and categorising are pure functions. The clock, the network and the filesystem are passed in.
- **No runtime dependencies, no build step.** Node.js runs the TypeScript directly.

## Data protection

- **Real bank data exists in production only**, on the host and in its backups, inside the EU.
- **This repository is public and holds none of it:** no data, no credentials, no rules, no bank names, no account numbers, no export formats. Development runs on a synthetic archive.
- **Logs and job output never contain** amounts, account numbers, names or descriptions.

## Build order

Each slice gets a short spec in `docs/specs/` before it is built, and the spec is retired when the slice is done.

1. **Archive format.** The record and layout in code, the normalised view, and fixtures regenerated to match: two banks, an imported stretch, a closed account.
2. **Sync.** `auth`, the backfill, the inbox, the nightly run, against a fake bank.
3. **Import.** Import formats and the `import` command.
4. **Dashboard.** Login, tables and charts over the fixtures.
5. **Categories.** Rules, the editor and the preview.
