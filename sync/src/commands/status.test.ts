import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { makeWorld, worldConfig } from "../../testing/world.ts";
import type { World } from "../../testing/world.ts";

const authorised = async (t: TestContext): Promise<World> => {
  const world = await makeWorld();
  t.after(world.cleanup);
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(await world.run("auth", "bnkb"), 0);
  world.bank.requests.length = 0;
  world.lines.length = 0;
  return world;
};

test("status prints each consent and each account's last full fetch, and asks the bank nothing", async (t) => {
  const world = await authorised(t);
  world.at("2026-03-05T03:00:00Z");
  assert.equal(await world.run("status"), 0);
  assert.deepEqual(world.lines, [
    "bnka: the consent lasts until 2026-08-28, 176 days from now",
    "  bnka-current: last fetched in full on 2026-03-01",
    "  bnka-joint: last fetched in full on 2026-03-01",
    "bnkb: the consent lasts until 2026-08-28, 176 days from now",
    "  bnkb-current: last fetched in full on 2026-03-01",
  ]);
  assert.equal(world.bank.requests.length, 0);
});

test("status fails for a bank that was never authorised", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  assert.equal(await world.run("status"), 1);
  assert.deepEqual(world.lines, [
    "bnka: no consent is stored. Run: auth bnka",
    "bnkb: no consent is stored. Run: auth bnkb",
  ]);
});

// A configuration the API can fetch nothing from would otherwise report nothing, and pass.
for (const [name, accounts] of [
  ["no accounts at all", {}],
  [
    "only accounts that are imported or closed",
    {
      "bnka-card": { bank: "bnka", import_id: "1001" },
      "bnka-old": { bank: "bnka", iban: "NL00BNKA0000000003", closed: true },
    },
  ],
] as const) {
  test(`status fails when no account is fetched through the API: ${name}`, async (t) => {
    const world = await makeWorld({ config: { ...worldConfig(), accounts } });
    t.after(world.cleanup);
    assert.equal(await world.run("status"), 1);
    assert.deepEqual(world.lines, [
      "no account is fetched through the API: none is open and has an iban",
    ]);
  });
}

test("status fails inside the warning window, so that the warning reaches someone", async (t) => {
  const world = await authorised(t);
  world.at("2026-08-14T02:59:59Z");
  assert.equal(await world.run("status"), 0);
  world.lines.length = 0;
  world.at("2026-08-20T03:00:00Z");
  assert.equal(await world.run("status"), 1);
  assert.equal(
    world.lines[0],
    "bnka: the consent lasts until 2026-08-28, 8 days from now. Run: auth bnka",
  );
});

test("status fails for an expired consent, and says when it ended", async (t) => {
  const world = await authorised(t);
  world.at("2026-09-01T03:00:00Z");
  assert.equal(await world.run("status"), 1);
  assert.equal(world.lines[0], "bnka: the consent expired on 2026-08-28. Run: auth bnka");
});

test("an account whose first fetch never finished says so", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  await world.openSession("bnka");
  await world.openSession("bnkb");
  assert.equal(await world.run("status"), 0);
  assert.equal(world.lines[1], "  bnka-current: never fetched in full");
});

test("status reads only, so a lock held by a running sync does not stop it", async (t) => {
  const world = await authorised(t);
  await writeFile(join(world.stateDir, "lock"), "999\n");
  world.alive.add(999);
  assert.equal(await world.run("status"), 0);
});
