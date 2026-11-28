# Spec: the app server

Slice 5a of the build order in [architecture.md](../architecture.md), added on 2026-11-27 when slice 5 was split in three. Written 2026-11-27. Once the slice has shipped this file is history and is not kept up to date.

## Goal

The server half of the app's technical foundation, built while the app's UX is still being designed: a `server` workspace that validates its configuration, logs people in, keeps them to the accounts they may see, and sends strict headers, in an image that can run it. No screens. Everything here is independent of what the screens turn out to be.

After this slice the image can run a web container that answers health and version, logs in the people the configuration names, and serves one authenticated placeholder route that only shows each person their own accounts. It is reviewed, by a code review and a `/security-review`, before it is merged. Nothing in this slice makes anything reachable on the real host.

## Why now

The UX work (user stories, principles, a second questionnaire round) decides what the screens show. It does not decide how a person logs in, how their accounts are kept from each other, what headers the server sends or how the image runs it. Those are the parts with the most risk, and they are worth building, reviewing and living with before any screen depends on them.

## The three slices

Slice 5, "Dashboard", becomes three. The build order in [architecture.md](../architecture.md) changes to match.

| Slice               | Holds                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **5a. App server**  | This spec. `server`, auth, lenses on a placeholder route, headers, the image running it, the infra changes written down.       |
| **5b. App client**  | [Its own spec](2026-11-27-app-client.md). `client`, the bundler, the shell, theming and fonts, the build stage, `npm run dev`. |
| **5c. App screens** | Waits for the UX work. The real screens, the browser libraries for them, and the data the app stores beside the rules.         |
| 6. Categories       | Unchanged: rules, the editor and the preview.                                                                                  |

Each of 5a and 5b ends in a security review. The one after 5b looks at the whole path end to end: the real bundle in a browser under the CSP, the cookies as the browser holds them, CSRF from the login page.

## Approaches considered

- **One slice or several.** One slice for server and client would let a single review see the login page and the CSP working against a real bundle. Split was chosen, so the first security review sees server code alone and the choice of browser libraries cannot hold up the auth work; the second review, after 5b, covers the end-to-end view the split would otherwise lose.
- **Where logins live.** In the environment, as [infra.md](../infra.md) said, or in the configuration file. The file was chosen: the mapping from person to accounts is structured, and a hash belongs beside the name it unlocks.
- **Where the session secret lives.** In the environment, from the vault, rotated by an edit and a redeploy; or in a file in `APP_DATA_DIR`, rotated by one command. The file was chosen, for a rotation that is one line and takes effect without a restart.
- **Session lifetime.** Thirty days from last use with a ninety-day cap was proposed. Seven days from login, with no renewal, was chosen: logging in is a password manager's autofill.
- **The store for what people write.** JSON documents or SQLite. Deferred to 5c; see "Left open".

## Names

Settled in this slice, and written into every document that uses the old ones:

- **The product is "the app"**, or "the money app", not "the dashboard". Its purpose is wider than a dashboard: budgets, pots, a year plan and more are coming. `docs/dashboard.md` becomes `docs/app.md`, and "dashboard" goes from every durable document, `README.md`, `CLAUDE.md`, code and comments, in favour of "the app", "the server" or "the client", whichever the sentence needs. The dated specs and plans of earlier slices are history and keep their words.
- **The app is not called read-only.** It writes plenty of its own: the secret now; rules, budgets, pots, a year plan, ownership of transactions and per-person settings later. What holds is narrower, and is said exactly: it never writes bank data, the archive is mounted read-only into its container, and nothing in this project can move money. "Read-only" stays only where it describes a mount; `README.md`'s "Read-only" becomes "Account information only".
- **The workspaces are `server/` and `client/`** (`@money/server`, `@money/client`), not `api/` and `app/`. Each says where it runs, which is also the line the dependency rule draws.
- **The writable directory is `APP_DATA_DIR`**, not `RULES_DIR`: what people write in the app. Today a session secret; rules in slice 6; more later. Infra has not declared it yet, so the rename is free. `DATA_DIR` and `STATE_DIR` are live in production and keep their names.
- **The web container** keeps its name in [infra.md](../infra.md).

## What gets built

| Part                          | Does                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `server/`                     | The workspace: settings, routes, auth, lenses, headers, static files, its commands. |
| `shared/src/config/`          | The configuration file gains `people` and each account's `owners`.                  |
| `fixtures/`                   | The generated configuration names two invented people and every account's owners.   |
| `bin/money`                   | Sends the server's commands to the server, and the rest to the sync, as today.      |
| `Dockerfile`, `.dockerignore` | The image holds `server/` and can run it.                                           |
| `scripts/check-image.sh`      | Starts the server in the image and asks it for health, version and a login.         |
| `package.json`                | The workspace, its tests, and `npm run server`.                                     |

### Configuration

The configuration file ([sync.md](../sync.md)) gains two things. Both are read by `shared`'s one validator, so the sync and the server can never disagree about what a valid file is.

```json
{
  "people": {
    "alex": { "username": "<generated>", "password": "scrypt$N=131072,r=8,p=1$<salt>$<key>" },
    "sam": { "username": "<generated>", "password": "scrypt$N=131072,r=8,p=1$<salt>$<key>" }
  },
  "accounts": {
    "bnka-personal": { "bank": "bnka", "iban": "NL00BNKA0000000001", "owners": ["alex"] },
    "bnka-joint": { "bank": "bnka", "iban": "NL00BNKA0000000002", "owners": ["alex", "sam"] }
  }
}
```

- **`people`**: one entry per person, keyed by a short readable name, such as a first name, so the file stays readable. The key is lowercase letters, digits and `-`, starting with a letter. It is what `owners` refers to and what the app shows; it is never typed to log in. The names in the example are placeholders.
- **`username`**: what that person types, or rather what their password manager fills in, to log in. Generated like a password, for a little more obscurity: 1 to 64 characters of letters in either case, digits, `-`, `_` and `.`. Stored as it is, not hashed: an attacker who has the file already has the password hashes to attack offline, and the username adds nothing to that. No two people may share one.
- **`password`**: a hash in the format below. Nothing else may be in a person's entry.
- **`owners`** on an account: the people who may see it, by their key. One owner makes it private to them; two make it shared. Every name must be a key in `people`.
- **For the sync, both are optional and ignored.** A file without them is as valid as today.
- **For the server, both are required**: `people` must name at least one person, and every account, closed ones included, must name at least one owner. Otherwise it refuses to start and names each problem. An account that nobody may see, or that everybody sees because nobody said otherwise, cannot happen by accident.
- **Hashes and names live in the configuration, not the environment.** They are structured, they belong beside the accounts they unlock, and the real file is already in infra's vault. [infra.md](../infra.md), which says logins come from the environment, is corrected.
- **Order of deployment.** The validator refuses unknown fields, so a file with `people` stops every nightly command on an image older than this slice. The image goes to production first; the vault gains the fields after. See "Deployment" below.

### Settings

From the environment, every problem reported at once, by name, never with a value, as the sync does ([sync.md](../sync.md)):

| Variable       | Holds                                                                          |
| -------------- | ------------------------------------------------------------------------------ |
| `CONFIG_PATH`  | The configuration file.                                                        |
| `DATA_DIR`     | The archive, mounted read-only. Must exist.                                    |
| `APP_DATA_DIR` | What the app writes. Must exist and be writable; never created.                |
| `CLIENT_DIR`   | The client's built files. Must exist. Empty until 5b.                          |
| `PORT`         | The port to listen on. The image sets it.                                      |
| `REVISION`     | The commit the image was built from, for the version route. The image sets it. |

The server needs no bank credentials and refuses nothing for their absence. `.env.example` documents the new variables.

### Routes

| Route                     | Who       | Answers                                                                                   |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `GET /health`             | anyone    | `200` while the configuration and the secret in use are valid, `503` otherwise.           |
| `GET /version`            | anyone    | `{ "revision": "<commit>" }`.                                                             |
| `POST /api/login`         | anyone    | `204` and a session cookie; `401`; `429` with `Retry-After`.                              |
| `POST /api/logout`        | logged in | `204`, and the cookie cleared.                                                            |
| `GET /api/session`        | logged in | The person's name, the account keys they may see, and their CSRF token. `401` otherwise.  |
| `GET /api/accounts`       | logged in | The placeholder: each visible account's key, bank and number of transactions in the view. |
| `GET /api/accounts/<key>` | logged in | The same for one account; `404` when it is unknown **or** not theirs, alike.              |
| `GET` anything else       | anyone    | A file from `CLIENT_DIR`, or `index.html` for a path without an extension.                |

- **Anything under `/api/` that is not a route is `404`**, never the client's `index.html`. Any method a route does not take is `405`.
- **Request bodies are JSON, and small.** A `POST` without `Content-Type: application/json` is `415`; a body over 4 KiB is `413`.
- **The placeholder exists to prove the lens on real data**: it reads the archive through `@money/shared/node`, cut to the person's accounts before anything is counted. Its shape is thrown away when the screens come.
- **Static files** are served only from inside `CLIENT_DIR`: a path is decoded once, and one that escapes the directory, names a dotfile or holds a NUL is `404`. No directory listings. Files whose names carry a content hash are cached for a year as immutable; `index.html` is `no-cache`. Until 5b the directory is empty and `/` is `404`.

### Login

- **One account per person**, from `people`. No sign-up, no password reset: a new entry in the configuration is how a username or password changes (below).
- **A login is a username and a password**, and the username is looked up among the `username` fields, never the keys. It is compared exactly, case and all, with nothing trimmed, and in constant time across every person. Usernames are generated and filled in by a password manager, so nothing about one is forgiven.
- **Hashes are scrypt from `node:crypto`**, with N = 2¹⁷, r = 8, p = 1 (128 MiB, about a quarter of a second), a 16-byte random salt and a 32-byte key. Stored as `scrypt$N=131072,r=8,p=1$<salt>$<key>`, base64 without padding, so the parameters can be raised later without breaking a stored hash. The server refuses to start on a hash weaker than these parameters. Argon2id is in Node 24 but still experimental; scrypt is not.
- **Compared with `timingSafeEqual`.** A username nobody has is checked against a fixed dummy hash, so an unknown username takes as long as a wrong password. Both answer the same `401` with the same body.
- **One check at a time.** Logins queue for the hash, so a burst cannot hold more than 128 MiB at once.
- **`money hash-password`** prints a hash for a password read from the terminal without echo, asked twice. When its input is not a terminal it reads one line, for tests. It refuses a password under 12 characters. It needs no configuration, so it runs anywhere the repository does: `node server/src/cli.ts hash-password`.

### Changing a username or password

Documented in [app.md](../app.md) and the README, without anything that names the host:

1. Generate the new username or password in the password manager.
2. For a new password, run `node server/src/cli.ts hash-password` on your own machine and paste the password when asked.
3. Put the username, or the printed hash, in the person's entry in the configuration in infra's vault, and deploy the configuration as infra's runbook says.
4. Nothing else. The server sees the new file without a restart, and that person's sessions end, because their signing key is derived from their username and their hash. The other person stays logged in.

### Sessions

- **A signed cookie, nothing stored on the server.** It holds the person's key (never the username) and the time of login, and an HMAC-SHA256 over them.
- **Seven days from login, then it ends.** No renewal on use: logging in again is a password manager's autofill. The cookie's `Max-Age` says the same, and the server checks the time itself against the injected clock. A login time in the future is refused.
- **`__Host-session`**: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and no `Domain`. Without `Domain` the browser sends it back only to the exact host that set it: not a parent domain, not a sibling, not a subdomain below it. The `__Host-` prefix makes the browser refuse the cookie unless all of that holds, which also keeps a sibling site from planting one of the same name.
- **The signing key is derived per person**: HMAC-SHA256 of the secret, that person's username and their stored hash. Changing a person's username or password ends that person's sessions; rotating the secret ends everyone's. A person removed from `people` is logged out on their next request.
- **Logout clears the cookie on that device.** A cookie copied elsewhere stays valid until it expires or the secret is rotated, which is the cost of storing nothing, and why the lifetime is short.

### The session secret

- **A file, `APP_DATA_DIR/session-secret`**: 32 random bytes, base64, readable by its owner only.
- **`money rotate-session-secret`** writes a new one, by a temporary file and a rename. That is the one-liner the README documents; the `docker exec` around it names the container and lives in infra's runbook.
- **The server re-reads it when it changes**, so a rotation logs everyone out at once without a restart.
- **No file, or one that is not 32 bytes of base64, stops the server at start** with a message that names `money rotate-session-secret`. The server never makes one up. A file that goes bad while it runs makes `/health` answer `503` and every request that needs a session answer `503`, until it is fixed: it fails closed.
- **Backed up with `APP_DATA_DIR`.** That backup will hold the rules, and the archive's backup holds every transaction, so a secret in it adds nothing an attacker with the backup lacks. Restoring an old secret revives only sessions younger than seven days.

### Cross-site requests

Anything that changes state is a `POST` with a JSON body, and is refused with `403` unless:

- the `Origin` header names the request's own `Host`;
- `Sec-Fetch-Site`, when the browser sends it, is `same-origin`;
- and, for everything but login, an `X-CSRF-Token` header holds the person's token: an HMAC of their session cookie, under their signing key, handed out by `GET /api/session`.

`SameSite=Strict` is kept, but not relied on: the host serves other apps, and if they share a registrable domain they are the same _site_, so `SameSite` would not stop a request from one of them. The custom header and the JSON content type also mean a cross-origin page cannot send the request without a preflight, which the server never answers.

The host check relies on the front door passing the original `Host` through. The deployment plan below says so, and the first login through the front door proves it: were the `Host` rewritten, that login would be refused with `403`. A scripted Tier 4 check is left for later.

### Rate limiting

- **Five failed logins per username in fifteen minutes**, then `429` with `Retry-After` until the window ends, for that username only. A success clears its count.
- **Every username typed is counted, whether anyone has it or not.** One nobody has is locked out after five failures exactly as a real one is, so the answers never tell the two apart.
- **No cap across usernames.** With every one counted, it would protect nothing more, and it would let anyone lock both people out at once.
- **Counted in memory, and bounded by the hash.** A username is counted only after its hash is checked, and checks run one at a time, so a window can hold only as many as a quarter-second check allows in fifteen minutes: a few thousand. A username over 64 characters is refused before it is checked or counted. Logins waiting for the hash queue up to a short limit; beyond it the server answers `503` until the queue drains. A restart resets the counts.
- **The client's address is not used.** Behind the front door it would come from a header, and trusting it would mean trusting the header.
- **Accepted on 2026-11-28:** someone who knows a username can keep that one person locked out, five tries every fifteen minutes. Usernames are generated like passwords and never shown, a device already logged in stays logged in for its seven days, and the login page says when to try again. If it ever happens, counting per name and per client address is the answer, with the front door's header trusted on purpose.

### Lenses

- **A person may see the accounts that name them in `owners`.** That set is worked out on every request from the configuration in use, so taking an account away needs no restart and no logout.
- **The server cuts the view before it leaves the server.** Nothing outside a person's set is ever sent to their browser, so whatever the browser later filters or groups is already only theirs. The client may offer lenses within the set ("mine", "ours", "everything I may see"); which ones is a 5c decision, made with the UX work.
- **Asking for an account outside the set is `404`**, the same answer as for an account that does not exist, so a person cannot learn which keys exist.

### Reloading the configuration

The configuration file is replaced by a rename on the host ([infra.md](../infra.md)), and the server has to see it without a restart for a removed person or owner to take effect. It checks the file's identity and modification time on each request and reads it again when they change. A new file that fails validation is not used: the server fails closed, `/health` answers `503`, every request that needs the configuration answers `503`, and one log line says the configuration is invalid, without its contents.

### Headers

On every response:

| Header                         | Value                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Content-Security-Policy`      | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options`       | `nosniff`                                                                                                                                                                                        |
| `Referrer-Policy`              | `no-referrer`                                                                                                                                                                                    |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                                                                                                                                                                    |
| `Cross-Origin-Resource-Policy` | `same-origin`                                                                                                                                                                                    |
| `Permissions-Policy`           | every powerful feature off: camera, microphone, geolocation, payment, USB and the rest                                                                                                           |
| `X-Frame-Options`              | `DENY`, for browsers older than `frame-ancestors`                                                                                                                                                |

And on every `/api/` response and `/version`, `Cache-Control: no-store`. HSTS is the front door's ([infra.md](../infra.md)). No inline script and no inline `<style>` is allowed: a library that needs either is a design change, not a fix ([app.md](../app.md)). Styles set by script through the DOM are not affected.

### Logging

One line per request: the method, the route's pattern rather than its path, the status and the time taken. A login logs whether it succeeded, and never the username tried or the person's key. Never a password, a hash, a cookie, a token, a request body or anything from the archive. Startup logs counts and keys only. The leak test ([testing.md](../testing.md)) grows to cover the server.

### Kept apart from the sync

The server must never be able to reach a bank, and the sync must never be reachable from the internet, even with the server compromised: code running as the server, with everything the server's container holds. Most of that is the host's declaration, not this code, so the spec says what each side guarantees.

**What a compromised server holds.** The archive, read-only, for both people; the configuration, read-only, with the password hashes in it; the session secret. With those it can read and send out bank data, which is why the archive's mount and the lens are not the last line. What it does not hold:

- **No Enable Banking credentials.** Every call to Enable Banking is signed with the application's private key, and the bank session is in the sync's state. The web container gets neither: no `EB_*` variable, no state volume. The sync's code is in the image too, but without the key and the session it cannot sign a request or name a session.
- **A tripwire in the server.** `money serve` refuses to start, naming the variables and nothing else, when any `EB_*` variable or `STATE_DIR` is present in its environment. That catches the likeliest mistake on the host: a web container given the app's one shared environment file, which today holds the key.
- **No path to the sync.** The sync container listens on nothing: its process is `sleep infinity`, and its commands are run by the host through `docker exec`. The web container shares no network with it, so there is not even a connection to refuse. Nothing the server can write is read by the sync: the archive and the configuration are mounted read-only into the web container, and the sync never mounts `APP_DATA_DIR`. The image is pulled by the host, not built from anything the server can touch.
- **No more than a non-root process gets.** The container runs as uid 1000, and the infra plan adds a read-only root filesystem, every capability dropped, no new privileges, no Docker socket and a memory limit. What is left is an escape from the container itself, which no declaration in this repository can rule out.

**What remains, stated so it is not mistaken for solved.** The web container has to reach the front door, and the front door's network today also has a route to the internet, so a compromised server can send out what it reads. Shutting that would mean a network of its own between the front door and this container, which changes the front door, a live app. It is noted in the infra plan as a later step, the owner's call.

### Commands

`bin/money` sends `serve`, `hash-password` and `rotate-session-secret` to `server/src/cli.ts`, and everything else to the sync as today. The sync's usage line lists all of them. `server/src/cli.ts` is the server's only edge, as `sync/src/cli.ts` is the sync's: it supplies the environment, the clock, the filesystem and the port, and is not run by any test.

### The image

Still one stage; the bundling stage is 5b's.

- **`server/` is copied in**, and `.dockerignore` admits it. `node_modules` still holds only `@money`.
- **`/app-data`**, owned by the image's user, with `APP_DATA_DIR=/app-data`. And an empty `/app/client`, with `CLIENT_DIR=/app/client`, which 5b fills.
- **`PORT=8080`**, declared with `EXPOSE`. The documented port of [infra.md](../infra.md)'s contract.
- **`REVISION`** set from the build argument the label already uses.
- **The default command stays `sleep infinity`.** The web container is started with `money serve`; that is infra's declaration. The stop signal stays `SIGKILL`: the server holds nothing a kill can lose, and every write is a temporary file and a rename.

`scripts/check-image.sh` gains, with `--network none` kept: a `money rotate-session-secret` into a temporary directory, a `money serve` in a detached container over a mounted copy of a small invented archive and configuration, and requests made from inside that container with Node's `fetch`. It asserts `/health` is `200`, `/version` names the revision the image was built with, a login with the configured password is `204` with a `__Host-session` cookie, and a wrong one is `401`. It also asserts the new directories' ownership.

## Tests

All with `node:test`, fakes rather than mocks, the clock injected.

- **Tier 1:** the hash format, its parsing and the refusal of weak parameters, with a fast hash only where the test is about the format and not the cost; cookie signing, expiry at exactly seven days, a login time in the future, a tampered name, a tampered time, a tampered signature; the per-person key; the CSRF token; the rate limiter over a moved clock; the lens function; the configuration's new fields, for the sync and for the server, every way each can be wrong; the settings.
- **Tier 2s, the real server over HTTP** on a free port, against a temporary `APP_DATA_DIR` and a small configuration and archive written by the test:
  - login, and the cookie's attributes; a wrong password; an unknown username, answered exactly as a wrong password; a real username in another case, and with a space around it, refused; a person's key typed as the username, refused;
  - the sixth failed login for a username is `429`, for a real one and an unknown one alike; another username is still served; a success clears the count; the window ends; a username over 64 characters; a full queue;
  - a `POST` without a token, with the wrong token, with a foreign `Origin`, with `Sec-Fetch-Site: cross-site`, with the wrong content type: each refused;
  - an expired cookie, a tampered one, one signed under an old secret after `rotate-session-secret`, one issued before the person's username or password changed, one for a person since removed, and the other person's session surviving each of those changes;
  - `money serve` refusing to start with an `EB_*` variable or `STATE_DIR` in its environment;
  - the lens: each person sees exactly their accounts in `/api/session` and `/api/accounts`, another's account and an unknown key are both `404` with the same body, and taking an owner away in the configuration takes effect on the next request;
  - a configuration replaced by an invalid one fails closed;
  - every header on every kind of response, the API's, a static file's, a `404`'s and a `500`'s;
  - static files: a hashed file, `index.html` for a path without an extension, and each way out of the directory refused;
  - `/api/` paths that do not exist, and methods a route does not take.
- **The leak test** drives the server through each of the above with recognisable names, passwords, cookies and archive values, and asserts none of them is printed.
- **The image**, in CI on every push: `scripts/check-image.sh`.

Rate-limit and login tests use the real scrypt parameters: correctness of the cost is part of what they test, and the suite can afford a few seconds.

Each new test is seen to fail first.

## Deployment

A plan for the infra repo, which this slice writes down and does not make. The concrete version, in that repo's own terms and conventions, is written as a draft spec in the infra repo and left uncommitted, for the owner to review and carry out; writing it means reading that repo, never its vault. Nothing below names the host. Infra changes stay additive: the live apps' rendered configuration stays byte-for-byte unchanged.

1. **This slice reaches `main` and production as an image.** The sync container runs it; nothing changes for the sync. Only then:
2. **The vault's configuration gains `people`, with usernames and hashes, and every account's `owners`.** The hashes come from `money hash-password`, run on the owner's own machine.
3. **A new volume for `APP_DATA_DIR`,** created by hand and declared as pre-existing, as the other two are. Added to the nightly volume backup, with a restore check that asserts `session-secret` is present.
4. **The web container**: the same image, command `money serve`, the data volume read-only, the configuration directory read-only, the new volume read-write, `PORT` as the image sets it. No state volume. **An environment of its own**, not the app's shared environment file, so no Enable Banking variable reaches it; the tripwire above refuses to start otherwise. **No network shared with the sync container.** A read-only root filesystem with a small temporary directory in memory, every capability dropped, no new privileges, no Docker socket, a memory limit.
5. **`money rotate-session-secret`, once**, run inside it before its first start succeeds. Until then it refuses to start, and says why.
6. **Not reachable from outside.** Until both reviews have passed, after 5a and after 5b, the front door has no route to it. Its port is published on the host's loopback address only, so the owner can reach it through an SSH tunnel to try it in a browser. `/health` and `/version` can also be read from inside it.
7. **Exposed after the 5b review**: the container joins the front door's network as the other apps do, the loopback port goes, and the front door gains a route, which terminates TLS, sets HSTS and passes the original `Host` through. The route is the one change to a live app's configuration, and it comes only at this step. The owner then logs in through it once, which proves the `Host` arrives intact.
8. **Later, the owner's call:** a network of its own between the front door and this container, with no route to the internet, so that a compromised server could not send out what it reads.

## Departures and additions

Written into the durable documents before the slice is done:

- **[architecture.md](../architecture.md):** the build order splits slice 5 into 5a, 5b and 5c; the names; the status line; the layout.
- **`docs/dashboard.md` becomes [app.md](../app.md)**, and gains login, sessions, the secret file, CSRF, rate limiting, lenses and headers as built; "owns exactly one piece of state" becomes `APP_DATA_DIR`, holding the secret now and the rules in slice 6.
- **[infra.md](../infra.md):** what keeps the web container apart from the sync, and what remains; logins from the configuration file, not the environment; changing a username or password; the secret file; the `APP_DATA_DIR` volume in place of the rules volume; the image's new directories, port and revision; the web container's command; the deployment order above.
- **[sync.md](../sync.md):** the configuration's `people` and `owners`, optional for the sync.
- **[testing.md](../testing.md):** Tier 2s is in place for the server; the leak test covers it; the image check's new steps.
- **`README.md`, `CLAUDE.md`, `.env.example`:** the names, the layout, the new variables, `npm run server`, `money rotate-session-secret`.

## Not in this slice

- **The client, the bundler, the shell and `npm run dev`.** 5b.
- **Any screen, and any data the app stores besides the secret.** 5c, with the UX work.
- **Anything on the host.** Written down above; made in the infra repo by the owner.

## Left open

- **How the app stores what people write.** Budgets, pots, a year plan, ownership of transactions and per-person settings are coming in 5c, and with two people editing at once. The mechanics of concurrency are settled either way: the server is the only writer, puts its writes in one queue and writes by temporary file and rename, and every save names the version it was based on and is refused when it is stale. What is open is the store. **The lean: small JSON documents, each with its own version, so that two people editing different budgets never conflict.** What would change it to SQLite, which Node ships as `node:sqlite`: a model that turns out relational, ownership of transactions being the likely first case, or a change that must save several things together. SQLite would cost infra a consistent snapshot before the backup and a different restore check. Decided in 5c, with the data model in hand.
- **Logout everywhere for one person** is changing their password. If that is too blunt, a per-person counter in the configuration, signed into the cookie, would do it; not built until it is wanted.

## What moved while it was built

Everything below is written into the documents that own it. This section is only the record of where the build differed from the text above.

- **`writeAtomic` moved from `sync` to `shared`** (`shared/src/util/atomic.ts`, exported from `@money/shared/node`). It takes a mode, and removes a stale temporary file first, so the file is always created with that mode: the secret's is `0600`.
- **The directory checks moved to `shared` too** (`shared/src/util/directories.ts`, in `@money/shared/node`), and the `Environment` type to `shared/src/config/environment.ts`, in the browser-safe entry. The sync and the server share them.
- **The handler is four modules, not one.** `server/src/handler.ts` holds the routing, static files and the net that turns a failure into a `500`; `server/src/api.ts` the API routes and login; `server/src/reply.ts` replies as data. `server/src/serve.ts` holds `makeHandlerDeps` and `makeServer`, shared by `main` and the test world. `server/src/line-input.ts` is the pure line buffer under the hidden terminal reader.
- **`main`'s dependencies gained `err`.** `hash-password` prints only the hash on standard output, and its prompts and messages go to standard error, so the hash can be captured. `listen` takes the `http.Server` rather than a handler, because the `clientError` handler needs it.
- **A hash is accepted only if scrypt can derive it.** "Weaker than these parameters" became exact: N a power of 2 and at least 2¹⁷, r at least 8, p from 1 to 16, a 16-byte salt, a 32-byte key, and memory, 128·r·(N + 2) + 128·r·p, within 256 MiB. A weaker or unusable hash stops the server at start.
- **The dummy hash moves with the parameters.** When stored hashes are raised, `DUMMY_HASH` and `SCRYPT` are raised with them, or a wrong password for that person takes longer than an unknown username.
- **The rate limit holds under concurrency.** The limit is checked again inside the hash queue, and a failure is recorded right after its hash, so a username locked while its logins wait gets no further checks. A locked username never joins the queue. A `429` or a `503` counts nothing.
- **The `Origin` must be canonical**: `new URL(origin).origin === origin`, over `http` or `https`, with a host. Userinfo, a path, uppercase and `null` are refused.
- **Static paths gained limits.** A path is decoded once; a segment over 255 bytes, or a resolved path over 1024 bytes, is not found, as is `ENAMETOOLONG`; only regular files are served, so a directory is `404`; `/api/*` never falls back to `index.html`; a trailing slash other than `/` is `404`.
- **`413`, `415` and a cross-site `403` close the connection**, since the body was never read.
- **Malformed requests**, Node's `clientError`, are answered `400` with the security headers and logged by a fixed line only. A handler whose promise rejects is logged as `failed <ErrorClass>` and answered `500`.
- **The startup line** is `serving port=<n> revision=<rev> people=<n> accounts=<n>`.
- **`/health`** answers `{"status":"ok"}`, or `503` with `{"error":"unavailable"}` while the configuration or the secret is invalid, and is `no-store` like `/version`.
- **The image no longer sets `DATA_DIR` or `STATE_DIR`.** `bin/money` sets them to `/data` and `/state` for the sync's commands only, when they are unset. The server's commands get neither, so the web container holds no `STATE_DIR` for the tripwire to refuse. Infra runs every sync command through `money`, so the sync container is unchanged. The web container sets `DATA_DIR` itself.
- **`npm run server`** runs `scripts/dev-server.ts`: the fixtures' archive and configuration, `APP_DATA_DIR` and `CLIENT_DIR` under `tmp/dev/`, the secret made on the first run, port 8080, `REVISION=dev`. The fixture people are `mila` (`fx-mila-Qp2w9Lz7`, `fixture password mila`) and `tom` (`fx-tom-Hk4r8Vn2`, `fixture password tom`).
- **The test world** issues requests through `node:http` with a keep-alive agent per request, so a `Connection: close` is the server's own, and hashes its two people once per process with the real parameters.
- **The leak test plants a value on every path it scans**: usernames, those of the burst included, people's keys, passwords and their hashes, whole and by salt and key, cookies and CSRF tokens, the session secret, the archive's values, and a `500` whose error message holds planted archive values.
- **The image check's `/app` listing** includes `server` and the empty `client`, and its ownership step covers `/app-data`. It also asserts that the image sets neither `DATA_DIR` nor `STATE_DIR`.

### Left open

Found in review and not done in this slice; the final review triages them.

- **`readJson` replaces invalid UTF-8** instead of refusing it.
- **`writeAtomic` could open its temporary file with `wx`** after removing a stale one.
- **The limiter prunes by a full scan on every call**, which is fine at a few thousand usernames.
- **A login waiting in the queue uses the configuration** as it was when the login arrived.
- **The hidden terminal reader** does not handle a character split across chunks, escape sequences, or a CR and LF split across chunks.
- **`clientError` logs every reset**, a client's own included.
- **The image check does not assert** `/app-data`'s mode `0700`, an empty `/app/client`, or an explicit `DATA_DIR` winning over the default.
- **The full-queue test waits 300 ms** before its last login, rather than waiting for an event.
- **The owner should run `money hash-password` once on a real terminal**, typing, backspace, Enter, Ctrl-C and Ctrl-D, since no test reaches the terminal path.
