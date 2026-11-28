import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import type { Person } from "../people.ts";
import { SCRYPT } from "./password.ts";
import {
  SESSION_COOKIE,
  SESSION_MS,
  clearedCookie,
  cookieValue,
  csrfMatches,
  csrfToken,
  decodeSession,
  encodeSession,
  sessionCookie,
  signingKey,
} from "./session.ts";

const secret = Buffer.alloc(32, 7);

const person = (overrides: Partial<Person> = {}): Person => ({
  key: "ann",
  username: "ann-login",
  password: {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: Buffer.alloc(SCRYPT.saltBytes, 1),
    key: Buffer.alloc(SCRYPT.keyBytes, 2),
  },
  ...overrides,
});

const key = signingKey(secret, person());
const keyFor = (personKey: string): Buffer | null => (personKey === "ann" ? key : null);
const issuedAt = Date.UTC(2026, 10, 1, 12);
const issued = encodeSession({ person: "ann", issuedAt }, key);
const [issuedPayload, issuedSignature] = issued.split(".");

const b64 = (text: string): string => Buffer.from(text).toString("base64url");
const signed = (payload: string, withKey: Buffer): string => {
  const first = b64(payload);
  return `${first}.${createHmac("sha256", withKey).update(first).digest("base64url")}`;
};

test("a session round-trips", () => {
  assert.deepEqual(decodeSession(issued, keyFor, issuedAt + 1000), {
    person: "ann",
    issuedAt,
  });
});

test("a session ends at exactly seven days", () => {
  assert.equal(SESSION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.notEqual(decodeSession(issued, keyFor, issuedAt + SESSION_MS - 1), null);
  assert.equal(decodeSession(issued, keyFor, issuedAt + SESSION_MS), null);
});

test("a login time one millisecond in the future is refused", () => {
  assert.notEqual(decodeSession(issued, keyFor, issuedAt), null);
  assert.equal(decodeSession(issued, keyFor, issuedAt - 1), null);
});

test("a tampered person, time or signature is refused", () => {
  const other = encodeSession({ person: "bob", issuedAt }, key).split(".")[0];
  const later = encodeSession({ person: "ann", issuedAt: issuedAt + 1 }, key).split(".")[0];
  assert.equal(
    decodeSession(`${other}.${issuedSignature}`, () => key, issuedAt),
    null,
  );
  assert.equal(decodeSession(`${later}.${issuedSignature}`, keyFor, issuedAt + 5), null);
  const flipped = issuedSignature.startsWith("A")
    ? `B${issuedSignature.slice(1)}`
    : `A${issuedSignature.slice(1)}`;
  assert.equal(decodeSession(`${issuedPayload}.${flipped}`, keyFor, issuedAt), null);
});

test("a new password or a new username ends the old cookie", () => {
  const newPassword = person({
    password: { ...person().password, key: Buffer.alloc(SCRYPT.keyBytes, 3) },
  });
  const newUsername = person({ username: "ann-new" });
  for (const changed of [newPassword, newUsername]) {
    const changedKey = signingKey(secret, changed);
    assert.notDeepEqual(changedKey, key);
    assert.equal(
      decodeSession(issued, () => changedKey, issuedAt),
      null,
    );
  }
  assert.notDeepEqual(signingKey(Buffer.alloc(32, 8), person()), key);
});

test("an unknown person is refused", () => {
  const stranger = encodeSession({ person: "zed", issuedAt }, key);
  assert.equal(decodeSession(stranger, keyFor, issuedAt), null);
});

test("malformed values are refused, never thrown", async (t) => {
  const cases: Record<string, string> = {
    empty: "",
    "no dot": "abc",
    "two dots": `${issued}.x`,
    "empty parts": ".",
    "empty signature": `${issuedPayload}.`,
    "non-alphabet payload": `${issuedPayload}=.${issuedSignature}`,
    "standard base64 signature": `${issuedPayload}.${issuedSignature}+`,
    "padded signature": `${issued}=`,
    "not json": signed("nope", key),
    "json array": signed("[]", key),
    "json null": signed("null", key),
    "missing time": signed('{"p":"ann"}', key),
    "extra field": signed('{"p":"ann","t":1,"x":1}', key),
    "person a number": signed('{"p":1,"t":1}', key),
    "time a string": signed(`{"p":"ann","t":"${issuedAt}"}`, key),
    "time a fraction": signed(`{"p":"ann","t":${issuedAt}.5}`, key),
  };
  for (const [name, value] of Object.entries(cases)) {
    await t.test(name, () => assert.equal(decodeSession(value, keyFor, issuedAt + 1), null));
  }
});

test("the cookie attributes are exactly these", () => {
  assert.equal(SESSION_COOKIE, "__Host-session");
  assert.equal(
    sessionCookie("abc"),
    "__Host-session=abc; Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Strict",
  );
  assert.equal(
    clearedCookie(),
    "__Host-session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
  );
});

test("cookieValue finds the session cookie", async (t) => {
  await t.test("alone", () => assert.equal(cookieValue("__Host-session=abc"), "abc"));
  await t.test("among others", () =>
    assert.equal(cookieValue("a=1; __Host-session=abc; b=2"), "abc"),
  );
  await t.test("with odd spacing", () =>
    assert.equal(cookieValue("  a=1 ;__Host-session=abc  ;b=2;"), "abc"),
  );
  await t.test("not by prefix or suffix", () => {
    assert.equal(cookieValue("x__Host-session=abc; __Host-sessions=d"), null);
  });
  await t.test("absent", () => {
    assert.equal(cookieValue(undefined), null);
    assert.equal(cookieValue(""), null);
    assert.equal(cookieValue("a=1"), null);
  });
  await t.test("twice is null", () => {
    assert.equal(cookieValue("__Host-session=a; __Host-session=b"), null);
    assert.equal(cookieValue("__Host-session=a; x=1; __Host-session=a"), null);
  });
});

test("a CSRF token is tied to its cookie and its key", () => {
  const token = csrfToken(issued, key);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token, csrfToken(issued, key));
  assert.equal(csrfMatches(token, csrfToken(issued, key)), true);
  assert.equal(csrfMatches(token, csrfToken(`${issued}x`, key)), false);
  assert.equal(csrfMatches(token, csrfToken(issued, Buffer.alloc(32, 9))), false);
});

test("csrfMatches refuses a missing, short or long value", () => {
  const token = csrfToken(issued, key);
  assert.equal(csrfMatches(undefined, token), false);
  assert.equal(csrfMatches("", token), false);
  assert.equal(csrfMatches(token.slice(1), token), false);
  assert.equal(csrfMatches(`${token}A`, token), false);
});
