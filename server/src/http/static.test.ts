import assert from "node:assert/strict";
import { test } from "node:test";

import { cacheControlOf, contentTypeOf, resolveStatic } from "./static.ts";

const dir = "/srv/client";

test("the root and paths without an extension resolve to index.html", () => {
  for (const path of ["/", "/login", "/a/b", "/?x=1"]) {
    assert.equal(resolveStatic(dir, path), `${dir}/index.html`, path);
  }
});

test("a file resolves inside the directory, and the query is dropped", () => {
  assert.equal(resolveStatic(dir, "/app-ABCD1234.js"), `${dir}/app-ABCD1234.js`);
  assert.equal(resolveStatic(dir, "/assets/a.css?v=2"), `${dir}/assets/a.css`);
});

test("ways out of the directory are refused", () => {
  for (const path of ["/../x", "/%2e%2e/x", "/..%2fx", "/a/../../x", "/./x", "/%2E%2E/x.js"]) {
    assert.equal(resolveStatic(dir, path), null, path);
  }
});

test("a path is decoded once: %252e%252e/x.js is a literal name inside the directory", () => {
  const resolved = resolveStatic(dir, "/%252e%252e/x.js");
  assert.equal(resolved, `${dir}/%2e%2e/x.js`);
});

test("a path without an extension whose text is a double escape serves the index", () => {
  assert.equal(resolveStatic(dir, "/%252e%252e/x"), `${dir}/index.html`);
});

test("a backslash, an empty segment, a NUL and malformed escapes are refused", () => {
  for (const path of [
    "/a\\b",
    "//etc/passwd",
    "/a//b",
    "/x%00.js",
    "/%zz",
    "/%",
    "/a/",
    "/%c3%28",
    "/a%5Cb",
  ]) {
    assert.equal(resolveStatic(dir, path), null, path);
  }
});

test("dotfiles and dot directories are refused", () => {
  for (const path of ["/.env", "/a/.git/config", "/.well-known/x"]) {
    assert.equal(resolveStatic(dir, path), null, path);
  }
});

test("a path that does not start with a slash is refused", () => {
  assert.equal(resolveStatic(dir, "x.js"), null);
  assert.equal(resolveStatic(dir, ""), null);
});

test("content types are known for the served extensions only", () => {
  assert.equal(contentTypeOf("/d/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeOf("/d/a.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeOf("/d/a.css"), "text/css; charset=utf-8");
  assert.equal(contentTypeOf("/d/a.js.map"), "application/json; charset=utf-8");
  assert.equal(contentTypeOf("/d/a.json"), "application/json; charset=utf-8");
  assert.equal(contentTypeOf("/d/a.woff2"), "font/woff2");
  assert.equal(contentTypeOf("/d/a.svg"), "image/svg+xml");
  assert.equal(contentTypeOf("/d/a.png"), "image/png");
  assert.equal(contentTypeOf("/d/a.ico"), "image/x-icon");
  assert.equal(contentTypeOf("/d/a.txt"), "text/plain; charset=utf-8");
  assert.equal(contentTypeOf("/d/a.webmanifest"), "application/manifest+json");
  assert.equal(contentTypeOf("/d/a.exe"), null);
  assert.equal(contentTypeOf("/d/noext"), null);
});

test("hashed names are immutable for a year, others are no-cache", () => {
  assert.equal(cacheControlOf("/d/app-ABCD1234.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlOf("/d/app-ABCD1234.js.map"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlOf("/d/app.js"), "no-cache");
  assert.equal(cacheControlOf("/d/index.html"), "no-cache");
  assert.equal(cacheControlOf("/d/app-abcd1234.js"), "no-cache");
  assert.equal(cacheControlOf("/d/app-ABC.js"), "no-cache");
});
