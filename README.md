# Money

Nightly, unattended sync of your own bank transactions into a self-hosted JSON archive, with a dashboard over it.

## Goal

Keep a complete archive of all transactions on your own bank accounts, across one or more banks, without daily or weekly manual work.

- **Unattended.** A nightly run fetches new and recently changed transactions. The only manual step is renewing bank consent, at most every 180 days, as PSD2 requires.
- **Complete history.** A bank's API only reaches back so far, often two years at most, so the archive is the source of truth. Nothing is ever deleted, and older years stay available after the bank stops serving them.
- **Read-only.** Account information only, no payments.
- **Private.** Bank data stays in the EU and exists in production only. It never enters this repository, a developer's machine, or the context of AI tools. Development runs on synthetic data.

Around that archive:

- **Import** of files exported from a bank's website, for history the API no longer serves and for accounts it cannot reach.
- **A dashboard** (second phase): tables and charts with filtering, sorting and grouping, and one category per transaction, assigned by ordered rules the user writes. It never changes bank data.

Out of scope: payments.

## Status

Built: the archive format, the synthetic archive, the sync, with its commands `auth <bank>`, `sync`, `status` and `banks <country>`, and the import, `import <format> <file>`. Not built yet: the dashboard, and the image. [docs/architecture.md](docs/architecture.md) has the build order.

## Tech stack

- **Node.js 24 LTS (≥ 24.12) and TypeScript**, in one repository of npm workspaces. Node runs `.ts` files directly by stripping types, so nothing that runs on the server is built. `tsc --noEmit` does the type-checking.
- **No runtime dependencies on the server.** The sync, the import and the dashboard's server use only what Node ships: `fetch`, `node:crypto`, `node:fs`, `node:http`. The dashboard's browser interface may use libraries, bundled at build time. See [docs/architecture.md](docs/architecture.md).
- **[Enable Banking](https://enablebanking.com) API** as the licensed intermediary to each bank's PSD2 interface. Any bank it supports can be connected; nothing in the code is specific to one bank. Enable Banking is a registered account information service provider (AISP) supervised by the Finnish FIN-FSA. We use its _restricted production_ mode: free for personal use, limited to accounts linked to the application.
- **JSON files** for storage: one directory per account, one file per calendar year.
- **Dockerised**, run nightly. One image, two containers: the sync, and later the dashboard. See [docs/infra.md](docs/infra.md).

## Documentation

- [docs/architecture.md](docs/architecture.md): the parts and how they fit. Start here.
- [docs/archive-format.md](docs/archive-format.md): the files everything shares.
- [docs/sync.md](docs/sync.md): authorising, the nightly sync, and import.
- [docs/dashboard.md](docs/dashboard.md): the web app and its category rules.
- [docs/infra.md](docs/infra.md): how this is hosted, backed up and monitored.
- [docs/testing.md](docs/testing.md): how this is tested.
- [docs/sandbox.md](docs/sandbox.md): running the sync against the Enable Banking sandbox.

## Development data

This repository holds no real bank data, and the working directory never does either. There is no local production configuration and no local copy of the archive.

- **`fixtures/archive/`** is a synthetic archive in the layout [docs/archive-format.md](docs/archive-format.md) describes: two made-up banks, ten accounts, both sources, with `fixtures/config.json` beside it. The dashboard is built against it.
- **`npm run fixtures`** produces it, deterministically. Change the generator and run `npm run fixtures`; never edit the files by hand. A test fails if the two drift apart.
- The `sync` code is developed against a fake bank in tests, and against the Enable Banking sandbox with data and state under `tmp/sandbox/`.

The synthetic `raw` shape follows Enable Banking's documented schema, not an observed bank response, and leaves optional fields null.

## Running the sync against the sandbox

The commands run against Enable Banking's sandbox, never against production, from a developer's machine. [docs/sandbox.md](docs/sandbox.md) walks through the setup: the application, `.env.sandbox`, the directories, the configuration file, and the first `auth`.

```sh
node --env-file=.env.sandbox sync/src/cli.ts banks <country>   # the bank names to configure
node --env-file=.env.sandbox sync/src/cli.ts auth <bank>       # approve at the bank, paste the address back
node --env-file=.env.sandbox sync/src/cli.ts sync              # fetch and merge, for every bank and account
node --env-file=.env.sandbox sync/src/cli.ts status            # consent expiry and last full fetch
node --env-file=.env.sandbox sync/src/cli.ts import <format> <file>   # check an exported file; --write imports it
```

`<bank>` is the bank's key in the configuration file. Each command exits 0, or 1 with a message that says what to do.
