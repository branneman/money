import assert from "node:assert/strict";
import { test } from "node:test";

import { SyncError } from "./errors.ts";
import { readRedirect } from "./redirect.ts";

const REDIRECT = "https://localhost/auth-callback";
const refused = (pasted: string, message: string): void => {
  assert.throws(
    () => readRedirect(pasted, REDIRECT, "state-1"),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.equal(error.message, message);
      return true;
    },
  );
};

test("the code is read from the address the browser was sent to", () => {
  assert.equal(
    readRedirect(`${REDIRECT}?state=state-1&code=code-1`, REDIRECT, "state-1"),
    "code-1",
  );
});

test("whitespace around a pasted address is ignored", () => {
  assert.equal(
    readRedirect(`  ${REDIRECT}?code=code-1&state=state-1 \n`, REDIRECT, "state-1"),
    "code-1",
  );
});

test("something that is not an address is refused", () => {
  refused("code-1", "that is not an address. Paste the whole address the browser was sent to.");
  refused("", "that is not an address. Paste the whole address the browser was sent to.");
});

test("an address that is not this application's redirect address is refused", () => {
  const message = "that is not the redirect address of this application";
  refused("https://elsewhere.example/auth-callback?state=state-1&code=code-1", message);
  refused("https://localhost/other?state=state-1&code=code-1", message);
});

test("a consent the bank did not grant says so, with the bank's code when it is a plain one", () => {
  refused(
    `${REDIRECT}?error=access_denied&state=state-1`,
    "the bank did not grant the consent (access_denied)",
  );
  refused(
    `${REDIRECT}?error=Recognisable%20words&state=state-1`,
    "the bank did not grant the consent",
  );
});

test("an address from another authorisation is refused", () => {
  const message =
    "that address belongs to another authorisation: its state does not match. Start again.";
  refused(`${REDIRECT}?state=other&code=code-1`, message);
  refused(`${REDIRECT}?code=code-1`, message);
});

test("an address without a code is refused", () => {
  refused(`${REDIRECT}?state=state-1`, "that address carries no code");
  refused(`${REDIRECT}?state=state-1&code=`, "that address carries no code");
});
