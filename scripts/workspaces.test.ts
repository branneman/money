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
