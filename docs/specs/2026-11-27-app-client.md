# Spec: the app client

Slice 5b of the build order in [architecture.md](../architecture.md), the second of the three that slice 5 was split into on 2026-11-27. Written 2026-11-27, together with [the app server's spec](2026-11-27-app-server.md), which it builds on. Once the slice has shipped this file is history and is not kept up to date.

## Goal

The browser half of the app's technical foundation: a `client` workspace, its bundler and UI library, and an empty shell that is already phone-first, themed, accessible and inside the server's Content Security Policy. A login page, an empty page behind it, and a place at the top where a lens switcher will go. The image builds it in a stage of its own, and one command runs server and client together against the synthetic archive.

After this slice a person can log in on a phone, see an empty page with their name and a logout, switch between light and dark, and log out. The whole path, browser to server, gets a second security review before the front door routes to it.

## Why now

The screens wait for the UX work. What they will be built on does not: the bundler, the library, the scaling and theming model, the fonts, how the shell talks to the server, and the image's build stage. Getting those right is slow, careful work that no screen should have to wait for.

## Decisions

### Bundler: esbuild

- **One development package, `esbuild`**, with the platform binary it installs as an optional dependency. MIT.
- It compiles TypeScript and JSX, bundles CSS with CSS Modules built in (`local-css`), and names files by content hash. Nothing else is needed for the shell.
- **There is no HTML pipeline.** A short build script, `client/build.ts`, run by Node like everything else, calls esbuild and writes `index.html` with the hashed names. No plugin.
- **Development is watch and rebuild, with a manual reload.** No hot reload. Vite would bring it, with a few dozen packages under it.

### UI library: React 19

- **`react` and `react-dom`** at runtime, which bring `scheduler`. **`@types/react` and `@types/react-dom`** for development. All MIT.
- Chosen over Preact because 5c is expected to want headless widgets in the manner of Radix, which needs React proper. Changing library after the screens exist would cost more than the difference in size does now.
- **No widget library in this slice.** The shell has nothing that needs one. When 5c adds one, it is wrapped once in the client, and styled entirely by our CSS, as foerier does.
- Versions are pinned exactly in `client/package.json`, at the current stable release when they are installed.
- **The owner approved these five packages on 2026-11-27**, in the conversation this spec came from: `esbuild`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, with esbuild's platform binaries as its optional dependencies; and `eslint-plugin-react-hooks` on 2026-11-28. That is the approval CLAUDE.md asks for, for these six and nothing else.

### Linting React, from the start

- **`eslint-plugin-react-hooks`**, a development dependency from the React team, MIT, with no dependencies of its own beyond what ESLint brings. Its recommended rules: the rules of hooks, and the React Compiler's checks of what a component may do while it renders.
- **Not `eslint-plugin-react`.** It catches a missing `key` and a few JSX slips, but brings several dozen small packages with it. Type-checking covers most of what it checks, and React warns about a missing `key` in development, which `npm run dev` runs.
- **Formatting is not linted.** Prettier is enforced already, on the whole repository, by `npm run format:check` in the pre-commit hook and in CI, and an unformatted file fails both. Running Prettier again inside ESLint would be a second dependency for the same check. The client's files are simply inside what Prettier checks.

### No other dependency

No router, no state library, no CSS framework, no component-test library, no font package. Each would be a request to the owner, in 5c or later, when a screen shows the need.

### Filtering and grouping run in the browser

This settles the open question in [app.md](../app.md). The app must feel instant, and a round trip per filter does not. The server sends a person their whole view, already cut to their lens, and the browser filters, sorts and groups it. That is safe only because the server never sends anything outside the lens ([the server's spec](2026-11-27-app-server.md)). Categorising already runs in the browser through `shared`. The functions themselves are 5c's.

## The frontend's principles

Adopted from foerier's frontend design, without its technology choices. Each is built into the shell now, so that every screen inherits it.

- **Phone-first.** The shell is designed at 360 px and widens from there. Breakpoints are in `em`, so a reader who enlarges text crosses them at the right point.
- **Text respects the reader.** `:root { font-size: 100% }`, no 62.5 % trick. The global grid (type, spacing, radii) is `rem`; a component's own internals are `em`. Nothing is sized in `px` except borders and the touch floor.
- **Tokens as custom properties**, in three layers: primitive (the scale), semantic (intent, and the only layer that changes with the theme), and component (only where a component needs a knob).
- **CSS in declared cascade layers**: reset, tokens, base, layout, components, utilities. Hand-written CSS Modules; no utility framework, no CSS-in-JS. Runtime-injected `<style>` is outside the CSP anyway.
- **Components adapt to the width they are given**, through container queries, and fail open to one column where those are not supported.
- **Touch targets: 44 px at least, 48 px aimed for**, on the hit area and not the painted box. A control drawn smaller keeps its drawn size and grows a hit area that does not paint, clamped to its row.
- **Light and dark follow `prefers-color-scheme`**, with an override (system, light, dark) remembered on the device in `localStorage`. A `data-theme` attribute on `<html>` repoints the semantic layer. Reading and writing it never throws: in a private window, or with storage blocked, the system setting simply wins.
- **No flash of the wrong theme, and no inline script.** A tiny same-origin script, loaded in `<head>` before the stylesheet, sets `data-theme` from storage before the first paint. Everything else loads as a module.
- **Reduced motion is respected**, and fails open: under `prefers-reduced-motion: reduce` transitions and animations stop; with no preference or no support, the page works the same, only with motion.
- **Fail open, not broken.** Feature queries guard anything newer; a missing feature leaves a plainer page, never a broken one. A one-line `<noscript>` says the app needs JavaScript.
- **Self-hosted fonts.** A variable `woff2` committed to the repository with its licence, served from the app's own origin, `font-display: swap`, with a fallback adjusted to the same metrics so the swap does not shift the layout. Nothing from a CDN. The CSP would refuse it anyway.
- **Inter** for now: it is under the SIL Open Font License, and it has tabular figures, so amounts line up in columns. The typeface itself is a visual decision for the UX work, and swapping it is a file and a name.

## What gets built

| Part                     | Does                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `client/`                | The workspace: the shell, its styles, its font, `build.ts`.                         |
| `client/src/api.ts`      | Talks to the server, with `fetch` passed in.                                        |
| `Dockerfile`             | A first stage that bundles the client; the image takes its output and nothing else. |
| `scripts/check-image.sh` | The web container serves the client, under the CSP.                                 |
| `scripts/dev.ts`         | `npm run dev`: server and client together, against the synthetic archive.           |
| `tsconfig.json`          | The client is type-checked with the DOM's types, and the server without them.       |

### The shell

- **On load,** the client asks `GET /api/session`. A `401` shows the login page; a session shows the empty page.
- **The login page.** A name and a password, labelled, with `autocomplete="username"` and `autocomplete="current-password"`, so a password manager fills them. A wrong password and an unknown name show the same message. A `429` says when to try again, from `Retry-After`. Submitting is a `fetch`, not a form post: the server takes JSON only.
- **The empty page.** A top bar holding, from left to right: the slot for the lens switcher, empty but in place and sized; the person's name; the theme control; logout. Below it, an empty main area with one line saying the screens are coming.
- **The lens slot** is a component with a fixed place in the layout and nothing in it. What goes there is 5c's.
- **Logout** posts with the CSRF token from the session, and returns to the login page. So does any `401` from the server, such as after a rotated secret.
- **No router.** Two states, one URL. Routes arrive with the screens.
- **Every request** goes to the same origin, with `credentials: "same-origin"` and, for a `POST`, `Content-Type: application/json` and the token.

### The build

- **`npm run build:client`** writes `client/dist/`: `index.html`, one script bundle, one stylesheet, the font, and the small theme script, every name but `index.html` carrying its content hash. `client/dist/` is ignored by git.
- **`index.html` holds no inline script and no inline style**, and references only files under its own origin.
- **Source maps are shipped**, beside the files they map, and served like them. A bug seen in production can then be read in the browser's tools as the source it came from. The repository is public, so a map reveals nothing that is not already there. The CSP is unaffected.

### The image

Two stages from now on, as [infra.md](../infra.md) foresaw.

- **The first stage** installs the development tools and the client's dependencies, and runs `npm run build:client`. Nothing of it reaches the image except `client/dist/`.
- **The second stage** is today's image, which takes `client/dist/` into `/app/client`. Its `node_modules` still holds only `@money`: React is bundled into the client's files and is not installed in the image. The server still has no third-party code at all.
- **The server refuses to start** when `CLIENT_DIR` has no `index.html`.

`scripts/check-image.sh` gains: `/` answers `200` with `index.html` and the CSP; every script and stylesheet `index.html` names is served with its content type; `index.html` holds no inline script or style; `/app/client` holds the built files and nothing else.

### Local development

- **`npm run dev`** runs the client's build in watch mode and the server under `node --watch`, against `fixtures/archive/` and `fixtures/config.json`, with `APP_DATA_DIR` at `tmp/dev/app-data/`. It creates that directory and its session secret the first time, through `money rotate-session-secret`, and says so.
- It listens on `http://localhost:8080`. Browsers treat `localhost` as secure, so the `__Host-` cookie works there without TLS. Safari is checked during the build; if it refuses, the README says to use another browser for development, and the cookie is not weakened.
- **The fixture people's passwords are written in the README.** They are invented, and the archive they unlock is too. The generator writes their hashes.
- The README documents the command, the address, the two logins, and that a reload is needed after a change.

## Tests

- **Tier 1, with `node:test`:** the theme choice from a stored value and the system preference, including storage that throws; the API module against a fake `fetch` (a `401`, a `429` with its `Retry-After`, the CSRF header on a `POST`, an unexpected shape refused); the lens slot's empty state if it holds logic. The client's pure modules sit beside their tests as everywhere else, and run under `npm test` with the timezone pinned.
- **The build, over the real server:** build the client into a temporary directory, serve it with the real server, and assert that `index.html` holds no inline script or style, that every file it names is served with the right content type and the CSP, and that hashed files are cached as immutable and `index.html` is not.
- **The dependency rule** still holds for `server`, `sync` and `shared`; `client` is the one workspace with runtime dependencies, and the test names them, so a new one fails until it is added on purpose.
- **In a browser, by hand,** before the review: at 360 px and on a desktop; at 200 % text size; in light, dark and both overrides; with reduced motion; with storage blocked; with JavaScript off; with a password manager filling the login. The console shows no CSP violation. The builder runs what a browser tool can reach; the owner runs what needs their own devices: a real phone, Safari, and the password manager. Both happen before the security review, and the plan stops for the owner's part.

No component-test library and no browser automation in this slice. Tier 3 and Tier 5 of [testing.md](../testing.md) arrive when there are screens worth them, and each would be a dependency asked for first.

## The second security review

After this slice is built and before it is merged: a code review, and a `/security-review` that looks at the whole path. The bundle as served, under the real CSP, in a real browser; the cookie as the browser holds it; the login and logout as the page makes them; what the served files reveal. Only after it passes does the front door get a route to the web container ([the server's spec](2026-11-27-app-server.md), "Deployment").

## Departures and additions

Written into the durable documents before the slice is done:

- **[architecture.md](../architecture.md):** the status line; the client's dependencies in the dependency table.
- **[app.md](../app.md):** the bundler and the library; filtering and grouping in the browser, the open question closed; the shell; the frontend's principles, in short.
- **[infra.md](../infra.md):** the two-stage image.
- **[testing.md](../testing.md):** the client's tests and the build test; Tier 3 still later.
- **`README.md`, `CLAUDE.md`:** `npm run dev`, the fixture logins, the development dependencies list.

## Not in this slice

- **Screens, routes, tables, charts, widgets.** 5c.
- **Any data the app stores**, and the rules editor. 5c and 6.
- **An installable app or offline use.** Not asked for; a service worker would change what the CSP and the caching have to say.

## Left open

- **A thin Android app around the client.** The owner may wrap the client in a native Android shell: a WebView that opens the app's own address, plus notifications. The name `client` still fits: there would still be one client, the web one, and the Android app would be a frame around it, in a folder of its own, reaching the same origin like any browser. Nothing in this slice blocks it. The WebView loads the page at the top level, so the `__Host-` cookie, `SameSite=Strict`, `frame-ancestors 'none'` and the CSP all hold as they do in a browser. Two things are for its own spec: where a notification comes from (pushed through a phone platform's service, or fetched by the app from the server), and the rule that **no bank data ever goes into a notification that passes through a third party**, since that service is outside the EU boundary. An installable web app with Web Push is the lighter alternative, and the same rule applies to it.
- **Subsetting the font** to Latin would cut its size by about half, but needs a font tool. The whole file is served until a screen shows the cost matters.
