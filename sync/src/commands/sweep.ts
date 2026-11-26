// What waits in the inbox for an account the night did not fetch: one closed, without an
// iban or with fetch false, every account of a bank with no usable consent, one the consent
// does not cover, and those passed over once the consent was gone. Only a fetch drains an
// account's inbox, so without this its pages would wait for a fetch that may never come.
import { ACCOUNT_KEY } from "@money/shared";

import type { Context } from "../context.ts";
import { isExpected } from "../errors.ts";
import { countWaiting, listInbox } from "../inbox.ts";
import { failureLines, mergeWaiting } from "./account.ts";

// A name nobody validated may not be printed, so every such entry is reported by this one
// line, and fails the run under the inbox's own name.
const NOT_A_KEY =
  ".inbox holds an entry that is not an account key. It is kept; nothing has been removed.";

// Merges and removes what waits for each configured account whose fetch was not begun, and
// reports what waits under a name the configuration does not hold. Returns the names to add
// to `failed:`. An expected failure stops its account only; anything else stops the run.
export const sweep = async (context: Context, started: ReadonlySet<string>): Promise<string[]> => {
  const { config, settings, deps } = context;
  const failed: string[] = [];
  const configured = Object.keys(config.accounts);
  for (const account of configured) {
    if (started.has(account)) continue;
    // Nothing waiting, nothing read: an account nobody fetches may hold files the code can
    // no longer read, and they are not this run's business.
    if ((await countWaiting(settings.dataDir, account)) === 0) continue;
    try {
      await mergeWaiting(context, account);
    } catch (error) {
      if (!isExpected(error)) throw error;
      failed.push(account);
      for (const line of failureLines(account, error)) deps.out(line);
    }
  }

  // Kept, never merged: which account they belong to, and so where their records go, is
  // what the configuration no longer says.
  let unnamed = false;
  for (const entry of await listInbox(settings.dataDir)) {
    if (configured.includes(entry.name)) continue;
    if (entry.directory && ACCOUNT_KEY.test(entry.name)) {
      const waiting = await countWaiting(settings.dataDir, entry.name);
      if (waiting === 0) continue;
      deps.out(
        `${entry.name}: ${waiting} run(s) wait in .inbox/${entry.name} for an account the configuration does not name. They are kept; nothing has been removed.`,
      );
      failed.push(entry.name);
    } else {
      if (entry.directory && (await countWaiting(settings.dataDir, entry.name)) === 0) continue;
      deps.out(NOT_A_KEY);
      unnamed = true;
    }
  }
  if (unnamed) failed.push(".inbox");
  return failed;
};
