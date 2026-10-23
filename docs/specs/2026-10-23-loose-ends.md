# Spec: loose ends

Not a slice of the build order in [architecture.md](../architecture.md): the small things the first four slices left, done together before the dashboard. Written 2026-10-23. Once it has shipped this file is history and is not kept up to date.

## Goal

Close what the image slice left open in review, and three gaps in the sync and the import that only matter once real accounts change over time:

- **CI and the image:** `:latest` always names the newest commit on `main`; no job keeps a token in its checkout; a nested `node_modules` stays out of the image; `scripts/check-image.sh` fails loudly, runs from anywhere, and never pulls or reaches a network.
- **The sync:** whatever waits in the inbox of an account the run does not fetch is merged in the same run, so closing an account in the configuration never strands what a bank already sent.
- **`auth`:** a renewal closes the session it replaces, and a session `auth` refuses to store is closed again at once.
- **`import`:** each account's summary says how many of the file's rows the view will not show.

No configuration field is added or changed, so the image can reach production before anything changes on the host.

## Why now

The sync has run every night since it went to production, and the import has been used on real files. Two things are now ordinary events rather than hypotheticals: an account is marked `closed` in the configuration, and a consent is renewed. Today a closed account's waiting pages sit in the inbox for ever, and nothing reports them; a renewed consent leaves the previous one open at the bank until it lapses, up to 180 days later. And `:latest` is what production runs, so the order in which it is pushed is no longer a CI detail.

## What gets built

| Part                                      | Does                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                | `publish` runs one at a time and moves `:latest` only to `main`'s head.       |
| `.dockerignore`, `scripts/check-image.sh` | A nested `node_modules` is kept out and checked for; the script's three gaps. |
| `sync/src/commands/account.ts`            | Merges an account's inbox without fetching it; `fetchAccount` takes names.    |
| `sync/src/commands/sync.ts`               | After the banks, merges what waits for every account it did not fetch.        |
| `sync/src/enablebanking/client.ts`        | `closeSession`, a `DELETE`.                                                   |
| `sync/src/commands/auth.ts`               | Closes the session a renewal replaced, and one it refused to store.           |
| `sync/src/commands/import.ts`             | `hidden=` in each account's summary.                                          |
| `sync/testing/fake-bank.ts`               | Deletes a session, and refuses a closed session's accounts.                   |

### CI and the image

These are the items under "Left open" in [the image spec](2026-10-14-image.md).

- **`publish` runs one at a time.** It gets a concurrency group of its own, without cancelling a run in progress. Two publishes then never interleave their pushes.
- **`:latest` moves only to the head of `main`.** A group serialises runs but does not order them: if the older commit's tests finish last, its publish runs last. So, just before pushing `:latest`, `publish` asks the remote for the commit `main` points at (`git ls-remote`, which needs no token on a public repository). If that is still this run's commit, it pushes `:<commit-sha>` and then `:latest`, as now. If not, it pushes `:<commit-sha>` only and prints a line saying `:latest` is left to the newer commit. A failure to ask fails the job.
  - A queued publish that GitHub replaces with a newer one never pushes its `:<commit-sha>` at all. That is fine: `:latest` still never names an image whose own tag is missing.
- **No checkout keeps a token.** Every `actions/checkout` step, in all four jobs, sets `persist-credentials: false`. None of them uses git with credentials after the checkout. In `publish` this matters most, because that token can write packages while a branch-built Dockerfile and the check run.
- **A nested `node_modules` stays out.** `.dockerignore` gains `**/node_modules` after the paths it admits. Step 5 of `scripts/check-image.sh` also fails if any `node_modules` exists in `/app` other than `/app/node_modules`.
- **`scripts/check-image.sh` fails with a `FAIL` line**, never silently. Every `docker run` whose output the script captures (the uid, the listing, the search for files that must be absent) ends in `|| fail "<what was being checked>"`, so a run that fails says which check it was.
- **It runs from any directory.** It finds the repository root from its own path, and makes its work directory there, where it does today when run from the root.
- **It runs only the image it was given, and without a network.** Every `docker run` gets `--pull=never` and `--network none`. A typo in the image name then fails instead of pulling a stranger's image of that name, and the check proves the commands it runs need no network.
- **The ownership step is seen to fail.** During the build, the Dockerfile is broken so that `/data` is not owned by the image's user, the image is built and checked, step 3 must print its `FAIL` line, and the Dockerfile is restored. The same is done for the nested `node_modules` check and for a failing captured run. None of these breaks is committed.

### The two weak tests, and the two booleans

- **"A backfill that died during auth is continued by sync"** (`sync/src/commands/sync.test.ts`) is renamed to say the account then fails, and asserts the line `bnka-current: fetched without a first success, so the bank gave only what it serves unattended. Run: auth bnka`.
- **"A record left in two year files stops a check, and is repaired under --write"** (`sync/src/commands/import.test.ts`) asserts its output in order again: the `recovered` line first, then the account's whole `import-account` line, not a fragment of it anywhere in the output.
- **`fetchAccount` takes `backfill` and `attended` by name.** `FetchOptions` already does for `fetchAccounts`. Inside, the private `fetchAccount` still takes them as two adjacent positional booleans, which are easy to swap.

### What waits for an account that is not fetched

Today only an account that is fetched has its inbox merged ([sync.md](../sync.md), "Only an account that is fetched has its inbox merged"). After this slice nothing that reached the inbox waits for a fetch that may never come.

- **After the banks, `sync` sweeps every other account in the configuration.** That is every configured account whose fetch the run did not start: one marked `closed`, one without an `iban`, every account of a bank with no stored state, state the sync cannot use, or an expired consent, one the stored consent does not cover, and those passed over after an error saying the consent is gone. An account whose fetch did start has already had its inbox merged, or failed while merging it, and is left alone.
- **A sweep merges and removes, and touches no state.** For each such account, a record left in two `api/` year files is repaired first, as before a fetch. Then every run in its inbox is merged, oldest first and page by page, exactly as the drain before a fetch merges it, and removed once its data is written. No success is recorded and no missing-record check is made, even for a completed run.
  - The account's state may be gone: a renewal keeps only the accounts it covers, so a closed account usually has none. A success recorded for an account nobody fetches again would mean nothing.
  - For an account that is fetched again later, a run's success left unrecorded costs nothing: its next window starts from the success before, or it is backfilled.
  - Each merged run prints the same `merged` line a drain prints.
- **What the sweep cannot merge fails as a drain's does.** A run the code cannot read, or a page the merge refuses, stays where it is, prints the same two lines, and adds the account to `failed:`, so the run exits 1. A sweep never stops another account.
- **Runs under a key the configuration does not name** are kept and reported. For each directory in `.inbox` that is not a configured account and holds at least one run, `sync` prints `<key>: <n> run(s) wait in .inbox/<key> for an account the configuration does not name. They are kept; nothing has been removed.`, adds the key to `failed:`, and exits 1. Such a directory is printed by name only if the name is a valid account key (`[a-z0-9-]+`). Any other name is reported as `an entry of .inbox that is not an account key`, since a name nobody validated may not be printed. Names starting with a dot are skipped, as everywhere in the inbox. An empty directory is not reported.
- **The sweep also runs when no account is fetched at all.** If no account is open and has an `iban`, `sync` still exits 1 with the line it prints today, but sweeps first. A configuration in which every account is closed is the one where waiting pages would otherwise never be merged.
- **Only `sync` sweeps.** `auth` fetches its bank's accounts and drains them, as now. `status` is unchanged: once `sync` merges everything it can, the only runs left waiting are ones `sync` already reports every night.

### Closing the sessions `auth` leaves open

- **The client gains `closeSession(id)`:** `DELETE /sessions/{id}`. A 200 is success. Its body is not read, since nothing in it is used and no sandbox has shown one. Any other status is an `ApiError`, as for every request.
- **`auth` closes the previous session after the fetch that follows the authorisation**, whatever that fetch's outcome among the failures the code expects. It closes it only if the bank had stored state before, its `session_id` differs from the new one, and its `valid_until` is still in the future. An expired session has nothing left to close.
  - After the fetch, not before it: a bank may serve the older history only while the user has just been there, and that time is not spent waiting up to two minutes for an answer about the old session.
  - If the fetch stops with an error nobody expected, nothing is closed, and the command stops as it does today.
- **A close that works prints a log line:** `previous-closed bank=<bank>`.
- **A close that does not work is a note, not a failure.** An `ApiError`, or no answer from Enable Banking, prints one plain line, `The previous consent was not closed, and ends by itself on <date>: <reason>.`, where `<reason>` is the error's own message (for example `Enable Banking answered 404`). `auth`'s exit code is unchanged by it: 0 if everything else worked. Some banks may close the old consent themselves when a new one is given, and then the close fails on every renewal while nothing is wrong. An error the code did not expect still stops the command.
- **A session `auth` refuses to store is closed again.** `auth` creates the session before it matches the configured accounts to it. When the matching fails (an account the consent does not cover, covers twice, or covers without a `uid`), nothing is stored, and today the session stays open at the bank, with access to transactions until it lapses, recorded nowhere. Every retry after ticking the wrong accounts would leave one more. After this slice `auth` closes it before it stops:
  - a close that works adds the line `The consent just given was closed again.` after the error's lines;
  - a close that does not work adds `The consent just given was not closed, and ends by itself on <date>: <reason>.`, with the new session's `valid_until` as the date;
  - either way the command exits 1 with its error, as now. An error the code did not expect while closing stops the command as anywhere.
- **The session's id is never printed**, like every identifier that comes from a response.
- **A known risk, accepted.** If a bank hands back the same underlying consent on a renewal, closing the old session would revoke the new one too. `auth` would still exit 0, the next `sync` would say the consent is gone, and every later renewal would do the same. Neither the fake bank nor the sandbox can show whether any bank behaves so, and asking Enable Banking whether the new session is still authorised may not reflect what the bank did, so no guard is built. If it ever happens the nightly failure is loud, and the answer is a code change, such as a way to renew without closing. [sync.md](../sync.md) states the risk.

### How many rows the view will hide

- **Each `import-account` line gains `hidden=<n>`**, after `unchanged`:

  ```text
  import-account account=bnka-current rows=412 new=380 changed=0 unchanged=32 hidden=12 from=2021-01-04 to=2024-12-31
  ```

- **`<n>` is the number of the file's rows for that account dated on or after the account's API start**, as the archive stands when the import runs. The view leaves those out ([archive-format.md](../archive-format.md), "When both sources cover the same day"). They are stored all the same. An account with no API records has no API start and shows `hidden=0`.
- **The API start comes from `apiStarts` in `shared`**, the function the view itself uses, so the count and the view cannot disagree.
- **`import` now reads the account's `api/` year files**, check and `--write` alike. A check still takes no lock and writes nothing. `import` never writes or repairs `api/`, which only the sync writes. So an `api/` the reader refuses, a record left in two `api/` year files included, stops the import with the reader's message, and the next nightly `sync` repairs a doubled record.
- **It is information only.** It never refuses a file and never changes the exit code: an export that overlaps the API's reach is normal.
- **The count is as of now.** A later deeper backfill moves the API start earlier and hides more of what is already stored. Nothing is rewritten when it does.

## Tests

Each new test is seen to fail first.

- **Tier 1:** `closeSession` sends a `DELETE` to `/sessions/<id>` with a token, treats a 200 as success whatever its body, and any other status as an `ApiError`. The hidden count over: no API records, rows before, on and after the API start.
- **The fake bank** answers `DELETE /sessions/<id>` for a session it issued and has not closed with 200, refuses an unknown or already closed one, and verifies the token as it does for every request. Once a session is closed, a transactions request for one of its accounts is refused, so a test that closed the wrong session fails on its next fetch. Its own tests cover each.
- **Tier 2,** the real commands against the fake bank and a temporary directory:
  - a closed account whose inbox holds a completed run and an incomplete one: `sync` merges both into its `api/` year files, removes them, writes no state for it, and exits as it would have without them;
  - the same for an account of a bank whose consent has expired, and one the stored consent does not cover;
  - a swept run the code cannot read stays, prints both lines, fails that account only, and the rest of the run completes;
  - runs under a key the configuration does not name are kept, reported, and fail the run; an empty such directory is not reported; a name that is not an account key is not printed;
  - every account closed: the sweep merges, and `sync` still exits 1 with the line it prints today;
  - a renewing `auth` closes the previous session and prints `previous-closed`, and the next `sync` fetches through the new session;
  - a first `auth`, a renewal after the previous session expired, and a renewal returning the same session id close nothing;
  - a close the fake refuses prints the note, keeps exit 0, and the new session works;
  - an `auth` whose consent does not cover a configured account closes the session it just created, prints `The consent just given was closed again.` after the error, stores nothing, and exits 1; when the fake refuses that close, the other line is printed and the exit is still 1;
  - `import` prints `hidden=` with the right count against an archive with API records, and `hidden=0` against one without;
  - `import` over an account with a record in two `api/` year files stops, and writes nothing.
- **The convergence property** still holds with a sweep in the run, and is run unchanged.
- **The leak test** covers the new lines: the unknown key, both close notes, the line for a refused session closed again, `previous-closed`, and `hidden=`.
- **The image check** in CI on every push, with the breaks above seen to fail once by hand.

## Departures and additions

Written into the durable documents before the slice is done:

- **[sync.md](../sync.md):**
  - the inbox bullet "Only an account that is fetched has its inbox merged" is replaced by the sweep;
  - the nightly run gains the sweep as its last step, and the run with no fetchable account sweeps before it stops;
  - `auth` gains its last step, closing the previous session, and the note; a session it refuses to store is closed again; the accepted risk of a bank that reuses a consent;
  - the import's "What it prints" gains `hidden=` and what it means, and that the import reads `api/`.
- **[archive-format.md](../archive-format.md):** "When both sources cover the same day" says the import counts what the rule hides.
- **[infra.md](../infra.md):** `publish` runs one at a time and moves `:latest` only to `main`'s head; no checkout keeps a token; the `.dockerignore` keeps out a nested `node_modules`.
- **[testing.md](../testing.md):** the image check's new assertions and flags; the fake bank deletes sessions and refuses a closed session's accounts.

## Not in this slice

- **`status`** does not report waiting runs.
- **A command to close a consent** other than by renewing it.
- **PSU headers, business consents**, and the quote-character setting for imports.
- **The Tier 4 contract test** against the sandbox.
- **Anything on a host.** No configuration field changes, so nothing in the infra repo moves.

## Done when

- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test` pass, in the worktree and again on the merged `main`.
- `docker build -t money:local . && scripts/check-image.sh money:local` passes, run once from the repository root and once from another directory, and each break above has been seen to fail.
- The durable documents say what this slice settled.
- CI is green on `main`, and the `publish` run has been watched to the end.

## Left open, for the owner

- **A sandbox renewal** would show what Enable Banking answers to a `DELETE /sessions/{id}`, which nothing here has seen. Run `auth` twice against the sandbox, any time after the slice lands.

## What moved while it was built

Everything below is written into the documents that own it. This section is only the record of where the build differed from the text above.

- **An entry of `.inbox` that is not an account key is reported by a sentence,** `.inbox holds an entry that is not an account key. It is kept; nothing has been removed.`, once for each such entry. The text above gives a phrase, not a line. The name added to `failed:` for them is `.inbox`, since the entry's own name was never validated and may not be printed.
- **With no account fetchable, what the sweep fails is still named.** The run prints the line it printed before and then, only if the sweep failed something, `failed: <names>`. The text above says those failures are added to `failed:`, and without the line they would have been dropped without a word. The exit code is 1 either way.
- **`failed:` names each account once.** An account the stored consent does not cover, or one passed over once the consent was gone, is swept, and a swept run it cannot read failed it a second time: it was listed twice and counted twice in `done`. The names are de-duplicated, in the order they first failed. Found in the final review, with a test.
- **The fake bank's `approve` gained `same`.** With it the exchange hands back the open session the bank already holds, as a bank that reuses its consent on a renewal would. It was added to test a renewal that returns the same session id, which the tests above name and the fake could not otherwise produce.
- **A session `auth` refuses to store is not closed when it is the one already stored.** A bank that hands back the stored session, followed by a failed match, made `auth` close the session the state still pointed to, and the next `sync` found the consent gone. Nothing new was given in that case, so nothing is closed and neither close line is printed; the error and exit 1 stay. Found in the final review, with a test. The accepted risk above, for a renewal that succeeds, is unchanged.
- **`publish` does not pipe `git ls-remote`,** and refuses an answer whose first field is not 40 hexadecimal characters. Piped into `cut` under `bash -e` without `pipefail`, a failing `ls-remote` would have been hidden, and the step would have taken the branch for a newer commit and succeeded.
- **`account.test.ts` asserts `started`** where it compared the old result whole. Adding the field broke those comparisons; it was not in the plan's file list.
- **The closed-account sweep test authorises the account while it is open, leaves its runs, and only then closes it,** so the account has state of its own and the check that its state is left alone can fail.
- **The convergence property reaches the sweep.** The text above has it run unchanged, but with one account that never closed and a consent that never expired the sweep always found nothing, against docs/testing.md's rule that a behaviour added to the sync is added to the generator. After a run that left something in the inbox, the account is now often closed in the configuration for the next run or two, and after every run with it closed, every version the bank served must already be in the archive. It was seen to fail with a sweep that passes over closed accounts and with a sync that does not sweep when nothing is fetched, and the four earlier breaks were tried again; where each now fails is recorded in the test.
- **A bank whose stored state the sync cannot use has its accounts swept,** as the text above says; a test was added for it in the final review, which the list of tests above did not name.
- **An account whose fetch began has failed "before its inbox could be merged",** not "while merging it": a fetch can fail in the repair of a record in two year files, before any merge.
- **A check by `import` can meet a record in two `api/` year files** while the nightly sync is writing, since it takes no lock, and stop with the reader's message. It is rare, and running the check again clears it. [sync.md](../sync.md) says so.
- **Every item under "Left open" in [the image spec](2026-10-14-image.md) is closed by this slice:** `publish` runs one at a time and keeps no token, a nested `node_modules` is kept out and checked for, the ownership step was seen to fail, the fetch takes its two booleans by name, the "continued by sync" test says the account fails, the two-year-files import test asserts its order again, and `scripts/check-image.sh` fails with a `FAIL` line, runs from anywhere and uses `--pull=never` and `--network none`.

### Left open

Found in review and not done in this slice; each is small.

- **A file, not a directory, at `.inbox/<key>` of a configured account that is not fetched** stops the run after the banks with an error nobody expected (`ENOTDIR`), as a fetch of that account would.
- **`<n> run(s)` under a key the configuration does not name counts every visible entry,** a stray file included.
- **`scripts/check-image.sh` takes a missing image for the failure steps 1 and 2 expect,** and then says the usage line was not printed, which misleads.
- **`publish` asks `https://github.com/`** for `main`'s head, rather than `GITHUB_SERVER_URL`.
- **The fake bank closes a revoked or an expired session with 200,** and `same` can hand back an expired session; neither is tested.
- **Untested:** a sweep that repairs a record in two year files before it merges; an empty directory under a name that is not an account key; one import file for two accounts of which only one has API records; and a `--write` whose `hidden` is above 0.
