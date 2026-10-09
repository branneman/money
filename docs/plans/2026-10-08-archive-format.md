# Archive Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the archive format into code as tested pure functions in a new `shared` workspace, regenerate the synthetic archive in the per-account layout, and add the first CI workflow.

**Architecture:** The repository becomes npm workspaces. `@money/shared` holds the record types, `merge`, year-file rendering and parsing, configuration validation, the normalised view, and one Node-only entry (`@money/shared/node`) that reads and writes an archive directory. The fixture generator is split into a simulation of a household, a description of its accounts, and a step that feeds the result through the real `merge` and file rendering.

**Tech Stack:** Node.js ≥ 24.12 running TypeScript directly (type stripping, no build), `node:test`, `node:assert/strict`, ESLint with `typescript-eslint`, Prettier, GitHub Actions. No runtime dependencies.

**Spec:** [docs/specs/2026-10-08-archive-format.md](../specs/2026-10-08-archive-format.md). The contract it implements is [docs/archive-format.md](../archive-format.md). Read both, and `CLAUDE.md`, before starting.

## Global Constraints

- **No runtime dependencies** in `shared`. Its `package.json` has no `dependencies` at all. No new development dependency either.
- **Erasable TypeScript only:** no `enum`, `namespace`, parameter properties. Relative imports carry the `.ts` extension. Type-only imports use `import type` or an inline `type` modifier.
- **`shared`'s main entry (`shared/src/index.ts`) must not import any `node:` module.** Only `shared/src/archive/store.ts` and test files may.
- **Pure functions.** `merge` takes the current time as an argument. Nothing in `shared/src` reads the clock or calls `Math.random`.
- **No bank is named anywhere:** code, tests, fixtures, commit messages. Made-up banks are `bnka` and `bnkb`. No column header from a real bank's export.
- **Every invented IBAN has check digits `00`** (`NL00...`).
- **Error messages and logs contain keys, dates and counts only.** Never an amount, an account number, a name or a description. An identity (`account/source/id`) is a key and is allowed.
- **Account keys match `[a-z0-9-]+`.**
- **Year files:** a JSON array, two-space indentation, trailing newline, sorted by `date` then `id`.
- **Record key order:** `account`, `source`, `id`, `format` (import only), `date`, `first_seen`, `revisions`, `raw`.
- **Import format encodings:** exactly `utf-8`, `windows-1252`, `iso-8859-15`.
- **Tests run through `npm test`**, which pins `TZ=Europe/Amsterdam`. Never a bare `node --test`.
- **Conventional commits**, `type(scope): message`. Scopes used here: `shared`, `fixtures`, `tooling`.
- **Work on a branch** named `archive-format`. Integrate by rebase, local fast-forward, full suite on `main`, then push, as `CLAUDE.md` describes. Never `--no-verify`.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task named.

1. **An amount with a thousands separator** (`1.234,56`) must be an error, never read as a smaller or larger number. Task 6.
2. **A currency without two decimals** (`JPY` has none, `KWD` has three) must give the right integer. Task 6.
3. **An API record where optional fields are absent, not null,** must normalise to nulls and an empty description, not throw. Task 6.
4. **A revision that moves a record into another year** must leave it in exactly one file, and remove a year file it emptied. Tasks 3, 4 and 8.
5. **Things in an archive directory that are not the archive** (`.inbox/`, `.DS_Store`, a leftover temporary file, a directory that is not a valid account key) must be skipped when dot-prefixed and reported otherwise. Task 8.

## File Structure

```text
package.json                          modify: workspaces, scripts
tsconfig.json                         modify: include
eslint.config.js                      modify: test file glob
.prettierignore                       modify: fixtures/config.json
.github/workflows/ci.yml              create
scripts/
  workspaces.ts                       create: link check and dependency rule, pure
  workspaces.test.ts                  create
  check-workspaces.ts                 create: the command
shared/
  package.json                        create
  src/
    index.ts                          create: the browser-safe entry
    util/equal.ts (+ .test.ts)        create: deepEqual
    util/dates.ts (+ .test.ts)        create: isIsoDate, isTimestamp, parseDate
    util/amounts.ts (+ .test.ts)      create: minorUnits, parseAmount
    archive/record.ts (+ .test.ts)    create: types, identity, checkRecord
    archive/merge.ts (+ .test.ts)     create
    archive/files.ts (+ .test.ts)     create: renderYearFiles, parseYearFile
    archive/normalise.ts (+ .test.ts) create
    archive/view.ts (+ .test.ts)      create
    archive/convergence.test.ts       create: property tests
    archive/store.ts (+ .test.ts)     create: Node only
    config/config.ts (+ .test.ts)     create
  testing/
    index.ts                          create
    factories.ts                      create
    random.ts                         create: seeded PRNG
fixtures/
  dates.ts                            create: moved out of generate.ts
  world.ts                            create: accounts, formats, config
  household.ts                        rename from generate.ts, edited
  generate.ts                         create: postings -> arrivals -> archive
  archive.test.ts                     rename from test/fixtures.test.ts, rewritten
  config.json                         generated
  archive/                            regenerated
```

---

### Task 1: Workspaces, the link check and the dependency rule

**Files:**

- Create: `shared/package.json`, `shared/src/index.ts`, `scripts/workspaces.ts`, `scripts/workspaces.test.ts`, `scripts/check-workspaces.ts`
- Modify: `package.json`, `tsconfig.json`, `eslint.config.js`
- Rename: `test/fixtures.test.ts` to `fixtures/archive.test.ts`

**Interfaces:**

- Produces: the package `@money/shared`; `npm run check:workspaces`; a test glob covering `shared/`, `fixtures/` and `scripts/`.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b archive-format
```

- [ ] **Step 2: Create the `shared` workspace**

`shared/package.json`:

```json
{
  "name": "@money/shared",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./node": "./src/archive/store.ts",
    "./testing": "./testing/index.ts"
  }
}
```

`shared/src/index.ts`:

```ts
// The browser-safe entry. Nothing exported from here may import a `node:` module.
export {};
```

- [ ] **Step 3: Point the root at it**

In `package.json`, add `"workspaces": ["shared"]` after `"engines"`, and set these scripts (keep `lint`, `format`, `format:check`, `fixtures`, `prepare` as they are):

```json
"check:workspaces": "node scripts/check-workspaces.ts",
"typecheck": "npm run check:workspaces && tsc --noEmit",
"test": "TZ=Europe/Amsterdam node --test 'shared/**/*.test.ts' 'fixtures/**/*.test.ts' 'scripts/**/*.test.ts'"
```

In `tsconfig.json`, set `"include": ["shared", "fixtures", "scripts"]`.

In `eslint.config.js`, change `files: ["test/**/*.ts"]` to `files: ["**/*.test.ts"]`.

Move the existing test, and fix its import:

```bash
git mv test/fixtures.test.ts fixtures/archive.test.ts
```

In `fixtures/archive.test.ts`, change both `"../fixtures/generate.ts"` to `"./generate.ts"`.

- [ ] **Step 4: Install, so the workspace is linked**

Run: `npm install`
Expected: `node_modules/@money/shared` exists and is a symlink to `../../shared`.

- [ ] **Step 5: Write the failing tests**

`scripts/workspaces.test.ts`:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { dependencyProblems, linkProblems, readWorkspaces } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";

const ROOT = join(import.meta.dirname, "..");
const shared: Workspace = { dir: "shared", name: "@money/shared", dependencies: {} };
const same = (path: string): string => path;

test("a workspace linked into this tree has no problem", () => {
  const resolve = (): string => "/repo/shared";
  assert.deepEqual(linkProblems("/repo", [shared], resolve, same), []);
});

test("a workspace that is not installed here is reported, with the fix", () => {
  const problems = linkProblems("/repo", [shared], () => null, same);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@money\/shared is not linked in this working tree/);
  assert.match(problems[0], /npm ci/);
});

test("a workspace that resolves into another checkout is reported", () => {
  const problems = linkProblems("/repo/worktree", [shared], () => "/repo/shared", same);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /resolves to \/repo\/shared/);
});

test("a server workspace may depend on other workspaces only", () => {
  const ok: Workspace = {
    dir: "sync",
    name: "@money/sync",
    dependencies: { "@money/shared": "*" },
  };
  const bad: Workspace = { dir: "api", name: "@money/api", dependencies: { leftpad: "^1.0.0" } };
  assert.deepEqual(dependencyProblems([shared, ok]), []);
  assert.match(dependencyProblems([bad])[0], /@money\/api depends on leftpad/);
});

test("the browser workspace is not held to the server rule", () => {
  const app: Workspace = { dir: "app", name: "@money/app", dependencies: { anything: "1" } };
  assert.deepEqual(dependencyProblems([app]), []);
});

test("this repository obeys the dependency rule", () => {
  const workspaces = readWorkspaces(ROOT);
  assert.ok(workspaces.some((workspace) => workspace.dir === "shared"));
  assert.deepEqual(dependencyProblems(workspaces), []);
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `npm test`
Expected: FAIL, cannot find module `./workspaces.ts`.

- [ ] **Step 7: Implement**

`scripts/workspaces.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Workspace = { dir: string; name: string; dependencies: Record<string, string> };

export const readWorkspaces = (root: string): Workspace[] => {
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  return (rootPackage.workspaces ?? []).map((dir) => {
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    return { dir, name: manifest.name, dependencies: manifest.dependencies ?? {} };
  });
};

// A git worktree without its own install resolves workspace packages up into the main
// checkout. Nothing errors, and every check then judges the wrong source tree.
export const linkProblems = (
  root: string,
  workspaces: readonly Workspace[],
  resolve: (name: string) => string | null,
  realPath: (path: string) => string,
): string[] =>
  workspaces.flatMap(({ dir, name }) => {
    const expected = realPath(join(root, dir));
    const actual = resolve(name);
    if (actual === null) return [`${name} is not linked in this working tree. Run npm ci here.`];
    if (actual !== expected) {
      return [
        `${name} resolves to ${actual}, not to ${expected}. Run npm ci in this working tree.`,
      ];
    }
    return [];
  });

// Code that runs on the server, next to bank data. See docs/architecture.md, Dependencies.
const SERVER_WORKSPACES = ["shared", "sync", "api"];

export const dependencyProblems = (workspaces: readonly Workspace[]): string[] =>
  workspaces
    .filter((workspace) => SERVER_WORKSPACES.includes(workspace.dir))
    .flatMap((workspace) =>
      Object.keys(workspace.dependencies)
        .filter((dependency) => !dependency.startsWith("@money/"))
        .map(
          (dependency) =>
            `${workspace.name} depends on ${dependency}. Server workspaces may depend on other workspaces only.`,
        ),
    );
```

`scripts/check-workspaces.ts`:

```ts
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { linkProblems, readWorkspaces } from "./workspaces.ts";

const root = join(import.meta.dirname, "..");
const resolve = (name: string): string | null => {
  const path = join(root, "node_modules", name);
  return existsSync(path) ? realpathSync(path) : null;
};

const problems = linkProblems(root, readWorkspaces(root), resolve, realpathSync);
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
```

- [ ] **Step 8: Run everything**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: all pass. The test report lists the six new tests and the seven existing fixture tests. The `shared/**` pattern matches nothing yet, which the test runner accepts.

- [ ] **Step 9: Prove the link check can fail**

```bash
mv node_modules/@money/shared /tmp/shared-link && npm run check:workspaces; mv /tmp/shared-link node_modules/@money/shared
```

Expected: `@money/shared is not linked in this working tree. Run npm ci here.` and a non-zero exit, then the link is restored. Run `npm run check:workspaces` again: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore(tooling): npm workspaces, the link check and the dependency rule"
```

---

### Task 2: Utilities and the record

**Files:**

- Create: `shared/src/util/equal.ts`, `shared/src/util/equal.test.ts`, `shared/src/util/dates.ts`, `shared/src/util/dates.test.ts`, `shared/src/archive/record.ts`, `shared/src/archive/record.test.ts`, `shared/testing/factories.ts`, `shared/testing/index.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**

- Produces:
  - `deepEqual(a: unknown, b: unknown): boolean`
  - `isIsoDate(text: string): boolean`, `isTimestamp(text: string): boolean`
  - `DATE_FORMATS`, `type DateFormat`, `parseDate(text: string, format: DateFormat): string | null`
  - types `Source`, `ApiRaw`, `ImportRaw`, `Revision`, `ApiRecord`, `ImportRecord`, `ArchiveRecord`
  - `ACCOUNT_KEY: RegExp`, `class ArchiveError extends Error`
  - `identityOf(record: { account: string; source: Source; id: string }): string`
  - `checkRecord(value: unknown, where: string): ArchiveRecord` (throws `ArchiveError`)
  - factories `anApiRaw`, `anImportRaw`, `anApiRecord`, `anImportRecord`

- [ ] **Step 1: Write the failing tests**

`shared/src/util/equal.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { deepEqual } from "./equal.ts";

test("equal values are equal whatever their key order", () => {
  assert.ok(deepEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }));
});

test("differences at any depth are seen", () => {
  assert.ok(!deepEqual({ a: [1, 2] }, { a: [1, 3] }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!deepEqual([1], { 0: 1 }));
  assert.ok(!deepEqual(null, {}));
  assert.ok(!deepEqual("1", 1));
});
```

`shared/src/util/dates.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { isIsoDate, isTimestamp, parseDate } from "./dates.ts";

test("a real calendar date is accepted", () => {
  assert.ok(isIsoDate("2024-02-29"));
});

test("a date that does not exist is rejected", () => {
  assert.ok(!isIsoDate("2025-02-29"));
  assert.ok(!isIsoDate("2025-13-01"));
  assert.ok(!isIsoDate("2025-1-1"));
  assert.ok(!isIsoDate("2025-01-01T00:00:00Z"));
});

test("only UTC timestamps are accepted", () => {
  assert.ok(isTimestamp("2026-10-07T03:00:00Z"));
  assert.ok(isTimestamp("2026-10-07T03:00:00.123Z"));
  assert.ok(!isTimestamp("2026-10-07T03:00:00+02:00"));
  assert.ok(!isTimestamp("2026-10-07"));
});

test("each supported notation parses to an ISO date", () => {
  assert.equal(parseDate("2025-12-31", "YYYY-MM-DD"), "2025-12-31");
  assert.equal(parseDate("31-12-2025", "DD-MM-YYYY"), "2025-12-31");
  assert.equal(parseDate("31/12/2025", "DD/MM/YYYY"), "2025-12-31");
  assert.equal(parseDate("20251231", "YYYYMMDD"), "2025-12-31");
});

test("text in another notation, or an impossible date, is null", () => {
  assert.equal(parseDate("31-12-2025", "YYYY-MM-DD"), null);
  assert.equal(parseDate("30-02-2025", "DD-MM-YYYY"), null);
  assert.equal(parseDate("", "YYYYMMDD"), null);
});
```

`shared/src/archive/record.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRecord, anImportRecord } from "../../testing/factories.ts";
import { ArchiveError, checkRecord, identityOf } from "./record.ts";

test("identity is account, source and id", () => {
  assert.equal(identityOf(anApiRecord({ account: "bnka-joint", id: "7" })), "bnka-joint/api/7");
  assert.equal(identityOf(anImportRecord({ account: "bnka-card", id: "7" })), "bnka-card/import/7");
});

test("a well-formed record of either source passes", () => {
  assert.deepEqual(checkRecord(anApiRecord(), "here"), anApiRecord());
  assert.deepEqual(checkRecord(anImportRecord(), "here"), anImportRecord());
});

test("a record keeps its key order", () => {
  assert.deepEqual(Object.keys(anApiRecord()), [
    "account",
    "source",
    "id",
    "date",
    "first_seen",
    "revisions",
    "raw",
  ]);
  assert.deepEqual(Object.keys(anImportRecord()), [
    "account",
    "source",
    "id",
    "format",
    "date",
    "first_seen",
    "revisions",
    "raw",
  ]);
});

const broken: [string, unknown, RegExp][] = [
  ["not an object", [], /is not an object/],
  ["a bad account key", { ...anApiRecord(), account: "Bnka Joint" }, /account/],
  ["an unknown source", { ...anApiRecord(), source: "csv" }, /source/],
  ["an empty id", { ...anApiRecord(), id: "" }, /id/],
  ["an impossible date", { ...anApiRecord(), date: "2025-02-30" }, /date/],
  ["a first_seen that is not UTC", { ...anApiRecord(), first_seen: "2025-01-01" }, /first_seen/],
  ["revisions that are not a list", { ...anApiRecord(), revisions: {} }, /revisions/],
  [
    "a revision without raw",
    { ...anApiRecord(), revisions: [{ replaced_at: "2025-01-03T03:00:00Z" }] },
    /revisions/,
  ],
  ["a raw that is not an object", { ...anApiRecord(), raw: "x" }, /raw/],
  ["an import record without a format", { ...anImportRecord(), format: undefined }, /format/],
  ["an import cell that is not text", { ...anImportRecord(), raw: { Amount: 10 } }, /raw/],
];

for (const [name, value, message] of broken) {
  test(`a record with ${name} is rejected, naming where`, () => {
    assert.throws(
      () => checkRecord(value, "bnka-joint/api/2025.json, record 3"),
      (error: unknown) =>
        error instanceof ArchiveError &&
        message.test(error.message) &&
        error.message.startsWith("bnka-joint/api/2025.json, record 3"),
    );
  });
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the utilities**

`shared/src/util/equal.ts`:

```ts
// Structural equality for JSON-like values. Key order does not matter.
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
};
```

`shared/src/util/dates.ts`:

```ts
export const isIsoDate = (text: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  // An impossible date either fails to parse or rolls over into the next month.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
};

export const isTimestamp = (text: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text) && isIsoDate(text.slice(0, 10));

export const DATE_FORMATS = {
  "YYYY-MM-DD": /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})$/,
  "DD-MM-YYYY": /^(?<d>\d{2})-(?<m>\d{2})-(?<y>\d{4})$/,
  "DD/MM/YYYY": /^(?<d>\d{2})\/(?<m>\d{2})\/(?<y>\d{4})$/,
  YYYYMMDD: /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/,
} as const;

export type DateFormat = keyof typeof DATE_FORMATS;

export const parseDate = (text: string, format: DateFormat): string | null => {
  const groups = DATE_FORMATS[format].exec(text)?.groups;
  if (groups === undefined) return null;
  const date = `${groups.y}-${groups.m}-${groups.d}`;
  return isIsoDate(date) ? date : null;
};
```

- [ ] **Step 4: Implement the record**

`shared/src/archive/record.ts`:

```ts
import { isIsoDate, isTimestamp } from "../util/dates.ts";

export type Source = "api" | "import";

// A transaction exactly as the Enable Banking API returned it. Only three of its fields
// are guaranteed, so it is read defensively, in normalise.ts, and nowhere else.
export type ApiRaw = { readonly [field: string]: unknown };

// One row of an exported file: column header to cell text, nothing parsed.
export type ImportRaw = { readonly [column: string]: string };

export type Revision<Raw> = { readonly replaced_at: string; readonly raw: Raw };

export type ApiRecord = {
  readonly account: string;
  readonly source: "api";
  readonly id: string;
  readonly date: string;
  readonly first_seen: string;
  readonly revisions: readonly Revision<ApiRaw>[];
  readonly raw: ApiRaw;
};

export type ImportRecord = {
  readonly account: string;
  readonly source: "import";
  readonly id: string;
  readonly format: string;
  readonly date: string;
  readonly first_seen: string;
  readonly revisions: readonly Revision<ImportRaw>[];
  readonly raw: ImportRaw;
};

export type ArchiveRecord = ApiRecord | ImportRecord;

export const ACCOUNT_KEY = /^[a-z0-9-]+$/;

export class ArchiveError extends Error {}

export const identityOf = (record: { account: string; source: Source; id: string }): string =>
  `${record.account}/${record.source}/${record.id}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

const isRaw = (value: unknown, source: Source): boolean =>
  isObject(value) &&
  (source === "api" || Object.values(value).every((cell) => typeof cell === "string"));

// Checks a value parsed from a year file. `where` names the file and position, and leads
// every message, so a problem can be found without printing the record itself.
export const checkRecord = (value: unknown, where: string): ArchiveRecord => {
  const fail = (problem: string): never => {
    throw new ArchiveError(`${where}: ${problem}`);
  };
  if (!isObject(value)) return fail("is not an object");
  const { account, source, id, format, date, first_seen, revisions, raw } = value;
  if (!isText(account) || !ACCOUNT_KEY.test(account)) return fail("account is not a valid key");
  if (source !== "api" && source !== "import") return fail("source is neither api nor import");
  if (!isText(id)) return fail("id is missing");
  if (source === "import" && !isText(format)) return fail("format is missing");
  if (!isText(date) || !isIsoDate(date)) return fail("date is not a calendar date");
  if (!isText(first_seen) || !isTimestamp(first_seen)) return fail("first_seen is not a UTC time");
  if (!Array.isArray(revisions)) return fail("revisions is not a list");
  for (const revision of revisions as unknown[]) {
    if (
      !isObject(revision) ||
      !isText(revision.replaced_at) ||
      !isTimestamp(revision.replaced_at) ||
      !isRaw(revision.raw, source)
    ) {
      return fail("revisions holds something that is not a revision");
    }
  }
  if (!isRaw(raw, source)) return fail("raw is not what this source stores");
  return value as ArchiveRecord;
};
```

- [ ] **Step 5: Add the factories**

`shared/testing/factories.ts`:

```ts
import type { ApiRaw, ApiRecord, ImportRaw, ImportRecord } from "../src/archive/record.ts";

// Everything here is invented. IBANs use check digits 00, which no real IBAN can have.

export const anApiRaw = (overrides: Record<string, unknown> = {}): ApiRaw => ({
  entry_reference: "20250102-10000001",
  transaction_amount: { currency: "EUR", amount: "12.34" },
  credit_debit_indicator: "DBIT",
  status: "BOOK",
  booking_date: "2025-01-02",
  value_date: "2025-01-02",
  creditor: { name: "Example Shop" },
  creditor_account: { iban: "NL00BNKC0000000009" },
  debtor: { name: "A. Holder" },
  debtor_account: { iban: "NL00BNKA0000000001" },
  bank_transaction_code: { description: "Card payment", code: "CARD", sub_code: null },
  remittance_information: ["Line one", "Line two"],
  ...overrides,
});

export const anImportRaw = (overrides: Record<string, string> = {}): ImportRaw => ({
  Account: "NL00BNKA0000000001",
  Currency: "EUR",
  Sequence: "000000000000000001",
  Booked: "2025-01-02",
  "Value date": "2025-01-02",
  Amount: "-12,34",
  "Counterparty account": "NL00BNKC0000000009",
  Counterparty: "Example Shop",
  Type: "card",
  "Text 1": "Line one",
  "Text 2": "Line two",
  "Text 3": "",
  "Original amount": "",
  "Original currency": "",
  ...overrides,
});

export const anApiRecord = (overrides: Partial<ApiRecord> = {}): ApiRecord => ({
  account: "bnka-current",
  source: "api",
  id: "20250102-10000001",
  date: "2025-01-02",
  first_seen: "2025-01-03T03:00:00Z",
  revisions: [],
  raw: anApiRaw(),
  ...overrides,
});

export const anImportRecord = (overrides: Partial<ImportRecord> = {}): ImportRecord => ({
  account: "bnka-current",
  source: "import",
  id: "000000000000000001",
  format: "example-export",
  date: "2025-01-02",
  first_seen: "2025-04-02T19:00:00Z",
  revisions: [],
  raw: anImportRaw(),
  ...overrides,
});
```

`shared/testing/index.ts`:

```ts
export * from "./factories.ts";
```

Replace `shared/src/index.ts` with:

```ts
// The browser-safe entry. Nothing exported from here may import a `node:` module.
export * from "./archive/record.ts";
export * from "./util/dates.ts";
export * from "./util/equal.ts";
```

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format
git add -A
git commit -m "feat(shared): the archive record and its validation"
```

---

### Task 3: Merge

**Files:**

- Create: `shared/src/archive/merge.ts`, `shared/src/archive/merge.test.ts`
- Modify: `shared/src/index.ts`, `shared/testing/factories.ts`

**Interfaces:**

- Consumes: `ArchiveRecord`, `ApiRaw`, `ImportRaw`, `identityOf`, `deepEqual`, `isIsoDate`.
- Produces:
  - `type Incoming = { readonly id: string; readonly date: string; readonly raw: ApiRaw | ImportRaw }`
  - `type Target = { readonly account: string; readonly source: "api" } | { readonly account: string; readonly source: "import"; readonly format: string }`
  - `type MergeResult = { records: ArchiveRecord[]; added: string[]; revised: string[]; unchanged: number }` where `added` and `revised` hold identities
  - `class MergeError extends Error`
  - `compareRecords(a: ArchiveRecord, b: ArchiveRecord): number`, by `date` then `id`
  - `merge(stored: readonly ArchiveRecord[], incoming: readonly Incoming[], target: Target, now: string): MergeResult`
  - factory `anIncoming(overrides?: Partial<Incoming>): Incoming`

`stored` is every record of one account and source, across all years. The caller extracts `id` and `date` from each transaction before calling; `merge` never looks inside `raw` except to compare it.

- [ ] **Step 1: Add the factory**

Append to `shared/testing/factories.ts` (and add `Incoming` to its type import, from `"../src/archive/merge.ts"`):

```ts
export const anIncoming = (overrides: Partial<Incoming> = {}): Incoming => ({
  id: "20250102-10000001",
  date: "2025-01-02",
  raw: anApiRaw(),
  ...overrides,
});
```

- [ ] **Step 2: Write the failing tests**

`shared/src/archive/merge.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRaw, anApiRecord, anImportRaw, anIncoming } from "../../testing/factories.ts";
import { merge, MergeError } from "./merge.ts";
import type { Target } from "./merge.ts";

const API: Target = { account: "bnka-current", source: "api" };
const IMPORT: Target = { account: "bnka-current", source: "import", format: "example-export" };
const NOW = "2025-01-03T03:00:00Z";
const LATER = "2025-01-04T03:00:00Z";

test("a new transaction becomes a record, first seen now", () => {
  const result = merge([], [anIncoming()], API, NOW);
  assert.deepEqual(result.records, [anApiRecord({ first_seen: NOW })]);
  assert.deepEqual(result.added, ["bnka-current/api/20250102-10000001"]);
  assert.deepEqual(result.revised, []);
  assert.equal(result.unchanged, 0);
});

test("an import target stamps its format on the record", () => {
  const [record] = merge([], [anIncoming({ id: "1", raw: anImportRaw() })], IMPORT, NOW).records;
  assert.equal(record.source, "import");
  assert.equal(record.source === "import" && record.format, "example-export");
  assert.deepEqual(Object.keys(record).slice(0, 4), ["account", "source", "id", "format"]);
});

test("a known, identical transaction changes nothing", () => {
  const stored = merge([], [anIncoming()], API, NOW).records;
  const result = merge(stored, [anIncoming()], API, LATER);
  assert.deepEqual(result.records, stored);
  assert.deepEqual(result.added, []);
  assert.equal(result.unchanged, 1);
});

test("key order inside raw is not a change", () => {
  const stored = merge([], [anIncoming({ raw: { a: 1, b: 2 } })], API, NOW).records;
  const result = merge(stored, [anIncoming({ raw: { b: 2, a: 1 } })], API, LATER);
  assert.deepEqual(result.revised, []);
});

test("a changed transaction keeps its earlier version", () => {
  const before = anApiRaw({ remittance_information: ["Line one"] });
  const after = anApiRaw({ remittance_information: ["Line one", "Line two"] });
  const stored = merge([], [anIncoming({ raw: before })], API, NOW).records;
  const result = merge(stored, [anIncoming({ raw: after })], API, LATER);
  assert.deepEqual(result.records, [
    anApiRecord({
      first_seen: NOW,
      revisions: [{ replaced_at: LATER, raw: before }],
      raw: after,
    }),
  ]);
  assert.deepEqual(result.revised, ["bnka-current/api/20250102-10000001"]);
});

test("a revised booking date moves the record's date with it", () => {
  const stored = merge([], [anIncoming({ date: "2025-12-31" })], API, NOW).records;
  const result = merge(stored, [anIncoming({ date: "2026-01-01" })], API, LATER);
  assert.equal(result.records[0].date, "2026-01-01");
  assert.equal(result.records[0].revisions.length, 1);
});

test("two transactions alike in everything but id stay two", () => {
  const twins = [anIncoming({ id: "a" }), anIncoming({ id: "b" })];
  assert.equal(merge([], twins, API, NOW).records.length, 2);
});

test("the same transaction twice in one batch is stored once", () => {
  const result = merge([], [anIncoming(), anIncoming()], API, NOW);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.added, ["bnka-current/api/20250102-10000001"]);
});

test("one id with two different contents in one batch is an error", () => {
  const batch = [anIncoming(), anIncoming({ raw: anApiRaw({ status: "OTHR" }) })];
  assert.throws(() => merge([], batch, API, NOW), MergeError);
});

test("records come back sorted by date, then id", () => {
  const batch = [
    anIncoming({ id: "b", date: "2025-01-02" }),
    anIncoming({ id: "a", date: "2025-01-02" }),
    anIncoming({ id: "z", date: "2025-01-01" }),
  ];
  assert.deepEqual(
    merge([], batch, API, NOW).records.map((record) => record.id),
    ["z", "a", "b"],
  );
});

test("nothing stored is ever dropped", () => {
  const stored = merge([], [anIncoming({ id: "a" }), anIncoming({ id: "b" })], API, NOW).records;
  const result = merge(stored, [anIncoming({ id: "c" })], API, LATER);
  assert.deepEqual(result.records.map((record) => record.id).toSorted(), ["a", "b", "c"]);
});

test("an incoming transaction without an id or a real date is an error", () => {
  assert.throws(() => merge([], [anIncoming({ id: "" })], API, NOW), MergeError);
  assert.throws(() => merge([], [anIncoming({ date: "2025-02-30" })], API, NOW), MergeError);
});

test("stored records of another account or source are an error", () => {
  const foreign = [anApiRecord({ account: "bnka-joint" })];
  assert.throws(() => merge(foreign, [], API, NOW), MergeError);
  assert.throws(() => merge([anApiRecord()], [], IMPORT, NOW), MergeError);
});

test("the inputs are not modified", () => {
  const stored = merge([], [anIncoming()], API, NOW).records;
  const snapshot = structuredClone(stored);
  merge(stored, [anIncoming({ raw: anApiRaw({ status: "OTHR" }) })], API, LATER);
  assert.deepEqual(stored, snapshot);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test`
Expected: FAIL, `./merge.ts` not found.

- [ ] **Step 4: Implement**

`shared/src/archive/merge.ts`:

```ts
import { isIsoDate } from "../util/dates.ts";
import { deepEqual } from "../util/equal.ts";
import { identityOf } from "./record.ts";
import type { ApiRaw, ArchiveRecord, ImportRaw } from "./record.ts";

// One transaction on its way into the archive. Whoever fetched or imported it has already
// read its identifier and booking date out of `raw`.
export type Incoming = {
  readonly id: string;
  readonly date: string;
  readonly raw: ApiRaw | ImportRaw;
};

export type Target =
  | { readonly account: string; readonly source: "api" }
  | { readonly account: string; readonly source: "import"; readonly format: string };

export type MergeResult = {
  records: ArchiveRecord[];
  added: string[];
  revised: string[];
  unchanged: number;
};

export class MergeError extends Error {}

export const compareRecords = (a: ArchiveRecord, b: ArchiveRecord): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// The object literals fix the key order that year files are written in.
const create = (target: Target, item: Incoming, now: string): ArchiveRecord =>
  target.source === "api"
    ? {
        account: target.account,
        source: "api",
        id: item.id,
        date: item.date,
        first_seen: now,
        revisions: [],
        raw: item.raw,
      }
    : {
        account: target.account,
        source: "import",
        id: item.id,
        format: target.format,
        date: item.date,
        first_seen: now,
        revisions: [],
        raw: item.raw as ImportRaw,
      };

const revise = (existing: ArchiveRecord, item: Incoming, now: string): ArchiveRecord =>
  ({
    ...existing,
    date: item.date,
    revisions: [...existing.revisions, { replaced_at: now, raw: existing.raw }],
    raw: item.raw,
  }) as ArchiveRecord;

// Merges one batch into everything stored for one account and source. Never deletes, and
// never decides that two transactions are the same by looking at their contents.
export const merge = (
  stored: readonly ArchiveRecord[],
  incoming: readonly Incoming[],
  target: Target,
  now: string,
): MergeResult => {
  const byId = new Map<string, ArchiveRecord>();
  for (const record of stored) {
    if (record.account !== target.account || record.source !== target.source) {
      throw new MergeError(
        `${identityOf(record)} does not belong to ${target.account}/${target.source}`,
      );
    }
    byId.set(record.id, record);
  }

  const batch = new Map<string, Incoming>();
  const added: string[] = [];
  const revised: string[] = [];
  let unchanged = 0;

  for (const item of incoming) {
    const identity = identityOf({ ...target, id: item.id });
    if (item.id === "")
      throw new MergeError(`${target.account}/${target.source}: a transaction has no id`);
    if (!isIsoDate(item.date)) throw new MergeError(`${identity} has no usable booking date`);

    const earlier = batch.get(item.id);
    if (earlier !== undefined) {
      if (deepEqual(earlier, item)) continue;
      throw new MergeError(`${identity} appears twice in one batch with different contents`);
    }
    batch.set(item.id, item);

    const existing = byId.get(item.id);
    if (existing === undefined) {
      byId.set(item.id, create(target, item, now));
      added.push(identity);
    } else if (existing.date === item.date && deepEqual(existing.raw, item.raw)) {
      unchanged += 1;
    } else {
      byId.set(item.id, revise(existing, item, now));
      revised.push(identity);
    }
  }

  return { records: [...byId.values()].toSorted(compareRecords), added, revised, unchanged };
};
```

Add to `shared/src/index.ts`:

```ts
export * from "./archive/merge.ts";
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format
git add -A
git commit -m "feat(shared): merge, which never deletes and never matches on content"
```

---

### Task 4: Year files

**Files:**

- Create: `shared/src/archive/files.ts`, `shared/src/archive/files.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**

- Consumes: `ArchiveRecord`, `ArchiveError`, `checkRecord`, `compareRecords`.
- Produces:
  - `renderYearFiles(records: readonly ArchiveRecord[]): Map<string, string>`, from file name (`"2025.json"`) to exact file text. `records` belong to one account and source.
  - `type FileLocation = { account: string; source: Source; year: string }`
  - `parseYearFile(text: string, where: FileLocation): ArchiveRecord[]` (throws `ArchiveError`)

- [ ] **Step 1: Write the failing tests**

`shared/src/archive/files.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRecord } from "../../testing/factories.ts";
import { parseYearFile, renderYearFiles } from "./files.ts";
import { ArchiveError } from "./record.ts";

const WHERE = { account: "bnka-current", source: "api", year: "2025" } as const;
const a = anApiRecord({ id: "a", date: "2025-01-02" });
const b = anApiRecord({ id: "b", date: "2025-01-02" });
const next = anApiRecord({ id: "c", date: "2026-01-01" });

test("records are split by the year of their date", () => {
  const files = renderYearFiles([next, a]);
  assert.deepEqual([...files.keys()].toSorted(), ["2025.json", "2026.json"]);
});

test("a file is sorted by date then id, whatever order the records came in", () => {
  const early = anApiRecord({ id: "z", date: "2025-01-01" });
  assert.equal(
    renderYearFiles([b, early, a]).get("2025.json"),
    renderYearFiles([early, a, b]).get("2025.json"),
  );
  const ids = parseYearFile(renderYearFiles([b, early, a]).get("2025.json") ?? "", WHERE).map(
    (r) => r.id,
  );
  assert.deepEqual(ids, ["z", "a", "b"]);
});

test("the text is two-space JSON with a trailing newline", () => {
  const text = renderYearFiles([a]).get("2025.json") ?? "";
  assert.ok(text.startsWith('[\n  {\n    "account": "bnka-current",\n    "source": "api",'));
  assert.ok(text.endsWith("]\n"));
  assert.ok(!text.endsWith("\n\n"));
});

test("rendering and parsing round-trips without loss, and renders the same bytes again", () => {
  const text = renderYearFiles([a, b]).get("2025.json") ?? "";
  const parsed = parseYearFile(text, WHERE);
  assert.deepEqual(parsed, [a, b]);
  assert.equal(renderYearFiles(parsed).get("2025.json"), text);
});

test("no records gives no files", () => {
  assert.equal(renderYearFiles([]).size, 0);
});

test("an empty array is a valid, empty year file", () => {
  assert.deepEqual(parseYearFile("[]\n", WHERE), []);
});

const rejected: [string, string, RegExp][] = [
  ["text that is not JSON", "{", /is not valid JSON/],
  ["an empty file", "", /is not valid JSON/],
  ["JSON that is not a list", "{}", /is not a list/],
  ["a record from another year", JSON.stringify([next]), /belongs in 2026/],
  [
    "a record of another account",
    JSON.stringify([anApiRecord({ account: "bnka-joint" })]),
    /another account/,
  ],
  [
    "a record of another source",
    JSON.stringify([{ ...a, source: "import", format: "x", raw: {} }]),
    /another source/,
  ],
  ["records out of order", JSON.stringify([b, a]), /out of order/],
  ["the same id twice", JSON.stringify([a, a]), /out of order|twice/],
  ["a malformed record", JSON.stringify([{ ...a, date: "soon" }]), /record 1: date/],
];

for (const [name, text, message] of rejected) {
  test(`a file with ${name} is rejected, naming the file`, () => {
    assert.throws(
      () => parseYearFile(text, WHERE),
      (error: unknown) =>
        error instanceof ArchiveError &&
        error.message.startsWith("bnka-current/api/2025.json") &&
        message.test(error.message),
    );
  });
}

test("a byte order mark is not accepted as JSON", () => {
  assert.throws(() => parseYearFile("﻿[]\n", WHERE), ArchiveError);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: FAIL, `./files.ts` not found.

- [ ] **Step 3: Implement**

`shared/src/archive/files.ts`:

```ts
import { compareRecords } from "./merge.ts";
import { ArchiveError, checkRecord } from "./record.ts";
import type { ArchiveRecord, Source } from "./record.ts";

export type FileLocation = { account: string; source: Source; year: string };

// File name to exact file text, for the records of one account and source. A year with no
// records gets no file.
export const renderYearFiles = (records: readonly ArchiveRecord[]): Map<string, string> => {
  const byYear = Map.groupBy(records, (record) => record.date.slice(0, 4));
  return new Map(
    [...byYear].map(([year, items]) => [
      `${year}.json`,
      `${JSON.stringify(items.toSorted(compareRecords), null, 2)}\n`,
    ]),
  );
};

// Parses and checks one year file. A file that is wrong in any way is rejected whole.
export const parseYearFile = (text: string, where: FileLocation): ArchiveRecord[] => {
  const file = `${where.account}/${where.source}/${where.year}.json`;
  const parse = (): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new ArchiveError(`${file} is not valid JSON`);
    }
  };
  const parsed = parse();
  if (!Array.isArray(parsed)) throw new ArchiveError(`${file} is not a list of records`);

  const records = (parsed as unknown[]).map((value, index) => {
    const position = `${file}, record ${index + 1}`;
    const record = checkRecord(value, position);
    if (record.account !== where.account)
      throw new ArchiveError(`${position}: is of another account`);
    if (record.source !== where.source) throw new ArchiveError(`${position}: is of another source`);
    if (record.date.slice(0, 4) !== where.year) {
      throw new ArchiveError(`${position}: belongs in ${record.date.slice(0, 4)}`);
    }
    return record;
  });

  // Strictly ascending also rules out the same id twice on one date.
  records.forEach((record, index) => {
    if (index > 0 && compareRecords(records[index - 1], record) >= 0) {
      throw new ArchiveError(`${file}, record ${index + 1}: is out of order`);
    }
  });
  const ids = new Set(records.map((record) => record.id));
  if (ids.size !== records.length) throw new ArchiveError(`${file}: holds an id twice`);
  return records;
};
```

Add to `shared/src/index.ts`:

```ts
export * from "./archive/files.ts";
```

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add -A
git commit -m "feat(shared): render and parse year files"
```

---

### Task 5: Configuration

**Files:**

- Create: `shared/src/config/config.ts`, `shared/src/config/config.test.ts`
- Modify: `shared/src/index.ts`, `shared/testing/factories.ts`

**Interfaces:**

- Consumes: `ACCOUNT_KEY`, `DATE_FORMATS`, `DateFormat`.
- Produces:
  - `ENCODINGS = ["utf-8", "windows-1252", "iso-8859-15"] as const`
  - types `Column = { column: string }`, `DateColumn = { column: string; format: DateFormat }`, `AmountColumn = { column: string; decimal: "." | "," }`
  - `type ImportFormat = { delimiter: string; encoding: (typeof ENCODINGS)[number]; account: Column; id: Column; date: DateColumn; amount: AmountColumn; currency: Column; value_date?: DateColumn; counterparty_name?: Column; counterparty_account?: Column; description?: { columns: string[] }; code?: Column; original_amount?: AmountColumn; original_currency?: Column }`
  - `type Account = { bank: string; iban?: string; import_id?: string; closed?: boolean }`
  - `type Config = { banks: Record<string, { aspsp: { name: string; country: string } }>; accounts: Record<string, Account>; imports: Record<string, ImportFormat> }`
  - `validateConfig(value: unknown): { ok: true; config: Config } | { ok: false; problems: string[] }`
  - factories `aFormat(overrides?: Partial<ImportFormat>): ImportFormat`, `aConfig(overrides?: Partial<Config>): Config`

The validator returns every problem it finds, not the first.

- [ ] **Step 1: Add the factories**

Append to `shared/testing/factories.ts` (add `Config` and `ImportFormat` to the type imports, from `"../src/config/config.ts"`):

```ts
// Describes the row that anImportRaw builds.
export const aFormat = (overrides: Partial<ImportFormat> = {}): ImportFormat => ({
  delimiter: ";",
  encoding: "utf-8",
  account: { column: "Account" },
  id: { column: "Sequence" },
  date: { column: "Booked", format: "YYYY-MM-DD" },
  value_date: { column: "Value date", format: "YYYY-MM-DD" },
  amount: { column: "Amount", decimal: "," },
  currency: { column: "Currency" },
  counterparty_name: { column: "Counterparty" },
  counterparty_account: { column: "Counterparty account" },
  description: { columns: ["Text 1", "Text 2", "Text 3"] },
  code: { column: "Type" },
  original_amount: { column: "Original amount", decimal: "," },
  original_currency: { column: "Original currency" },
  ...overrides,
});

export const aConfig = (overrides: Partial<Config> = {}): Config => ({
  banks: { bnka: { aspsp: { name: "Example Bank", country: "NL" } } },
  accounts: {
    "bnka-current": { bank: "bnka", iban: "NL00BNKA0000000001" },
    "bnka-card": { bank: "bnka", import_id: "1001" },
  },
  imports: { "example-export": aFormat() },
  ...overrides,
});
```

- [ ] **Step 2: Write the failing tests**

`shared/src/config/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { aConfig, aFormat } from "../../testing/factories.ts";
import { validateConfig } from "./config.ts";

const problemsOf = (value: unknown): string[] => {
  const result = validateConfig(value);
  return result.ok ? [] : result.problems;
};

test("a valid configuration passes and comes back typed", () => {
  const result = validateConfig(structuredClone(aConfig()));
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.config, aConfig());
});

test("a configuration with only the three sections, all empty, is valid", () => {
  assert.ok(validateConfig({ banks: {}, accounts: {}, imports: {} }).ok);
});

const wrong: [string, unknown, RegExp][] = [
  ["something that is not an object", [], /not a JSON object/],
  ["no banks section", { accounts: {}, imports: {} }, /banks is missing/],
  [
    "a bank without a name",
    aConfig({ banks: { bnka: { aspsp: { name: "", country: "NL" } } } }),
    /banks\.bnka: aspsp\.name/,
  ],
  [
    "a bank with a bad country",
    aConfig({ banks: { bnka: { aspsp: { name: "Example Bank", country: "nl" } } } }),
    /banks\.bnka: aspsp\.country/,
  ],
  [
    "an account key with capitals",
    aConfig({ accounts: { "Bnka Current": { bank: "bnka", iban: "NL00BNKA0000000001" } } }),
    /accounts\.Bnka Current: the key/,
  ],
  [
    "an account at an unknown bank",
    aConfig({ accounts: { a: { bank: "nope", iban: "NL00BNKA0000000001" } } }),
    /accounts\.a: bank nope is not configured/,
  ],
  [
    "an account with neither identifier",
    aConfig({ accounts: { a: { bank: "bnka" } } }),
    /accounts\.a: needs an iban or an import_id/,
  ],
  [
    "a closed flag that is not a boolean",
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001", closed: "yes" as unknown as boolean },
      },
    }),
    /accounts\.a: closed/,
  ],
  [
    "two accounts with one IBAN",
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001" },
        b: { bank: "bnka", iban: "NL00BNKA0000000001" },
      },
    }),
    /accounts\.b: shares its iban with a/,
  ],
  [
    "two accounts with one import_id",
    aConfig({
      accounts: { a: { bank: "bnka", import_id: "1" }, b: { bank: "bnka", import_id: "1" } },
    }),
    /accounts\.b: shares its import_id with a/,
  ],
  [
    "a format with a long delimiter",
    aConfig({ imports: { x: aFormat({ delimiter: ";;" }) } }),
    /imports\.x: delimiter/,
  ],
  [
    "a format with an unlisted encoding",
    aConfig({ imports: { x: aFormat({ encoding: "latin1" as "utf-8" }) } }),
    /imports\.x: encoding must be one of utf-8, windows-1252, iso-8859-15/,
  ],
  [
    "a format without an id column",
    aConfig({ imports: { x: { ...aFormat(), id: undefined } as never } }),
    /imports\.x: id/,
  ],
  [
    "a format with an unsupported date notation",
    aConfig({
      imports: { x: aFormat({ date: { column: "Booked", format: "MM/DD/YY" as "YYYYMMDD" } }) },
    }),
    /imports\.x: date\.format/,
  ],
  [
    "a format with a bad decimal mark",
    aConfig({ imports: { x: aFormat({ amount: { column: "Amount", decimal: " " as "," } }) } }),
    /imports\.x: amount\.decimal/,
  ],
  [
    "a format with an empty description list",
    aConfig({ imports: { x: aFormat({ description: { columns: [] } }) } }),
    /imports\.x: description/,
  ],
  [
    "a bad optional column",
    aConfig({ imports: { x: aFormat({ code: { column: "" } }) } }),
    /imports\.x: code/,
  ],
];

for (const [name, value, message] of wrong) {
  test(`${name} is reported`, () => {
    const problems = problemsOf(value);
    assert.ok(
      problems.some((problem) => message.test(problem)),
      problems.join(" | "),
    );
  });
}

test("every problem is reported, not only the first", () => {
  const problems = problemsOf(
    aConfig({
      accounts: { a: { bank: "nope" } },
      imports: { x: aFormat({ delimiter: "" }) },
    }),
  );
  assert.ok(problems.length >= 3, problems.join(" | "));
});

test("a problem never repeats an account number", () => {
  const problems = problemsOf(
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001" },
        b: { bank: "bnka", iban: "NL00BNKA0000000001" },
      },
    }),
  );
  assert.ok(problems.every((problem) => !problem.includes("NL00")));
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test`
Expected: FAIL, `./config.ts` not found.

- [ ] **Step 4: Implement**

`shared/src/config/config.ts`:

```ts
import { ACCOUNT_KEY } from "../archive/record.ts";
import { DATE_FORMATS } from "../util/dates.ts";
import type { DateFormat } from "../util/dates.ts";

export const ENCODINGS = ["utf-8", "windows-1252", "iso-8859-15"] as const;

export type Column = { column: string };
export type DateColumn = { column: string; format: DateFormat };
export type AmountColumn = { column: string; decimal: "." | "," };

export type ImportFormat = {
  delimiter: string;
  encoding: (typeof ENCODINGS)[number];
  account: Column;
  id: Column;
  date: DateColumn;
  amount: AmountColumn;
  currency: Column;
  value_date?: DateColumn;
  counterparty_name?: Column;
  counterparty_account?: Column;
  description?: { columns: string[] };
  code?: Column;
  original_amount?: AmountColumn;
  original_currency?: Column;
};

export type Account = { bank: string; iban?: string; import_id?: string; closed?: boolean };

export type Config = {
  banks: Record<string, { aspsp: { name: string; country: string } }>;
  accounts: Record<string, Account>;
  imports: Record<string, ImportFormat>;
};

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isColumn = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && isText(value.column);

const formatProblems = (format: unknown): string[] => {
  if (!isObject(format)) return ["is not an object"];
  const problems: string[] = [];
  const column = (name: string, required: boolean): void => {
    if (format[name] === undefined ? required : !isColumn(format[name])) {
      problems.push(`${name} must name a column`);
    }
  };
  const dated = (name: string, required: boolean): void => {
    const value = format[name];
    if (value === undefined && !required) return;
    if (!isColumn(value)) problems.push(`${name} must name a column`);
    else if (!isText(value.format) || !Object.hasOwn(DATE_FORMATS, value.format)) {
      problems.push(`${name}.format must be one of ${Object.keys(DATE_FORMATS).join(", ")}`);
    }
  };
  const amount = (name: string, required: boolean): void => {
    const value = format[name];
    if (value === undefined && !required) return;
    if (!isColumn(value)) problems.push(`${name} must name a column`);
    else if (value.decimal !== "." && value.decimal !== ",") {
      problems.push(`${name}.decimal must be a point or a comma`);
    }
  };

  if (typeof format.delimiter !== "string" || format.delimiter.length !== 1) {
    problems.push("delimiter must be a single character");
  }
  if (!ENCODINGS.includes(format.encoding as (typeof ENCODINGS)[number])) {
    problems.push(`encoding must be one of ${ENCODINGS.join(", ")}`);
  }
  column("account", true);
  column("id", true);
  dated("date", true);
  amount("amount", true);
  column("currency", true);
  dated("value_date", false);
  column("counterparty_name", false);
  column("counterparty_account", false);
  column("code", false);
  amount("original_amount", false);
  column("original_currency", false);
  if (format.description !== undefined) {
    const columns = isObject(format.description) ? format.description.columns : undefined;
    if (!Array.isArray(columns) || columns.length === 0 || !columns.every(isText)) {
      problems.push("description must list at least one column");
    }
  }
  return problems;
};

// Returns every problem, each as a sentence a person can act on. Messages name keys and
// fields, never the values of account numbers.
export const validateConfig = (value: unknown): ConfigResult => {
  if (!isObject(value)) return { ok: false, problems: ["the configuration is not a JSON object"] };
  const problems: string[] = [];
  const section = (name: string): Record<string, unknown> => {
    if (isObject(value[name])) return value[name];
    problems.push(`${name} is missing or is not an object`);
    return {};
  };
  const banks = section("banks");
  const accounts = section("accounts");
  const imports = section("imports");

  for (const [key, bank] of Object.entries(banks)) {
    const aspsp = isObject(bank) && isObject(bank.aspsp) ? bank.aspsp : {};
    if (!isText(aspsp.name)) problems.push(`banks.${key}: aspsp.name is missing`);
    if (!isText(aspsp.country) || !/^[A-Z]{2}$/.test(aspsp.country)) {
      problems.push(`banks.${key}: aspsp.country must be a two-letter country code`);
    }
  }

  const ibans = new Map<string, string>();
  const importIds = new Map<string, string>();
  for (const [key, account] of Object.entries(accounts)) {
    const at = `accounts.${key}`;
    if (!ACCOUNT_KEY.test(key)) problems.push(`${at}: the key may hold only a-z, 0-9 and -`);
    if (!isObject(account)) {
      problems.push(`${at}: is not an object`);
      continue;
    }
    if (!isText(account.bank)) problems.push(`${at}: bank is missing`);
    else if (!Object.hasOwn(banks, account.bank)) {
      problems.push(`${at}: bank ${account.bank} is not configured`);
    }
    if (!isText(account.iban) && !isText(account.import_id)) {
      problems.push(`${at}: needs an iban or an import_id`);
    }
    if (account.closed !== undefined && typeof account.closed !== "boolean") {
      problems.push(`${at}: closed must be true or false`);
    }
    for (const [field, seen] of [
      ["iban", ibans],
      ["import_id", importIds],
    ] as const) {
      const identifier = account[field];
      if (!isText(identifier)) continue;
      const other = seen.get(identifier);
      if (other !== undefined) problems.push(`${at}: shares its ${field} with ${other}`);
      else seen.set(identifier, key);
    }
  }

  for (const [key, format] of Object.entries(imports)) {
    problems.push(...formatProblems(format).map((problem) => `imports.${key}: ${problem}`));
  }

  return problems.length === 0 ? { ok: true, config: value as Config } : { ok: false, problems };
};
```

Add to `shared/src/index.ts`:

```ts
export * from "./config/config.ts";
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format
git add -A
git commit -m "feat(shared): the configuration file and its validation"
```

---

### Task 6: Amounts and the normalised transaction

**Files:**

- Create: `shared/src/util/amounts.ts`, `shared/src/util/amounts.test.ts`, `shared/src/archive/normalise.ts`, `shared/src/archive/normalise.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**

- Consumes: `ArchiveRecord`, `ApiRecord`, `ImportRecord`, `identityOf`, `ImportFormat`, `parseDate`.
- Produces:
  - `minorUnits(currency: string): number`
  - `parseAmount(text: string, decimal: "." | ",", currency: string): number | null`, an integer in the currency's smallest unit
  - `type Transaction = { account: string; source: Source; id: string; date: string; value_date: string | null; amount: number; currency: string; counterparty_name: string | null; counterparty_account: string | null; description: string; code: string | null; original_amount: number | null; original_currency: string | null; first_seen: string; revised: boolean }`
  - `class NormaliseError extends Error`
  - `normalise(record: ArchiveRecord, formats: Readonly<Record<string, ImportFormat>>): Transaction`

`amount` is negative for money leaving the account. `original_amount` takes the same sign as `amount`.

- [ ] **Step 1: Write the failing tests**

`shared/src/util/amounts.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { minorUnits, parseAmount } from "./amounts.ts";

test("amounts become integers in the smallest unit", () => {
  assert.equal(parseAmount("12.34", ".", "EUR"), 1234);
  assert.equal(parseAmount("12,34", ",", "EUR"), 1234);
  assert.equal(parseAmount("12", ".", "EUR"), 1200);
  assert.equal(parseAmount("12.3", ".", "EUR"), 1230);
  assert.equal(parseAmount("0.07", ".", "EUR"), 7);
});

test("a leading sign is honoured", () => {
  assert.equal(parseAmount("-10,00", ",", "EUR"), -1000);
  assert.equal(parseAmount("+20,00", ",", "EUR"), 2000);
});

test("zero is zero, never negative zero", () => {
  assert.ok(Object.is(parseAmount("-0,00", ",", "EUR"), 0));
});

test("currencies have their own number of decimals", () => {
  assert.equal(minorUnits("EUR"), 2);
  assert.equal(minorUnits("JPY"), 0);
  assert.equal(minorUnits("KWD"), 3);
  assert.equal(parseAmount("1500", ".", "JPY"), 1500);
  assert.equal(parseAmount("1.234", ".", "KWD"), 1234);
});

test("a thousands separator is an error, never a different number", () => {
  assert.equal(parseAmount("1.234,56", ",", "EUR"), null);
  assert.equal(parseAmount("1,234.56", ".", "EUR"), null);
  assert.equal(parseAmount("1.234", ",", "EUR"), null);
  assert.equal(parseAmount("1 234,56", ",", "EUR"), null);
});

test("anything else that is not a plain number is null", () => {
  for (const text of ["", " ", "abc", "12,345", "1e3", "12.", ".5", "--1", "1.5"]) {
    assert.equal(
      parseAmount(text, text === "1.5" ? "." : ",", text === "1.5" ? "JPY" : "EUR"),
      null,
      text,
    );
  }
});

test("a number too large to hold exactly is null", () => {
  assert.equal(parseAmount("99999999999999999.99", ".", "EUR"), null);
});
```

`shared/src/archive/normalise.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aFormat,
  anApiRaw,
  anApiRecord,
  anImportRaw,
  anImportRecord,
} from "../../testing/factories.ts";
import { normalise, NormaliseError } from "./normalise.ts";

const FORMATS = { "example-export": aFormat() };

test("an API debit is negative, and its counterparty is the creditor", () => {
  assert.deepEqual(normalise(anApiRecord(), FORMATS), {
    account: "bnka-current",
    source: "api",
    id: "20250102-10000001",
    date: "2025-01-02",
    value_date: "2025-01-02",
    amount: -1234,
    currency: "EUR",
    counterparty_name: "Example Shop",
    counterparty_account: "NL00BNKC0000000009",
    description: "Line one\nLine two",
    code: "CARD",
    original_amount: null,
    original_currency: null,
    first_seen: "2025-01-03T03:00:00Z",
    revised: false,
  });
});

test("an API credit is positive, and its counterparty is the debtor", () => {
  const raw = anApiRaw({
    credit_debit_indicator: "CRDT",
    debtor: { name: "Employer" },
    debtor_account: { iban: "NL00BNKD0000000005" },
  });
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.amount, 1234);
  assert.equal(result.counterparty_name, "Employer");
  assert.equal(result.counterparty_account, "NL00BNKD0000000005");
});

test("an API record with only the guaranteed fields normalises to nulls", () => {
  const raw = {
    transaction_amount: { currency: "EUR", amount: "5.00" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
  };
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.amount, -500);
  assert.equal(result.value_date, null);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.counterparty_account, null);
  assert.equal(result.description, "");
  assert.equal(result.code, null);
});

test("explicit nulls are treated like absent fields", () => {
  const raw = anApiRaw({
    creditor: null,
    creditor_account: null,
    remittance_information: null,
    bank_transaction_code: null,
    value_date: null,
  });
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.description, "");
});

test("a counterparty account without an IBAN falls back to its other identification", () => {
  const raw = anApiRaw({ creditor_account: { other: { identification: "12345678" } } });
  assert.equal(normalise(anApiRecord({ raw }), FORMATS).counterparty_account, "12345678");
});

test("the code falls back to the bank's description of it", () => {
  const raw = anApiRaw({ bank_transaction_code: { description: "Card payment" } });
  assert.equal(normalise(anApiRecord({ raw }), FORMATS).code, "Card payment");
});

test("a purchase in another currency carries the original amount, signed like the amount", () => {
  const raw = anApiRaw({
    exchange_rate: {
      unit_currency: "EUR",
      exchange_rate: "160.0",
      instructed_amount: { currency: "JPY", amount: "1500" },
    },
  });
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.original_amount, -1500);
  assert.equal(result.original_currency, "JPY");
});

test("a record with revisions is marked revised", () => {
  const record = anApiRecord({
    revisions: [{ replaced_at: "2025-01-04T03:00:00Z", raw: anApiRaw() }],
  });
  assert.equal(normalise(record, FORMATS).revised, true);
});

test("the date is the record's date, not re-read from raw", () => {
  const record = anApiRecord({ date: "2025-01-05", raw: anApiRaw({ booking_date: "2025-01-02" }) });
  assert.equal(normalise(record, FORMATS).date, "2025-01-05");
});

test("an import row is read through its format", () => {
  assert.deepEqual(normalise(anImportRecord(), FORMATS), {
    account: "bnka-current",
    source: "import",
    id: "000000000000000001",
    date: "2025-01-02",
    value_date: "2025-01-02",
    amount: -1234,
    currency: "EUR",
    counterparty_name: "Example Shop",
    counterparty_account: "NL00BNKC0000000009",
    description: "Line one\nLine two",
    code: "card",
    original_amount: null,
    original_currency: null,
    first_seen: "2025-04-02T19:00:00Z",
    revised: false,
  });
});

test("an import row with empty optional cells gives nulls", () => {
  const raw = anImportRaw({
    Counterparty: "",
    "Counterparty account": "",
    Type: "",
    "Value date": "",
    "Text 1": "",
    "Text 2": "",
  });
  const result = normalise(anImportRecord({ raw }), FORMATS);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.counterparty_account, null);
  assert.equal(result.code, null);
  assert.equal(result.value_date, null);
  assert.equal(result.description, "");
});

test("a format without optional columns gives nulls for them", () => {
  const formats = {
    "example-export": aFormat({
      value_date: undefined,
      counterparty_name: undefined,
      counterparty_account: undefined,
      description: undefined,
      code: undefined,
      original_amount: undefined,
      original_currency: undefined,
    }),
  };
  const result = normalise(anImportRecord(), formats);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.description, "");
  assert.equal(result.original_amount, null);
});

test("an imported foreign purchase carries the original amount, signed like the amount", () => {
  const raw = anImportRaw({ "Original amount": "74,50", "Original currency": "DKK" });
  const result = normalise(anImportRecord({ raw }), FORMATS);
  assert.equal(result.original_amount, -7450);
  assert.equal(result.original_currency, "DKK");
});

const unreadable: [string, () => unknown, RegExp][] = [
  [
    "an API record without a currency",
    () =>
      normalise(
        anApiRecord({ raw: anApiRaw({ transaction_amount: { amount: "1.00" } }) }),
        FORMATS,
      ),
    /currency/,
  ],
  [
    "an API record with an unreadable amount",
    () =>
      normalise(
        anApiRecord({
          raw: anApiRaw({ transaction_amount: { currency: "EUR", amount: "1.234,56" } }),
        }),
        FORMATS,
      ),
    /amount/,
  ],
  [
    "an API record with a signed amount",
    () =>
      normalise(
        anApiRecord({
          raw: anApiRaw({ transaction_amount: { currency: "EUR", amount: "-1.00" } }),
        }),
        FORMATS,
      ),
    /amount/,
  ],
  [
    "an API record without a direction",
    () => normalise(anApiRecord({ raw: anApiRaw({ credit_debit_indicator: undefined }) }), FORMATS),
    /direction/,
  ],
  [
    "an import record of an unknown format",
    () => normalise(anImportRecord({ format: "gone" }), FORMATS),
    /format gone is not configured/,
  ],
  [
    "an import row with an unreadable amount",
    () => normalise(anImportRecord({ raw: anImportRaw({ Amount: "1.234,56" }) }), FORMATS),
    /amount/,
  ],
  [
    "an import row without a currency",
    () => normalise(anImportRecord({ raw: anImportRaw({ Currency: "" }) }), FORMATS),
    /currency/,
  ],
  [
    "an import row with an unreadable value date",
    () => normalise(anImportRecord({ raw: anImportRaw({ "Value date": "02-01-2025" }) }), FORMATS),
    /value date/,
  ],
];

for (const [name, act, message] of unreadable) {
  test(`${name} is an error that names the record and nothing private`, () => {
    assert.throws(act, (error: unknown) => {
      assert.ok(error instanceof NormaliseError);
      assert.match(error.message, message);
      assert.match(error.message, /^bnka-current\/(api|import)\//);
      assert.ok(!/Example Shop|NL00|12[.,]34|1\.234/.test(error.message), error.message);
      return true;
    });
  });
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the amounts**

`shared/src/util/amounts.ts`:

```ts
// ISO 4217 currencies that do not have two decimals.
const NO_DECIMALS = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DECIMALS = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export const minorUnits = (currency: string): number =>
  NO_DECIMALS.has(currency) ? 0 : THREE_DECIMALS.has(currency) ? 3 : 2;

// Reads a decimal number as an integer in the currency's smallest unit. Strict on purpose:
// one optional sign, digits, at most one decimal mark, and it must be the expected one.
// A thousands separator therefore fails instead of producing a different number.
export const parseAmount = (text: string, decimal: "." | ",", currency: string): number | null => {
  const match = /^([+-]?)(\d+)(?:([.,])(\d+))?$/.exec(text);
  if (match === null) return null;
  const sign = match[1];
  const whole = match[2];
  const mark = match[3] as string | undefined;
  const fraction = (match[4] as string | undefined) ?? "";
  if (mark !== undefined && mark !== decimal) return null;
  const digits = minorUnits(currency);
  if (fraction.length > digits) return null;
  const value = Number(`${whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(value)) return null;
  return sign === "-" && value !== 0 ? -value : value;
};
```

Keep the two `Set` literals as Prettier formats them; `npm run format` will reflow them.

- [ ] **Step 4: Implement normalise**

`shared/src/archive/normalise.ts`:

```ts
import type { ImportFormat } from "../config/config.ts";
import { parseAmount } from "../util/amounts.ts";
import { parseDate } from "../util/dates.ts";
import { identityOf } from "./record.ts";
import type { ApiRecord, ArchiveRecord, ImportRecord, Source } from "./record.ts";

// What every reader works on. `raw` is never interpreted anywhere but in this file.
export type Transaction = {
  account: string;
  source: Source;
  id: string;
  date: string;
  value_date: string | null;
  amount: number;
  currency: string;
  counterparty_name: string | null;
  counterparty_account: string | null;
  description: string;
  code: string | null;
  original_amount: number | null;
  original_currency: string | null;
  first_seen: string;
  revised: boolean;
};

export class NormaliseError extends Error {}

// Messages name the record and the field. They never repeat a value from `raw`.
const failure = (record: ArchiveRecord, problem: string): NormaliseError =>
  new NormaliseError(`${identityOf(record)} ${problem}`);

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const withSign = (magnitude: number, like: number): number =>
  like < 0 && magnitude !== 0 ? -Math.abs(magnitude) : Math.abs(magnitude);

const common = (record: ArchiveRecord) => ({
  account: record.account,
  source: record.source,
  id: record.id,
  date: record.date,
});

const normaliseApi = (record: ApiRecord): Transaction => {
  const { raw } = record;
  const money = object(raw.transaction_amount);
  const currency = text(money.currency);
  if (currency === null) throw failure(record, "has no currency");
  const magnitude = parseAmount(text(money.amount) ?? "", ".", currency);
  if (magnitude === null || magnitude < 0)
    throw failure(record, "has an amount that cannot be read");
  const indicator = raw.credit_debit_indicator;
  if (indicator !== "CRDT" && indicator !== "DBIT") throw failure(record, "has no direction");
  const amount = withSign(magnitude, indicator === "DBIT" ? -1 : 1);

  const party = object(indicator === "DBIT" ? raw.creditor : raw.debtor);
  const partyAccount = object(indicator === "DBIT" ? raw.creditor_account : raw.debtor_account);
  const code = object(raw.bank_transaction_code);
  const instructed = object(object(raw.exchange_rate).instructed_amount);
  const originalCurrency = text(instructed.currency);
  const original =
    originalCurrency === null
      ? null
      : parseAmount(text(instructed.amount) ?? "", ".", originalCurrency);
  const lines = Array.isArray(raw.remittance_information)
    ? (raw.remittance_information as unknown[]).filter((line) => text(line) !== null)
    : [];

  return {
    ...common(record),
    value_date: text(raw.value_date),
    amount,
    currency,
    counterparty_name: text(party.name),
    counterparty_account:
      text(partyAccount.iban) ?? text(object(partyAccount.other).identification),
    description: lines.join("\n"),
    code: text(code.code) ?? text(code.description),
    original_amount: original === null ? null : withSign(original, amount),
    original_currency: original === null ? null : originalCurrency,
    first_seen: record.first_seen,
    revised: record.revisions.length > 0,
  };
};

const normaliseImport = (record: ImportRecord, format: ImportFormat): Transaction => {
  const cell = (column: { column: string } | undefined): string | null =>
    column === undefined ? null : text(record.raw[column.column]);

  const currency = cell(format.currency);
  if (currency === null) throw failure(record, "has no currency");
  const amount = parseAmount(cell(format.amount) ?? "", format.amount.decimal, currency);
  if (amount === null) throw failure(record, "has an amount that cannot be read");

  const valueDateText = cell(format.value_date);
  const valueDate =
    valueDateText === null || format.value_date === undefined
      ? null
      : parseDate(valueDateText, format.value_date.format);
  if (valueDateText !== null && valueDate === null) {
    throw failure(record, "has a value date that cannot be read");
  }

  const originalCurrency = cell(format.original_currency);
  const originalText = cell(format.original_amount);
  const original =
    originalCurrency === null || originalText === null || format.original_amount === undefined
      ? null
      : parseAmount(originalText, format.original_amount.decimal, originalCurrency);
  if (originalCurrency !== null && originalText !== null && original === null) {
    throw failure(record, "has an original amount that cannot be read");
  }

  return {
    ...common(record),
    value_date: valueDate,
    amount,
    currency,
    counterparty_name: cell(format.counterparty_name),
    counterparty_account: cell(format.counterparty_account),
    description: (format.description?.columns ?? [])
      .map((column) => record.raw[column] ?? "")
      .filter((line) => line !== "")
      .join("\n"),
    code: cell(format.code),
    original_amount: original === null ? null : withSign(original, amount),
    original_currency: original === null ? null : originalCurrency,
    first_seen: record.first_seen,
    revised: record.revisions.length > 0,
  };
};

export const normalise = (
  record: ArchiveRecord,
  formats: Readonly<Record<string, ImportFormat>>,
): Transaction => {
  if (record.source === "api") return normaliseApi(record);
  if (!Object.hasOwn(formats, record.format)) {
    throw failure(
      record,
      `is of import format ${record.format}, but format ${record.format} is not configured`,
    );
  }
  return normaliseImport(record, formats[record.format]);
};
```

Add to `shared/src/index.ts`:

```ts
export * from "./archive/normalise.ts";
export * from "./util/amounts.ts";
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS. If the "unknown format" test fails on its message, the message must contain `format gone is not configured`.

- [ ] **Step 6: Commit**

```bash
npm run format
git add -A
git commit -m "feat(shared): the normalised transaction, for both sources"
```

---

### Task 7: The view

**Files:**

- Create: `shared/src/archive/view.ts`, `shared/src/archive/view.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**

- Consumes: `ArchiveRecord`, `normalise`, `Transaction`, `ImportFormat`.
- Produces:
  - `apiStarts(records: readonly ArchiveRecord[]): Map<string, string>`, from account key to the earliest `date` among its API records
  - `visibleRecords(records: readonly ArchiveRecord[]): ArchiveRecord[]`
  - `view(records: readonly ArchiveRecord[], formats: Readonly<Record<string, ImportFormat>>): Transaction[]`, sorted by `date`, `account`, `source`, `id`

- [ ] **Step 1: Write the failing tests**

`shared/src/archive/view.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { aFormat, anApiRecord, anImportRecord } from "../../testing/factories.ts";
import { apiStarts, view, visibleRecords } from "./view.ts";

const FORMATS = { "example-export": aFormat() };
const imported = (id: string, date: string, account = "bnka-current") =>
  anImportRecord({ id, date, account });
const fetched = (id: string, date: string, account = "bnka-current") =>
  anApiRecord({ id, date, account });

test("an account's API start is the earliest date among its API records", () => {
  const starts = apiStarts([
    fetched("b", "2025-03-01"),
    fetched("a", "2025-01-10"),
    imported("x", "2021-01-01"),
  ]);
  assert.deepEqual([...starts], [["bnka-current", "2025-01-10"]]);
});

test("import records on or after the API start are left out", () => {
  const records = [
    imported("old", "2025-01-09"),
    imported("same-day", "2025-01-10"),
    imported("later", "2025-02-01"),
    fetched("first", "2025-01-10"),
  ];
  assert.deepEqual(
    visibleRecords(records)
      .map((record) => record.id)
      .toSorted(),
    ["first", "old"],
  );
});

test("an account with no API records keeps every import record", () => {
  const records = [
    imported("a", "2021-01-01", "bnka-card"),
    imported("b", "2026-01-01", "bnka-card"),
  ];
  assert.equal(visibleRecords(records).length, 2);
});

test("one account's API start does not hide another account's imports", () => {
  const records = [
    fetched("f", "2025-01-10", "bnka-current"),
    imported("i", "2026-01-01", "bnka-card"),
  ];
  assert.equal(visibleRecords(records).length, 2);
});

test("the result does not depend on the order of the records", () => {
  const records = [
    imported("old", "2025-01-09"),
    imported("later", "2025-02-01"),
    fetched("first", "2025-01-10"),
  ];
  assert.deepEqual(view(records.toReversed(), FORMATS), view(records, FORMATS));
});

test("the view is sorted by date, account, source and id", () => {
  const records = [
    fetched("b", "2025-01-02", "bnka-joint"),
    fetched("a", "2025-01-02", "bnka-joint"),
    imported("z", "2025-01-02", "bnka-card"),
    fetched("y", "2025-01-01", "bnka-joint"),
  ];
  assert.deepEqual(
    view(records, FORMATS).map((item) => `${item.date} ${item.account} ${item.id}`),
    [
      "2025-01-01 bnka-joint y",
      "2025-01-02 bnka-card z",
      "2025-01-02 bnka-joint a",
      "2025-01-02 bnka-joint b",
    ],
  );
});

test("nothing is removed from the input", () => {
  const records = [imported("later", "2025-02-01"), fetched("first", "2025-01-10")];
  visibleRecords(records);
  assert.equal(records.length, 2);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: FAIL, `./view.ts` not found.

- [ ] **Step 3: Implement**

`shared/src/archive/view.ts`:

```ts
import type { ImportFormat } from "../config/config.ts";
import { normalise } from "./normalise.ts";
import type { Transaction } from "./normalise.ts";
import type { ArchiveRecord } from "./record.ts";

export const apiStarts = (records: readonly ArchiveRecord[]): Map<string, string> => {
  const starts = new Map<string, string>();
  for (const record of records) {
    if (record.source !== "api") continue;
    const current = starts.get(record.account);
    if (current === undefined || record.date < current) starts.set(record.account, record.date);
  }
  return starts;
};

// The same real transaction can be stored twice, once fetched and once imported. From the
// first day the API covers an account, the API's copy is the one that is shown. This
// depends only on what is stored, never on the order things were done in.
export const visibleRecords = (records: readonly ArchiveRecord[]): ArchiveRecord[] => {
  const starts = apiStarts(records);
  return records.filter((record) => {
    if (record.source === "api") return true;
    const start = starts.get(record.account);
    return start === undefined || record.date < start;
  });
};

const sortKey = (item: Transaction): string =>
  `${item.date}\u0000${item.account}\u0000${item.source}\u0000${item.id}`;

export const view = (
  records: readonly ArchiveRecord[],
  formats: Readonly<Record<string, ImportFormat>>,
): Transaction[] =>
  visibleRecords(records)
    .map((record) => normalise(record, formats))
    .toSorted((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
```

Add to `shared/src/index.ts`:

```ts
export * from "./archive/view.ts";
```

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add -A
git commit -m "feat(shared): the view, which prefers the API where both sources overlap"
```

---

### Task 8: The store

**Files:**

- Create: `shared/src/archive/store.ts`, `shared/src/archive/store.test.ts`

**Interfaces:**

- Consumes: `parseYearFile`, `ArchiveError`, `ACCOUNT_KEY`, `ArchiveRecord`, `Source`.
- Produces, from `@money/shared/node`:
  - `readAccountSource(dataDir: string, account: string, source: Source): Promise<ArchiveRecord[]>`
  - `readArchive(dataDir: string): Promise<ArchiveRecord[]>`
  - `writeYearFiles(dataDir: string, account: string, source: Source, files: ReadonlyMap<string, string>): Promise<{ written: string[]; removed: string[] }>`

`store.ts` is the only file in `shared/src` that imports `node:` modules. It is **not** exported from `shared/src/index.ts`.

Rules: names starting with a dot are skipped at every level. Anything else that does not belong is an error. A file whose text is unchanged is not rewritten. A year file that the new set no longer contains is removed, and removed last.

- [ ] **Step 1: Write the failing tests**

`shared/src/archive/store.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { anApiRecord, anImportRecord } from "../../testing/factories.ts";
import { renderYearFiles } from "./files.ts";
import { ArchiveError } from "./record.ts";
import { readAccountSource, readArchive, writeYearFiles } from "./store.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "money-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const a = anApiRecord({ id: "a", date: "2025-06-01" });
const b = anApiRecord({ id: "b", date: "2026-01-01" });
const write = (records: Parameters<typeof renderYearFiles>[0]) =>
  writeYearFiles(dir, "bnka-current", "api", renderYearFiles(records));

test("an archive that does not exist yet reads as empty", async () => {
  assert.deepEqual(await readArchive(join(dir, "nothing-here")), []);
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), []);
});

test("what is written can be read back", async () => {
  assert.deepEqual(await write([a, b]), { written: ["2025.json", "2026.json"], removed: [] });
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), [a, b]);
});

test("the whole archive is read across accounts and sources", async () => {
  await write([a]);
  const imported = anImportRecord({ account: "bnka-card", date: "2025-06-01" });
  await writeYearFiles(dir, "bnka-card", "import", renderYearFiles([imported]));
  assert.equal((await readArchive(dir)).length, 2);
});

test("a file whose text has not changed is left untouched", async () => {
  await write([a]);
  const path = join(dir, "bnka-current", "api", "2025.json");
  const before = (await stat(path)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await write([a]), { written: [], removed: [] });
  assert.equal((await stat(path)).mtimeMs, before);
});

test("only the files that changed are rewritten", async () => {
  await write([a, b]);
  const result = await write([a, b, anApiRecord({ id: "c", date: "2026-02-01" })]);
  assert.deepEqual(result, { written: ["2026.json"], removed: [] });
});

test("no temporary file is left behind", async () => {
  await write([a]);
  assert.deepEqual(await readdir(join(dir, "bnka-current", "api")), ["2025.json"]);
});

test("a record that moved to another year leaves no empty year behind", async () => {
  await write([a]);
  const moved = { ...a, date: "2026-06-01" };
  assert.deepEqual(await write([moved]), { written: ["2026.json"], removed: ["2025.json"] });
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), [moved]);
});

test("dot-prefixed names are skipped at every level", async () => {
  await write([a]);
  await mkdir(join(dir, ".inbox", "bnka-current"), { recursive: true });
  await writeFile(join(dir, ".DS_Store"), "x");
  await writeFile(join(dir, "bnka-current", ".DS_Store"), "x");
  await writeFile(join(dir, "bnka-current", "api", ".2025.json.tmp"), "half a fi");
  assert.deepEqual(await readArchive(dir), [a]);
});

const strays: [string, (root: string) => Promise<unknown>, RegExp][] = [
  [
    "a directory that is not an account key",
    (root) => mkdir(join(root, "Not A Key")),
    /Not A Key is not an account key/,
  ],
  [
    "a file where accounts belong",
    (root) => writeFile(join(root, "notes.txt"), "x"),
    /notes\.txt does not belong/,
  ],
  [
    "an unknown source directory",
    (root) => mkdir(join(root, "bnka-current", "csv"), { recursive: true }),
    /bnka-current\/csv does not belong/,
  ],
  [
    "a file that is not a year file",
    (root) => writeFile(join(root, "bnka-current", "api", "2025.json.bak"), "x"),
    /2025\.json\.bak does not belong/,
  ],
];

for (const [name, make, message] of strays) {
  test(`${name} is reported, not ignored`, async () => {
    await write([a]);
    await make(dir);
    await assert.rejects(
      readArchive(dir),
      (error: unknown) => error instanceof ArchiveError && message.test(error.message),
    );
  });
}

test("a corrupt year file stops the read", async () => {
  await write([a]);
  await writeFile(join(dir, "bnka-current", "api", "2025.json"), "[");
  await assert.rejects(readArchive(dir), ArchiveError);
});

test("one id in two year files is reported", async () => {
  await write([a]);
  const copy = renderYearFiles([{ ...a, date: "2026-06-01" }]).get("2026.json") ?? "";
  await writeFile(join(dir, "bnka-current", "api", "2026.json"), copy);
  await assert.rejects(
    readArchive(dir),
    /bnka-current\/api\/a is stored in more than one year file/,
  );
});

test("written text is exactly the rendered text", async () => {
  await write([a]);
  const text = await readFile(join(dir, "bnka-current", "api", "2025.json"), "utf8");
  assert.equal(text, renderYearFiles([a]).get("2025.json"));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: FAIL, `./store.ts` not found.

- [ ] **Step 3: Implement**

`shared/src/archive/store.ts`:

```ts
// The only place the archive touches the disk. Node only: import it as @money/shared/node.
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseYearFile } from "./files.ts";
import { ACCOUNT_KEY, ArchiveError, identityOf } from "./record.ts";
import type { ArchiveRecord, Source } from "./record.ts";

const SOURCES: readonly Source[] = ["api", "import"];
const YEAR_FILE = /^\d{4}\.json$/;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

// A directory's entries, without anything dot-prefixed. A missing directory is empty.
const entries = async (dir: string): Promise<Dirent[]> => {
  try {
    const all = await readdir(dir, { withFileTypes: true });
    return all.filter((entry) => !entry.name.startsWith("."));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

const yearFileNames = async (dir: string, label: string): Promise<string[]> => {
  const found = await entries(dir);
  for (const entry of found) {
    if (!entry.isFile() || !YEAR_FILE.test(entry.name)) {
      throw new ArchiveError(`${label}/${entry.name} does not belong in the archive`);
    }
  }
  return found.map((entry) => entry.name).toSorted();
};

export const readAccountSource = async (
  dataDir: string,
  account: string,
  source: Source,
): Promise<ArchiveRecord[]> => {
  const dir = join(dataDir, account, source);
  const records: ArchiveRecord[] = [];
  for (const name of await yearFileNames(dir, `${account}/${source}`)) {
    const text = await readFile(join(dir, name), "utf8");
    records.push(...parseYearFile(text, { account, source, year: name.slice(0, 4) }));
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new ArchiveError(`${identityOf(record)} is stored in more than one year file`);
    }
    seen.add(record.id);
  }
  return records;
};

export const readArchive = async (dataDir: string): Promise<ArchiveRecord[]> => {
  const records: ArchiveRecord[] = [];
  for (const account of await entries(dataDir)) {
    if (!account.isDirectory())
      throw new ArchiveError(`${account.name} does not belong in the archive`);
    if (!ACCOUNT_KEY.test(account.name))
      throw new ArchiveError(`${account.name} is not an account key`);
    for (const source of await entries(join(dataDir, account.name))) {
      if (!source.isDirectory() || !SOURCES.includes(source.name as Source)) {
        throw new ArchiveError(`${account.name}/${source.name} does not belong in the archive`);
      }
      records.push(...(await readAccountSource(dataDir, account.name, source.name as Source)));
    }
  }
  return records;
};

const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

// Writes the year files of one account and source. Each file goes to a temporary name and
// is renamed into place, so a file is the old version or the new one, never part of each.
export const writeYearFiles = async (
  dataDir: string,
  account: string,
  source: Source,
  files: ReadonlyMap<string, string>,
): Promise<{ written: string[]; removed: string[] }> => {
  const dir = join(dataDir, account, source);
  await mkdir(dir, { recursive: true });
  const existing = await yearFileNames(dir, `${account}/${source}`);

  const written: string[] = [];
  for (const name of [...files.keys()].toSorted()) {
    const text = files.get(name) ?? "";
    if ((await readIfPresent(join(dir, name))) === text) continue;
    const temporary = join(dir, `.${name}.tmp`);
    await writeFile(temporary, text, { flush: true });
    await rename(temporary, join(dir, name));
    written.push(name);
  }

  // A year file that is no longer in the set has had its last record move to another
  // year. It goes last: a crash before this line leaves a record stored twice, which
  // reading reports, and never a record stored nowhere.
  const removed = existing.filter((name) => !files.has(name));
  for (const name of removed) await rm(join(dir, name));
  return { written, removed };
};
```

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Check the browser-safe entry stays clean**

Run: `grep -rn "node:" shared/src --include='*.ts' | grep -v '\.test\.ts' | grep -v 'archive/store.ts'`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
npm run format
git add -A
git commit -m "feat(shared): read and write an archive directory, atomically"
```

---

### Task 9: Convergence properties

**Files:**

- Create: `shared/testing/random.ts`, `shared/src/archive/convergence.test.ts`
- Modify: `shared/testing/index.ts`

**Interfaces:**

- Consumes: `merge`, `view`, `visibleRecords`, `apiStarts`, `aFormat`, `anApiRaw`, `anImportRaw`.
- Produces: `makeRandom(seed: number): Random` where `type Random = { next(): number; int(min: number, max: number): number; chance(probability: number): boolean; pick<T>(items: readonly T[]): T; shuffle<T>(items: readonly T[]): T[] }`

These are Tier 2 property tests. Each runs many seeded cases, and a failure names its seed so it replays exactly.

- [ ] **Step 1: Add the seeded generator**

`shared/testing/random.ts`:

```ts
export type Random = {
  next: () => number;
  int: (min: number, max: number) => number;
  chance: (probability: number) => boolean;
  pick: <T>(items: readonly T[]) => T;
  shuffle: <T>(items: readonly T[]) => T[];
};

// mulberry32. Deterministic: the same seed always gives the same sequence.
export const makeRandom = (seed: number): Random => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (items) => items[int(0, items.length - 1)],
    shuffle: (items) => {
      const result = [...items];
      for (let index = result.length - 1; index > 0; index--) {
        const other = int(0, index);
        [result[index], result[other]] = [result[other], result[index]];
      }
      return result;
    },
  };
};
```

Add to `shared/testing/index.ts`:

```ts
export * from "./random.ts";
```

- [ ] **Step 2: Write the properties**

`shared/src/archive/convergence.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { aFormat, anApiRaw, anImportRaw } from "../../testing/factories.ts";
import { makeRandom } from "../../testing/random.ts";
import type { Random } from "../../testing/random.ts";
import { merge } from "./merge.ts";
import type { Incoming, Target } from "./merge.ts";
import type { ArchiveRecord } from "./record.ts";
import { apiStarts, view } from "./view.ts";

const FORMATS = { "example-export": aFormat() };
const ACCOUNTS = ["bnka-current", "bnka-joint"];
const RUNS = 300;

const day = (random: Random): string =>
  `2025-${String(random.int(1, 3)).padStart(2, "0")}-${String(random.int(1, 28)).padStart(2, "0")}`;

type Feed = { target: Target; items: Incoming[] };

// For each account, a set of imported transactions and a set of fetched ones, with dates
// that overlap. Ids are unique within a feed and say nothing about the contents.
const world = (random: Random): Feed[] =>
  ACCOUNTS.flatMap((account): Feed[] => [
    {
      target: { account, source: "import", format: "example-export" },
      items: Array.from({ length: random.int(0, 12) }, (_, index) => {
        const date = day(random);
        return { id: `i${index}`, date, raw: anImportRaw({ Sequence: `i${index}`, Booked: date }) };
      }),
    },
    {
      target: { account, source: "api" },
      items: Array.from({ length: random.int(0, 12) }, (_, index) => {
        const date = day(random);
        return {
          id: `a${index}`,
          date,
          raw: anApiRaw({ entry_reference: `a${index}`, booking_date: date }),
        };
      }),
    },
  ]);

// Covers `items` with overlapping batches: every item is in at least one, many in several.
const batches = (random: Random, items: readonly Incoming[]): Incoming[][] => {
  const count = random.int(1, 4);
  const result: Incoming[][] = Array.from({ length: count }, () => []);
  for (const item of items) {
    result[random.int(0, count - 1)].push(item);
    for (const batch of result) if (random.chance(0.3) && !batch.includes(item)) batch.push(item);
  }
  return result;
};

const withoutTimes = (records: readonly ArchiveRecord[]) =>
  view(records, FORMATS).map((item) => ({ ...item, first_seen: "" }));

const inOneGo = (feeds: readonly Feed[]): ArchiveRecord[] =>
  feeds.flatMap((feed) => merge([], feed.items, feed.target, "2025-06-01T03:00:00Z").records);

test("however the batches fall and in whatever order, the view is the same", () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = makeRandom(seed);
    const feeds = world(random);
    const steps = random.shuffle(
      feeds.flatMap((feed) =>
        batches(random, feed.items).map((items) => ({ target: feed.target, items })),
      ),
    );
    const stored = new Map<string, ArchiveRecord[]>();
    steps.forEach((step, index) => {
      const key = `${step.target.account}/${step.target.source}`;
      const now = `2025-06-${String(1 + (index % 28)).padStart(2, "0")}T03:00:00Z`;
      stored.set(
        key,
        merge(stored.get(key) ?? [], random.shuffle(step.items), step.target, now).records,
      );
    });
    assert.deepEqual(
      withoutTimes([...stored.values()].flat()),
      withoutTimes(inOneGo(feeds)),
      `seed ${seed}`,
    );
  }
});

test("merging the same batch again changes nothing", () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = makeRandom(seed);
    for (const feed of world(random)) {
      const once = merge([], feed.items, feed.target, "2025-06-01T03:00:00Z");
      const twice = merge(
        once.records,
        random.shuffle(feed.items),
        feed.target,
        "2025-06-02T03:00:00Z",
      );
      assert.deepEqual(twice.records, once.records, `seed ${seed}`);
      assert.deepEqual(twice.added, [], `seed ${seed}`);
      assert.deepEqual(twice.revised, [], `seed ${seed}`);
    }
  }
});

test("nothing fetched is ever hidden, and no import shows from the API start onward", () => {
  let overlaps = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const records = inOneGo(world(makeRandom(seed)));
    const starts = apiStarts(records);
    const shown = view(records, FORMATS);
    const fetched = records.filter((record) => record.source === "api").length;
    assert.equal(shown.filter((item) => item.source === "api").length, fetched, `seed ${seed}`);
    for (const item of shown) {
      if (item.source !== "import") continue;
      const start = starts.get(item.account);
      assert.ok(start === undefined || item.date < start, `seed ${seed}`);
    }
    if (shown.length < records.length) overlaps += 1;
  }
  // The property is only worth something if the generator actually produces overlap.
  assert.ok(overlaps > RUNS / 2, `only ${overlaps} of ${RUNS} runs had anything to hide`);
});
```

- [ ] **Step 3: Run them**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS. These test code that already exists, so they pass at once.

- [ ] **Step 4: Prove the first property can fail**

In `shared/src/archive/view.ts`, change `record.date < start` to `record.date <= start`. Run `npm test`.
Expected: `view.test.ts` fails on "import records on or after the API start are left out", and the third property fails naming a seed. Revert the change and run `npm test` again: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add -A
git commit -m "test(shared): the view does not depend on how or in what order data arrived"
```

---

### Task 10: Regenerate the fixtures

**Files:**

- Create: `fixtures/dates.ts`, `fixtures/world.ts`, `fixtures/generate.ts` (new content)
- Rename: `fixtures/generate.ts` to `fixtures/household.ts` (then edited)
- Rewrite: `fixtures/archive.test.ts`
- Modify: `.prettierignore`
- Regenerate: `fixtures/archive/`, `fixtures/config.json`

**Interfaces:**

- Consumes: `merge`, `renderYearFiles`, `view`, `validateConfig`, `readArchive`, types from `@money/shared`.
- Produces:
  - `fixtures/world.ts`: `ACCOUNTS`, `type AccountKey`, `ROLES`, `type Role`, `accountFor(role, day)`, `SWITCH`, `FORMATS`, `CONFIG`, `importedAt(account, day, lastNight)`
  - `fixtures/household.ts`: `simulate(): Posting[]`, `type Posting = { day: number; account: AccountKey; event: Event }`, `type Event`, `KINDS`, `hash`, `makeRng`, `START`, `END`
  - `fixtures/generate.ts`: `buildArrivals()`, `buildArchive()`, `renderArchive(records)`, `renderConfig()`, `ARCHIVE_DIR`, `CONFIG_PATH`

The split: `household.ts` says what happened, in terms of roles (the joint account, the card). `world.ts` says which accounts exist and how each is reached. `generate.ts` turns what happened into what arrived, and feeds it through the real `merge`.

- [ ] **Step 1: Move the date helpers out**

```bash
git mv fixtures/generate.ts fixtures/household.ts
```

Create `fixtures/dates.ts` by cutting these declarations out of `fixtures/household.ts`, unchanged, and adding `export` to each: `MS_PER_DAY`, `utcDay`, `parts`, `pad`, `iso`, `dutchDate`, `isWeekend`, `businessDayOnOrAfter`, `businessDayOnOrBefore`, `Shift`, `due`, `MONTHS`. Keep their comments. Start the file with:

```ts
// Dates as whole days since the Unix epoch, in UTC. Used only by the fixture generator.
```

- [ ] **Step 2: Describe the accounts**

`fixtures/world.ts`:

```ts
// Which accounts the invented household has, and how each one reaches the archive.
// Two made-up banks. Everything here is invented; every IBAN has check digits 00.
import type { Config, ImportFormat } from "@money/shared";

import { iso, parts, utcDay } from "./dates.ts";

// A second bank is added on this day. The joint account, its savings and the card are at
// bnkb from then on; the personal account stays at bnka.
export const SWITCH = utcDay(2026, 4, 1);

export const ROLES = [
  "personal",
  "joint",
  "personal-savings",
  "joint-savings",
  "card",
  "second-personal",
  "second-savings",
] as const;
export type Role = (typeof ROLES)[number];

export type AccountKey =
  | "bnka-personal"
  | "bnka-joint"
  | "bnka-personal-savings"
  | "bnka-joint-savings"
  | "bnka-card"
  | "bnkb-personal"
  | "bnkb-joint"
  | "bnkb-personal-savings"
  | "bnkb-joint-savings"
  | "bnkb-card";

type FormatKey = "account-export" | "card-export";

// `api`: fetched nightly from `firstSync`, reaching back to `from`.
// `history`: one export, imported once, covering everything up to HISTORY_UNTIL.
// `ongoing`: the API cannot reach this account, so it is exported every quarter.
type Reach = {
  api?: { from: number; firstSync: number };
  import?: "history" | "ongoing";
};

export type AccountInfo = {
  bank: "bnka" | "bnkb";
  holder: string;
  iban?: string;
  import_id?: string;
  closed?: true;
  format: FormatKey;
  reach: Reach;
};

const SOLO = "M. Visser";
const JOINT = "M. Visser en/of T. Bakker";
const BNKA_API = { from: utcDay(2025, 1, 1), firstSync: utcDay(2025, 4, 1) };
const BNKB_API = { from: SWITCH, firstSync: SWITCH };
const ACCOUNT = "account-export";

export const ACCOUNTS: Record<AccountKey, AccountInfo> = {
  "bnka-personal": {
    bank: "bnka",
    holder: SOLO,
    iban: "NL00BNKA0000000001",
    format: ACCOUNT,
    reach: { api: BNKA_API, import: "history" },
  },
  "bnka-joint": {
    bank: "bnka",
    holder: JOINT,
    iban: "NL00BNKA0000000002",
    closed: true,
    format: ACCOUNT,
    reach: { api: BNKA_API, import: "history" },
  },
  "bnka-personal-savings": {
    bank: "bnka",
    holder: SOLO,
    iban: "NL00BNKA0000000003",
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnka-joint-savings": {
    bank: "bnka",
    holder: JOINT,
    iban: "NL00BNKA0000000004",
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnka-card": {
    bank: "bnka",
    holder: JOINT,
    import_id: "1001",
    format: "card-export",
    reach: { import: "ongoing" },
  },
  "bnkb-personal": {
    bank: "bnkb",
    holder: SOLO,
    iban: "NL00BNKB0000000001",
    format: ACCOUNT,
    reach: { api: BNKB_API },
  },
  "bnkb-joint": {
    bank: "bnkb",
    holder: JOINT,
    iban: "NL00BNKB0000000002",
    format: ACCOUNT,
    reach: { api: BNKB_API },
  },
  "bnkb-personal-savings": {
    bank: "bnkb",
    holder: SOLO,
    iban: "NL00BNKB0000000003",
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnkb-joint-savings": {
    bank: "bnkb",
    holder: JOINT,
    iban: "NL00BNKB0000000004",
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnkb-card": {
    bank: "bnkb",
    holder: JOINT,
    import_id: "2001",
    format: "card-export",
    reach: { import: "ongoing" },
  },
};

export const accountFor = (role: Role, day: number): AccountKey => {
  const atBnkb = day >= SWITCH;
  switch (role) {
    case "personal":
      return "bnka-personal";
    case "personal-savings":
      return "bnka-personal-savings";
    case "joint":
      return atBnkb ? "bnkb-joint" : "bnka-joint";
    case "joint-savings":
      return atBnkb ? "bnkb-joint-savings" : "bnka-joint-savings";
    case "card":
      return atBnkb ? "bnkb-card" : "bnka-card";
    case "second-personal":
      return "bnkb-personal";
    case "second-savings":
      return "bnkb-personal-savings";
  }
};

// Two made-up export formats. The first has a sequence number and a counterparty. The
// second, for cards, has neither a counterparty nor an IBAN.
export const FORMATS: Record<FormatKey, ImportFormat> = {
  "account-export": {
    delimiter: ";",
    encoding: "utf-8",
    account: { column: "Account" },
    id: { column: "Sequence" },
    date: { column: "Booked", format: "YYYY-MM-DD" },
    value_date: { column: "Value date", format: "YYYY-MM-DD" },
    amount: { column: "Amount", decimal: "," },
    currency: { column: "Currency" },
    counterparty_name: { column: "Counterparty" },
    counterparty_account: { column: "Counterparty account" },
    description: { columns: ["Text 1", "Text 2", "Text 3"] },
    code: { column: "Type" },
    original_amount: { column: "Original amount", decimal: "," },
    original_currency: { column: "Original currency" },
  },
  "card-export": {
    delimiter: ";",
    encoding: "utf-8",
    account: { column: "Card" },
    id: { column: "Reference" },
    date: { column: "Booked", format: "YYYY-MM-DD" },
    amount: { column: "Amount", decimal: "," },
    currency: { column: "Currency" },
    description: { columns: ["Text"] },
    original_amount: { column: "Original amount", decimal: "," },
    original_currency: { column: "Original currency" },
  },
};

export const CONFIG: Config = {
  banks: {
    bnka: { aspsp: { name: "Example Bank A", country: "NL" } },
    bnkb: { aspsp: { name: "Example Bank B", country: "NL" } },
  },
  accounts: Object.fromEntries(
    Object.entries(ACCOUNTS).map(([key, account]) => [
      key,
      {
        bank: account.bank,
        ...(account.iban === undefined ? {} : { iban: account.iban }),
        ...(account.import_id === undefined ? {} : { import_id: account.import_id }),
        ...(account.closed === undefined ? {} : { closed: true }),
      },
    ]),
  ),
  imports: FORMATS,
};

export const HISTORY_UNTIL = utcDay(2025, 3, 31);
const HISTORY_IMPORTED_AT = "2025-04-02T19:14:05Z";

// When the row for a transaction booked on `day` was imported, or null if it never was:
// either it falls after a one-off history export, or its quarter has not been exported yet.
export const importedAt = (account: AccountKey, day: number, lastNight: number): string | null => {
  const plan = ACCOUNTS[account].reach.import;
  if (plan === undefined) return null;
  if (day <= HISTORY_UNTIL) return HISTORY_IMPORTED_AT;
  if (plan === "history") return null;
  const { y, m } = parts(day);
  const nextQuarter = utcDay(y, Math.floor((m - 1) / 3) * 3 + 4, 1);
  return nextQuarter >= lastNight ? null : `${iso(nextQuarter)}T20:00:00Z`;
};
```

- [ ] **Step 3: Turn the household's accounts into roles**

Edit `fixtures/household.ts`. The type-checker lists every site you miss; run `npx tsc --noEmit` as you go.

1. Replace the file's header comment with:

   ```ts
   // What the invented household did, day by day, in terms of roles: the joint account, the
   // card, the savings. Which real account a role is on a given day is world.ts's business,
   // and how a posting reached the archive is generate.ts's. Everything here is invented.
   ```

2. Delete the `node:fs` and `node:path` imports, and the types `Amount`, `RawTransaction`, `Revision` and `ArchiveRecord`. Keep `ExchangeRate`, exported, with `Amount` inlined as `{ currency: string; amount: string }`.

3. Delete `FIRST_SYNC`, `OUTAGES`, the old `AccountKey` type, the old `ACCOUNTS`, `SAVINGS_IBAN` and `JOINT_SAVINGS_IBAN`. Delete everything from `inOutage` to the end of the file.

4. Add these imports at the top, and export `START`, `END`, `KINDS`, `hash`, `makeRng` and the `Event` type:

   ```ts
   import {
     businessDayOnOrAfter,
     businessDayOnOrBefore,
     due,
     dutchDate,
     isWeekend,
     MONTHS,
     pad,
     parts,
     utcDay,
   } from "./dates.ts";
   import { ACCOUNTS, accountFor, ROLES, SWITCH } from "./world.ts";
   import type { AccountKey, Role } from "./world.ts";
   ```

   Drop any name from the first import that turns out unused.

5. Add a kind for interest: in the `Kind` union add `"interest"`, and in `KINDS` add `interest: { description: "Rente", code: "RNT" }`.

6. In `Event`, replace `account: AccountKey;` with:

   ```ts
   role: Role;
   // Set only where an event belongs to one specific account whatever the day.
   account?: AccountKey;
   ```

7. In `fakeIban`, replace the bank list with `["BNKC", "BNKD", "BNKE", "BNKF", "BNKG", "BNKH"]`, so no counterparty shares a bank code with the household's own accounts. Set `PARTNER`'s IBAN to `"NL00BNKC0000000004"` (unchanged if already so).

8. In the builders `card`, `debit`, `ideal` and `credit`: rename the parameter `account: AccountKey` to `role: Role`, and the object key `account` to `role`. In `card`, the pass number becomes:

   ```ts
   const pas =
     options.pas ??
     (role === "personal"
       ? "003"
       : role === "second-personal"
         ? "004"
         : r.pick(["001", "001", "002"]));
   ```

   In `debit`, the hash input becomes `` `${creditor}:${role}` ``.

9. Replace `internal` with:

   ```ts
   // A transfer between two of the household's own accounts shows up twice, once on each.
   const internal = (
     day: number,
     from: Role,
     to: Role,
     kind: Kind,
     cents: number,
     lines: string[],
   ): Event[] => {
     const source = ACCOUNTS[accountFor(from, day)];
     const target = ACCOUNTS[accountFor(to, day)];
     return [
       {
         role: from,
         kind,
         cents: -cents,
         party: target.holder,
         iban: target.iban ?? null,
         remittance: lines,
       },
       {
         role: to,
         kind,
         cents,
         party: source.holder,
         iban: source.iban ?? null,
         remittance: lines,
       },
     ];
   };
   ```

10. In `fixedRules`:
    - every `internal(` call gains `day` as its first argument;
    - every object literal with `account: "personal"` or `account: "joint"` becomes `role: ...`;
    - the Netflix and Spotify events become `role: "card"`;
    - the one-sided "Sparen" event becomes
      `events.push(...internal(day, "personal", "personal-savings", "standing", y < 2024 ? 30_000 : 40_000, ["Sparen"]));`
    - add, before `return events;`:

      ```ts
      if (m === 1 && due(day, 2)) {
        for (const role of ["personal-savings", "joint-savings"] as const) {
          events.push({
            role,
            kind: "interest",
            cents: 300 + (hash(`interest:${role}:${y}`) % 3_700),
            party: null,
            iban: null,
            remittance: [`Rente ${y - 1}`],
          });
        }
      }
      if (day >= SWITCH) {
        if (due(day, 1))
          events.push(
            ...internal(day, "personal", "second-personal", "standing", 15_000, ["Zakgeld"]),
          );
        if (due(day, 2))
          events.push(
            ...internal(day, "second-personal", "second-savings", "standing", 5_000, ["Sparen"]),
          );
      }
      ```

11. In `dailyRules`: every `account:` key in an object literal becomes `role:` (the Tikkie and cash-machine events). Add, before `return events;`:

    ```ts
    if (day >= SWITCH && r.chance(0.12)) {
      events.push(card(r, day, "second-personal", r.pick(LUNCH), r.cents(3 * prices, 14 * prices)));
    }
    ```

12. In `tripRules`: the `abroad` helper's parameter becomes `role: Role`, and `abroad("personal")` becomes `abroad("card")`.

13. Replace `balancingRules` with:

    ```ts
    // Keeps balances inside a believable band, the way people move money around at the end
    // of the month. Balances never reach the archive; they only steer these transfers.
    const balancingRules = (day: number, balances: Record<Role, number>): Event[] => {
      const events: Event[] = [];
      if (due(day, 27) && balances.card < 0) {
        events.push(
          ...internal(day, "joint", "card", "debit", -balances.card, ["Afrekening creditcard"]),
        );
      }
      if (!due(day, 28)) return events;

      let personal = balances.personal;
      if (balances.joint < 60_000) {
        const topUp = Math.ceil((100_000 - balances.joint) / 10_000) * 10_000;
        events.push(
          ...internal(day, "personal", "joint", "transfer", topUp, ["Aanvulling huishoudpot"]),
        );
        personal -= topUp;
      } else if (balances.joint > 400_000) {
        events.push(...internal(day, "joint", "joint-savings", "transfer", 150_000, ["Buffer"]));
      }
      // The contribution to the joint account leaves on the 1st, so this has to cover it.
      if (personal > 330_000) {
        const extra = Math.floor((personal - 280_000) / 5_000) * 5_000;
        events.push(
          ...internal(day, "personal", "personal-savings", "transfer", extra, ["Extra sparen"]),
        );
      } else if (personal < 200_000) {
        const back = Math.ceil((250_000 - personal) / 25_000) * 25_000;
        events.push(
          ...internal(day, "personal-savings", "personal", "transfer", back, ["Van spaarrekening"]),
        );
      }
      return events;
    };
    ```

14. Add at the end of the file:

    ```ts
    export type Posting = { day: number; account: AccountKey; event: Event };

    // What moves on the day the second bank is added: the card is settled, and the joint
    // account and its savings are emptied into their successors.
    const switchEvents = (balances: Record<AccountKey, number>): Event[] => {
      const move = (from: AccountKey, to: AccountKey): Event[] => {
        const cents = Math.max(balances[from], 25_000);
        const lines = ["Saldo overboeken"];
        return [
          {
            role: "joint",
            account: from,
            kind: "transfer",
            cents: -cents,
            party: ACCOUNTS[to].holder,
            iban: ACCOUNTS[to].iban ?? null,
            remittance: lines,
          },
          {
            role: "joint",
            account: to,
            kind: "transfer",
            cents,
            party: ACCOUNTS[from].holder,
            iban: ACCOUNTS[from].iban ?? null,
            remittance: lines,
          },
        ];
      };
      const owed = -balances["bnka-card"];
      const settle: Event[] =
        owed <= 0
          ? []
          : [
              {
                role: "joint",
                account: "bnka-joint",
                kind: "debit",
                cents: -owed,
                party: ACCOUNTS["bnka-card"].holder,
                iban: null,
                remittance: ["Afrekening creditcard"],
              },
              {
                role: "card",
                account: "bnka-card",
                kind: "debit",
                cents: owed,
                party: ACCOUNTS["bnka-joint"].holder,
                iban: ACCOUNTS["bnka-joint"].iban ?? null,
                remittance: ["Afrekening creditcard"],
              },
            ];
      return [
        ...settle,
        ...move("bnka-joint", "bnkb-joint"),
        ...move("bnka-joint-savings", "bnkb-joint-savings"),
      ];
    };

    export const simulate = (): Posting[] => {
      const r = makeRng(20261007);
      const balances = Object.fromEntries(Object.keys(ACCOUNTS).map((key) => [key, 0])) as Record<
        AccountKey,
        number
      >;
      balances["bnka-personal"] = 185_000;
      balances["bnka-joint"] = 124_000;
      const scheduled = new Map<number, Event[]>();
      const postings: Posting[] = [];

      const schedule: Schedule = (day, event) => {
        scheduled.set(day, [...(scheduled.get(day) ?? []), event]);
      };
      const post = (day: number, event: Event): void => {
        const account = event.account ?? accountFor(event.role, day);
        balances[account] += event.cents;
        postings.push({ day, account, event });
      };
      const byRole = (day: number): Record<Role, number> =>
        Object.fromEntries(ROLES.map((role) => [role, balances[accountFor(role, day)]])) as Record<
          Role,
          number
        >;

      for (let day = START; day <= END; day++) {
        if (day === SWITCH) for (const event of switchEvents(balances)) post(day, event);
        const trip = TRIPS.find(
          (candidate) => day >= candidate.start && day < candidate.start + candidate.days,
        );
        const events = [
          ...(scheduled.get(day) ?? []),
          ...fixedRules(r, day),
          ...(trip ? tripRules(r, day, trip) : dailyRules(r, day, schedule)),
        ];
        for (const event of events) post(day, event);
        for (const event of balancingRules(day, byRole(day))) post(day, event);
      }
      return postings;
    };
    ```

Run: `npx tsc --noEmit`
Expected: errors only in `fixtures/archive.test.ts`, which still imports the old `generate.ts`.

- [ ] **Step 4: Write the new generator**

`fixtures/generate.ts`:

```ts
// Generates fixtures/archive/ and fixtures/config.json: a synthetic archive in the layout
// docs/archive-format.md describes. Everything in it is invented.
//
//   npm run fixtures
//
// It is deterministic: fixed seeds, a fixed date range, no clock. Every record goes through
// the real merge and the real file rendering, so the fixtures cannot drift from the format.
// fixtures/archive.test.ts fails if the committed files differ from what this produces.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { merge, renderYearFiles } from "@money/shared";
import type { ApiRaw, ArchiveRecord, ImportRaw, Incoming, Target } from "@money/shared";

import { iso, pad, utcDay } from "./dates.ts";
import { END, hash, KINDS, makeRng, simulate } from "./household.ts";
import type { Posting } from "./household.ts";
import { ACCOUNTS, CONFIG, importedAt } from "./world.ts";
import type { AccountKey } from "./world.ts";

export const ARCHIVE_DIR = join(import.meta.dirname, "archive");
export const CONFIG_PATH = join(import.meta.dirname, "config.json");

// The sync that ran the night after the last simulated day.
const LAST_NIGHT = END + 1;

// Nights without a successful sync. Transactions booked in these windows were first seen
// on the night the sync came back.
const OUTAGES: readonly (readonly [number, number])[] = [
  [utcDay(2025, 7, 6), utcDay(2025, 7, 13)],
  [utcDay(2026, 2, 10), utcDay(2026, 2, 12)],
];
const inOutage = (day: number): boolean => OUTAGES.some(([from, to]) => day >= from && day <= to);
const nextSyncNight = (day: number): number => (inOutage(day) ? nextSyncNight(day + 1) : day);
// The sync runs at 03:00 UTC and takes a few seconds, never the same number twice running.
const syncInstant = (day: number): string =>
  `${iso(day)}T03:00:${pad(3 + (hash(`sync:${day}`) % 50))}Z`;

const euros = (cents: number): string => (cents / 100).toFixed(2);
const signedComma = (cents: number): string =>
  `${cents < 0 ? "-" : "+"}${euros(Math.abs(cents)).replace(".", ",")}`;

// The shape is the Transaction schema from Enable Banking's API reference, not an observed
// bank response. Fields the generator has no basis to invent are null, so nothing built on
// this data can come to depend on them.
const apiRaw = ({ day, account, event }: Posting, entryReference: string): ApiRaw => {
  const own = ACCOUNTS[account];
  const isCredit = event.cents > 0;
  const self = { name: own.holder };
  const selfAccount = own.iban === undefined ? null : { iban: own.iban };
  const other = event.party === null ? null : { name: event.party };
  const otherAccount = event.iban === null ? null : { iban: event.iban };
  return {
    entry_reference: entryReference,
    transaction_amount: { currency: "EUR", amount: euros(Math.abs(event.cents)) },
    credit_debit_indicator: isCredit ? "CRDT" : "DBIT",
    status: "BOOK",
    booking_date: iso(day),
    value_date: iso(day),
    transaction_date: iso(day - (event.daysBeforeBooking ?? 0)),
    creditor: isCredit ? self : other,
    creditor_account: isCredit ? selfAccount : otherAccount,
    creditor_agent: null,
    debtor: isCredit ? other : self,
    debtor_account: isCredit ? otherAccount : selfAccount,
    debtor_agent: null,
    bank_transaction_code: { ...KINDS[event.kind], sub_code: null },
    merchant_category_code: null,
    remittance_information: event.remittance,
    exchange_rate: event.exchange ?? null,
    balance_after_transaction: null,
    reference_number: null,
    reference_number_schema: null,
    debtor_account_additional_identification: null,
    creditor_account_additional_identification: null,
    note: null,
    transaction_id: null,
  };
};

// One row of a made-up export file. Every cell is text, in the file's own notation.
const importRow = ({ day, account, event }: Posting, id: string): ImportRaw => {
  const own = ACCOUNTS[account];
  const original = event.exchange?.instructed_amount;
  const foreign = {
    "Original amount": original === undefined ? "" : original.amount.replace(".", ","),
    "Original currency": original?.currency ?? "",
  };
  if (own.format === "card-export") {
    return {
      Card: own.import_id ?? "",
      Currency: "EUR",
      Reference: id,
      Booked: iso(day),
      Amount: signedComma(event.cents),
      Text: event.remittance[0] ?? event.party ?? "",
      ...foreign,
    };
  }
  return {
    Account: own.iban ?? "",
    Currency: "EUR",
    Sequence: id,
    Booked: iso(day),
    "Value date": iso(day),
    Amount: signedComma(event.cents),
    "Counterparty account": event.iban ?? "",
    Counterparty: event.party ?? "",
    Type: KINDS[event.kind].code.toLowerCase(),
    "Text 1": event.remittance[0] ?? "",
    "Text 2": event.remittance[1] ?? "",
    "Text 3": event.remittance[2] ?? "",
    ...foreign,
  };
};

// One batch-to-be: a transaction, where it is going, and when it got there.
export type Arrival = { target: Target; at: string; incoming: Incoming };

export const buildArrivals = (): Arrival[] => {
  const r = makeRng(20250401);
  const references = new Map<string, number>();
  const sequences = new Map<AccountKey, number>();
  const arrivals: Arrival[] = [];

  for (const posting of simulate()) {
    const { day, account, event } = posting;
    const { reach, format } = ACCOUNTS[account];
    const date = iso(day);

    if (reach.api !== undefined && day >= reach.api.from) {
      const key = `${account}:${day}`;
      const sequence =
        (references.get(key) ?? 10_000_000 + (hash(key) % 80_000_000)) + r.int(1, 997);
      references.set(key, sequence);
      const id = `${date.replaceAll("-", "")}-${sequence}`;
      const raw = apiRaw(posting, id);
      const target: Target = { account, source: "api" };

      const booked = day + (r.chance(0.15) ? 2 : 1);
      const firstNight = Math.min(LAST_NIGHT, nextSyncNight(Math.max(reach.api.firstSync, booked)));
      // Now and then the bank changes a transaction after it was first stored. Here the
      // earlier version lacked its last remittance line.
      const revisedNight = nextSyncNight(firstNight + r.int(1, 3));
      const revised = r.chance(0.01) && event.remittance.length > 1 && revisedNight <= LAST_NIGHT;

      const first = revised
        ? { ...raw, remittance_information: event.remittance.slice(0, -1) }
        : raw;
      arrivals.push({ target, at: syncInstant(firstNight), incoming: { id, date, raw: first } });
      if (revised)
        arrivals.push({ target, at: syncInstant(revisedNight), incoming: { id, date, raw } });
    }

    if (reach.import !== undefined) {
      // Numbered whether or not the row was ever exported, as a bank numbers them.
      const sequence = (sequences.get(account) ?? 0) + 1;
      sequences.set(account, sequence);
      const at = importedAt(account, day, LAST_NIGHT);
      if (at !== null) {
        const id =
          format === "card-export"
            ? `P${pad(100_000_000 + sequence * 7_919, 12)}`
            : pad(sequence, 18);
        const target: Target = { account, source: "import", format };
        arrivals.push({ target, at, incoming: { id, date, raw: importRow(posting, id) } });
      }
    }
  }
  return arrivals;
};

// Feeds every arrival through the real merge, per account and source, in the order the
// batches arrived.
export const buildArchive = (arrivals: readonly Arrival[] = buildArrivals()): ArchiveRecord[] =>
  [
    ...Map.groupBy(
      arrivals,
      (arrival) => `${arrival.target.account}/${arrival.target.source}`,
    ).values(),
  ].flatMap((feed) => {
    const inOrder = feed.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let stored: ArchiveRecord[] = [];
    for (const [at, batch] of Map.groupBy(inOrder, (arrival) => arrival.at)) {
      stored = merge(
        stored,
        batch.map((arrival) => arrival.incoming),
        batch[0].target,
        at,
      ).records;
    }
    return stored;
  });

// Path below the archive directory to exact file text.
export const renderArchive = (records: readonly ArchiveRecord[]): Map<string, string> => {
  const files = new Map<string, string>();
  for (const [dir, group] of Map.groupBy(
    records,
    (record) => `${record.account}/${record.source}`,
  )) {
    for (const [name, text] of renderYearFiles(group)) files.set(`${dir}/${name}`, text);
  }
  return files;
};

export const renderConfig = (): string => `${JSON.stringify(CONFIG, null, 2)}\n`;

if (import.meta.main) {
  const files = renderArchive(buildArchive());
  rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(ARCHIVE_DIR, path)), { recursive: true });
    writeFileSync(join(ARCHIVE_DIR, path), text);
  }
  writeFileSync(CONFIG_PATH, renderConfig());
  console.log(`wrote ${files.size} year files and config.json`);
}
```

Add a line to `.prettierignore`:

```text
fixtures/config.json
```

- [ ] **Step 5: Rewrite the fixture tests**

Replace `fixtures/archive.test.ts` with:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { apiStarts, identityOf, validateConfig, view, visibleRecords } from "@money/shared";
import type { ArchiveRecord } from "@money/shared";
import { readArchive } from "@money/shared/node";

import { ARCHIVE_DIR, buildArchive, CONFIG_PATH, renderArchive, renderConfig } from "./generate.ts";
import { ACCOUNTS, CONFIG, FORMATS } from "./world.ts";
import type { AccountKey } from "./world.ts";

const records = buildArchive();
const files = renderArchive(records);
const shown = view(records, FORMATS);
const of = (account: AccountKey, source: "api" | "import"): ArchiveRecord[] =>
  records.filter((record) => record.account === account && record.source === source);

test("the committed archive is exactly what the generator produces", async () => {
  const onDisk = renderArchive(await readArchive(ARCHIVE_DIR));
  assert.deepEqual([...onDisk.keys()].toSorted(), [...files.keys()].toSorted());
  for (const [path, text] of files) {
    // Compared by equality, not deepEqual on the text: a mismatch would print megabytes.
    assert.ok(
      readFileSync(`${ARCHIVE_DIR}/${path}`, "utf8") === text,
      `${path} is stale: run npm run fixtures`,
    );
  }
  assert.ok(
    readFileSync(CONFIG_PATH, "utf8") === renderConfig(),
    "config.json is stale: run npm run fixtures",
  );
});

test("generating twice gives the same bytes", () => {
  assert.deepEqual([...renderArchive(buildArchive())], [...files]);
});

test("the configuration is valid", () => {
  const result = validateConfig(JSON.parse(renderConfig()));
  assert.deepEqual(result.ok ? [] : result.problems, []);
});

test("identity is unique across the whole archive", () => {
  const identities = records.map(identityOf);
  assert.equal(new Set(identities).size, identities.length);
});

test("every configured account has records, and only from the sources that reach it", () => {
  for (const [key, account] of Object.entries(ACCOUNTS) as [
    AccountKey,
    (typeof ACCOUNTS)[AccountKey],
  ][]) {
    assert.equal(of(key, "api").length > 0, account.reach.api !== undefined, `${key} api`);
    assert.equal(of(key, "import").length > 0, account.reach.import !== undefined, `${key} import`);
  }
  assert.deepEqual(
    [...new Set(records.map((record) => record.account))].toSorted(),
    Object.keys(CONFIG.accounts).toSorted(),
  );
});

test("accounts without an IBAN are recognised by their import id", () => {
  for (const key of ["bnka-card", "bnkb-card"] as const) {
    assert.equal(CONFIG.accounts[key].iban, undefined);
    assert.ok(
      of(key, "import").every((record) => record.raw.Card === CONFIG.accounts[key].import_id),
    );
  }
});

test("where both sources cover an account, they overlap and the view hides the import", () => {
  const starts = apiStarts(records);
  for (const key of ["bnka-personal", "bnka-joint"] as const) {
    const start = starts.get(key) ?? "";
    // The API reaches back to 1 January 2025; the first booking is on or just after it.
    assert.ok(start >= "2025-01-01" && start <= "2025-01-03", `${key} starts at ${start}`);
    const overlapping = of(key, "import").filter((record) => record.date >= start);
    assert.ok(
      overlapping.length > 50,
      `${key} has only ${overlapping.length} overlapping import records`,
    );
    assert.ok(of(key, "import").some((record) => record.date < start));
    const visible = new Set(visibleRecords(records).map(identityOf));
    assert.ok(overlapping.every((record) => !visible.has(identityOf(record))));
  }
  assert.ok(shown.length < records.length);
});

test("the closed account receives nothing after it closed", () => {
  assert.equal(CONFIG.accounts["bnka-joint"].closed, true);
  const last = of("bnka-joint", "api").at(-1)?.date ?? "";
  assert.equal(last, "2026-04-01");
});

test("a transfer between two of the household's accounts appears on both", () => {
  const moved = shown.filter(
    (item) =>
      item.description === "Saldo overboeken" &&
      ["bnka-joint", "bnkb-joint"].includes(item.account),
  );
  assert.deepEqual(moved.map((item) => item.account).toSorted(), ["bnka-joint", "bnkb-joint"]);
  assert.equal(moved[0].amount + moved[1].amount, 0);
});

test("every record normalises, and amounts are never zero", () => {
  assert.ok(shown.every((item) => Number.isSafeInteger(item.amount) && item.amount !== 0));
  assert.ok(shown.every((item) => item.currency === "EUR"));
});

test("no generated IBAN can be a real one", () => {
  const ibans = shown.flatMap((item) =>
    item.counterparty_account === null ? [] : [item.counterparty_account],
  );
  assert.ok(ibans.length > 1000);
  // Check digits 00 never pass the IBAN checksum.
  for (const iban of ibans) assert.match(iban, /^NL00[A-Z]{4}\d{10}$/);
  for (const account of Object.values(CONFIG.accounts)) {
    if (account.iban !== undefined) assert.match(account.iban, /^NL00BNK[AB]\d{10}$/);
  }
});

test("records were seen after they were booked, and revisions after that", () => {
  for (const record of records) {
    assert.ok(record.first_seen.slice(0, 10) > record.date, identityOf(record));
    for (const revision of record.revisions) assert.ok(revision.replaced_at > record.first_seen);
  }
});

test("the archive contains the cases the app has to handle", () => {
  const count = (predicate: (item: (typeof shown)[number]) => boolean): number =>
    shown.filter(predicate).length;
  assert.ok(records.length > 5000, `only ${records.length} records`);
  assert.ok(count((item) => item.revised) > 5, "revised transactions");
  assert.ok(count((item) => item.original_currency !== null) > 20, "foreign-currency transactions");
  assert.ok(
    count((item) => item.counterparty_name === null) > 100,
    "transactions without a counterparty",
  );
  assert.ok(count((item) => item.amount > 0) > 300, "credits");
  assert.ok(count((item) => item.source === "import") > 2000, "imported transactions in view");

  const lookalikes = Map.groupBy(shown, (item) =>
    [item.account, item.date, item.counterparty_name, item.amount, item.description].join("\u0000"),
  );
  assert.ok(
    [...lookalikes.values()].some((group) => group.length > 1),
    "identical-looking transactions on one day",
  );

  const firstSeen = Map.groupBy(of("bnka-personal", "api"), (record) =>
    record.first_seen.slice(0, 10),
  );
  assert.ok(!firstSeen.has("2025-07-08"), "a night without a sync");
});
```

- [ ] **Step 6: Generate, and look at what came out**

Run: `npm run fixtures`
Expected: `wrote N year files and config.json`, with N around 40.

Run: `find fixtures/archive -name '*.json' | sort | head -50 && du -sh fixtures/archive`
Expected: ten account directories; `api/` under the four fetched accounts, `import/` under the eight imported ones; a total around 7 MB.

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS. If a count in "the archive contains the cases" is off, print the real number and adjust the threshold to roughly two thirds of it; these thresholds guard against an empty category, not an exact size. If "the closed account" fails on its date, print `of("bnka-joint", "api").at(-1)?.date`: it must be the switch day, and anything later means an event is still being routed to the old account.

- [ ] **Step 7: Remove the empty `test/` directory**

Run: `rmdir test 2>/dev/null; git status --short | head`
Expected: no `test/` directory remains.

- [ ] **Step 8: Commit**

```bash
npm run format
git add -A
git commit -m "feat(fixtures): two banks, ten accounts, both sources, through the real merge"
```

---

### Task 11: Continuous integration

**Files:**

- Create: `.github/workflows/ci.yml`

**Interfaces:**

- Produces: two jobs, `static-analysis` and `tests`, on every push and pull request.

- [ ] **Step 1: Find the commit SHAs to pin**

```bash
gh api repos/actions/checkout/releases/latest --jq '.tag_name'
gh api repos/actions/setup-node/releases/latest --jq '.tag_name'
```

For each tag printed, resolve it to a commit:

```bash
gh api repos/actions/checkout/commits/<tag> --jq '.sha'
gh api repos/actions/setup-node/commits/<tag> --jq '.sha'
```

Expected: two 40-character SHAs. Use them, with the tag as a trailing comment, in the next step.

- [ ] **Step 2: Write the workflow**

`.github/workflows/ci.yml`, with the two SHAs and tags filled in:

```yaml
name: ci

on:
  push:
  pull_request:

# The workflow reads the repository and nothing else. It holds no secret.
permissions:
  contents: read

jobs:
  static-analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<checkout-sha> # <checkout-tag>
      - uses: actions/setup-node@<setup-node-sha> # <setup-node-tag>
        with:
          node-version-file: package.json
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run format:check

  tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<checkout-sha> # <checkout-tag>
      - uses: actions/setup-node@<setup-node-sha> # <setup-node-tag>
        with:
          node-version-file: package.json
          cache: npm
      - run: npm ci
      - run: npm test
```

- [ ] **Step 3: Check it locally**

Run: `npm run format:check && grep -c '@[0-9a-f]\{40\} #' .github/workflows/ci.yml`
Expected: formatting passes, and the count is `4`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci(tooling): typecheck, lint, format and tests on every push"
```

---

### Task 12: Bring the durable docs up to date, integrate, and watch the run

**Files:**

- Modify: `docs/architecture.md`, `README.md`, `CLAUDE.md`, `docs/testing.md`, `docs/specs/2026-10-08-archive-format.md`

- [ ] **Step 1: Update the durable docs**

`docs/architecture.md`: replace the status note at the top with:

```markdown
> **Status.** Built: the `shared` workspace (the archive format, merge, the normalised view, configuration) and the synthetic archive. Not built yet: `sync`, `api`, `app`.
```

`README.md`, section "Development data": replace the first bullet with:

```markdown
- **`fixtures/archive/`** is a synthetic archive in the layout [docs/archive-format.md](docs/archive-format.md) describes: two made-up banks, ten accounts, both sources, with `fixtures/config.json` beside it. The dashboard is built against it.
```

and in the second bullet replace ``**`fixtures/generate.ts`** produces it`` with ``**`npm run fixtures`** produces it``.

`CLAUDE.md`, section "Layout": delete the sentence `Until the first slice creates the workspaces, the only code is `fixtures/`and`test/`.` and replace the `fixtures/` lines of the tree with:

```text
fixtures/
  household.ts     what the invented household did
  world.ts         its accounts, and how each reaches the archive
  generate.ts      feeds it through the real merge
  archive/         generated
  config.json      generated
scripts/           repository checks
```

`docs/testing.md`, section "Status": set the rows for CI and for the workspace-link check and dependency rule to `in place`, and change the fixture row's file to `fixtures/archive.test.ts`.

- [ ] **Step 2: Record what moved in the spec**

Append to `docs/specs/2026-10-08-archive-format.md`:

```markdown
## What moved while it was built

- **The record gained a `date` field.** A record has to be filed under a year when it is written, and a file has to be checkable against its own name without interpreting `raw`. Recorded in [archive-format.md](../archive-format.md).
- **`store.ts` is a separate, Node-only entry**, `@money/shared/node`, so the main entry stays free of I/O. Recorded in [architecture.md](../architecture.md).
- **`merge` reports `added`, `revised` and `unchanged`** instead of a list of warnings. A stored record missing from a fetch can only be noticed by something that knows the fetch window, which is the sync slice's.
- **The same id twice in one batch** is stored once when the two are identical, and is an error when they differ.
- **The generator is three files**, not one: `household.ts`, `world.ts` and `generate.ts`.
```

Add to that list anything else that departed from the spec during the work, in one sentence each. If a departure changes how the system works, write it into the durable doc that owns the subject as well.

- [ ] **Step 3: Run the whole suite on the branch**

Run: `npm run format && npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: all pass. Read the test report: the `tests` and `pass` counts match, `fail` is 0.

```bash
git add -A
git commit -m "docs: the archive format is built"
```

- [ ] **Step 4: Integrate, as CLAUDE.md prescribes**

If this work was done in a git worktree, leave it first and do the rest in the main checkout.

```bash
git checkout archive-format && git rebase main
git checkout main && git merge --ff-only archive-format
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test
```

Expected: the fast-forward succeeds, and the full suite passes on `main`. Only then:

```bash
git push
```

- [ ] **Step 5: Watch the run**

```bash
gh run list --limit 1
gh run watch <id> --exit-status
```

Expected: both jobs green. On a failure: `gh run view <id> --log-failed`, fix on a branch, and integrate the same way.

Then set the CI row in `docs/testing.md` if it was left pending, and delete the merged branch: `git branch -d archive-format`.

---

## Self-Review

- **Spec coverage.** Workspaces and the link check: Task 1. `record.ts`: Task 2. `merge.ts`: Task 3. `files.ts`: Task 4. `src/config/`: Task 5. `normalise.ts`: Task 6. `view.ts`: Task 7. `store.ts`: Task 8. Tier 2 properties: Task 9. Fixtures and their assertions: Task 10. CI: Task 11. "Done when", including the docs and the watched run: Task 12.
- **Not in this plan, by the spec:** reading exported files, the inbox, the fetch window, the Enable Banking client, any command, rules and categories.
- **Review Focus** items each have a test: 1 and 2 in `amounts.test.ts`; 3 in `normalise.test.ts` ("only the guaranteed fields", "explicit nulls"); 4 in `merge.test.ts` ("a revised booking date") and `store.test.ts` ("moved to another year"); 5 in `store.test.ts` ("dot-prefixed names", the four strays).
