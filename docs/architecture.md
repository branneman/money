# Architecture

The whole picture on one page. Each part has its own document; this one says how they fit.

> **Status.** Built: the `shared` workspace (the archive format, merge, the normalised view, configuration), the synthetic archive, and the `sync` workspace (`auth`, `sync`, `status`, `banks`, tested against a fake bank and run once against the sandbox, and `import`, tested with made-up export files), the image CI publishes from `main`, and the app's `server` (login, sessions, lenses on a placeholder route, headers, its commands, run by the image, and not yet reachable from outside). Not built yet: the app's `client`, its screens, and categories.

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
         +------------+
         | app server | <----> app data: session secret, rules
         +------------+
                ^
                |
         app client, in the browser
```

| Part        | Does                                                                            | Document                               |
| ----------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| **sync**    | Fetches booked transactions from every bank, nightly.                           | [sync.md](sync.md)                     |
| **import**  | Merges files exported by hand, for history and unreachable accounts.            | [sync.md](sync.md)                     |
| **archive** | Per-account JSON files. The only thing the parts share.                         | [archive-format.md](archive-format.md) |
| **app**     | Shows each person the accounts they own, and categorises them by ordered rules. | [app.md](app.md)                       |

Hosting is in [infra.md](infra.md), testing in [testing.md](testing.md).

**The app**, or the money app, does more than show the archive: budgets, pots and a year plan are coming, so it writes data of its own. What holds is narrower, and is said exactly: it never writes bank data, the archive is mounted read-only into its container, and nothing in this project can move money. Its two halves are named for where they run: the **server**, in the web container, and the **client**, in the browser.

## Who writes what

Every piece of stored data has exactly one writer.

| Data                   | Written by | Read by              | Backed up     |
| ---------------------- | ---------- | -------------------- | ------------- |
| `<account>/api/`       | sync       | server               | yes           |
| `<account>/import/`    | import     | server               | yes           |
| Session and sync state | sync       | sync                 | no            |
| Session secret         | server     | server               | yes           |
| Rules                  | server     | server               | yes           |
| Configuration          | the host   | sync, import, server | with the host |

The session secret and the rules live in `APP_DATA_DIR`, the one directory the app writes ([app.md](app.md)). The secret is written by the server's command `rotate-session-secret`, never by the server as it runs.

Two consequences:

- **The app cannot damage bank data**, and the sync cannot damage what the app writes. Neither can reach the other's files for writing.
- **Everything derived is recomputed, never stored.** The normalised view comes from `raw`; categories come from rules. Fixing a rule or an import format changes what is shown and rewrites nothing.

## Principles

- **The archive is the source of truth.** Banks forget: their APIs reach back a limited time. What is in the archive may exist nowhere else.
- **Never delete, never deduplicate on content.** Identity is the bank's own identifier.
- **No bank is special.** Nothing in the code or in this repository names or assumes a particular bank. Which banks and accounts are connected is configuration.
- **Fail loudly.** An unexpected response, a missing identifier or a bad configuration stops the run with a clear message. Nothing is guessed.
- **Pure core, I/O at the edges.** Merging, normalising and categorising are pure functions. The clock, the network and the filesystem are passed in.
- **Nothing on the server depends on third-party code.** See Dependencies below.

## Code layout

One repository, with npm workspaces. Each workspace is a package named `@money/<name>`.

```text
shared/     the archive format, merge, the normalised view,
            configuration, categorising. Pure functions.
sync/       the command line: auth, sync, status, import
server/     the app's server: login, sessions, lenses, its routes
client/     the app's interface, in the browser
fixtures/   the synthetic archive and its generator
docs/       this design
```

- **`shared` is the core.** Its main entry has no I/O and runs unchanged in Node and in the browser. Everything that decides what a transaction is or which category it gets lives here, once.
- **`@money/shared/node` is the one exception**, a separate entry for reading and writing an archive directory. Every Node part needs exactly that, and the browser never imports it.
- **`sync`, `server` and `client` depend on `shared`, and never on each other.**
- **Tests sit next to the code they test**, as `*.test.ts`.
- **One image is built from the repository.** The sync container runs `sync`; the web container runs `server`, which also serves `client`'s built files.

## Dependencies

The rule differs by where the code runs, because what a dependency could do differs.

| Workspace | Runs           | Can reach                                                                | Runtime dependencies                  |
| --------- | -------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `shared`  | everywhere     | whatever its caller can                                                  | none                                  |
| `sync`    | on the server  | bank credentials, the whole archive, the network                         | none                                  |
| `server`  | on the server  | the whole archive, the password hashes, what the app writes, the network | none                                  |
| `client`  | in the browser | what the logged-in person may see                                        | allowed, each one a deliberate choice |

- **On the server, none.** Every dependency there is someone else's code running with access to bank data and an open network connection. What Node ships is enough for all three: `fetch`, `node:crypto`, `node:fs`, `node:http`. A workspace's `dependencies` may name only other `@money` workspaces, and a test enforces it.
- **In the browser, a few.** Large tables, charts and an editor are not worth building from nothing. Browser code is confined by a strict Content Security Policy: it can load nothing from, and send nothing to, anywhere but the app's own origin. Each library is still chosen deliberately and kept to a short list.
- **Development tools** (type-checker, linter, formatter, test runner, bundler) never run in production and never see real data. They are still added only on purpose.
- **The bundler is the one tool whose output ships.** The image build therefore takes exactly one thing from the build stage: `client`'s built files. Server code is copied into the image from the source tree, untouched by any tool.

So "no build step" holds for everything Node runs, and `client` is the one workspace that is built.

## Data protection

- **Real bank data exists in production only**, on the host and in its backups, inside the EU.
- **This repository is public and holds none of it:** no data, no credentials, no rules, no bank names, no account numbers, no export formats. Development runs on a synthetic archive.
- **Logs and job output never contain** amounts, account numbers, names or descriptions.

## Build order

Each slice gets a spec in `docs/specs/`, dated, before it is built. Once the slice has shipped the spec is history: it is kept and no longer maintained, and whatever it settled is written into the documents above.

1. **Archive format.** The workspaces, the record and layout in code, the normalised view, and fixtures regenerated to match: two banks, an imported stretch, a closed account.
2. **Sync.** `auth`, the backfill, the inbox, the nightly run, against a fake bank.
3. **Import.** Import formats and the `import` command.
4. **Image.** The container image, published by CI from `main`, so the sync and the backup run in production before the app exists. Added on 2026-10-14.
5. **The app**, split in three on 2026-11-27, so the parts with the most risk are built and reviewed before any screen depends on them. Each of 5a and 5b ends in a security review.
   - **5a. App server.** `server`, login, sessions, lenses on a placeholder route, headers, the image running it, and the infra changes written down.
   - **5b. App client.** `client`, the bundler, the shell, theming and fonts, the image's build stage, `npm run dev`. [Its spec](specs/2026-11-27-app-client.md).
   - **5c. App screens.** Waits for the UX work. The real screens, the browser libraries for them, and the data the app stores beside the rules.
6. **Categories.** Rules, the editor and the preview.
