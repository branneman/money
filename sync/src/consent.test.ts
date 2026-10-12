import assert from "node:assert/strict";
import { test } from "node:test";

import { consentAt } from "./consent.ts";

const UNTIL = "2027-04-09T10:00:00Z";

test("a consent far from its end is neither expired nor warned about", () => {
  assert.deepEqual(consentAt(UNTIL, "2026-10-11T03:00:00Z", 14), {
    expired: false,
    daysLeft: 180,
    warn: false,
  });
});

test("the warning starts exactly the given number of days before the end", () => {
  assert.equal(consentAt(UNTIL, "2027-03-26T09:59:59Z", 14).warn, false);
  assert.deepEqual(consentAt(UNTIL, "2027-03-26T10:00:00Z", 14), {
    expired: false,
    daysLeft: 14,
    warn: true,
  });
});

test("days left are whole days, rounded down", () => {
  assert.equal(consentAt(UNTIL, "2027-04-08T10:00:01Z", 14).daysLeft, 0);
  assert.equal(consentAt(UNTIL, "2027-04-08T10:00:00Z", 14).daysLeft, 1);
});

test("a consent is expired from the instant it ends", () => {
  assert.equal(consentAt(UNTIL, "2027-04-09T09:59:59Z", 14).expired, false);
  assert.deepEqual(consentAt(UNTIL, UNTIL, 14), { expired: true, daysLeft: 0, warn: true });
  assert.deepEqual(consentAt(UNTIL, "2027-05-01T00:00:00Z", 14), {
    expired: true,
    daysLeft: 0,
    warn: true,
  });
});

test("a warning window of nothing warns only once expired", () => {
  assert.equal(consentAt(UNTIL, "2027-04-09T09:59:59Z", 0).warn, false);
  assert.equal(consentAt(UNTIL, UNTIL, 0).warn, true);
});
