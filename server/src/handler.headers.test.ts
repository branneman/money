import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { describe, test } from "node:test";

import { NO_STORE, SECURITY_HEADERS } from "./http/headers.ts";
import { makeServerWorld, PEOPLE } from "../testing/world.ts";
import type { ServerWorld, WorldResponse } from "../testing/world.ts";

const withWorld = async (run: (world: ServerWorld) => Promise<void>): Promise<void> => {
  const world = await makeServerWorld();
  try {
    await run(world);
  } finally {
    await world.close();
  }
};

const assertSecurityHeaders = (headers: IncomingHttpHeaders): void => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(headers[name.toLowerCase()], value, name);
  }
};

const assertNoStore = (headers: IncomingHttpHeaders): void => {
  assert.equal(headers["cache-control"], NO_STORE["Cache-Control"]);
};

const expect = (response: WorldResponse, status: number): WorldResponse => {
  assert.equal(response.status, status);
  assertSecurityHeaders(response.headers);
  return response;
};

describe("headers", { concurrency: true }, () => {
  test("a 200 from the API carries every header, and no-store", async () => {
    await withWorld(async (world) => {
      const { cookie } = await world.login(PEOPLE.ana.username, PEOPLE.ana.password);
      assert.ok(cookie !== null);
      const response = expect(
        await world.request("GET", "/api/accounts", { headers: { Cookie: cookie } }),
        200,
      );
      assertNoStore(response.headers);
      assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    });
  });

  test("a login's 204, /health and /version carry every header, and no-store", async () => {
    await withWorld(async (world) => {
      const login = await world.request("POST", "/api/login", {
        headers: { Origin: world.url, "Content-Type": "application/json" },
        body: JSON.stringify(PEOPLE.ben),
      });
      assertNoStore(expect(login, 204).headers);
      assertNoStore(expect(await world.request("GET", "/health"), 200).headers);
      assertNoStore(expect(await world.request("GET", "/version"), 200).headers);
    });
  });

  test("a static file carries every header", async () => {
    await withWorld(async (world) => {
      await writeFile(join(world.clientDir, "index.html"), "<!doctype html>\n");
      expect(await world.request("GET", "/"), 200);
    });
  });

  test("a 404 carries every header, and no-store under /api/", async () => {
    await withWorld(async (world) => {
      assertNoStore(expect(await world.request("GET", "/api/nothing"), 404).headers);
      expect(await world.request("GET", "/missing.js"), 404);
    });
  });

  test("a 405 carries every header", async () => {
    await withWorld(async (world) => {
      assertNoStore(expect(await world.request("GET", "/api/login"), 405).headers);
      expect(await world.request("DELETE", "/"), 405);
    });
  });

  test("a 500 carries every header, and logs only the error's class", async () => {
    await withWorld(async (world) => {
      const { cookie } = await world.login(PEOPLE.ana.username, PEOPLE.ana.password);
      assert.ok(cookie !== null);
      // A file where an account directory belongs: readArchive refuses the archive.
      await writeFile(join(world.dataDir, "stray"), "");
      const response = expect(
        await world.request("GET", "/api/accounts", { headers: { Cookie: cookie } }),
        500,
      );
      assertNoStore(response.headers);
      assert.equal(response.body, JSON.stringify({ error: "failed" }));
      assert.deepEqual(world.output.slice(-2), [
        "failed ArchiveError",
        "request method=GET route=/api/accounts status=500 ms=0",
      ]);
    });
  });
});
