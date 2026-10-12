import assert from "node:assert/strict";
import { test } from "node:test";

import { ArchiveError, MergeError } from "@money/shared";

import { ApiError, describeError, isExpected, SyncError } from "./errors.ts";

test("the project's own errors are expected, and their message is printed", () => {
  for (const error of [
    new SyncError("bnka: no consent is stored"),
    new ArchiveError("bnka-current/api holds something that is not a year file"),
    new MergeError("bnka-current/api/a is stored twice"),
    new ApiError(401, "EXPIRED_SESSION"),
  ]) {
    assert.equal(isExpected(error), true);
    assert.equal(describeError(error), error.message);
  }
});

test("an API error says the status and the code, and nothing else", () => {
  assert.equal(
    new ApiError(429, "ASPSP_RATE_LIMIT_EXCEEDED").message,
    "Enable Banking answered 429 ASPSP_RATE_LIMIT_EXCEEDED",
  );
  assert.equal(new ApiError(502, null).message, "Enable Banking answered 502");
});

test("only the codes that end a session mean the consent is gone", () => {
  for (const code of [
    "EXPIRED_SESSION",
    "REVOKED_SESSION",
    "CLOSED_SESSION",
    "SESSION_DOES_NOT_EXIST",
  ]) {
    assert.equal(new ApiError(401, code).consentGone, true, code);
  }
  assert.equal(new ApiError(500, "ASPSP_ERROR").consentGone, false);
  assert.equal(new ApiError(500, null).consentGone, false);
});

test("any other error is described by its class and code, never its message", () => {
  // A JSON syntax error quotes the text it failed on, and a filesystem error names a path.
  const syntax = new SyntaxError('Unexpected token N, "NL00BNKA0000000001" is not valid JSON');
  assert.equal(isExpected(syntax), false);
  assert.equal(describeError(syntax), "unexpected SyntaxError");

  const missing = Object.assign(new Error("ENOENT: no such file, open '/some/host/path'"), {
    code: "ENOENT",
  });
  assert.equal(describeError(missing), "unexpected Error ENOENT");
  assert.equal(describeError("a thrown string"), "unexpected failure");
});
