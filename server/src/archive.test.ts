import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ArchiveRecord } from "@money/shared";
import { aConfig, anApiRecord, anImportRecord } from "@money/shared/testing";

import { writeRecords } from "../testing/world.ts";
import { countByAccount } from "./archive.ts";

const config = aConfig({
  accounts: {
    "bnka-solo": { bank: "bnka", iban: "NL00BNKA0000000001" },
    "bnka-shared": { bank: "bnka", iban: "NL00BNKA0000000002" },
    "bnka-empty": { bank: "bnka", iban: "NL00BNKA0000000003" },
  },
});

const withArchive = async (
  records: readonly ArchiveRecord[],
  run: (dataDir: string) => Promise<void>,
): Promise<void> => {
  const dataDir = await mkdtemp(join(tmpdir(), "money-server-archive-"));
  try {
    await writeRecords(dataDir, records);
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
};

const api = (account: string, id: string, date: string): ArchiveRecord =>
  anApiRecord({ account, id, date });

test("counts only the accounts asked for", async () => {
  const records = [
    api("bnka-solo", "s1", "2025-01-02"),
    api("bnka-solo", "s2", "2025-01-03"),
    api("bnka-shared", "h1", "2025-01-02"),
  ];
  await withArchive(records, async (dataDir) => {
    assert.deepEqual(await countByAccount(dataDir, config, ["bnka-shared"]), { "bnka-shared": 1 });
    assert.deepEqual(await countByAccount(dataDir, config, ["bnka-solo", "bnka-shared"]), {
      "bnka-solo": 2,
      "bnka-shared": 1,
    });
  });
});

test("an account with no records is counted as 0", async () => {
  await withArchive([api("bnka-solo", "s1", "2025-01-02")], async (dataDir) => {
    assert.deepEqual(await countByAccount(dataDir, config, ["bnka-solo", "bnka-empty"]), {
      "bnka-solo": 1,
      "bnka-empty": 0,
    });
  });
});

test("an import record from after the API's start is not counted", async () => {
  const records = [
    api("bnka-solo", "s1", "2025-02-01"),
    anImportRecord({ account: "bnka-solo", id: "000000000000000001", date: "2025-01-15" }),
    anImportRecord({ account: "bnka-solo", id: "000000000000000002", date: "2025-02-10" }),
  ];
  await withArchive(records, async (dataDir) => {
    assert.deepEqual(await countByAccount(dataDir, config, ["bnka-solo"]), { "bnka-solo": 2 });
  });
});

test("an account not asked for cannot move another's start", async () => {
  // The other account's API record is earlier, but starts are per account.
  const records = [
    api("bnka-shared", "h1", "2025-01-01"),
    anImportRecord({ account: "bnka-solo", id: "000000000000000001", date: "2025-01-15" }),
  ];
  await withArchive(records, async (dataDir) => {
    assert.deepEqual(await countByAccount(dataDir, config, ["bnka-solo"]), { "bnka-solo": 1 });
  });
});
