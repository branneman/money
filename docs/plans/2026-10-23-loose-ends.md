# Loose ends: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what the image slice left open, merge what waits in the inbox of accounts the sync does not fetch, close the sessions `auth` leaves open, and have `import` count the rows the view will hide.

**Architecture:** CI and `scripts/check-image.sh` change on their own. In `sync`, a new `sweep` runs after the banks and merges, without touching state, every inbox the run did not drain; the client gains `closeSession`, which `auth` calls after its fetch and before it stops on a refused session; `import` reads the account's `api/` records to count rows on or after the API start.

**Tech Stack:** Node 24 running TypeScript directly, `node:test`, Docker, GitHub Actions, bash.

**Spec:** `docs/specs/2026-10-23-loose-ends.md`

## Global Constraints

- No new dependency of any kind, and no new GitHub Action.
- Every invented IBAN uses check digits `00`. Examples use made-up banks (`bnka`, `bnkb`, `Example Bank`). No real bank, and no production host, volume or container name, appears anywhere, commit messages included.
- Printed lines hold counts, dates, codes and account keys only. Never a session id, a uid, an IBAN, an amount or a path. `sync/src/leak.test.ts` enforces it; every new line is driven through it.
- Erasable TypeScript only; relative imports carry `.ts`; type-only imports use `import type`. Match the comment density and voice of the surrounding code: comments say why, in full sentences.
- Durable docs are updated in the same task as the code they describe (spec, "Departures and additions"). The spec itself is not edited by tasks.
- Conventional commits, scope `sync` or `ci`/`tooling` as fits. Every commit passes the pre-commit hook (typecheck, lint, format check, full suite). Never `--no-verify`. Do not push; the controller integrates.
- Run tests through `npm test` (it pins `TZ`). A single file: `TZ=Europe/Amsterdam node --test <file>`.
- Never open anything that looks like real bank data, and never touch production.
- Lines fixed by the spec, verbatim (`<…>` filled in):
  - `<key>: <n> run(s) wait in .inbox/<key> for an account the configuration does not name. They are kept; nothing has been removed.`
  - `.inbox holds an entry that is not an account key. It is kept; nothing has been removed.` (the spec's "an entry of .inbox that is not an account key", as a sentence)
  - `previous-closed bank=<bank>` (through `log`)
  - `The previous consent was not closed, and ends by itself on <date>: <reason>.`
  - `The consent just given was closed again.`
  - `The consent just given was not closed, and ends by itself on <date>: <reason>.`
  - `<reason>` is the caught error's `message`, e.g. `Enable Banking answered 404 SESSION_DOES_NOT_EXIST` or `no answer from Enable Banking (TimeoutError)`. `<date>` is `dateOf(valid_until)`.
  - `import-account account=<key> rows=<n> new=<n> changed=<n> unchanged=<n> hidden=<n> from=<date> to=<date>`

## Review Focus

1. **A closed account with a large inbox on the first night after this ships.** Expected: everything merged in one run, removed, nothing in state. Task 4's closed-account test uses a completed and an incomplete run together.
2. **The renewal closes the wrong session** (the new one instead of the old). Expected: impossible to miss, because the fake refuses a closed session's accounts and the test runs `sync` after the renewal. Task 3.
3. **A stray non-directory, or an oddly named directory, directly in `.inbox`.** Expected: reported once, by the generic line, never crashing the run and never printing the name. Task 4 tests a file named `notes.txt` and a directory named `Bad_Name`.
4. **`import` of an account whose `api/` holds a record in two year files.** Expected: the import stops with the reader's message and writes nothing, not even under `--write`; it never repairs `api/`. Task 5.
5. **Two quick pushes to `main` whose tests finish out of order.** Expected: `:latest` ends on the newer commit. Unprovable on a branch; Task 1 makes the `ls-remote` guard readable at a glance, and the controller watches the first `publish` on `main`.

---

## File structure

| File                                                                         | Change | Responsibility                                                         |
| ---------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                                   | modify | Concurrency, the head check before `:latest`, `persist-credentials`.   |
| `.dockerignore`, `scripts/check-image.sh`                                    | modify | Nested `node_modules`; `FAIL` on a failed run; any cwd; no pull/net.   |
| `sync/testing/fake-bank.ts`                                                  | modify | `DELETE /sessions/<id>`; a closed session's accounts are refused.      |
| `sync/src/enablebanking/client.ts`                                           | modify | `closeSession`.                                                        |
| `sync/src/commands/auth.ts`                                                  | modify | Closes the previous session, and a session it refused to store.        |
| `sync/src/inbox.ts`                                                          | modify | Lists `.inbox`'s entries, and counts what waits under one.             |
| `sync/src/commands/account.ts`                                               | modify | `mergeWaiting`, `failureLines` exported, `started`, named options.     |
| `sync/src/commands/sweep.ts`                                                 | create | Which accounts to sweep, and what to say about unknown entries.        |
| `sync/src/commands/sync.ts`                                                  | modify | Sweeps after the banks, and before stopping when nothing is fetchable. |
| `sync/src/commands/import.ts`                                                | modify | `hidden=`.                                                             |
| tests beside each module; `sync/src/leak.test.ts`                            | modify | As each task says.                                                     |
| `docs/sync.md`, `docs/archive-format.md`, `docs/infra.md`, `docs/testing.md` | modify | In the task whose code they describe.                                  |

---

### Task 1: CI and the image check

**Files:**

- Modify: `.github/workflows/ci.yml`, `.dockerignore`, `scripts/check-image.sh`
- Docs: `docs/infra.md` (publishing, the `.dockerignore`), `docs/testing.md` ("The image")

**Interfaces:** none in code.

- [ ] **Step 1: `ci.yml`.** Add `with: persist-credentials: false` to every `actions/checkout` step (four). Give `publish` `concurrency: { group: publish, cancel-in-progress: false }`. Split the push step so `:<sha>` is always pushed, and `:latest` only when `git ls-remote "https://github.com/${GITHUB_REPOSITORY}" refs/heads/main | cut -f1` equals `$GITHUB_SHA`; otherwise `echo` that `:latest` is left to the newer commit on main. The `ls-remote` runs under `set -e` (the default `bash -e` of `run:`), so a failure to ask fails the job. Keep a comment saying why both the group and the check are needed (a group serialises, it does not order).
- [ ] **Step 2: verify the YAML parses and says what it should.** Run: `ruby -ryaml -e 'y=YAML.load_file(".github/workflows/ci.yml"); p y["jobs"]["publish"]["concurrency"]; p y["jobs"].values.flat_map{|j| j["steps"].select{|s| s["uses"].to_s.start_with?("actions/checkout")}.map{|s| s.dig("with","persist-credentials")}}'`. Expected: `{"group"=>"publish", "cancel-in-progress"=>false}` and `[false, false, false, false]`.
- [ ] **Step 3: `.dockerignore`.** Add `**/node_modules` after the admitted paths, with a one-line comment.
- [ ] **Step 4: `check-image.sh`.**
  - Find the root from the script's own path (`ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)`) and make `WORK` under `$ROOT`, keeping the existing comment's reason.
  - `run()` becomes `docker run --rm --pull=never --network none "$@"`.
  - Every captured run (`uid=…`, `listing=…`, `found=…`) ends in `|| fail "<which check could not run>"`.
  - Step 5's `find` prunes only `/app/node_modules` and also reports any other directory named `node_modules`; the label says so.
- [ ] **Step 5: build and check, from the root and from elsewhere.** Run: `DOCKER_BUILDKIT=0 docker build -t money:local . && scripts/check-image.sh money:local && (cd /tmp && "$OLDPWD/scripts/check-image.sh" money:local)`. Expected: both end in `image checked`. (`DOCKER_BUILDKIT=0` only because this machine has no buildx; drop it if `docker buildx version` works.)
- [ ] **Step 6: see each check fail, then restore.** In turn, and never committed:
  1. In the `Dockerfile`, remove `/data` from the `chown` (or otherwise leave it root-owned), rebuild, run the check: Expected `FAIL: /data and /state are not owned and writable by the image's user`.
  2. `mkdir -p sync/node_modules/x && touch sync/node_modules/x/y` with `**/node_modules` temporarily removed from `.dockerignore`, rebuild, check: Expected the step-5 `FAIL` naming `node_modules`. Then restore `.dockerignore`, rebuild, check passes with the directory still present (proving the ignore works), then delete `sync/node_modules`.
  3. `scripts/check-image.sh money:does-not-exist`: Expected a `FAIL:` line (from step 1's run) and exit 1, and no pull.
  4. Temporarily make `run()` in the `uid=` line fail (e.g. `uid=$(run "$IMAGE" false)`): Expected its `FAIL:` line.
     Restore everything; `git status` shows only the intended changes.
- [ ] **Step 7: docs.** `docs/infra.md`: `publish` runs one at a time and moves `:latest` only to `main`'s head; no checkout keeps a token; the `.dockerignore` keeps out a nested `node_modules`. `docs/testing.md`, "The image": the new assertion, `--pull=never`, `--network none`, runs from any directory.
- [ ] **Step 8: commit.** `git commit -m "ci: :latest only moves to main's head, and the image check fails loudly from anywhere"`.

---

### Task 2: the fake bank and the client close sessions

**Files:**

- Modify: `sync/testing/fake-bank.ts`, `sync/src/enablebanking/client.ts`
- Test: `sync/testing/fake-bank.test.ts`, `sync/src/enablebanking/client.test.ts`
- Docs: `docs/testing.md` (the fake bank's strictness paragraph)

**Interfaces:**

- Produces: `Client.closeSession(sessionId: string): Promise<void>`. Resolves on 200 whatever the body; any other status throws `ApiError`; no answer throws `SyncError("no answer from Enable Banking (…)")`, as `send` already does.
- Produces (fake): `DELETE /sessions/<id>` → 200 `{"message":"OK"}` for an open session it issued; `refuse(404, "SESSION_DOES_NOT_EXIST")` for an unknown id; `refuse(401, "CLOSED_SESSION")` for one already closed. A transactions request for a closed session's uid → `refuse(401, "CLOSED_SESSION")` (a consent-gone code in `sync/src/errors.ts`). The token is verified first, as for every route.

- [ ] **Step 1: failing tests.**
  - `client.test.ts`: `"closeSession sends a DELETE for the session, with a token"`: one call, method `DELETE`, url `https://api.enablebanking.com/sessions/<id>` (the id passed through `encodeURIComponent`), an `authorization: Bearer …` header, no body. `"closeSession takes any 200 as done, and anything else as an ApiError"`: 200 with body `not json` resolves; 404 `{"error":"SESSION_DOES_NOT_EXIST"}` rejects with `ApiError` whose `status` is 404 and `code` `SESSION_DOES_NOT_EXIST`.
  - `fake-bank.test.ts`: `"a session can be closed once, and its accounts are then refused"`: approve and create a session, `DELETE` it → 200; a transactions request for one of its uids → 401 `CLOSED_SESSION`; a second `DELETE` → 401 `CLOSED_SESSION`. `"closing a session nobody issued is refused"` → 404 `SESSION_DOES_NOT_EXIST`. `"closing a session needs a valid token"` → 401 `UNAUTHORIZED_ACCESS`. `"closing one session leaves another open"`: two sessions, close the first, the second's transactions still answer 200.
- [ ] **Step 2: run, expect FAIL.** `TZ=Europe/Amsterdam node --test sync/src/enablebanking/client.test.ts sync/testing/fake-bank.test.ts`.
- [ ] **Step 3: implement.** `send` accepts `"DELETE"`. `closeSession` calls it and ignores the text. In the fake, `Session` gains `closed: boolean`; route `DELETE /sessions/<id>`; `transactions` refuses a closed session before the revoked/expired checks.
- [ ] **Step 4: run, expect PASS**, then `npm test`.
- [ ] **Step 5: docs.** `docs/testing.md`'s fake-bank paragraph: it deletes sessions and refuses a closed session's accounts.
- [ ] **Step 6: commit.** `git commit -m "feat(sync): the client can close a session, and the fake bank holds it to that"`.

---

### Task 3: `auth` closes the sessions it leaves open

**Files:**

- Modify: `sync/src/commands/auth.ts`
- Test: `sync/src/commands/auth.test.ts`, `sync/src/leak.test.ts`
- Docs: `docs/sync.md` ("Authorising: `auth <bank>`")

**Interfaces:**

- Consumes: `Client.closeSession` (Task 2); the fake's `DELETE /sessions/<id>`; `world.bank.failRequest(n, { status, error })` to make the close fail.

- [ ] **Step 1: failing tests in `auth.test.ts`.**
  - `"a renewal closes the session it replaced, and sync then fetches through the new one"`: first `auth bnka`, note `state.session_id`; move the clock a day; renew → exit 0; exactly one `DELETE` request, to `/sessions/<old id>`; output has `previous-closed bank=bnka`; then `sync` → 0, and a transaction added after the renewal is stored.
  - `"a first auth closes nothing"`, `"a renewal after the previous session expired closes nothing"` (clock past the old `valid_until`), each asserting no `DELETE` request.
  - `"a close the bank refuses is a note, and the renewal still succeeds"`: make the `DELETE` fail with `{ status: 404, error: "SESSION_DOES_NOT_EXIST" }`. It is the renewal's last request, so `failRequest(k)` with `k` the number of requests a renewal makes in that world (say why `k` is what it is in a comment); exit 0; the line `The previous consent was not closed, and ends by itself on <old date>: Enable Banking answered 404 SESSION_DOES_NOT_EXIST.`; the new session fetches on the next `sync`.
  - `"a renewal whose fetch fails still closes the previous session"`: fail one transactions page; exit 1 with the existing "consent is stored" line; the `DELETE` happened.
  - Extend `"a configured account the consent does not cover is an error that names it"`: exactly one `DELETE`, for the session just created; the output ends with `The consent just given was closed again.`; nothing stored; exit 1. Add `"a refused session the bank will not close says so, and still fails"`: the close refused → `The consent just given was not closed, and ends by itself on <new date>: Enable Banking answered …` and exit 1.
  - `leak.test.ts`: drive the renewal-with-close, the refused close, and the refused-session close through the existing scan of printed output, so the session ids (old and new) are planted values that must not appear.
- [ ] **Step 2: run, expect FAIL.** `TZ=Europe/Amsterdam node --test sync/src/commands/auth.test.ts sync/src/leak.test.ts`.
- [ ] **Step 3: implement in `auth.ts`.**
  - A helper `closeSession(context, sessionId, validUntil): Promise<string | null>` (name free) that calls the client and returns `null` on success or the caught expected error's `message`; an unexpected error is rethrown.
  - On refused matching: before throwing, close the new session and append the one line to `problems`, so it is printed after the error's lines.
  - After the fetch, in both the success and the expected-failure path (not in the `catch` for unexpected errors): if `previous !== null && previous.session_id !== session.sessionId && previous.valid_until > timestampOf(deps.clock())` (both whole-second UTC timestamps, which compare as strings), close it; on success `log("previous-closed", { bank })`, on failure `deps.out` the note. The exit code is what the fetch decided.
  - Existing tests that list a renewal's exact requests gain the `DELETE`.
- [ ] **Step 4: run, expect PASS**, then `npm test`.
- [ ] **Step 5: docs.** `docs/sync.md`, `auth`: step 4's failure closes the session just made, with both lines; a new last step closes the previous session after the fetch, when and why after, the two outcomes and that the exit code is unaffected; the accepted risk of a bank that reuses a consent on renewal (spec, "A known risk, accepted").
- [ ] **Step 6: commit.** `git commit -m "feat(sync): auth closes the session a renewal replaces, and one it refused to store"`.

---

### Task 4: `sync` sweeps what waits for the accounts it does not fetch

**Files:**

- Modify: `sync/src/inbox.ts`, `sync/src/commands/account.ts`, `sync/src/commands/sync.ts`
- Create: `sync/src/commands/sweep.ts`
- Test: `sync/src/inbox.test.ts`, `sync/src/commands/sync.test.ts`, `sync/src/leak.test.ts`
- Docs: `docs/sync.md` ("Fetching: the inbox", "The nightly run: `sync`")

**Interfaces:**

- Produces in `inbox.ts`: `listInbox(dataDir: string): Promise<{ name: string; directory: boolean }[]>`, the visible (not dot-prefixed) entries directly under `.inbox`, sorted, empty when `.inbox` is missing; `countWaiting(dataDir: string, key: string): Promise<number>`, the visible names under `.inbox/<key>`, 0 when missing.
- Produces in `account.ts`: `export const failureLines` (unchanged body); `export const mergeWaiting = (context: Context, account: string): Promise<void>`, which repairs `api/` (as `recover` does) and drains the inbox with no state read or written and no missing check; `fetchAccounts` additionally returns `started: string[]`, every account whose fetch it began.
- Produces in `sweep.ts`: `export const sweep = (context: Context, started: ReadonlySet<string>): Promise<string[]>`, the names to add to `failed:`.

- [ ] **Step 1: the two small ones first.**
  - `fetchAccount`'s last two parameters become one `{ backfill: boolean; attended: boolean }`; callers pass names. No behaviour changes; `npm test` passes.
  - In `sync.test.ts`, rename `"a backfill that died during auth is continued by sync, asking for the longest period again"` to `"a backfill that died during auth is continued by sync, which asks for the longest period and fails the account"` and add `assert.match(printed(world), /^bnka-current: fetched without a first success, so the bank gave only what it serves unattended\. Run: auth bnka$/m)` (define `printed` as in `auth.test.ts` if the file lacks it).
  - Commit: `git commit -m "refactor(sync): the fetch takes backfill and attended by name, and a test says the account fails"`.
- [ ] **Step 2: failing tests.**
  - `inbox.test.ts`: `listInbox` with no `.inbox`, with a dot-entry, a file and two directories; `countWaiting` with a missing directory, an empty one, and two runs.
  - `sync.test.ts`, each with runs planted by the existing helpers (a completed run via a fetch that is then left in place, or by writing pages and a marker the way `inbox.test.ts` does):
    - `"a closed account's waiting runs are merged and removed, and its state is left alone"`: a completed and an incomplete run in the inbox of `bnka-old`, which `worldConfig()` already has as `closed: true` (or of an account closed in `world.config` after a run was left for it); `sync` merges both into `api/`, `world.inbox(account)` is empty, the bank's state file is byte-for-byte unchanged, and the exit code is what it would be without them (0).
    - `"what waits for a bank whose consent has expired is merged"` and `"what waits for an account the consent does not cover is merged"`; the latter still exits 1 with its existing line.
    - `"a swept run that cannot be read stays, and fails only its account"`: both `failureLines` lines for it, `failed:` names it, other accounts synced.
    - `"runs under a key the configuration does not name are kept and reported"`: `.inbox/bnka-gone/<run>` → the fixed line with `n=1`, `failed: bnka-gone`, exit 1, run still there. `"an empty directory under an unknown key is not reported"`. `"an entry of .inbox that is not an account key is reported without its name"`: a file `notes.txt` and a directory `Bad_Name` with one entry → the generic line, neither name printed anywhere, `failed:` includes `.inbox`.
    - `"with every account closed, sync still merges what waits, then stops as before"`: exit 1, `NOTHING_FETCHED` printed, the runs merged.
    - `"an account with nothing waiting is not read"`: a closed account whose `api/` holds an unreadable year file and whose inbox is empty → no failure for it.
  - `leak.test.ts`: the unknown-key line and the generic line under its scan.
- [ ] **Step 3: run, expect FAIL.**
- [ ] **Step 4: implement.**
  - `inbox.ts`: the two functions, via `readdir(…, { withFileTypes: true })` and the existing `visible`.
  - `account.ts`: `drainInbox` takes `bank: string | null`; with `null` it skips the whole success/state branch (`missing` stays 0 in the `merged` line). `mergeWaiting` = `recover` + `drainInbox(context, null, account)` (argument order free). `fetchAccounts` pushes each account to `started` before calling `fetchAccount`.
  - `sweep.ts`: for each key of `config.accounts` (configuration order) not in `started`, if `countWaiting` > 0, `mergeWaiting`; an expected error prints `failureLines` and adds the key, an unexpected one is rethrown. Then for each `listInbox` entry not in `config.accounts`: a directory whose name passes `ACCOUNT_KEY` (from `@money/shared`) with `countWaiting` > 0 prints the named line and adds the key; any other directory with entries, or any non-directory, prints the generic line once per entry and adds `.inbox` once.
  - `sync.ts`: `syncBank`'s outcome carries `started`; `runSync` collects them and calls `sweep` after the banks loop, adding its names to `failed`. When `fetchable` is empty, `sweep(context, new Set())` runs before `NOTHING_FETCHED` is printed and 1 returned. A bank that fails before fetching (no state, expired, unusable state) contributes no `started`, so its accounts are swept.
- [ ] **Step 5: run, expect PASS**, then `npm test` (the convergence property included, unchanged).
- [ ] **Step 6: docs.** `docs/sync.md`: replace the bullet "Only an account that is fetched has its inbox merged" with the sweep (which accounts, merge and remove, no state, failures, unknown keys, only `sync`); "The nightly run" gains the sweep as its last step, and the no-fetchable-account case sweeps first.
- [ ] **Step 7: commit.** `git commit -m "feat(sync): the nightly run merges what waits for every account it does not fetch"`.

---

### Task 5: `import` counts the rows the view will hide

**Files:**

- Modify: `sync/src/commands/import.ts`
- Test: `sync/src/commands/import.test.ts`, `sync/src/leak.test.ts`
- Docs: `docs/sync.md` ("What it prints", and that the import reads `api/`), `docs/archive-format.md` ("When both sources cover the same day")

**Interfaces:**

- Consumes: `apiStarts(records): Map<string, string>` from `@money/shared`; `readAccountSource(dataDir, account, "api")` from `@money/shared/node`.

- [ ] **Step 1: failing tests in `import.test.ts`.**
  - `"hidden counts the file's rows on or after the API start"`: store API records for `bnka-current` starting `2025-01-10` (write a year file with `renderYearFiles` of `anApiRecord`s, or run an `auth` in a world that has both), import rows dated `2025-01-09`, `2025-01-10`, `2025-01-11` → `hidden=2`.
  - `"hidden is 0 for an account with no API records"`.
  - `"an api/ record in two year files stops the import, and nothing is written"`: `--write` → exit 1, the reader's "more than one year file" message, `import/` unchanged, `api/` unchanged.
  - Update every existing assertion on an `import-account` line to include `hidden=0`.
  - Tighten `"a record left in two year files stops a check, and is repaired under --write"`: under `--write`, `world.lines[0]` is `recovered account=bnka-current records=1` and `world.lines[1]` is the whole line `import-account account=bnka-current rows=1 new=0 changed=0 unchanged=1 hidden=0 from=2024-12-31 to=2024-12-31`.
  - `leak.test.ts`: the import scan now includes an account with API records, so a `hidden=` above 0 is printed under it.
- [ ] **Step 2: run, expect FAIL.**
- [ ] **Step 3: implement.** In the per-account loop, read the account's `api/` records, take `apiStarts(api).get(account)`, count `incoming` items whose `date >= start` (0 without a start), and log `hidden` between `unchanged` and `from`. No recovery of `api/`.
- [ ] **Step 4: run, expect PASS**, then `npm test`.
- [ ] **Step 5: docs.** `docs/sync.md`: the example line with `hidden=`, a bullet on what it counts, that it is as of now, that the import reads `api/` and stops on a doubled `api/` record it never repairs. `docs/archive-format.md`: one sentence that `import` reports how many rows this rule hides.
- [ ] **Step 6: commit.** `git commit -m "feat(sync): import says how many rows the view will hide"`.

---

### Task 6 (controller): integrate

- [ ] Whole-branch review against the spec.
- [ ] Add "What moved while it was built" to the spec: where the build differed (at least the generic `.inbox` line written as a sentence), and the image spec's "Left open" items now closed.
- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` in the worktree; the image built and checked.
- [ ] Rebase on `main`, leave the worktree (keep), `git merge --ff-only`, the full suite on `main`, then push at a time the owner is not running `auth` or `import --write` (a push to `main` redeploys), and watch the run to the end, `publish` included.
