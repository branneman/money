import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { makeWorld, worldAspsps } from "../../testing/world.ts";

test("banks prints each name Enable Banking lists for a country, as the configuration file takes it", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  assert.equal(await world.run("banks", "NL"), 0);
  assert.deepEqual(world.lines, ['"Example Bank"', '"Other Example Bank"']);
  assert.deepEqual(
    world.bank.requests.map((request) => request.path),
    ["/aspsps"],
  );
});

test("a name is printed as JSON, so nothing in it can pass for a line of its own", async (t) => {
  const aspsps = worldAspsps();
  aspsps[0].name = 'Example "Bank"\nof examples';
  const world = await makeWorld({ aspsps });
  t.after(world.cleanup);
  assert.equal(await world.run("banks", "NL"), 0);
  assert.equal(world.lines[0], '"Example \\"Bank\\"\\nof examples"');
});

test("banks fails for a country with no bank listed", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  assert.equal(await world.run("banks", "BE"), 1);
  assert.deepEqual(world.lines, ["Enable Banking lists no bank for the country BE"]);
});

test("banks takes one country, as two capital letters", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  for (const argv of [
    ["banks"],
    ["banks", "nl"],
    ["banks", "Netherlands"],
    ["banks", "NL", "BE"],
  ]) {
    world.lines.length = 0;
    assert.equal(await world.run(...argv), 1);
    assert.deepEqual(world.lines, [
      "usage: auth <bank> [--show-ibans] | sync | status | banks <country>",
    ]);
  }
  assert.equal(world.bank.requests.length, 0);
});

test("banks reads only, so a lock held by a running sync does not stop it", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  await writeFile(join(world.stateDir, "lock"), "999\n");
  world.alive.add(999);
  assert.equal(await world.run("banks", "NL"), 0);
});

test("auth for a bank that is not listed says how to see the names that are", async (t) => {
  const world = await makeWorld({ aspsps: worldAspsps().slice(1) });
  t.after(world.cleanup);
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.deepEqual(world.lines, [
    "bnka: Enable Banking lists no bank under the configured name and country. Run banks <country> for the names it lists; the name must match exactly.",
  ]);
});
