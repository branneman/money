import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMIT, makeLimiter } from "./limiter.ts";

const start = Date.parse("2026-11-28T10:00:00Z");

const setup = () => {
  let now = start;
  const limiter = makeLimiter(() => new Date(now));
  const advance = (seconds: number) => {
    now += seconds * 1000;
  };
  return { limiter, advance };
};

const fail = (limiter: ReturnType<typeof makeLimiter>, name: string, times: number) => {
  for (let i = 0; i < times; i++) limiter.failed(name);
};

test("the limit is five failures in fifteen minutes", () => {
  assert.deepEqual(LIMIT, { failures: 5, windowMs: 900_000 });
});

test("four failures leave the username served", () => {
  const { limiter } = setup();
  fail(limiter, "anna", 4);
  assert.equal(limiter.retryAfter("anna"), null);
});

test("the fifth failure locks the username for the whole window", () => {
  const { limiter } = setup();
  fail(limiter, "anna", 5);
  assert.equal(limiter.retryAfter("anna"), 900);
});

test("retryAfter counts down, rounded up, and ends at the window's end", () => {
  const { limiter, advance } = setup();
  fail(limiter, "anna", 5);
  advance(899);
  assert.equal(limiter.retryAfter("anna"), 1);
  advance(1);
  assert.equal(limiter.retryAfter("anna"), null);
});

test("retryAfter rounds a part second up", () => {
  let now = start;
  const limiter = makeLimiter(() => new Date(now));
  fail(limiter, "anna", 5);
  now += 899_500;
  assert.equal(limiter.retryAfter("anna"), 1);
});

test("after the window, counting starts again from zero", () => {
  const { limiter, advance } = setup();
  fail(limiter, "anna", 5);
  advance(900);
  fail(limiter, "anna", 4);
  assert.equal(limiter.retryAfter("anna"), null);
  limiter.failed("anna");
  assert.equal(limiter.retryAfter("anna"), 900);
});

test("the window starts at the first failure and is not extended by later ones", () => {
  const { limiter, advance } = setup();
  limiter.failed("anna");
  advance(600);
  fail(limiter, "anna", 4);
  assert.equal(limiter.retryAfter("anna"), 300);
});

test("a success clears the count", () => {
  const { limiter } = setup();
  fail(limiter, "anna", 4);
  limiter.succeeded("anna");
  fail(limiter, "anna", 4);
  assert.equal(limiter.retryAfter("anna"), null);
});

test("a success clears a lock", () => {
  const { limiter } = setup();
  fail(limiter, "anna", 5);
  limiter.succeeded("anna");
  assert.equal(limiter.retryAfter("anna"), null);
});

test("another username is unaffected", () => {
  const { limiter } = setup();
  fail(limiter, "anna", 5);
  assert.equal(limiter.retryAfter("ben"), null);
  fail(limiter, "ben", 4);
  assert.equal(limiter.retryAfter("ben"), null);
});

test("names that look like object internals are ordinary usernames", () => {
  const { limiter } = setup();
  fail(limiter, "__proto__", 5);
  assert.equal(limiter.retryAfter("__proto__"), 900);
  assert.equal(limiter.retryAfter("constructor"), null);
  assert.equal(limiter.retryAfter("toString"), null);
});

test("after a window, a username failed once needs five fresh failures again", () => {
  const { limiter, advance } = setup();
  for (let i = 0; i < 10_000; i++) limiter.failed(`user-${i}`);
  advance(900);
  fail(limiter, "user-0", 4);
  assert.equal(limiter.retryAfter("user-0"), null);
  limiter.failed("user-0");
  assert.equal(limiter.retryAfter("user-0"), 900);
  assert.equal(limiter.retryAfter("user-9999"), null);
});
