# App server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build slice 5a: a `server` workspace that validates its configuration, logs two people in with signed cookies, keeps each to their own accounts on a placeholder route, sends strict headers, and runs in the image, reviewed before it is merged.

**Architecture:** Pure modules (password format, session cookie, CSRF, limiter, lens, static path resolution, settings) under `server/src/`, each tested at Tier 1. One handler over `node:http` composes them, tested at Tier 2s over real HTTP against a temporary directory and an injected clock. `server/src/cli.ts` is the only edge. Configuration stays one file, validated by `shared`'s one validator, which gains `people` and `owners`.

**Tech Stack:** Node 24, TypeScript run by type stripping, `node:http`, `node:crypto` (scrypt, HMAC, `timingSafeEqual`), `node:test`. No new dependency.

**Spec:** `docs/specs/2026-11-27-app-server.md`. Read it whole before Task 1; this plan argues from it and does not repeat its reasoning.

## Global Constraints

- `server` has no runtime dependency beyond `@money/shared`. The dependency-rule test enforces it once `server` is in its list.
- Erasable TypeScript only; relative imports end in `.ts`; type-only imports use `import type`.
- Every log line holds counts, dates, keys of accounts and route patterns only. **Never** a username, a person's key (a first name), a password, a hash, a cookie, a CSRF token, a request body, or anything from the archive. Configuration problems name a person by position (`people, entry 2`), never by key or username.
- scrypt: N = 131072, r = 8, p = 1, salt 16 bytes, key 32 bytes, `maxmem` 256 MiB. Format `scrypt$N=131072,r=8,p=1$<salt>$<key>`, standard base64 with the padding removed.
- Session: cookie `__Host-session`, `Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Strict`, no `Domain`. Lifetime exactly 7 days from login, no renewal.
- Rate limit: 5 failures per username per 15 minutes, fixed window from the first failure. No cap across usernames. Usernames over 64 characters refused before hashing or counting. Hash checks one at a time; at most 8 waiting, beyond that `503`.
- Login usernames compared exactly: no trimming, no case folding.
- Secret: `APP_DATA_DIR/session-secret`, 32 random bytes, base64, a trailing newline, mode `0600`, written by temporary file and rename.
- Request bodies: JSON only (`415` otherwise), at most 4096 bytes (`413`).
- Tests run through `npm test` (TZ pinned); the clock is injected; no test reads the real time or the network beyond `127.0.0.1`.
- Every new test is seen to fail before the code that passes it is written.
- Commits are conventional: `feat(server): …`, `test(server): …`, `refactor(shared): …`, `docs: …`. The pre-commit hook runs the whole suite; never `--no-verify`.
- Nothing names a bank, a host, a container or a volume. Fixture people, usernames and passwords are invented.

## Review Focus

The inputs the spec implies but does not spell out, most likely to bite first. Each has its test in the task named.

1. **A `Cookie` header with two `__Host-session` values**, or the cookie among others with odd spacing: two values are refused as no session, never "the first one wins" (Task 5).
2. **Paths that escape `CLIENT_DIR` by encoding**: `%2e%2e/`, `%252e%252e/` (decoded once only, so it stays a literal name), `..%2f`, a backslash, `//etc/passwd`, a NUL as `%00`: each `404` (Task 8).
3. **A body with no `Content-Length`**, sent chunked, longer than 4096 bytes: `413`, and the connection's remaining data not parsed as JSON (Task 8).
4. **The configuration file missing for an instant** while the host renames a new one into place: that request fails closed with `503`, and the next request, once the file is back, is served (Task 7).
5. **A burst of logins**: a username already locked is answered `429` without joining the hash queue, the ninth waiting login is `503`, and no count is lost or doubled (Task 10).

---

## File structure

```text
shared/src/util/atomic.ts          writeAtomic, moved from sync; re-exported by @money/shared/node
shared/src/config/config.ts        people, owners
server/package.json                @money/server, depends on @money/shared only
server/src/
  auth/password.ts                 hash format, scrypt, verify, the dummy hash
  auth/session.ts                  cookie encode/decode, signing key, CSRF token, cookie headers
  auth/limiter.ts                  per-username failure windows
  auth/queue.ts                    one hash check at a time, bounded waiting
  people.ts                        server-only config checks, the person list, username lookup, the lens
  settings.ts                      environment → Settings, the tripwire, directory checks
  live.ts                          a file re-read when its identity changes, failing closed
  secret.ts                        parse and rotate the session secret
  server-config.ts                 text → { config, people } or problems
  archive.ts                       transactions per visible account, for the placeholder
  http/headers.ts                  the security headers
  http/body.ts                     a bounded JSON body
  http/origin.ts                   the cross-site check
  http/static.ts                   path resolution, content types, cache headers
  log.ts                           the request and event lines
  handler.ts                       routes, composing everything above
  main.ts                          serve | hash-password | rotate-session-secret
  cli.ts                           the edge: env, clock, terminal, port
server/testing/world.ts            a real server on a free port, over temporary directories
scripts/dev-server.ts              npm run server, against the fixtures
```

Tests sit beside each module as `*.test.ts`. The Tier 2s tests are split by concern: `handler.login.test.ts`, `handler.csrf.test.ts`, `handler.session.test.ts`, `handler.lens.test.ts`, `handler.reload.test.ts`, `handler.headers.test.ts`, `handler.static.test.ts`, and `leak.test.ts`.

---

### Task 1: Move `writeAtomic` into `shared`, with a mode

The server writes the secret atomically and may not import `sync`.

**Files:**

- Create: `shared/src/util/atomic.ts`, `shared/src/util/atomic.test.ts`
- Modify: `shared/src/archive/store.ts` (re-export), every importer of `sync/src/atomic.ts`
- Delete: `sync/src/atomic.ts` (and its test, if one exists, moved)

**Interfaces:**

- Produces: `writeAtomic(path: string, text: string, mode?: number): Promise<void>`, exported from `@money/shared/node`. The temporary file is created with `mode` (default `0o644`), so the file never exists with wider permissions.

- [ ] **Step 1:** Write `shared/src/util/atomic.test.ts`: `"writeAtomic replaces a file whole"` (old content, write, new content, no `.name.tmp` left) and `"writeAtomic creates the file with the mode it is given"` (`0o600` → `(await stat(p)).mode & 0o777 === 0o600`).
- [ ] **Step 2:** `npm test` — the new tests fail (module missing).
- [ ] **Step 3:** Move the function, add the `mode` parameter passed to `writeFile` as `{ flush: true, mode }`, re-export from `store.ts`, update the sync's imports to `@money/shared/node`.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` — all pass.
- [ ] **Step 5:** `git commit -m "refactor(shared): writeAtomic moves to shared, and takes a mode"`

---

### Task 2: The `server` workspace and the password hash

**Files:**

- Create: `server/package.json`, `server/src/auth/password.ts`, `server/src/auth/password.test.ts`
- Modify: root `package.json` (workspaces add `"server"`; `test` glob adds `'server/**/*.test.ts'`), `tsconfig.json` (`include` adds `"server"`), `scripts/workspaces.ts` (`SERVER_WORKSPACES` becomes `["shared", "sync", "server"]`), `scripts/workspaces.test.ts` (its made-up `api` workspace becomes `server`)

**Interfaces:**

- Produces, from `server/src/auth/password.ts`:
  - `SCRYPT: { readonly N: 131072; readonly r: 8; readonly p: 1; readonly saltBytes: 16; readonly keyBytes: 32 }`
  - `type PasswordHash = { N: number; r: number; p: number; salt: Buffer; key: Buffer }`
  - `parseHash(text: string): PasswordHash | null` — null for anything not exactly the format.
  - `formatHash(hash: PasswordHash): string`
  - `isStrongEnough(hash: PasswordHash): boolean` — N ≥ 131072, r ≥ 8, p ≥ 1, salt 16 bytes, key 32 bytes.
  - `hashPassword(password: string, salt: Buffer): Promise<string>` — always the `SCRYPT` parameters.
  - `verifyPassword(password: string, hash: PasswordHash): Promise<boolean>` — derives with the hash's own parameters, compares with `timingSafeEqual`.
  - `DUMMY_HASH: PasswordHash` — parsed at load from a fixed literal with the `SCRYPT` parameters; matches no password anyone will type.
  - `MIN_PASSWORD_LENGTH = 12`

- [ ] **Step 1:** `npm ci` in the worktree after adding the workspace, so `node_modules/@money/server` links here. Run `npm run check:workspaces` — passes.
- [ ] **Step 2:** Write tests: `"a hash round-trips through its text"`; `"parseHash refuses"` each of: another algorithm name, a missing part, padding `=` present, a non-number parameter, an extra `$` part, an empty salt; `"isStrongEnough refuses N=65536, r=4, a 15-byte salt and a 31-byte key"`; `"verifyPassword accepts the password and refuses one character changed"`; `"verifyPassword uses the parameters stored in the hash"` (a hash made with N=1024 here, by calling `scrypt` directly in the test, verifies); `"the dummy hash has the full parameters"`.
- [ ] **Step 3:** `npm test` — fails.
- [ ] **Step 4:** Implement with `promisify(scrypt)` and `maxmem: 256 * 1024 * 1024`.
- [ ] **Step 5:** `npm test && npm run typecheck && npm run lint` — pass.
- [ ] **Step 6:** `git commit -m "feat(server): the workspace, and scrypt password hashes"`

---

### Task 3: `people` and `owners` in the configuration, and the fixtures

**Files:**

- Modify: `shared/src/config/config.ts`, `shared/src/config/config.test.ts`, `fixtures/world.ts`, `fixtures/archive.test.ts`, then `npm run fixtures` (rewrites `fixtures/config.json`)
- Create: `server/src/people.ts`, `server/src/people.test.ts`

**Interfaces:**

- Produces, in `shared`:
  - `Account` gains `owners?: string[]`; `Config` gains `people?: Record<string, { username: string; password: string }>`.
  - `validateConfig` checks: `people` optional, an object; each key matches `/^[a-z][a-z0-9-]*$/`; each entry has exactly `username` and `password`; `username` matches `/^[A-Za-z0-9._-]{1,64}$/`; no two usernames equal; `password` a non-empty text (its format is the server's check). `owners` optional; a non-empty array of texts, no repeats, each a key of `people`. Problems about people say `people, entry <n>`; problems about owners say `accounts.<key>: owners names a person the configuration does not know`, never the name.
- Produces, in `server/src/people.ts`:
  - `type Person = { key: string; username: string; password: PasswordHash }`
  - `serverConfigProblems(config: Config): string[]` — `people` names at least one person; every account names at least one owner (`accounts.<key>: names no owner`); every password parses and `isStrongEnough` (`people, entry <n>: password is not a hash money hash-password made` / `…: password hash is weaker than this server accepts`).
  - `peopleOf(config: Config): Person[]` — only called once `serverConfigProblems` is empty.
  - `findByUsername(people: readonly Person[], username: string): Person | null` — compares the SHA-256 of the typed username with that of every person's, all of them, with `timingSafeEqual`; never stops early.
  - `visibleAccounts(config: Config, personKey: string): string[]` — the account keys whose `owners` include `personKey`, sorted.
- Fixtures: `fixtures/world.ts` exports `PEOPLE` with two invented people, keys `mila` and `tom`, usernames `fx-mila-Qp2w9Lz7` and `fx-tom-Hk4r8Vn2`, passwords `fixture password mila` and `fixture password tom`. `CONFIG.people` holds their usernames and hashes made by `hashPassword` with a salt of the first 16 bytes of `sha256("fixture salt " + key)`, so the generator stays deterministic. Owners: an account whose `holder` is `SOLO` gets `["mila"]`, one whose holder is `JOINT` gets `["mila", "tom"]`. The fixtures import `hashPassword` by relative path from `../server/src/auth/password.ts`.

- [ ] **Step 1:** Write shared tests: one per refusal above, `"a configuration without people or owners is valid, as before"`, `"no problem message repeats a username or a person's key"` (plant `zq-user-1` and key `zqperson`, assert neither appears in any problem).
- [ ] **Step 2:** Write `people.test.ts`: `serverConfigProblems` for no `people`, an account with no owner, a closed account with no owner, a malformed hash, a weak hash; `findByUsername` exact match, another case refused, a leading space refused, a person's key refused as a username; `visibleAccounts` for one owner, two owners, none.
- [ ] **Step 3:** `npm test` — the new tests fail.
- [ ] **Step 4:** Implement the shared validation and `people.ts`.
- [ ] **Step 5:** Update `fixtures/world.ts` and add to `fixtures/archive.test.ts`: `"the configuration satisfies the server"` (`serverConfigProblems(CONFIG)` is empty) and `"each fixture person logs in with their password"` (`verifyPassword` on both).
- [ ] **Step 6:** `npm run fixtures`, then `npm test && npm run typecheck && npm run lint` — pass, freshness included.
- [ ] **Step 7:** `git commit -m "feat(shared): people and owners in the configuration"`

---

### Task 4: Settings, and the tripwire

**Files:**

- Create: `server/src/settings.ts`, `server/src/settings.test.ts`

**Interfaces:**

- Produces:
  - `type Environment = Readonly<Record<string, string | undefined>>`
  - `type Settings = { configPath: string; dataDir: string; appDataDir: string; clientDir: string; port: number; revision: string }`
  - `readSettings(env: Environment): { ok: true; settings: Settings } | { ok: false; problems: string[] }` — each of `CONFIG_PATH`, `DATA_DIR`, `APP_DATA_DIR`, `CLIENT_DIR`, `PORT`, `REVISION` missing gives `<NAME> is not set`; `PORT` not a whole number from 1 to 65535 gives `PORT must be a port number`. Every variable whose name starts with `EB_`, and `STATE_DIR`, gives `<NAME> must not reach the server`. All problems at once; never a value.
  - `directoryProblems(settings: Settings, access: typeof import("node:fs/promises").access): Promise<string[]>` — `DATA_DIR` and `CLIENT_DIR` must be existing directories; `APP_DATA_DIR` an existing directory this user can write. Messages as the sync's (`does not name an existing directory`, `cannot be written by this user`).

- [ ] **Step 1:** Tests: each missing variable; a bad port (`0`, `65536`, `80a`); `"EB_PRIVATE_KEY, EB_APP_ID and STATE_DIR each stop the server, and their values are not printed"`; a complete environment gives the settings; each directory problem against a temporary directory (an absent path, a file in place of a directory, an `APP_DATA_DIR` made `0o500`).
- [ ] **Step 2:** `npm test` — fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` — pass.
- [ ] **Step 5:** `git commit -m "feat(server): settings, refusing any bank credential"`

---

### Task 5: The session cookie and the CSRF token

**Files:**

- Create: `server/src/auth/session.ts`, `server/src/auth/session.test.ts`

**Interfaces:**

- Consumes: `Person`, `formatHash`.
- Produces:
  - `SESSION_COOKIE = "__Host-session"`, `SESSION_MS = 7 * 24 * 60 * 60 * 1000`
  - `type Session = { person: string; issuedAt: number }` (milliseconds since the epoch)
  - `signingKey(secret: Buffer, person: Person): Buffer` — HMAC-SHA256 under `secret` of `"session\0" + person.username + "\0" + formatHash(person.password)`.
  - `encodeSession(session: Session, key: Buffer): string` — `<base64url JSON {p, t}>.<base64url HMAC-SHA256 of the first part>`.
  - `decodeSession(value: string, keyFor: (personKey: string) => Buffer | null, now: number): Session | null` — null when malformed, signature wrong (compared with `timingSafeEqual`), person unknown, `issuedAt > now`, or `now >= issuedAt + SESSION_MS`.
  - `sessionCookie(value: string): string` — `__Host-session=<value>; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Strict`
  - `clearedCookie(): string` — the same with an empty value and `Max-Age=0`.
  - `cookieValue(header: string | undefined): string | null` — the `__Host-session` value, null when absent **or present more than once**.
  - `csrfToken(cookie: string, key: Buffer): string` — base64url HMAC-SHA256 of `"csrf\0" + cookie`.
  - `csrfMatches(given: string | undefined, expected: string): boolean` — constant time, false for a missing or wrong-length value.

- [ ] **Step 1:** Tests: round trip; `"a session ends at exactly seven days"` (valid at `SESSION_MS - 1`, refused at `SESSION_MS`); a login time one millisecond in the future; a tampered person, a tampered time, a tampered signature; a key changed by a new password and by a new username each refuse an old cookie; an unknown person; `cookieValue` with other cookies around it, with odd spacing, and with the cookie twice (null); the cookie attributes exactly; a CSRF token refused under another cookie and another key.
- [ ] **Step 2:** `npm test` — fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` — pass.
- [ ] **Step 5:** `git commit -m "feat(server): signed session cookies and CSRF tokens"`

---

### Task 6: The rate limiter and the hash queue

**Files:**

- Create: `server/src/auth/limiter.ts`, `server/src/auth/limiter.test.ts`, `server/src/auth/queue.ts`, `server/src/auth/queue.test.ts`

**Interfaces:**

- Produces:
  - `LIMIT = { failures: 5, windowMs: 15 * 60 * 1000 }`
  - `makeLimiter(clock: () => Date): { retryAfter(username: string): number | null; failed(username: string): void; succeeded(username: string): void }` — `retryAfter` is the whole seconds, rounded up, until the username's window ends once it holds 5 failures, else null. A window starts at a username's first failure. Expired windows are dropped on every call.
  - `QUEUE_LIMIT = 8`
  - `makeQueue(limit: number): { run<T>(task: () => Promise<T>): Promise<T> | null }` — runs tasks one at a time, in order; returns null at once when `limit` tasks are already waiting.

- [ ] **Step 1:** Limiter tests over a moved clock: four failures leave the username served; the fifth makes `retryAfter` 900; 899 seconds later it is 1; at 900 seconds it is null and counting starts again; a success clears it; another username is unaffected; 10,000 usernames failed once and then a window later leave nothing held (assert through a `size()` exposed for tests only, or by behaviour: count restarts).
- [ ] **Step 2:** Queue tests: two tasks never overlap (a task records start and end on a shared list); order is kept; with one running and 8 waiting, the next `run` returns null; a task that rejects does not stop the next.
- [ ] **Step 3:** `npm test` — fails.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `npm test && npm run typecheck && npm run lint` — pass.
- [ ] **Step 6:** `git commit -m "feat(server): the login rate limit, and one hash check at a time"`

---

### Task 7: Files that change under the server: configuration and secret

**Files:**

- Create: `server/src/live.ts`, `server/src/live.test.ts`, `server/src/secret.ts`, `server/src/secret.test.ts`, `server/src/server-config.ts`, `server/src/server-config.test.ts`

**Interfaces:**

- Consumes: `validateConfig`, `serverConfigProblems`, `peopleOf`, `writeAtomic`.
- Produces:
  - `type Live<T> = { current(): Promise<T | null> }` — null means "invalid right now": fail closed.
  - `makeLive<T>(path: string, parse: (text: string) => T | null, onInvalid: () => void): Live<T>` — on each call, `stat`s the path; when `ino`, `mtimeMs` and `size` match the last read it returns the cached value; otherwise it reads and parses again. A missing file, an unreadable one or a parse of null gives null and calls `onInvalid` once per change of identity.
  - `SECRET_FILE = "session-secret"`, `parseSecret(text: string): Buffer | null` — exactly one line of standard base64 decoding to 32 bytes, with or without a trailing newline.
  - `rotateSecret(appDataDir: string, randomBytes: (size: number) => Buffer): Promise<void>` — `writeAtomic(join(appDataDir, SECRET_FILE), base64 + "\n", 0o600)`.
  - `type ServerConfig = { config: Config; people: Person[] }`
  - `loadServerConfig(text: string): { ok: true; value: ServerConfig } | { ok: false; problems: string[] }` — `the configuration file is not valid JSON`, then `validateConfig`'s problems, then `serverConfigProblems`.

- [ ] **Step 1:** `live` tests over a temporary file: the first read; an unchanged file is not read again (count reads through the `parse` passed in); a file replaced by a rename with new content is read again; a replacement that does not parse gives null and calls `onInvalid` once across two calls; a file removed gives null; restored, it is served again (Review Focus 4).
- [ ] **Step 2:** `secret` tests: 32 bytes accepted; 31 and 33 refused; two lines refused; non-base64 refused; `rotateSecret` writes a file of mode `0o600` that `parseSecret` accepts, and a second rotation writes a different one.
- [ ] **Step 3:** `server-config` tests: not JSON; a sync-only file without `people` refused by the server's check; the fixtures' `config.json` accepted with two people.
- [ ] **Step 4:** `npm test` — fails.
- [ ] **Step 5:** Implement.
- [ ] **Step 6:** `npm test && npm run typecheck && npm run lint` — pass.
- [ ] **Step 7:** `git commit -m "feat(server): the configuration and the secret, re-read when they change"`

---

### Task 8: HTTP pieces: headers, body, origin, static paths

**Files:**

- Create: `server/src/http/headers.ts`, `server/src/http/body.ts`, `server/src/http/origin.ts`, `server/src/http/static.ts`, each with its `*.test.ts`

**Interfaces:**

- Produces:
  - `SECURITY_HEADERS: Readonly<Record<string, string>>` — exactly the spec's table. `Permissions-Policy` is `accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=()`. `NO_STORE = { "Cache-Control": "no-store" }`.
  - `readJson(request: IncomingMessage, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415 }>` — `415` unless the media type is `application/json` (parameters such as `charset=utf-8` allowed); `413` as soon as more than `limit` bytes arrive, whatever `Content-Length` said, and the rest is not parsed; `400` for invalid JSON.
  - `crossSiteProblem(headers: IncomingHttpHeaders): string | null` — a problem when `Origin` is missing, does not parse, or its `host` differs from `headers.host`; or when `Sec-Fetch-Site` is present and is not `same-origin`. The problem text is for tests, never logged with values.
  - `resolveStatic(clientDir: string, rawPath: string): string | null` — strips the query; decodes percent-escapes once; refuses a NUL, a backslash, an empty segment, a `.` or `..` segment, and any segment starting with `.`; a path without an extension in its last segment resolves to `index.html`; the result must lie inside `clientDir`.
  - `contentTypeOf(path: string): string | null` — `.html`, `.js`, `.css`, `.map`, `.json`, `.woff2`, `.svg`, `.png`, `.ico`, `.txt`, `.webmanifest`; others null (served as `404`).
  - `cacheControlOf(path: string): string` — `public, max-age=31536000, immutable` for a name matching `/-[A-Z0-9]{8}\.[a-z0-9.]+$/` (esbuild's `[name]-[hash]`; 5b's build must name files that way), `no-cache` otherwise.

- [ ] **Step 1:** `body` tests over a real local `http` server: valid JSON; `text/plain` is 415; 4097 bytes with `Content-Length` is 413; 5000 bytes chunked with no `Content-Length` is 413 (Review Focus 3); invalid JSON is 400.
- [ ] **Step 2:** `origin` tests: same host passes; another host, a missing `Origin`, `Origin: null`, `Sec-Fetch-Site: cross-site` and `same-site` each refused; `Sec-Fetch-Site` absent with a good `Origin` passes.
- [ ] **Step 3:** `static` tests: `/`, `/app-ABCD1234.js`, `/login` (index), `/a/b` (index); each refused: `/../x`, `/%2e%2e/x`, `/..%2fx`, and `/%252e%252e/x`, decoded once, resolves to the literal name `%2e%2e/x` inside the directory, never outside it; `/a\\b`, `//etc/passwd`, `/x%00.js`, `/.env`, `/a/.git/config`; the cache rule for hashed and unhashed names; `headers` test that the table is exactly the spec's.
- [ ] **Step 4:** `npm test` — fails.
- [ ] **Step 5:** Implement.
- [ ] **Step 6:** `npm test && npm run typecheck && npm run lint` — pass.
- [ ] **Step 7:** `git commit -m "feat(server): headers, bounded bodies, the origin check, static paths"`

---

### Task 9: The handler, and the test world

**Files:**

- Create: `server/src/handler.ts`, `server/src/log.ts`, `server/src/archive.ts`, `server/src/archive.test.ts`, `server/testing/world.ts`, `server/src/handler.login.test.ts`, `server/src/handler.session.test.ts`, `server/src/handler.headers.test.ts`, `server/src/handler.static.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2 to 8.
- Produces:
  - `countByAccount(dataDir: string, config: Config, accounts: readonly string[]): Promise<Record<string, number>>` — reads the archive with `readArchive`, keeps only records of `accounts`, then `view(records, config.imports)`, and counts per account. Every key of `accounts` appears, with 0 when it has none.
  - `makeLog(out: (line: string) => void)` with `request(method: string, route: string, status: number, ms: number)` → `request method=GET route=/api/accounts/:key status=404 ms=3`, and `event(text: string)` for `login ok`, `login refused`, `login limited`, `login queue full`, `configuration invalid, refusing requests`, `session secret invalid, refusing requests`, `serving port=<n> people=<n> accounts=<n>`, `failed <ErrorClass>`.
  - `type HandlerDeps = { settings: Settings; clock: () => Date; log: ReturnType<typeof makeLog>; config: Live<ServerConfig>; secret: Live<Buffer>; limiter: ReturnType<typeof makeLimiter>; queue: ReturnType<typeof makeQueue> }`
  - `makeHandler(deps: HandlerDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void>` — routes exactly as the spec's table. Every response carries `SECURITY_HEADERS`; `/api/*`, `/health` and `/version` also `NO_STORE`. JSON bodies: `401 {"error":"login refused"}`, `404 {"error":"not found"}`, `405 {"error":"method not allowed"}` with `Allow`, `403 {"error":"refused"}`, `429 {"error":"too many attempts"}` with `Retry-After`, `503 {"error":"unavailable"}`, `500 {"error":"failed"}`. `GET /api/session` → `{ person, accounts, csrf }`. `GET /api/accounts` → `{ accounts: [{ key, bank, transactions }] }`. Login order: cross-site check, body, username length, `retryAfter`, queue, `findByUsername` or `DUMMY_HASH`, verify, limiter update, cookie.
  - `server/testing/world.ts`: `makeServerWorld(options?: { config?: Config; records?: ArchiveRecord[] }): Promise<ServerWorld>`, where `ServerWorld` has `url`, `host`, `clock: { now(): Date; advance(ms: number): void }`, `output: string[]`, `configPath`, `appDataDir`, `writeConfig(config: Config): Promise<void>` (by temporary file and rename), `rotateSecret(): Promise<void>`, `request(method: string, path: string, options?: { headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>` over `node:http` so every header is set exactly, `login(username: string, password: string): Promise<{ status: number; cookie: string | null }>` sending a good `Origin`, `session(cookie: string): Promise<{ person: string; accounts: string[]; csrf: string }>`, and `close()`. Its default configuration has people `ana` (owns `bnka-solo`, and `bnka-shared` with `ben`) and `ben`, with hashes made once per process with the real parameters; its default archive holds a few records per account from `@money/shared/testing`.

- [ ] **Step 1:** `archive.test.ts`: counts only the accounts asked for; an account with no records is 0; an import record hidden by the API's start is not counted.
- [ ] **Step 2:** `handler.login.test.ts`: a login sets the cookie with exactly the attributes; a wrong password and an unknown username give the same status and body; the username in another case, with a space before it, and a person's key typed as the username are each refused; the sixth failure for a real and for an unknown username is 429 with `Retry-After: 900`, another username is still served, a success clears the count, the window ends after the clock moves 15 minutes; a username of 65 characters is refused and not counted; `GET /api/login` is 405.
- [ ] **Step 3:** `handler.session.test.ts`: `/api/session` with a fresh cookie; at seven days the cookie is refused; a tampered cookie; after `rotateSecret` an old cookie is refused; after the person's password or username changes in the configuration their cookie is refused while the other person's still works; a person removed is refused; logout with the token clears the cookie; `/health` 200 and `/version` gives the revision.
- [ ] **Step 4:** `handler.headers.test.ts`: every header on a `200` from the API, a static file, a `404`, a `405` and a `500` (provoke the last by a `records` fixture that makes `readArchive` throw, such as a file where an account directory belongs).
- [ ] **Step 5:** `handler.static.test.ts`: a hashed file with its content type and immutable caching, `index.html` for `/` and `/somewhere`, `no-cache` on it, every path from Task 8's refusals is `404` over HTTP, `/api/nothing` is 404 JSON and not the index, an empty `CLIENT_DIR` gives 404 for `/`.
- [ ] **Step 6:** `npm test` — all fail.
- [ ] **Step 7:** Implement `archive.ts`, `log.ts`, `handler.ts`, `world.ts`.
- [ ] **Step 8:** `npm test && npm run typecheck && npm run lint` — pass. Note the suite's added time; the real scrypt cost should keep it within a few seconds.
- [ ] **Step 9:** `git commit -m "feat(server): login, sessions, the placeholder route and static files over HTTP"`

---

### Task 10: CSRF, lenses, reloading and bursts over HTTP

**Files:**

- Create: `server/src/handler.csrf.test.ts`, `server/src/handler.lens.test.ts`, `server/src/handler.reload.test.ts`
- Modify: `server/src/handler.ts` only where a test finds it wrong

**Interfaces:**

- Consumes: `ServerWorld`.

- [ ] **Step 1:** `handler.csrf.test.ts`: logout without the token, with another person's token, with a token for an old cookie; logout and login with a foreign `Origin`, with no `Origin`, with `Sec-Fetch-Site: cross-site`, with `Content-Type: text/plain`: each 403 or 415 as the spec says, and nothing changed.
- [ ] **Step 2:** `handler.lens.test.ts`: `ana` sees `bnka-solo` and `bnka-shared`, `ben` sees `bnka-shared` only, in `/api/session` and `/api/accounts`; `ben` asking for `bnka-solo` and for `bnka-nope` gets the same status and the same body; the transaction counts are for the person's accounts only; after `writeConfig` takes `ben` off `bnka-shared`, his next `/api/accounts` is empty without a new login.
- [ ] **Step 3:** `handler.reload.test.ts`: a configuration replaced by invalid JSON makes `/health` 503, `/api/session` 503 and a login 503, logs `configuration invalid, refusing requests` once, and recovers when a valid file returns; the same for a secret file replaced by a short one; the tripwire is Task 11's.
- [ ] **Step 4:** Bursts (Review Focus 5), in `handler.login.test.ts`: with a username already locked, 20 simultaneous logins for it are all 429 and none waits for a hash (assert total time well under one hash); 12 simultaneous logins for distinct unknown usernames give at least one 503 and every other one 401; afterwards each username that was answered 401 holds exactly one failure (four more wrong attempts are each 401, and the attempt after them is 429), and each answered 503 holds none.
- [ ] **Step 5:** `npm test` — what fails points at the handler; fix it there.
- [ ] **Step 6:** `npm test && npm run typecheck && npm run lint` — pass.
- [ ] **Step 7:** `git commit -m "test(server): CSRF, lenses, reloading and bursts over HTTP"`

---

### Task 11: Commands, `bin/money` and `npm run server`

**Files:**

- Create: `server/src/main.ts`, `server/src/main.test.ts`, `server/src/cli.ts`, `scripts/dev-server.ts`
- Modify: `bin/money`, `sync/src/main.ts` (the usage line), any sync test that asserts it, root `package.json` (`"server": "node scripts/dev-server.ts"`)

**Interfaces:**

- Produces:
  - `type Deps = { clock: () => Date; out: (line: string) => void; randomBytes: (size: number) => Buffer; isTerminal: boolean; readHidden: (prompt: string) => Promise<string>; listen: (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>, port: number) => Promise<{ port: number; close(): Promise<void> }> }`
  - `main(argv: readonly string[], env: Environment, deps: Deps): Promise<{ exit: number } | { running: { port: number; close(): Promise<void> } }>`
    - `serve`: `readSettings`, then `directoryProblems`, then the secret file must parse (else `the session secret is missing or invalid. Run: money rotate-session-secret`), then `loadServerConfig` must succeed; all problems printed, exit 1. Otherwise listen, log `serving …`, return `running`.
    - `hash-password`: with a terminal, ask `password: ` and `again: ` through `readHidden`, refuse a mismatch (`the two passwords differ`) and anything under 12 characters (`a password needs at least 12 characters`), print the hash on its own line; without a terminal, read one line once. Needs no other setting.
    - `rotate-session-secret`: needs `APP_DATA_DIR` only, an existing writable directory; writes the secret, prints `session secret rotated`.
    - anything else: `usage: serve | hash-password | rotate-session-secret`, exit 1.
  - `cli.ts`: supplies `process.env`, `() => new Date()`, `console.log`, `crypto.randomBytes`, `process.stdin.isTTY`, a hidden reader using raw mode on a terminal (and a plain line reader otherwise), and `listen` via `http.createServer`. Exits with the code; a `running` server is left to run.
  - `bin/money`: `serve|hash-password|rotate-session-secret` run `node /app/server/src/cli.ts "$@"`; everything else runs the sync as today. The sync's `USAGE` lists the server's three commands too.
  - `scripts/dev-server.ts`: creates `tmp/dev/app-data/` and `tmp/dev/client/` if absent, runs `rotate-session-secret` when the secret is missing (and says so), then `serve` with `CONFIG_PATH=fixtures/config.json`, `DATA_DIR=fixtures/archive`, `PORT=8080`, `REVISION=dev`.

- [ ] **Step 1:** `main.test.ts`: `serve` with each missing variable, with an `EB_PRIVATE_KEY` and with `STATE_DIR` present (exit 1, the variable's name printed, its value not), with no secret (the line naming the command), with a sync-only configuration (the server's problems); `serve` with everything valid returns `running` and answers `/health` on the returned port; `hash-password` through a fake terminal (mismatch, too short, a good one whose output `parseHash` accepts and `verifyPassword` confirms), and through piped input; `rotate-session-secret` with no `APP_DATA_DIR`, and with one; an unknown command.
- [ ] **Step 2:** `npm test` — fails.
- [ ] **Step 3:** Implement `main.ts`, `cli.ts`, `bin/money`, the usage line, `dev-server.ts` and the script.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` — pass. Then `npm run server` and, in another terminal, `curl -s localhost:8080/health` → `{"status":"ok"}`-style 200, and a login with `fx-mila-Qp2w9Lz7` / `fixture password mila` with `-H 'Origin: http://localhost:8080' -H 'Content-Type: application/json'` → 204 with the cookie. Stop it.
- [ ] **Step 5:** `git commit -m "feat(server): serve, hash-password and rotate-session-secret"`

---

### Task 12: The leak test

**Files:**

- Create: `server/src/leak.test.ts`

**Interfaces:**

- Consumes: `ServerWorld`, `main`.

- [ ] **Step 1:** Plant recognisable values: person keys `zqana` and `zqben`, usernames `zq-user-ana-81` and `zq-user-ben-37`, passwords `zq-password-ana-4492`, a wrong password `zq-wrong-7731`, an unknown username `zq-nobody-55`, archive records with recognisable IBANs, names, descriptions and amounts. Drive: good and bad logins, the limit, the queue full, logout, session, accounts (own, other's, unknown), a tampered cookie, a CSRF refusal, an invalid configuration, an invalid secret, a `500`, and `main`'s refusals (`EB_PRIVATE_KEY=zq-key-value`). Collect every line printed. Assert no planted value, no cookie value and no CSRF token appears, and that each path was actually reached (its log line is present).
- [ ] **Step 2:** `npm test` — passes only if nothing leaks. Break it on purpose once (log the username in `login refused`), see it fail, and undo the break.
- [ ] **Step 3:** `git commit -m "test(server): nothing a person typed or the archive holds is printed"`

---

### Task 13: The image

**Files:**

- Modify: `Dockerfile`, `.dockerignore`, `scripts/check-image.sh`

**Interfaces:**

- The image: `COPY server server`; `/app-data` owned by `node` with mode `0700`; an empty `/app/client`; `ENV APP_DATA_DIR=/app-data CLIENT_DIR=/app/client PORT=8080`; `EXPOSE 8080`; `ENV REVISION=${REVISION}` from the existing build argument. The default command and the stop signal stay.
- `check-image.sh`:
  - Step 4's expected listing becomes `client node_modules package-lock.json package.json server shared sync `.
  - Step 3 also checks `/app-data` is the image user's and writable.
  - A new step: a hash made in the image by piping a password generated for the run into `money hash-password`; a configuration of invented banks, one account, one person (key `ana`, username `check-user-1`) written into the work directory; an empty data directory; `docker run -d --pull=never --network none` with the configuration and data mounted read-only, running `sh -c 'money rotate-session-secret && exec money serve'`; up to 20 tries half a second apart of `docker exec <id> node -e "fetch('http://127.0.0.1:8080/health')…"`; then from inside: `/health` is 200, `/version`'s revision equals the image's `org.opencontainers.image.revision` label, a login with the right password is 204 and its `Set-Cookie` starts with `__Host-session=`, a wrong one is 401. The container is removed on exit by the script's trap. Every failure ends in a `FAIL` line.
  - A further step: `money serve` with `-e EB_PRIVATE_KEY=x` exits non-zero and names `EB_PRIVATE_KEY`.

- [ ] **Step 1:** Change `check-image.sh` first and run `docker build -t money:local . && scripts/check-image.sh money:local` — it fails on the listing.
- [ ] **Step 2:** Change the `Dockerfile` and `.dockerignore`.
- [ ] **Step 3:** `docker build --build-arg REVISION=$(git rev-parse HEAD) -t money:local . && scripts/check-image.sh money:local` — ends with `image checked`.
- [ ] **Step 4:** Break the login check once (expect 200), see `FAIL`, undo.
- [ ] **Step 5:** `git commit -m "feat: the image runs the server, and its check logs in"`

---

### Task 14: The durable documents

**Files:**

- Rename: `docs/dashboard.md` → `docs/app.md`
- Modify: `docs/architecture.md`, `docs/app.md`, `docs/infra.md`, `docs/sync.md`, `docs/testing.md`, `docs/archive-format.md`, `README.md`, `CLAUDE.md`, `.env.example`, and the spec's closing section
- Do not modify: any earlier dated spec or plan.

- [ ] **Step 1:** Every item under the spec's "Departures and additions", one document at a time. Among them: the build order (5a, 5b, 5c, 6) and the status line; the dependency table names `server` and `client`; `app.md` describes what was built (configuration, login, sessions, the secret file, CSRF, the rate limit and its accepted risk, lenses, reloading, headers, keeping apart from the sync, changing a username or password) and keeps the categories section; `infra.md`'s phase 2 says logins come from the configuration, the `APP_DATA_DIR` volume replaces the rules volume, the web container's command, environment of its own, networks, hardening and the deployment order; `.env.example` gains the server's variables in a section of their own; README gains `npm run server` with the two fixture logins, and `money rotate-session-secret`; `CLAUDE.md`'s layout and commands.
- [ ] **Step 2:** `grep -rniI dashboard --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude . | grep -v 'docs/specs/2026-1[0]\|docs/plans/2026-1[0]'` prints only the new spec's and plan's own mentions of the old name. `grep -rniI 'read-only' docs README.md CLAUDE.md` shows mounts only. `grep -rn RULES_DIR .` outside old specs and plans prints nothing.
- [ ] **Step 3:** Add "What moved while it was built" to the spec, listing every departure, as earlier specs do.
- [ ] **Step 4:** `npm run format:check && npm test` — pass.
- [ ] **Step 5:** `git commit -m "docs: the app server, and the app no longer called a dashboard"`

---

### Task 15: The infra plan, as a draft in the infra repo

**Files:**

- Create, in `~/Source/infra`: a draft spec in that repo's own convention (`docs/specs/<topic>.md`, no date), **left uncommitted**.

- [ ] **Step 1:** Read that repo's readme, `apps/money/`, another app's `app.yml` and `compose.yml`, the volume backup and restore check, and the edge role. **Never** the vault (`ansible/group_vars/all/vault.yml`). Never the host.
- [ ] **Step 2:** Write the draft: the spec's "Deployment" steps 1 to 8 in that repo's terms, each change additive with the live apps' rendered output byte-for-byte unchanged until step 7; the web service with its own environment (no `.env` shared with `sync`), no `edge` network and the port bound to the host's loopback until exposure, no network shared with `sync`, `read_only: true` with a `tmpfs` for `/tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, a memory limit, a healthcheck through `node` against `/health`; the new external volume, its backup and a restore check that asserts `session-secret`; the vault edits for `people` and `owners`, with `EDITOR=nano`; the one-liners for `rotate-session-secret` and for changing a username or password; the order (image first, vault second); step 7's route and what it changes on the front door; step 8 as a later option.
- [ ] **Step 3:** Tell the owner where it is. Do not commit it, and do not run anything in that repo.

---

### Task 16: Reviews, then merge

- [ ] **Step 1:** Run the code review (`/code-review` at `high`) and the security review (`/security-review`) over the branch. Report the findings to the owner; fix what they agree with, each fix with its test first.
- [ ] **Step 2:** Ask the owner before merging: a push to `main` publishes the image and restarts the production sync container within a minute, so it must not land while they are running `auth` or `import --write`, nor near 01:00 or 03:30.
- [ ] **Step 3:** `git rebase main` in the worktree; leave it with `ExitWorktree` (`keep`); in the main checkout, `git merge --ff-only worktree-app-server`, the full suite (`npm run typecheck && npm run lint && npm run format:check && npm test`), then `git push`, then `gh run watch <id> --exit-status`.
- [ ] **Step 4:** Remove the worktree and its branch once `main` is green. The 5b plan is written next, in its own worktree.
