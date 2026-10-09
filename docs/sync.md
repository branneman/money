# Sync and import

How transactions get into the archive. Two writers, each with its own subdirectory per account:

- **`sync`** fetches from banks through the Enable Banking API, nightly and unattended.
- **`import`** reads a file exported from a bank's website, by hand, for history and accounts the API cannot reach.

What they write is defined in [archive-format.md](archive-format.md).

```text
Bank  <--------- consent via `auth <bank>`
  |              (manual, at most every 180 days)
  | PSD2
  v
Enable Banking              bank's website
  |                              |
  | REST                         | export file
  v                              v
sync (nightly)              import (by hand)
  |                              |
  v                              v
<account>/api/<year>.json   <account>/import/<year>.json
```

## Commands

| Command                  | Run by      | Does                                                    |
| ------------------------ | ----------- | ------------------------------------------------------- |
| `auth <bank>`            | the user    | Starts or renews consent for one bank, then backfills.  |
| `sync`                   | the nightly | Fetches, merges and writes, for every bank and account. |
| `status`                 | either      | Consent expiry and last successful sync, per bank.      |
| `import <format> <file>` | the user    | Merges an exported file into the archive.               |

Every command exits non-zero on any failure, with a message that says what to do.

## Configuration

**Environment variables** hold what is secret or specific to one machine: `EB_APP_ID`, the Enable Banking private key, `EB_REDIRECT_URL`, `CONFIG_PATH`, `DATA_DIR`, `STATE_DIR`, `LOOKBACK_DAYS` (default 30) and `CONSENT_WARN_DAYS` (default 14).

**A configuration file**, at `CONFIG_PATH`, holds what is structured: the banks, the accounts and the import formats.

```json
{
  "banks": {
    "bnka": { "aspsp": { "name": "Example Bank", "country": "NL" } }
  },
  "accounts": {
    "bnka-current": { "bank": "bnka", "iban": "NL00BNKA0000000001" },
    "bnka-joint": { "bank": "bnka", "iban": "NL00BNKA0000000002" },
    "bnka-card": { "bank": "bnka", "import_id": "1234" },
    "bnkb-current": { "bank": "bnkb", "iban": "NL00BNKB0000000001", "closed": true }
  },
  "imports": {
    "bnka-export": {}
  }
}
```

- **`banks`**: one entry per bank, with the exact name and country Enable Banking lists it under. Read the name from `GET /aspsps`; never guess it.
- **`accounts`**: one entry per account key. `iban` is how the account is recognised in a consent, and in an export file. `import_id` is what an export file calls the account when that is not an IBAN. An account with only an `import_id` is never fetched.
- **`closed`**: the account is kept and shown, and never fetched again.
- **`imports`**: import formats by key, as described in [archive-format.md](archive-format.md).

- **Keys.** Bank keys and import format keys match `[a-z0-9-]+`, like account keys.
- **Identifiers.** An `iban` or an `import_id` that is present must be a non-empty text, even when the other one is valid.
- **Messages never contain a value from the file.** They name keys and fields. An unknown bank is reported without its name, and an entry whose key is malformed is named by its position, such as `accounts, entry 2`.

The file is validated at startup, and anything wrong with it stops the command. Both containers read it; neither writes it. The real file names real banks and accounts, so it lives with the production configuration. This repository holds only a made-up example, which the tests use.

One Enable Banking application serves all banks. It is registered once, in production mode, with every account linked to it in the Control Panel. Linking whitelists an account; it does not authorise anything.

## Authorising: `auth <bank>`

Interactive, run by the user in production, at most every 180 days per bank.

1. Start an authorisation for the bank (`POST /auth`) and print the URL. Ask for the longest consent the bank supports, taken from `maximum_consent_validity`.
2. The user approves with the bank. The browser lands on the redirect URL; the page does not load, which is expected. The user pastes the full URL back.
3. Verify `state` and exchange the code for a session (`POST /sessions`).
4. Match the session's accounts to the configured ones by IBAN. A configured, open account that the consent does not cover is an error that names it.
5. Store the session, its expiry and the account mapping under `STATE_DIR`.
6. **Backfill at once**, before returning. See below.

## The backfill

Under PSD2, a bank may serve older history only while the user has just authenticated, and afterwards only the most recent 90 days. Some banks go further and allow the full history to be fetched once. So the fetch that follows an authorisation can reach further back than any later one, and may not be repeatable.

- `auth` therefore fetches every account immediately, asking for the longest period the bank will give (`strategy=longest`).
- It does this for each account that has no API records yet. A renewal for an account that already has data fetches from its last successful sync, like a nightly run.
- The first authorisation at a bank is not a test run. Do it only when the sync is finished and tested.

Whether a deep backfill needs the PSU headers that mark the user as present is not yet known. See Open questions.

## Fetching: the inbox

Every fetch, backfill or nightly, has two phases, so that nothing a bank returned can be lost between receiving it and merging it.

1. **Receive.** Each page is written, exactly as received, to `$DATA_DIR/.inbox/<account key>/<run>/<n>.json` before the next page is requested. When the last page is in, a marker file completes the run.
2. **Merge.** A completed run is merged into the year files, and then removed.

At startup, a completed run left in the inbox is merged first. An incomplete one is reported and left alone: for a nightly run it is fetched again, and for a backfill the pages that did arrive are still there.

## The nightly run: `sync`

For each bank, and each of its open accounts that the API can reach:

1. Mint a fresh JWT.
2. Fetch booked transactions from _last successful sync minus `LOOKBACK_DAYS`_ through today, following `continuation_key` until it is absent. Because the window is anchored on the last success, missed nights catch up on their own.
3. Send no PSU headers. The run is unattended.
4. Merge, as defined in [archive-format.md](archive-format.md). The merge cannot tell that a stored record is missing from a fetch; the sync knows the window, so it is the sync that checks, keeps the record and logs a warning. Record the success in `STATE_DIR` only after the data is written.

Then:

- **Banks fail separately.** An expired consent at one bank does not stop the others. The run finishes them, then exits non-zero and names what failed.
- **Consent warnings.** `sync` and `status` warn when any consent expires within `CONSENT_WARN_DAYS`. In production a warning nobody sees is useless, so `status` exits non-zero inside that window. See [infra.md](infra.md).
- **Logs hold counts, dates and keys only.** No amounts, account numbers, names or descriptions.

## Bank constraints

These differ per bank. The sync assumes the strictest case and reads a bank's real limits from the API where it can.

- Only **booked** transactions are archived. Some banks never return pending ones.
- Unattended access reaches back a limited time, as little as **90 days**.
- Consent lasts **180 days** at most, and renewing it needs the user.
- At most **four unattended fetches per day** per account.
- PSD2 covers **payment accounts**. Savings accounts are often not exposed, and credit cards are frequently run by a separate issuer. Those accounts are reachable by import only.

## Enable Banking details

- **JWT:** RS256, header `kid` set to the application id, claims `iss: "enablebanking.com"`, `aud: "api.enablebanking.com"`, `iat` and `exp`. The lifetime may not exceed 24 hours; mint one per run.
- **Account `uid`s live only as long as their session** and change with every new consent. They are session state, never identity.
- **Dates:** `date_from` and `date_to` are UTC dates.
- **Amount sign:** `transaction_amount` is unsigned; `credit_debit_indicator` gives the direction.
- **Redirect URL** must be HTTPS. The registered one is `https://localhost/auth-callback`.
- **Validate on arrival.** A response of an unexpected shape stops the run. A booked transaction without `entry_reference` or `booking_date` is such a response.

## Import: `import <format> <file>`

Run by the user in production: copy the exported file to the host, run the command in the sync container, delete the file. The file never passes through this repository.

1. Decode the file with the encoding the import format names, checking it as described below, and read it with that format. Every row must have an account, an identifier, a date and an amount that parse.
2. Route each row to its account key. A row for an unknown account rejects the file.
3. Check that identifiers are unique within each account. If not, reject the file.
4. Merge into `<account>/import/<year>.json`, by the same rules as the sync.

Nothing is written unless the whole file is accepted. And nothing is written at all without `--write`: by default `import` only checks the file and prints a summary, so the result can be looked at first. An import is permanent, like everything in the archive.

### Checking the encoding

A file read with the wrong encoding still produces text, just with the wrong letters, and that text would be stored for good. The single-byte encodings accept any byte, so decoding alone never fails for them. The import therefore checks:

- **A file declared single-byte that is valid UTF-8 with multi-byte characters, or starts with a UTF-8 byte order mark, is rejected.** Real single-byte text almost never forms valid UTF-8 by accident.
- **A file declared UTF-8 that is not valid UTF-8 is rejected.**
- **Decoded text containing control characters is rejected**, other than tab and line endings. This catches bytes that have no meaning in the declared encoding.
- **Every column the format names must be present in the header, exactly.** A header containing an accented letter doubles as a known-answer test.
- **The summary lists every distinct non-ASCII character found, with a count.** `windows-1252` and `iso-8859-15` differ in only eight characters, the euro sign among them, and no check can tell them apart. A stray `¤` where a `€` belongs is visible in that list.

Import is safe to repeat. Importing the same file twice changes nothing, and overlapping exports merge by identifier. That matters for accounts the API cannot reach, where a fresh export every so often is the only route.

Where an import overlaps what the API has fetched, both are stored and the reader prefers the API. See [archive-format.md](archive-format.md).

## What the sync and the import owe the archive

The archive-format slice left these to the code that calls it:

- Check at startup that `DATA_DIR` exists. A missing directory reads as an empty archive.
- A recovery path for a record found in two year files after an interrupted write. Reading reports it and stops.
- Timestamps passed to `merge` are truncated to whole seconds.
- Validate API responses at the boundary by type as well as presence: a value date that is a number, numbers that would not survive JSON unchanged. Hand `merge` only JSON-clean `raw`.
- A stored record absent from a fetch window that should contain it is noticed here, since `merge` cannot see the window.
- Filesystem errors carry host paths in their messages. The top-level handler decides what is logged.
- The configuration validator should reject unknown keys, so a mistyped column name cannot silently yield nulls (import slice).
- An import format's `id` column must not point at a sensitive column, since identities appear in messages.
- A new workspace's tests are not run until the root `test` script and `tsconfig.json` list it.

The power-loss and single-writer limits are stated in [archive-format.md](archive-format.md).

## Open questions

Each needs a real response or a real file to answer. None can be settled from documentation.

- **Does every bank supply `entry_reference`, and is it stable?** Fetch the same period on two different days and compare.
- **Does `strategy=longest` unlock a bank's one-time full history?** The first production backfill will show how far back it reached.
- **Are PSU headers needed for a deep backfill?** They assert that the user is present, which is true during `auth`, but there is no browser to take them from.
