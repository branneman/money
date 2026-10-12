import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRaw, anApiRecord } from "../../testing/factories.ts";
import { laterCopy } from "./recover.ts";

const earlier = anApiRecord({ id: "a", date: "2025-12-31" });
const later = anApiRecord({
  id: "a",
  date: "2026-01-02",
  revisions: [{ replaced_at: "2026-01-03T03:00:00Z", raw: earlier.raw }],
  raw: anApiRaw({ booking_date: "2026-01-02" }),
});

test("of the two copies an interrupted write leaves, the revised one is kept", () => {
  assert.equal(laterCopy(earlier, later), later);
  assert.equal(laterCopy(later, earlier), later);
});

test("a copy that already had revisions is still recognised", () => {
  const first = { replaced_at: "2025-12-31T03:00:00Z", raw: anApiRaw({ value_date: null }) };
  const before = { ...earlier, revisions: [first] };
  const after = { ...later, revisions: [first, ...later.revisions] };
  assert.equal(laterCopy(before, after), after);
});

test("a copy that is several revisions ahead is still the later one", () => {
  // One write can add more than one revision: a run is merged page by page.
  const further = {
    ...later,
    revisions: [...later.revisions, { replaced_at: "2026-01-03T03:00:00Z", raw: later.raw }],
  };
  assert.equal(laterCopy(earlier, further), further);
  assert.equal(laterCopy(further, earlier), further);
});

test("two copies that an interrupted write does not explain are refused", () => {
  const cases = {
    "identical copies": earlier,
    "another transaction": { ...later, id: "b" },
    "another account": { ...later, account: "bnka-joint" },
    "a revision that is not the other copy": {
      ...later,
      revisions: [{ replaced_at: "2026-01-03T03:00:00Z", raw: anApiRaw({ value_date: null }) }],
    },
    "first seen at another time": { ...later, first_seen: "2025-01-04T03:00:00Z" },
  };
  for (const [name, other] of Object.entries(cases)) {
    assert.equal(laterCopy(earlier, other), null, name);
  }
});
