import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { makeServerWorld } from "../testing/world.ts";
import type { ServerWorld } from "../testing/world.ts";

const NOT_FOUND = JSON.stringify({ error: "not found" });
const INDEX = "<!doctype html>\n<title>index</title>\n";

// A client directory as a build would leave it, plus things that must never be served.
const withClient = async (run: (world: ServerWorld) => Promise<void>): Promise<void> => {
  const world = await makeServerWorld();
  const files: Record<string, string> = {
    "index.html": INDEX,
    "assets/app-ABCD1234.js": "console.log(1);\n",
    "app-ABCD1234.js": "console.log(2);\n",
    ".env": "SECRET=1\n",
    "a/.git/config": "[core]\n",
    "%2e%2e/x.js": "a literal name\n",
    "notes.xyz": "an extension that is not served\n",
  };
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(world.clientDir, path)), { recursive: true });
      await writeFile(join(world.clientDir, path), text);
    }
    // A directory named like a file, and a file beside the client directory.
    await mkdir(join(world.clientDir, "folder.js"));
    await writeFile(join(world.clientDir, "..", "x"), "outside\n");
    await run(world);
  } finally {
    await world.close();
  }
};

describe("static files", { concurrency: true }, () => {
  test("a hashed file under assets/ is cached for a year, one elsewhere is not", async () => {
    await withClient(async (world) => {
      const response = await world.request("GET", "/assets/app-ABCD1234.js");
      assert.equal(response.status, 200);
      assert.equal(response.body, "console.log(1);\n");
      assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
      assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
      const elsewhere = await world.request("GET", "/app-ABCD1234.js");
      assert.equal(elsewhere.status, 200);
      assert.equal(elsewhere.headers["cache-control"], "no-cache");
    });
  });

  test("index.html answers / and a path without an extension, and is no-cache", async () => {
    await withClient(async (world) => {
      for (const path of ["/", "/somewhere", "/a/b?x=1"]) {
        const response = await world.request("GET", path);
        assert.equal(response.status, 200, path);
        assert.equal(response.body, INDEX);
        assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(response.headers["cache-control"], "no-cache");
      }
    });
  });

  test("every way out of the directory, every dotfile and a NUL is 404", async () => {
    await withClient(async (world) => {
      const refused = [
        "/../x",
        "/%2e%2e/x",
        "/..%2fx",
        "/a\\b",
        "//etc/passwd",
        "/x%00.js",
        "/.env",
        "/a/.git/config",
        "/%E0%A4%A",
      ];
      for (const path of refused) {
        const response = await world.request("GET", path);
        assert.equal(response.status, 404, path);
        assert.equal(response.body, NOT_FOUND, path);
      }
    });
  });

  test("a double-encoded escape is decoded once, to a literal name inside", async () => {
    await withClient(async (world) => {
      const response = await world.request("GET", "/%252e%252e/x.js");
      assert.equal(response.status, 200);
      assert.equal(response.body, "a literal name\n");
    });
  });

  test("a directory, a missing file and an unserved extension are 404", async () => {
    await withClient(async (world) => {
      for (const path of ["/folder.js", "/missing.js", "/notes.xyz"]) {
        assert.equal((await world.request("GET", path)).status, 404, path);
      }
    });
  });

  test("/api/nothing is a 404 in JSON, and not the index", async () => {
    await withClient(async (world) => {
      for (const path of ["/api/nothing", "/api", "/api/accounts/a/b"]) {
        const response = await world.request("GET", path);
        assert.equal(response.status, 404, path);
        assert.equal(response.body, NOT_FOUND);
        assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
      }
    });
  });

  test("a method other than GET on a static path is 405", async () => {
    await withClient(async (world) => {
      const response = await world.request("POST", "/somewhere");
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, "GET");
    });
  });

  test("a path segment over 255 bytes is 404, and not a failure", async () => {
    await withClient(async (world) => {
      const response = await world.request("GET", `/${"a".repeat(300)}.js`);
      assert.equal(response.status, 404);
      assert.equal(response.body, NOT_FOUND);
      assert.ok(!world.output.some((line) => line.startsWith("failed")));
    });
  });

  test("a path of many short segments, too long for the filesystem, is 404, and not a failure", async () => {
    await withClient(async (world) => {
      const response = await world.request("GET", `${"/a".repeat(600)}/x.js`);
      assert.equal(response.status, 404);
      assert.equal(response.body, NOT_FOUND);
      assert.ok(!world.output.some((line) => line.startsWith("failed")));
    });
  });

  test("an empty client directory answers / with 404", async () => {
    const world = await makeServerWorld();
    try {
      const response = await world.request("GET", "/");
      assert.equal(response.status, 404);
      assert.equal(response.body, NOT_FOUND);
    } finally {
      await world.close();
    }
  });
});
