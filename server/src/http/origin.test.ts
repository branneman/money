import assert from "node:assert/strict";
import { test } from "node:test";

import { crossSiteProblem } from "./origin.ts";

const host = "app.example.test";

test("an Origin naming the Host passes", () => {
  assert.equal(crossSiteProblem({ host, origin: `https://${host}` }), null);
});

test("a Host with a port must match the Origin's port", () => {
  assert.equal(crossSiteProblem({ host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080" }), null);
  assert.notEqual(
    crossSiteProblem({ host: "127.0.0.1:8080", origin: "http://127.0.0.1:9090" }),
    null,
  );
});

test("another host is refused, including one that merely contains ours", () => {
  assert.notEqual(crossSiteProblem({ host, origin: "https://other.example.test" }), null);
  assert.notEqual(crossSiteProblem({ host, origin: `https://${host}.evil.test` }), null);
  assert.notEqual(crossSiteProblem({ host, origin: `https://evil.test/${host}` }), null);
});

test("a missing Origin is refused", () => {
  assert.notEqual(crossSiteProblem({ host }), null);
});

test("Origin: null and an unparseable Origin are refused", () => {
  assert.notEqual(crossSiteProblem({ host, origin: "null" }), null);
  assert.notEqual(crossSiteProblem({ host, origin: "not a url" }), null);
});

test("an Origin that is not in canonical form is refused, even when its host matches", () => {
  const refused: Record<string, string> = {
    userinfo: `https://evil@${host}`,
    path: `https://${host}/path`,
    "scheme other than http and https": `ftp://${host}`,
    "uppercase scheme and host": `HTTPS://${host.toUpperCase()}`,
  };
  for (const [name, origin] of Object.entries(refused)) {
    assert.notEqual(crossSiteProblem({ host, origin }), null, name);
  }
  // file: URLs have an empty host, which an empty Host header would otherwise equal.
  assert.notEqual(crossSiteProblem({ host: "", origin: "file:///x" }), null, "empty host");
});

test("a missing Host is refused", () => {
  assert.notEqual(crossSiteProblem({ origin: `https://${host}` }), null);
});

test("Sec-Fetch-Site other than same-origin is refused", () => {
  for (const site of ["cross-site", "same-site", "none"]) {
    assert.notEqual(
      crossSiteProblem({ host, origin: `https://${host}`, "sec-fetch-site": site }),
      null,
      site,
    );
  }
});

test("Sec-Fetch-Site same-origin passes, and absent passes with a good Origin", () => {
  assert.equal(
    crossSiteProblem({ host, origin: `https://${host}`, "sec-fetch-site": "same-origin" }),
    null,
  );
  assert.equal(crossSiteProblem({ host, origin: `https://${host}` }), null);
});
