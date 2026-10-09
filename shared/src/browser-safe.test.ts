import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

// Every module specifier in a file's import and export statements, static or dynamic.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

const specifiersOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((match) => match[1]);

// Every file reachable from `entry` through relative imports, test files left out.
const reachableFrom = (entry: string): string[] => {
  const reached = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (reached.has(file) || file.endsWith(".test.ts")) continue;
    reached.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) queue.push(join(dirname(file), specifier));
    }
  }
  return [...reached].toSorted();
};

test("nothing the browser-safe entry reaches imports a node: module", () => {
  const root = import.meta.dirname;
  const reached = reachableFrom(join(root, "index.ts"));
  assert.ok(reached.length > 5, `the walk reached only ${reached.length} files`);
  const offenders = reached.flatMap((file) =>
    specifiersOf(file)
      .filter((specifier) => specifier.startsWith("node:"))
      .map((specifier) => `${relative(root, file)} imports ${specifier}`),
  );
  assert.deepEqual(offenders, []);
});
