import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { booked, makeWorld } from "../testing/world.ts";

const A = "NL00BNKA0000000001";
const B = "NL00BNKB0000000001";

const secret = (id: string, date: string): Record<string, unknown> =>
  booked(id, date, {
    transaction_amount: { currency: "EUR", amount: "9876.54" },
    creditor: { name: "Recognisable Person" },
    creditor_account: { iban: "NL00BNKC0000000077" },
    remittance_information: ["Recognisable text"],
  });

test("nothing a bank sent, and nothing that identifies a session, is ever printed", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  world.add(A, secret("ref-secret-1", "2026-02-20"));
  const gone = world.add(A, secret("ref-secret-2", "2026-02-21"));
  world.add(B, secret("ref-secret-3", "2026-02-20"));

  // Everything going well.
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(await world.run("auth", "bnkb"), 0);
  assert.equal(await world.run("status"), 0);

  // A new transaction, and one the bank withdrew.
  world.at("2026-03-02T03:00:00Z");
  gone.push({ from: "2026-03-01T12:00:00Z", raw: null });
  world.add(A, secret("ref-secret-4", "2026-03-01"));
  assert.equal(await world.run("sync"), 1);

  // An error response, whose message and detail are recognisable.
  world.at("2026-03-03T03:00:00Z");
  world.bank.failRequest(1, { status: 500, error: "ASPSP_ERROR" });
  assert.equal(await world.run("sync"), 1);

  // An answer that is not JSON.
  world.at("2026-03-04T03:00:00Z");
  world.bank.failRequest(1, { body: "<html>Recognisable gateway page</html>" });
  assert.equal(await world.run("sync"), 1);

  // A booked transaction without its identifier, at the second bank.
  world.at("2026-03-05T03:00:00Z");
  world.add(B, secret("", "2026-03-04"));
  assert.equal(await world.run("sync"), 1);

  // A number that would not survive being stored, at the first bank.
  world.at("2026-03-06T03:00:00Z");
  const odd =
    '{"transactions":[{"status":"BOOK","entry_reference":"ref-secret-5",' +
    '"booking_date":"2026-03-05","note":"Recognisable note","rate":1.10}]}';
  world.bank.failRequest(1, { body: odd });
  assert.equal(await world.run("sync"), 1);

  // An error nobody expected: a file where an account's inbox directory belongs.
  world.at("2026-03-07T03:00:00Z");
  await rm(join(world.dataDir, ".inbox", "bnka-joint"), { recursive: true });
  await writeFile(join(world.dataDir, ".inbox", "bnka-joint"), "Recognisable contents");
  assert.equal(await world.run("sync"), 1);

  const printed = world.lines.join("\n");

  // The run did meet each of those outcomes.
  for (const outcome of [
    /authorised bank=bnka/,
    /were absent from a fetch that should hold them/,
    /Enable Banking answered 500 ASPSP_ERROR/,
    /page 1 is not valid JSON/,
    /is booked without an entry_reference/,
    /holds a number that would not survive being stored/,
    /unexpected Error ENOTDIR/,
  ]) {
    assert.match(printed, outcome);
  }

  const states = [await world.state("bnka"), await world.state("bnkb")];
  const sessions = states.flatMap((state) =>
    state === null
      ? []
      : [state.session_id, ...Object.values(state.accounts).map((account) => account.uid)],
  );
  assert.equal(sessions.length, 5);
  const forbidden = [
    "9876.54",
    "Recognisable",
    "NL00",
    "ref-secret",
    "state-from-the-test",
    world.dataDir,
    ...sessions,
  ];
  for (const text of forbidden) {
    assert.ok(!printed.includes(text), `something printed holds ${text.slice(0, 8)}...`);
  }
});
