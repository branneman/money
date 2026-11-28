# The app

A web app over the archive, for the people it belongs to: tables and charts with filtering, sorting and grouping, rule-based categories, and later budgets, pots and a year plan. Each person sees the accounts they own, and no others.

It is two workspaces: `server`, which runs in the web container, and `client`, the interface that runs in the browser. Both use `shared` for the normalised view and for categorising, so the server and the browser can never disagree about a category.

Built: the server, with its configuration, login, sessions, lenses, headers and commands, and one placeholder route over the archive. Not built yet: the client ([its spec](specs/2026-11-27-app-client.md)), the screens and the categories. [architecture.md](architecture.md) has the build order.

## Boundaries

- **It never writes bank data.** The archive is mounted read-only into its container, so this is enforced by the mount and not by the code.
- **It never talks to a bank.** It has no bank credentials and no session, and refuses to start beside either. See "Kept apart from the sync".
- **It writes in one directory, `APP_DATA_DIR`,** and nowhere else. The session secret lives there; the rules join it with the categories, and what people write in the app after that. The sync never mounts it.
- **Nothing in this project can move money.** Account information only.
- **It reads the normalised view only**, never `raw`. See [archive-format.md](archive-format.md).

## Settings

From the environment, every problem reported at once, by name and never with a value, as the sync does ([sync.md](sync.md)):

| Variable       | Holds                                                                          |
| -------------- | ------------------------------------------------------------------------------ |
| `CONFIG_PATH`  | The configuration file.                                                        |
| `DATA_DIR`     | The archive, mounted read-only. Must exist.                                    |
| `APP_DATA_DIR` | What the app writes. Must exist and be writable.                               |
| `CLIENT_DIR`   | The client's built files. Must exist.                                          |
| `PORT`         | The port to listen on. The image sets it.                                      |
| `REVISION`     | The commit the image was built from, for the version route. The image sets it. |

- **No directory is ever created.** A missing mount is an error at start, never an empty archive.
- **No bank credential may be present.** Any `EB_*` variable, or `STATE_DIR`, stops the server at start, naming the variable and nothing else. An empty one counts too. See "Kept apart from the sync".
- **The server needs no bank credentials**, and refuses nothing for their absence. `.env.example` documents its variables in a section of their own.

## The configuration

The server reads the same file as the sync ([sync.md](sync.md)), through `shared`'s one validator, so the two can never disagree about what a valid file is. Two parts of it are the server's:

- **`people`**: one entry per person, keyed by a short readable name such as a first name. The key is what `owners` refers to and what the app shows; it is never typed to log in. Each entry holds a `username` and a `password` hash, and nothing else.
- **`owners`** on an account: the people who may see it, by their key. One owner makes it private to that person; two make it shared.

For the server both are required. `people` must name at least one person, and every account, closed ones included, must name at least one owner, so an account nobody may see, or one everybody sees because nobody said otherwise, cannot happen by accident. Every password must be a hash `money hash-password` made, at parameters this server accepts (see Login). Anything else stops the server at start, with every problem named.

**Messages name a person by position**, as `people, entry 2`, never by key or username. A key is a first name, and a username is half a login.

## Routes

| Route                     | Who       | Answers                                                                                              |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `GET /health`             | anyone    | `{"status":"ok"}`; `503` `{"error":"unavailable"}` while the configuration or the secret is invalid. |
| `GET /version`            | anyone    | `{"revision":"<commit>"}`.                                                                           |
| `POST /api/login`         | anyone    | `204` and a session cookie; `401`; `429` with `Retry-After`; `503` while the queue is full.          |
| `POST /api/logout`        | logged in | `204`, and the cookie cleared.                                                                       |
| `GET /api/session`        | logged in | The person's name, the account keys they may see, and their CSRF token. `401` otherwise.             |
| `GET /api/accounts`       | logged in | The placeholder: each visible account's key, bank and number of transactions in the view.            |
| `GET /api/accounts/<key>` | logged in | The same for one account; `404` when it is unknown **or** not theirs, alike.                         |
| `GET` anything else       | anyone    | A file from `CLIENT_DIR`, or `index.html` for a path without an extension.                           |

- **Anything under `/api/` that is not a route is `404`**, never the client's `index.html`. Any method a route does not take is `405`, with `Allow`.
- **Request bodies are JSON, and small.** A `POST` without `Content-Type: application/json` is `415`; a body over 4 KiB is `413`. Both close the connection, as a cross-site `403` does: the body was never read, so nothing more on that connection can be trusted.
- **A request Node cannot parse** is answered `400`, one that took too long to arrive `408`, and one whose headers overflow `431`, each with the security headers, and logged by its own fixed line only. A client's own reset is neither answered nor logged.
- **A failure nobody expected** is a `500` with `{"error":"failed"}`, logged as `failed <ErrorClass>` and nothing else. The server keeps serving.
- **The placeholder exists to prove the lens on real data.** It reads the archive through `@money/shared/node`, cut to the person's accounts before anything is counted. Its shape is thrown away when the screens come.

### Static files

Served only from inside `CLIENT_DIR`. A path is decoded once, and is `404` when it:

- escapes the directory, names a dotfile, holds a NUL or a backslash;
- has a segment over 255 bytes, or resolves to a path over 1024 bytes, so a long path is not found rather than a failure anyone can provoke;
- ends in a slash, other than `/` itself;
- names anything but a regular file. A directory is `404`, and there are no listings;
- has an extension the server does not serve. It serves the types a built client holds: HTML, scripts, styles, source maps, JSON, fonts, images, text and the web manifest.

Files under `assets/` whose names carry a content hash, as the bundler writes them (`<name>-<8 capitals and digits>.<ext>`), are cached for a year as immutable; everything else, `index.html` and a hash-shaped name anywhere but `assets/` included, is `no-cache`, so the client's build must emit its hashed files into `assets/`. The image's `CLIENT_DIR` is empty until the client is built, and `/` is `404` until then.

## Login

- **One account per person**, from `people`. No sign-up, no password reset: a new entry in the configuration is how a username or password changes (below).
- **A login is a username and a password**, and the username is looked up among the `username` fields, never the keys. It is compared exactly, case and all, with nothing trimmed, and in constant time across every person. Usernames are generated and filled in by a password manager, so nothing about one is forgiven.
- **Usernames are generated like passwords**: 1 to 64 characters of letters in either case, digits, `-`, `_` and `.`, and no two people share one. They are stored as they are, not hashed: whoever has the file already has the hashes to attack offline, and a username adds nothing to that.
- **Hashes are scrypt from `node:crypto`**, with N = 2¹⁷, r = 8, p = 1 (128 MiB, about a quarter of a second), a 16-byte random salt and a 32-byte key. Stored as `scrypt$N=131072,r=8,p=1$<salt>$<key>`, standard base64 without padding, so the parameters can be raised later without breaking a stored hash. Argon2id is in Node 24 but still experimental; scrypt is not.
- **A hash is accepted only if scrypt can derive it.** N a power of 2 and at least 2¹⁷, r at least 8, p from 1 to 16, a 16-byte salt, a 32-byte key, and memory, 128·r·(N + 2) + 128·r·p bytes, within 256 MiB. A weaker or unusable hash stops the server at start, rather than failing at a login.
- **Compared with `timingSafeEqual`.** A username nobody has is checked against a fixed dummy hash, so an unknown username takes as long as a wrong password. Both answer the same `401` with the same body. **When stored hashes are raised to new parameters, raise `DUMMY_HASH` and `SCRYPT` in `server/src/auth/password.ts` with them**, or a wrong password for that person takes longer than an unknown username, and the difference tells the two apart.
- **One check at a time.** Logins queue for the hash, so a burst cannot hold more than 128 MiB at once. At most 8 wait; beyond that the answer is `503` until the queue drains.

### `money hash-password`

Prints a hash for a password read from the terminal without echo, asked twice. The prompts and every message go to standard error, and standard output holds the hash alone, so it can be captured. When its input is not a terminal it reads one line, for tests and scripts. It refuses a password under 12 characters. It needs no configuration, so it runs anywhere the repository does: `node server/src/cli.ts hash-password`.

## Rate limiting

- **Five failed logins per username in fifteen minutes**, then `429` with `Retry-After` until the window ends, for that username only. The window is fixed from the first failure. A success clears the count.
- **Every username typed is counted, whether anyone has it or not.** One nobody has is locked out after five failures exactly as a real one is, so the answers never tell the two apart.
- **No cap across usernames.** With every one counted, it would protect nothing more, and it would let anyone lock both people out at once.
- **A username over 64 characters** is refused with `401` before it is checked or counted.
- **Counted in memory, and bounded by the hash.** A username is counted only after its hash is checked, and checks run one at a time, so a window can hold only as many as a quarter-second check allows in fifteen minutes: a few thousand. A restart resets the counts.
- **Exact under concurrency.** A locked username never joins the queue. The limit is checked again inside the queue, just before the hash, and a failure is recorded right after its hash, so a username that locks while its logins wait gets no further checks. A `429` or a `503` counts nothing.
- **The client's address is not used.** Behind the front door it would come from a header, and trusting it would mean trusting the header.
- **Accepted on 2026-11-28:** someone who knows a username can keep that one person locked out, five tries every fifteen minutes. Usernames are generated like passwords and never shown, a device already logged in stays logged in for its seven days, and the login page says when to try again. If it ever happens, counting per name and per client address is the answer, with the front door's header trusted on purpose.

## Sessions

- **A signed cookie, nothing stored on the server.** It holds the person's key (never the username) and the time of login, and an HMAC-SHA256 over them.
- **Seven days from login, then it ends.** No renewal on use: logging in again is a password manager's autofill. The cookie's `Max-Age` says the same, and the server checks the time itself against its clock. A login time in the future is refused.
- **`__Host-session`**: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and no `Domain`. Without `Domain` the browser sends it back only to the exact host that set it: not a parent domain, not a sibling, not a subdomain below it. The `__Host-` prefix makes the browser refuse the cookie unless all of that holds, which also keeps a sibling site from planting one of the same name. A request that carries two cookies of that name is refused rather than picked from.
- **The signing key is derived per person**: HMAC-SHA256 of the secret, that person's username and their stored hash. Changing a person's username or password ends that person's sessions; rotating the secret ends everyone's. A person removed from `people` is logged out on their next request.
- **Logout clears the cookie on that device.** A cookie copied elsewhere stays valid until it expires or the secret is rotated, which is the cost of storing nothing, and why the lifetime is short. Logging one person out everywhere is changing their password.

## The session secret

- **A file, `APP_DATA_DIR/session-secret`**: 32 random bytes, base64, a trailing newline, mode `0600`.
- **`money rotate-session-secret`** writes a new one, by a temporary file and a rename. A stale temporary file is removed first, so the file is always created with its mode. It needs only `APP_DATA_DIR`. The `docker exec` around it names the container, and lives in infra's runbook.
- **The server re-reads it when it changes**, so a rotation logs everyone out at once without a restart.
- **No file, or one that is not 32 bytes of base64, stops the server at start** with a message that names `money rotate-session-secret`. The server never makes one up. A file that goes bad while it runs makes `/health` and every request that needs a session answer `503`, until it is fixed: it fails closed.
- **Backed up with `APP_DATA_DIR`.** That backup will hold the rules, and the archive's backup holds every transaction, so a secret in it adds nothing an attacker with the backup lacks. Restoring an old secret revives only sessions younger than seven days.

## Cross-site requests

Anything that changes state is a `POST` with a JSON body, and is refused with `403` unless:

- the `Origin` header is in canonical form, as `new URL(origin).origin` would write it, over `http` or `https`, with a host, and names the request's own `Host`. Userinfo, a path, uppercase and `null` are refused;
- `Sec-Fetch-Site`, when the browser sends it, is `same-origin`;
- and, for everything but login, an `X-CSRF-Token` header holds the person's token: an HMAC of their session cookie, under their signing key, handed out by `GET /api/session`.

`SameSite=Strict` is kept, but not relied on: the host serves other apps, and if they share a registrable domain they are the same _site_, so `SameSite` would not stop a request from one of them. The custom header and the JSON content type also mean a cross-origin page cannot send the request without a preflight, which the server never answers.

The host check relies on the front door passing the original `Host` through ([infra.md](infra.md)). Were the `Host` rewritten, every login through it would be refused with `403`.

## Lenses

- **A person may see the accounts that name them in `owners`.** That set is worked out on every request from the configuration in use, so taking an account away needs no restart and no logout.
- **The server cuts the view before it leaves the server.** Nothing outside a person's set is ever sent to their browser, so whatever the browser later filters or groups is already only theirs. The client may offer lenses within the set ("mine", "ours", "everything I may see"); which ones is decided with the screens.
- **Asking for an account outside the set is `404`**, the same answer as for an account that does not exist, so a person cannot learn which keys exist.

## Reloading

The configuration file is replaced by a rename on the host ([infra.md](infra.md)), and the server has to see that without a restart for a removed person or owner to take effect. So for the configuration and for the secret, it looks at the file's identity (inode, modification time and size) on every request, and reads it again when that changed.

- **A new file that fails validation is not used.** The server fails closed: `/health` answers `503`, every request that needs the file answers `503`, and one line says the configuration, or the secret, is invalid, without its contents. One line per change of the file, not one per request.
- **An unreadable file is tried again on every request**, because permissions can be fixed without changing its identity.
- **A valid file puts everything right** on the next request.

## Headers

On every response, a `400` for a malformed request included:

| Header                         | Value                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Content-Security-Policy`      | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options`       | `nosniff`                                                                                                                                                                                        |
| `Referrer-Policy`              | `no-referrer`                                                                                                                                                                                    |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                                                                                                                                                                    |
| `Cross-Origin-Resource-Policy` | `same-origin`                                                                                                                                                                                    |
| `Permissions-Policy`           | every powerful feature off, each by name: camera, microphone, geolocation, payment, USB and the rest                                                                                             |
| `X-Frame-Options`              | `DENY`, for browsers older than `frame-ancestors`                                                                                                                                                |

And on every `/api/` response, `/health` and `/version`, `Cache-Control: no-store`. HSTS is the front door's ([infra.md](infra.md)).

**The Content Security Policy is what makes browser libraries acceptable**, so loosening it is a design change, not a fix. No inline script and no inline `<style>` is allowed: a library that needs either is not used. Styles set by script through the DOM are not affected.

## Logging

- **One line per request**: `request method=<method> route=<pattern> status=<n> ms=<n>`. The route's pattern, such as `/api/accounts/:key`, never its path.
- **Events are fixed texts** from the server's own code: `login ok`, `login refused`, `login limited`, `login queue full`, `configuration invalid, refusing requests`, `session secret invalid, refusing requests`, `malformed request refused`, `request timeout`, `headers too large`, `failed <ErrorClass>`.
- **The startup line** is `serving port=<n> revision=<commit> people=<n> accounts=<n>`.
- **Never** a username, a person's key, a password, a hash, a cookie, a token, a request body or anything from the archive, here as everywhere. The leak test holds the server to this ([testing.md](testing.md)).

## Kept apart from the sync

The server must never be able to reach a bank, and the sync must never be reachable from the internet, even with the server compromised: code running as the server, with everything the server's container holds. Most of that is the host's declaration ([infra.md](infra.md)), not this code, so this says what each side guarantees.

**What a compromised server holds.** The archive, read-only, for both people; the configuration, read-only, with the password hashes in it; the session secret. With those it can read and send out bank data, which is why the archive's mount and the lens are not the last line. What it does not hold:

- **No Enable Banking credentials.** Every call to Enable Banking is signed with the application's private key, and the bank session is in the sync's state. The web container gets neither: no `EB_*` variable, no state volume. The sync's code is in the image too, but without the key and the session it cannot sign a request or name a session.
- **A tripwire in the server.** `money serve` refuses to start when any `EB_*` variable or `STATE_DIR` is in its environment. That catches the likeliest mistake on the host: a web container given the app's one shared environment file, which holds the key. The image sets neither `DATA_DIR` nor `STATE_DIR` for the same reason: the web container inherits the image's environment.
- **No path to the sync.** The sync container listens on nothing, and its commands are run by the host. Nothing the server can write is read by the sync: the archive and the configuration are mounted read-only into the web container, and the sync never mounts `APP_DATA_DIR`.
- **No more than a non-root process gets.** The container runs as uid 1000, and infra hardens it further ([infra.md](infra.md)).

## Commands

`money` sends `serve`, `hash-password` and `rotate-session-secret` to `server/src/cli.ts`, and everything else to the sync. Each exits 0, or 1 with a message that says what to do; an unknown command prints the sync's usage, and no command prints it and the server's.

| Command                 | Does                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `serve`                 | Checks the settings, the directories, the configuration and the secret, then serves. |
| `hash-password`         | Prints a password hash for the configuration. See Login.                             |
| `rotate-session-secret` | Writes a new session secret, logging everyone out.                                   |

`server/src/cli.ts` is the server's only edge, as `sync/src/cli.ts` is the sync's: it supplies the environment, the clock, the filesystem, the terminal and the port, and is not run by any test.

## Changing a username or password

1. Generate the new username or password in the password manager.
2. For a new password, run `node server/src/cli.ts hash-password` on your own machine, and paste the password when asked.
3. Put the username, or the printed hash, in the person's entry in the configuration in infra's vault, and deploy the configuration as infra's runbook says.
4. Nothing else. The server sees the new file without a restart, and that person's sessions end, because their signing key is derived from their username and their hash. The other person stays logged in.

## Storing what people write

Budgets, pots, a year plan, ownership of transactions and per-person settings are coming, with two people editing at once. The mechanics of concurrency are settled: the server is the only writer, puts its writes in one queue and writes by temporary file and rename, and every save names the version it was based on and is refused when it is stale. The store is not settled. The lean is small JSON documents, each with its own version, so that two people editing different budgets never conflict. What would change it to SQLite, which Node ships as `node:sqlite`, is a model that turns out relational, ownership of transactions being the likely first case, or a change that must save several things together. It is decided with the screens.

## Categories

Every transaction has exactly one category, so the totals per category add up to the whole. The category is not stored anywhere. It is computed from the rules, every time.

```text
category = first rule, in order, whose conditions all match
           otherwise "uncategorised"
```

- **Rules are an ordered list**, and the order is the user's to set. The first match wins. A specific rule placed above a general one is how exceptions are made.
- **Uncategorised is a first-class category**, shown prominently. It is the to-do list for writing rules.
- **Nothing is built in.** A transfer between two of the user's own accounts is not special to this app. It is a rule like any other: "counterparty account is one of these, category `transfer`". Categorising has no idea which accounts are whose.
- **Every assignment can be explained.** Next to a transaction's category, the app shows the rule that gave it.

### A rule

```json
{
  "id": "r-0042",
  "name": "Groceries",
  "category": "groceries",
  "match": {
    "accounts": ["bnka-joint"],
    "direction": "out",
    "counterparty_name": "albert heijn|jumbo|lidl",
    "amount_max": 30000
  }
}
```

All conditions in `match` must hold. An empty `match` matches everything, which makes a useful last rule.

| Condition               | Matches when                                               |
| ----------------------- | ---------------------------------------------------------- |
| `accounts`              | the account key is in the list                             |
| `direction`             | `"in"` or `"out"`, by the sign of the amount               |
| `counterparty_name`     | the regular expression matches, ignoring case              |
| `counterparty_accounts` | the counterparty account is in the list, exactly           |
| `description`           | the regular expression matches, ignoring case              |
| `amount_min`            | the absolute amount is at least this, in the smallest unit |
| `amount_max`            | the absolute amount is at most this                        |
| `date_from`, `date_to`  | the booking date is in the range, inclusive                |
| `transactions`          | the identity is in the list                                |

`transactions` is what makes bulk tagging by hand work without a second mechanism: selecting rows in a table and giving them a category creates one rule that lists them.

### Storing rules

- One file, `APP_DATA_DIR/rules.json`: the ordered list and a version number.
- Written to a temporary file and renamed, like the archive.
- A save names the version it was based on. If someone else saved in between, it is refused and nothing is lost. Two people editing at once is the normal case here, not an edge case.
- A rule with an invalid regular expression is refused on save.
- The file is backed up with `APP_DATA_DIR`. See [infra.md](infra.md).

Rules hold names of people and employers. They are private data and never belong in this repository.

### Computing categories

Categorising is a pure function of the rules and the normalised view. The server keeps the result in memory and recomputes it when either input changes:

- at start;
- when a year file has changed, checked cheaply by modification time;
- when rules are saved.

So a rule change takes effect on save, and the nightly sync needs no hook into the app. Nothing is cached on disk. At the size this archive can reach, the whole computation takes about as long as a page load. If that stops being true, a cache is added then.

Before saving, the editor previews the change: how many transactions move, and from which category to which. With ordered rules, the effect of moving one is otherwise hard to predict.

## Screens

What the screens show is decided with the UX work. Planned so far:

- A transaction table with filter, sort and group by account, category, counterparty, month and year.
- Totals and charts over time, per category and per account.
- The rules editor, with reordering and the preview.

## The client

- **Runs in the browser, and may use libraries**: for tables, charts and the editor. Which ones is decided in the slices that build it. The list stays short; see [architecture.md](architecture.md).
- **Bundled at build time into static files**, which the server serves from `CLIENT_DIR`. This is the only part of the project with a build step.
- **Confined by the Content Security Policy** the server sends: scripts, styles and requests from and to its own origin only, with no inline script.
- **Categorising can run here too**, because `shared` does. That is what lets the rules editor preview a change without saving it.

Still undecided, and settled with the screens: whether filtering and grouping run in the browser over the person's whole normalised view, or on the server per request.

## Development

`npm run server` runs the real server over the synthetic archive and configuration in `fixtures/`, with `APP_DATA_DIR` and `CLIENT_DIR` under `tmp/dev/`, on port 8080, with `REVISION=dev`. The session secret is made on the first run. It passes the server only its own variables, so a bank credential in the developer's shell never reaches it. The fixture configuration's two invented people log in with:

| Person | Username           | Password                |
| ------ | ------------------ | ----------------------- |
| `mila` | `fx-mila-Qp2w9Lz7` | `fixture password mila` |
| `tom`  | `fx-tom-Hk4r8Vn2`  | `fixture password tom`  |

`mila` owns every account; `tom` owns the joint accounts and the cards. Real data is never needed and never available.
