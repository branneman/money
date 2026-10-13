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
| `banks <country>`        | the user    | The bank names Enable Banking lists for one country.    |
| `import <format> <file>` | the user    | Merges an exported file into the archive.               |

`auth` and `sync` take a lock in `STATE_DIR`, so only one of them writes at a time. `status` and `banks` read only.

Under the lock, and before any request, `auth` and `sync` prove that `DATA_DIR` can be written where a fetch writes first: they create `DATA_DIR/.inbox` if it is absent, write a dot-prefixed file in it, and remove it. Startup checks only that the directory exists, and everything before the first page only reads, so without this a data volume mounted read-only would be found after the bank had answered. A failure says `DATA_DIR cannot be written`, with the error's code, and never the path.

Every command exits non-zero on any failure, with a message that says what to do. The exit code is 0 or 1.

## Configuration

**Environment variables** hold what is secret or specific to one machine: `EB_APP_ID`, `EB_PRIVATE_KEY` (the PEM file, base64-encoded), `EB_REDIRECT_URL`, `CONFIG_PATH`, `DATA_DIR`, `STATE_DIR`, `LOOKBACK_DAYS` (default 30) and `CONSENT_WARN_DAYS` (default 14). The two numbers are whole, 0 or more. `.env.example` documents each one.

`DATA_DIR` and `STATE_DIR` must exist. Neither is ever created, so a missing mount is an error and never an empty archive.

Every command checks all of this at startup, in two stages, and stops at the first stage that finds something. First the environment: every problem in it is reported together. Then, once the environment is sound, the two directories and the configuration file: every problem there is reported together. A message names a variable and never repeats its value.

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

- **`banks`**: one entry per bank, with the exact name and country Enable Banking lists it under. Read the name from `banks <country>`, which prints what `GET /aspsps` lists; never guess it.
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

1. Read the bank's entry from `GET /aspsps` by its exact configured name and country. It gives `maximum_consent_validity`, in seconds, and the PSU headers the bank lists as required, which are printed. Start an authorisation (`POST /auth`) for a personal consent, for transactions only, lasting that long, and print the URL.
2. The user approves with the bank. The browser lands on the redirect URL; the page does not load, which is expected. The user pastes the full URL back. If the input ends without an answer, as it does without a terminal, the command fails with "no address was given", exits 1 and releases the lock.
3. Verify `state` and exchange the code for a session (`POST /sessions`). The session's `valid_until` must be an RFC 3339 time, with `Z` or a numeric offset and a real calendar date. Anything else stops the command. It is stored as a UTC timestamp in whole seconds.
4. Match the session's accounts to the configured ones by IBAN, ignoring spaces and case. A configured, open account that the consent does not cover, or covers without a `uid`, is an error that names it, and nothing is stored. So is a configured account whose IBAN matches more than one account in the consent: `auth` never picks one. Accounts in the consent that are not configured are counted and ignored.
5. Store the session, its expiry and the account mapping under `STATE_DIR`.
6. **Fetch at once**, before returning. See below. If a fetch fails here the session is already stored, and the command exits non-zero and names the accounts not fetched in full. It says to run `auth` again now, and why: see "When the first fetch is not whole", below. An error the code did not expect stops the command as it does anywhere, but the same line is printed first, naming every account of the bank, since the user has been to the bank and must learn that the consent is kept.

**`auth <bank> --show-ibans`** prints, after step 3, the IBAN of every account in the consent, each as JSON on a line of its own. It is the only place any command prints an IBAN, and only when asked. It exists for the sandbox, where a test account's IBAN cannot be known beforehand and the configuration needs it. Never use it where output is collected.

A renewing `auth`, like `sync`, exits 1 when a stored record is newly missing from a window that should hold it.

**What can be found out before the bank visit is.** Before step 1, `auth` reads the state that is already there for the bank, and for each account it is about to fetch does what the fetch does first anyway: repairs a record left in two year files, reads the account's API records, and lists the runs in its inbox. State the sync cannot use, a year file it cannot read, or an inbox run that is not what the sync wrote, therefore stops the command before the user goes to the bank, with the message the fetch would have given. Nothing is merged at this point, and nothing is written unless a record needed repair.

**A token per request.** The user may take longer at the bank than a token lasts, and a deep backfill may too, so no token is kept: each request carries one minted for it.

## The backfill

Under PSD2, a bank may serve older history only while the user has just authenticated, and afterwards only the most recent 90 days. Some banks go further and allow the full history to be fetched once. So the fetch that follows an authorisation can reach further back than any later one, and may not be repeatable.

- An account with **no recorded success** is fetched over the longest period the bank will give (`strategy=longest`, no dates), by whichever command reaches it first. `auth` fetches every account immediately, so for a new account that is the fetch with the user present.
- "No recorded success" rather than "no records": a backfill that died halfway, or a lost state volume, must get the deep fetch again. A renewal for an account that has a success fetches from it, like a nightly run.
- `auth` decides this from the state as it finds it. An account that had no recorded success then is asked for the longest period, even when a completed run left in the inbox has just recorded one. So after lost state, `auth` always reaches as far back as the bank gives.
- The first authorisation at a bank is not a test run. Do it only when the sync is finished and tested.

Whether a deep backfill needs the PSU headers that mark the user as present is not yet known. See Open questions.

### When the first fetch is not whole

If `auth` ends with an account not fetched in full, **run `auth <bank>` again, at once, before the nightly job runs.** The command says so:

```text
The consent is stored. Not fetched in full: bnka-current. Run auth bnka again now: only then can the bank be asked for the whole history. The nightly sync will otherwise continue with what the bank serves unattended.
```

The reason is what the nightly `sync` would do with such an account. It has no recorded success, so `sync` asks for the longest period, but by then the bank no longer treats the user as present and gives only what it serves unattended. That fetch completes, and a completed fetch records the account's success. From then on every `auth` is a renewal with a dated window, and the older history is never asked for again. A second `auth` finds the account still without a success, and asks for the longest period with the user present.

What arrived before the failure is not lost either way: the pages are in the inbox, and whichever command runs next merges them.

One case where the dated window is harmless: a completed run left in the inbox records its success when it is merged, so if `auth`'s own longest fetch then dies, the next `sync` sends a dated window for that account. The archive already holds the earlier history in that case, from the runs before the state was lost.

Whether an unattended longest-period fetch that completes should count as the account's first success at all is an open question for the owner. See Open questions.

## Fetching: the inbox

Every fetch, backfill or nightly, has two phases, so that nothing a bank returned can be lost between receiving it and merging it. The inbox is the only way data moves from the first to the second: the merge reads pages from disk, never from memory, so a fresh fetch and one left by a run that died take the same path.

```text
$DATA_DIR/.inbox/<account key>/<run>/
  1.json  2.json  ...     the pages, as received
  complete.json           the marker
```

`<run>` is the run's start time, `YYYYMMDDTHHMMSSZ`.

1. **Receive.** Each response with status 200 that parses as JSON is written, as received, by temporary file and rename, before the next page is requested. Any other response is not a page and is not kept. When the last page is in, the marker is written: the run's start time, its window and its page count.
2. **Merge.** A run is merged into the year files, page by page, and then removed. Runs are merged oldest first. Merging one page at a time means that a transaction that changed at the bank between two pages becomes a revision instead of a contradiction.

Before fetching, whatever the inbox already holds for the account is merged first:

- **A completed run** is merged as if it had just been fetched, and its success is recorded with the start time in its marker. The bank is not asked for it again.
- **An incomplete run is merged too.** Each page present is whole and is what the bank sent, and a partial batch cannot do harm, because the merge never deletes. No success is recorded for it and no missing-record check is made. A half-finished backfill's pages therefore reach the archive.
- **A run the code cannot read stays, and stops its account**, every night, until the code is taught to read it or the user removes it by hand. Fetching past it could put revisions in the wrong order; removing it would discard something a bank sent. The account's failure is followed by a line that names the way out: the run's name, that it stays in `.inbox/<account>/<run>` and stops the account until it can be read, and that nothing has been removed. That holds for a page that fails validation, a page the merge refuses, and a run whose pages or marker are not what the sync wrote.
- **A page the merge refuses is reported by run and page, never by identifier.** The one thing the merge can still refuse on a validated page is a transaction that appears on it twice with different contents. The message says that, and names the account, the run and the page number. It does not name the transaction: the identifier has come from a response and is stored nowhere yet, and the line is printed every night for as long as the run stays.
- **Only an account that is fetched has its inbox merged.** The inbox is not merged for an account that is closed or loses its `iban`; for any account of a bank whose consent has expired, or that has no stored state or state the sync cannot use; for an account the stored consent does not cover; or for the accounts passed over after an error that says the consent is gone. It waits until the account can be fetched again, and nothing reports that pages are waiting there.

Details that matter when something goes wrong:

- **"As received" means the text the response decodes to as UTF-8.** A byte order mark is dropped, and a byte sequence that is not valid UTF-8 becomes U+FFFD. The inbox is a buffer against a run dying, not a forensic copy.
- **A merged run is removed in two steps.** Its directory is renamed to `.removed-<run>` and then deleted, and any `.removed-*` left by an earlier removal is deleted first. A run is therefore whole or hidden, never half there. Names starting with a dot are never listed as runs or pages.
- **Durability.** Pages, markers and state are written to a temporary name, flushed, and renamed. The directory is not flushed after the rename, so the guarantee is against the process dying, not against power loss. The ordering relied on spans three directories: the year files, the state and the inbox.

## The nightly run: `sync`

The run first proves that `DATA_DIR` can be written (see Commands). Every request carries a JWT minted for it. Then, for each bank, and each of its open accounts that the API can reach:

1. Repair a record that an interrupted write left in two year files ([archive-format.md](archive-format.md)), and merge whatever the inbox holds.
2. Fetch booked transactions from _last successful sync minus `LOOKBACK_DAYS`_ through today, following `continuation_key` until it is absent. Because the window is anchored on the last success, missed nights catch up on their own. An account with no recorded success is asked for the longest period instead.
3. Send no PSU headers. The run is unattended.
4. Merge, as defined in [archive-format.md](archive-format.md). Record the success in `STATE_DIR` only after the data is written. The success is the run's **start** time, so a transaction booked while the run was in progress falls inside the next window.

Then:

- **Banks fail separately, and so do accounts.** An expired consent at one bank, or an error on one account, does not stop the others. The run finishes them, then exits non-zero and names what failed. A consent known to have expired makes no request at all. An error that says the consent is gone stops the rest of that bank's accounts.
- **That holds for failures the code expects:** an API error, an expired or absent consent, a response that fails validation, state the sync did not write. An error it did not anticipate, such as a filesystem error or a bug, stops the whole run, later banks included, and exits non-zero.
- **Missing records.** A stored record whose date lies inside a completed window and that the fetch did not return is kept, and makes the run exit non-zero, **once**: the account's state remembers which ids are missing, and only a newly missing one alerts. It means a bank withdrew a booking or changed an identifier. The line that reports it is printed before the state is written, so a run that dies between the two has said it, and the next run, which finds the ids not yet remembered, says it again. A backfill makes no such check, since its reach is not known.
- **No clamp.** If a bank refuses a window that reaches further back than it serves unattended, the account fails with a message that says to run `auth`.
- **A consent near its end** is logged by `sync` when it expires within `CONSENT_WARN_DAYS`, and that does not change the exit code. In production a line nobody reads is useless, so it is `status` that exits non-zero inside that window. See below, and [infra.md](infra.md).
- **Logs hold counts, dates and keys only.** No amounts, account numbers, names or descriptions. The handler at the top prints a message only for the project's own errors. Any other error prints its class and code and nothing else, because a filesystem error carries a host path and a JSON syntax error quotes the text it failed on.

## State

One file per bank, `$STATE_DIR/<bank key>.json`, written by temporary file and rename, and validated when read.

```json
{
  "session_id": "00000000-0000-4000-8000-000000000000",
  "valid_until": "2027-04-09T10:00:00Z",
  "accounts": {
    "bnka-current": {
      "uid": "00000000-0000-4000-8000-000000000001",
      "last_success": "2026-10-11T03:00:00Z",
      "missing": []
    }
  }
}
```

- `auth` writes the session, its expiry and each `uid`. A renewal replaces those and keeps `last_success` and `missing`.
- `last_success` is absent until the account's first completed fetch has been written.
- **State is written after the data it describes.** A run that dies between the two leaves a completed run in the inbox, and the next run records the success without asking the bank.
- **Losing it loses nothing permanent.** After a new `auth`, every account is fetched as far back as the bank gives, into the existing archive.
- A file that is not what the sync wrote fails its bank, with a message that says to remove it and run `auth`.

### The lock

`auth` and `sync` take `$STATE_DIR/lock`, which holds the process id of the run, and release it when they end. The store assumes one writer per account and source; without the lock, a manual run overlapping the nightly one could overwrite what the other had just written.

- **A lock whose process is alive stops the command**, with a message that says so.
- **A lock whose process is gone is taken over.** So is one whose content is not a plain positive integer.
- **It is never seen empty.** Its content is written to a temporary file that is then linked to the lock's name, which fails if the lock exists. `STATE_DIR` must therefore be on a filesystem with hard links.
- **Taking over** renames the lock aside, and checks that what was moved is what was judged stale. If it is not, it is put back and the command stops.
- **Releasing** removes the lock only if it still holds this process's id.

One limit, stated plainly: **the lock only excludes runs that share a process-id namespace.** Whether a holder is alive is judged by its process id, and a lock naming the command's own id is treated as stale, because ids repeat inside a container. If the nightly job and a manual `auth` each run as process 1 in separate containers over one `STATE_DIR`, neither excludes the other. How the commands are run is the host's decision; the requirement is in [infra.md](infra.md).

## Checking: `status`

Makes no request and takes no lock. For each bank it prints the date the consent ends and the days left, and for each account the date of its last full fetch.

It exits non-zero when a bank that has an account to fetch has no stored consent, or its consent has expired or expires within `CONSENT_WARN_DAYS`. The exit code is the warning.

## Listing banks: `banks <country>`

Takes a country as two capital letters, such as `NL`. Makes one request, `GET /aspsps` for that country, takes no lock and writes nothing. It prints each listed bank's name on a line of its own, as JSON with its quotes, which is exactly what a bank's `name` in the configuration file must hold. It exits non-zero when nothing is listed for the country.

`auth` matches a bank by name and country exactly, capitals and spaces included, and says to run `banks` when it finds no match. Which banks are listed depends on the application: a sandbox application is shown sandbox banks.

The names come from a response and are printed, so this command is for a terminal. It is never part of the nightly job, whose output leaves the host.

## Bank constraints

These differ per bank. The sync assumes the strictest case and reads a bank's real limits from the API where it can.

- Only **booked** transactions are archived. Some banks never return pending ones.
- Unattended access reaches back a limited time, as little as **90 days**.
- Consent lasts **180 days** at most, and renewing it needs the user.
- At most **four unattended fetches per day** per account.
- PSD2 covers **payment accounts**. Savings accounts are often not exposed, and credit cards are frequently run by a separate issuer. Those accounts are reachable by import only.

## Enable Banking details

- **JWT:** RS256, header `kid` set to the application id, claims `iss: "enablebanking.com"`, `aud: "api.enablebanking.com"`, `iat` and `exp`. The API allows a lifetime of at most 24 hours. A token is minted for each request, valid for an hour, so a command that runs longer than that, as an `auth` can, never sends an expired one.
- **One address.** Sandbox and production share `https://api.enablebanking.com`. Which one a request reaches is decided by the application the token names.
- **Account `uid`s live only as long as their session** and change with every new consent. They are session state, never identity.
- **Dates:** `date_from` and `date_to` are UTC dates.
- **Booked only.** Transactions are requested with `transaction_status=BOOK`, and anything else that arrives is skipped and counted.
- **`strategy=longest`** is sent without dates. It ignores `date_to`.
- **Amount sign:** `transaction_amount` is unsigned; `credit_debit_indicator` gives the direction.
- **Redirect URL** must be HTTPS. The registered one is `https://localhost/auth-callback`.
- **Validate on arrival.** Each response is checked for the fields the code reads, by type as well as presence. One of an unexpected shape fails its account, or stops `auth`. A booked transaction without `entry_reference`, or without a `booking_date` that is a real date, is such a response.
- **Numbers.** A page holding a number that JSON would write back differently is refused, since the stored copy would then differ from every later fetch. The rule is for pages only, because only pages are stored: the list of banks, an authorisation and a session are parsed as plain JSON, so a number in a field nobody reads cannot refuse a session after its one-time code is spent.
- **The list of banks.** Only the entry asked for is checked. Any other entry is passed over, including one that is not an object.
- **No answer.** A request that fails without a response is reported as no answer, with the error's name when that is a plain word, such as `TimeoutError`, and otherwise its class.
- **Paging.** A `continuation_key` the bank has already given during the same fetch stops the account with an error. Following it would never end.
- **Errors.** A failed response is reduced to its HTTP status and its `error` code. Its `message` and `detail` are never kept. `EXPIRED_SESSION`, `REVOKED_SESSION`, `CLOSED_SESSION` and `SESSION_DOES_NOT_EXIST` mean the consent is gone.
- **No retries, and a time limit on every request.**

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

The archive-format slice left these to the import:

- The configuration validator should reject unknown keys, so a mistyped column name cannot silently yield nulls.
- An import format's `id` column must not point at a sensitive column, since identities appear in messages.

The power-loss and single-writer limits are stated in [archive-format.md](archive-format.md).

## Open questions

Each needs a real response or a real file to answer. None can be settled from documentation.

- **Does every bank supply `entry_reference`, and is it stable?** Fetch the same period on two different days and compare.
- **Does `strategy=longest` unlock a bank's one-time full history?** The first production backfill will show how far back it reached.
- **Are PSU headers needed for a deep backfill?** They assert that the user is present, which is true during `auth`, but there is no browser to take them from.

### What the sandbox showed

On 2026-10-13 the commands were run against one sandbox bank with one account: `auth`, `sync` twice, and `status`. A sandbox bank is not a real bank, so none of the three questions above is closed by it.

- **Every response was accepted as the code expects it.** The list of banks, the start of the authorisation, the session with its `valid_until`, and four pages of transactions passed validation unchanged. The consent was given for 180 days.
- **The identity held between fetches a minute apart.** `auth` stored 366 transactions from three pages. Each `sync` that followed asked for a 30-day window and found its 31 transactions unchanged: none added, none revised, none missing. So each had the identity and the exact `raw` it had before. That says nothing yet about two different days.
- **The longest period was served without PSU headers.** The bank lists `psu-ip-address` as required; none is sent, and the fetch that follows the authorisation was served in full. How far back it reached in dates was not read.
- **The fake needed no correction.** No place was found where the real API differs from it. A page held more than a hundred transactions.
- **Not observed:** whether the two dates of a window are inclusive, how the last page marks its end, a consent that has expired, and any error response.

The pass also showed what a first run cannot know, and three things were added for it: `banks <country>`, the count of accounts when a configured account is not in the consent, and `auth --show-ibans`. [sandbox.md](sandbox.md) is the walkthrough.

One is for the owner to decide, not for a response to answer:

- **Should an unattended longest-period fetch that completes count as an account's first success?** Today it does. When a first `auth` leaves an account not fetched in full and the nightly `sync` reaches it before a second `auth` does, the account's success is recorded on whatever the bank served unattended, and the older history is never asked for again. The message and the runbook say to run `auth` again first; nothing enforces it.
