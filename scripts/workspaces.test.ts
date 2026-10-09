import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { dependencyProblems, linkProblems, readWorkspaces } from "./workspaces.ts";
import type { Workspace } from "./workspaces.ts";

const ROOT = join(import.meta.dirname, "..");
const workspace = (dir: string, fields: Partial<Workspace> = {}): Workspace => ({
  dir,
  name: `@money/${dir}`,
  dependencies: {},
  optionalDependencies: {},
  peerDependencies: {},
  ...fields,
});
const shared = workspace("shared");
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
  const ok = workspace("sync", { dependencies: { "@money/shared": "*" } });
  const bad = workspace("api", { dependencies: { leftpad: "^1.0.0" } });
  assert.deepEqual(dependencyProblems([shared, ok]), []);
  assert.match(dependencyProblems([bad])[0], /@money\/api depends on leftpad/);
});

test("the browser workspace is not held to the server rule", () => {
  const app = workspace("app", {
    dependencies: { anything: "1" },
    optionalDependencies: { something: "1" },
    peerDependencies: { other: "1" },
  });
  assert.deepEqual(dependencyProblems([app]), []);
});

test("an optional dependency of a server workspace is held to the same rule", () => {
  const ok = workspace("sync", { optionalDependencies: { "@money/shared": "*" } });
  const bad = workspace("api", { optionalDependencies: { leftpad: "^1.0.0" } });
  assert.deepEqual(dependencyProblems([ok]), []);
  assert.deepEqual(dependencyProblems([bad]).length, 1);
  assert.match(dependencyProblems([bad])[0], /@money\/api depends on leftpad/);
});

test("a peer dependency of a server workspace is held to the same rule", () => {
  const ok = workspace("sync", { peerDependencies: { "@money/shared": "*" } });
  const bad = workspace("shared", { peerDependencies: { leftpad: "^1.0.0" } });
  assert.deepEqual(dependencyProblems([ok]), []);
  assert.deepEqual(dependencyProblems([bad]).length, 1);
  assert.match(dependencyProblems([bad])[0], /@money\/shared depends on leftpad/);
});

test("this repository obeys the dependency rule", () => {
  const workspaces = readWorkspaces(ROOT);
  assert.ok(workspaces.some((workspace) => workspace.dir === "shared"));
  assert.deepEqual(dependencyProblems(workspaces), []);
});
