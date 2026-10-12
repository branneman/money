// One account's fetch, shared by auth and sync. Two phases joined only by the inbox:
// receive writes pages to disk, and the merge reads them from disk. A fresh fetch and one
// left behind by a run that died therefore take the same path.
import { merge, MergeError, renderYearFiles } from "@money/shared";
import type { Config, MergeResult } from "@money/shared";
import { readAccountSource, recoverAccountSource, writeYearFiles } from "@money/shared/node";

import type { Context } from "../context.ts";
import {
  checkPage,
  isJson,
  parseExact,
  readTransactions,
  ResponseError,
} from "../enablebanking/responses.ts";
import { ApiError, isExpected, SyncError } from "../errors.ts";
import { completeRun, listRuns, removeRun, RunError, writePage } from "../inbox.ts";
import { missingIds, newlyMissing } from "../missing.ts";
import { readState, withSuccess, writeState } from "../state.ts";
import { runNameOf, timestampOf } from "../time.ts";
import { fetchWindow } from "../window.ts";
import type { Window } from "../window.ts";

// Bank key to the accounts the API is asked for: open, and known by an IBAN.
export const fetchable = (config: Config): Map<string, string[]> => {
  const byBank = new Map<string, string[]>();
  for (const [key, account] of Object.entries(config.accounts)) {
    if (account.iban === undefined || account.closed === true) continue;
    byBank.set(account.bank, [...(byBank.get(account.bank) ?? []), key]);
  }
  return byBank;
};

// Phase one. Each page is on disk, exactly as received, before the next is asked for. Only
// a 200 response that parses as JSON is a page.
const receive = async (
  context: Context,
  account: string,
  uid: string,
  started: string,
  window: Window,
): Promise<void> => {
  const { client, settings, deps } = context;
  const run = runNameOf(started);
  const seen = new Set<string>();
  let key: string | null = null;
  let number = 0;
  do {
    const text = await client.transactionsPage(uid, window, key);
    const where = `${account}, page ${number + 1}`;
    if (!isJson(text)) throw new ResponseError(`${where} is not valid JSON`);
    number += 1;
    await writePage(settings.dataDir, account, run, number, text);
    deps.checkpoint("page-written");
    key = checkPage(parseExact(text, where), where).continuationKey;
    if (key !== null) {
      // A bank that hands back a key it already gave would be asked forever.
      if (seen.has(key)) throw new ResponseError(`${where} repeats an earlier continuation_key`);
      seen.add(key);
    }
  } while (key !== null);
  await completeRun(settings.dataDir, account, run, { started, window, pages: number });
  deps.checkpoint("received");
};

// The booked transactions of a page in the inbox. A page the code cannot read is the run's
// failure: the run stays, and the error carries its name.
const readPage = (
  run: string,
  text: string,
  where: string,
): ReturnType<typeof readTransactions> => {
  try {
    return readTransactions(checkPage(parseExact(text, where), where), where);
  } catch (error) {
    if (error instanceof ResponseError) throw new RunError(run, error.message);
    throw error;
  }
};

// One page's merge. The stored records were validated when read and every incoming
// transaction when the page was, so the one thing the merge can still refuse is a
// transaction that is on the page twice with different contents. Its own message names the
// transaction by an identifier that has come from a response and is stored nowhere yet,
// and the run stays in the inbox, so that message would be printed every night. The page
// is named instead.
const mergePage = (run: string, where: string, merging: () => MergeResult): MergeResult => {
  try {
    return merging();
  } catch (error) {
    if (!(error instanceof MergeError)) throw error;
    throw new RunError(run, `${where} holds the same transaction twice with different contents`);
  }
};

// Phase two. Merges every run in the account's inbox, oldest first, and removes each once
// its data is written. An incomplete run is merged too: each page present is whole and is
// what the bank sent, and a partial batch cannot do harm because merge never deletes. Only
// a completed run records a success, and only a completed window is checked for records
// that should have come back. Returns how many records are newly missing.
const drainInbox = async (context: Context, bank: string, account: string): Promise<number> => {
  const { settings, deps, log } = context;
  let newly = 0;
  for (const run of await listRuns(settings.dataDir, account)) {
    const now = timestampOf(deps.clock());
    let records = await readAccountSource(settings.dataDir, account, "api");
    const fetched = new Set<string>();
    const counts = { added: 0, revised: 0, unchanged: 0, skipped: 0 };
    // One page at a time: if a transaction changed at the bank between two pages, the
    // later page revises the earlier one instead of contradicting it.
    run.pages.forEach((text, index) => {
      const where = `${account}, run ${run.name}, page ${index + 1}`;
      const page = readPage(run.name, text, where);
      const result = mergePage(run.name, where, () =>
        merge(records, page.booked, { account, source: "api" }, now),
      );
      records = result.records;
      counts.added += result.added.length;
      counts.revised += result.revised.length;
      counts.unchanged += result.unchanged;
      counts.skipped += page.skipped;
      for (const item of page.booked) fetched.add(item.id);
    });
    await writeYearFiles(settings.dataDir, account, "api", renderYearFiles(records));
    deps.checkpoint("data-written");

    let missing = 0;
    if (run.marker !== null) {
      const state = await readState(settings.stateDir, bank);
      const entry = state?.accounts[account];
      if (state === null || entry === undefined) {
        throw new SyncError(
          `${account}: a fetch finished without a stored consent. Run: auth ${bank}`,
        );
      }
      const window = run.marker.window;
      // A backfill's reach is not known, so it cannot say what should have come back.
      const absent =
        window.strategy === "default" ? missingIds(records, fetched, window) : entry.missing;
      const fresh = window.strategy === "default" ? newlyMissing(absent, entry.missing) : [];
      // Said before the state remembers them: once it does, no later run finds them newly
      // missing, so a run that died in between would have dropped the only alert.
      if (fresh.length > 0) {
        deps.out(
          `${account}: ${fresh.length} stored record(s) were absent from a fetch that should hold them. They are kept.`,
        );
      }
      await writeState(
        settings.stateDir,
        bank,
        withSuccess(state, account, run.marker.started, absent),
      );
      deps.checkpoint("state-written");
      missing = absent.length;
      newly += fresh.length;
    }
    await removeRun(settings.dataDir, account, run.name);
    log("merged", {
      account,
      run: run.name,
      complete: run.marker === null ? "no" : "yes",
      pages: run.pages.length,
      ...counts,
      missing,
    });
  }
  return newly;
};

// What is printed when an account stops. A run that cannot be read stops its account every
// night, so its failure also says where the run is and that it is still there.
const failureLines = (account: string, error: Error): string[] => {
  const lines = [`${account}: ${error.message}`];
  if (error instanceof RunError) {
    lines.push(
      `${account}: run ${error.run} stays in .inbox/${account}/${error.run} and stops this account until it can be read. Nothing has been removed.`,
    );
  }
  return lines;
};

// Repairs a record that an interrupted write left in two year files. Writes only then.
const recover = async (context: Context, account: string): Promise<void> => {
  const { settings, log } = context;
  const recovered = await recoverAccountSource(settings.dataDir, account, "api");
  if (recovered > 0) log("recovered", { account, records: recovered });
};

// Reads what a fetch of the account reads before it asks the bank for anything: its stored
// records and the runs in its inbox. Nothing is merged. `auth` does this before the user
// goes to the bank, so that an archive or an inbox the code cannot read stops it there, with
// the message the fetch would have given.
export const readAhead = async (context: Context, account: string): Promise<void> => {
  const { settings } = context;
  try {
    await recover(context, account);
    await readAccountSource(settings.dataDir, account, "api");
    await listRuns(settings.dataDir, account);
  } catch (error) {
    if (!isExpected(error)) throw error;
    throw new SyncError(failureLines(account, error).join("\n"));
  }
};

const fetchAccount = async (
  context: Context,
  bank: string,
  account: string,
  uid: string,
  backfill: boolean,
): Promise<number> => {
  const { settings, deps, log } = context;
  await recover(context, account);

  // What an earlier run left is merged before the bank is asked for anything new.
  let newly = await drainInbox(context, bank, account);

  const state = await readState(settings.stateDir, bank);
  // Read before the first request, so a transaction booked while the run is in progress
  // falls inside the next window.
  const started = timestampOf(deps.clock());
  // Draining may just have recorded a success from a run an earlier process left. `auth`
  // asks for the whole history regardless, for an account it found with none.
  const window: Window = backfill
    ? { strategy: "longest" }
    : fetchWindow(state?.accounts[account]?.last_success, started, settings.lookbackDays);
  log("fetching", {
    account,
    strategy: window.strategy,
    ...(window.strategy === "default" ? { from: window.dateFrom, to: window.dateTo } : {}),
  });
  await receive(context, account, uid, started, window);
  newly += await drainInbox(context, bank, account);
  return newly;
};

// Fetches each account in turn. An expected failure stops that account only, unless it
// says the consent is gone, which stops the rest of the bank. Anything unexpected is not
// caught: it stops the run.
export const fetchAccounts = async (
  context: Context,
  bank: string,
  accounts: readonly (readonly [string, string])[],
  backfill: ReadonlySet<string> = new Set(),
): Promise<{ failed: string[]; newlyMissing: number }> => {
  const { deps } = context;
  const failed: string[] = [];
  let newly = 0;
  for (const [index, [account, uid]] of accounts.entries()) {
    try {
      newly += await fetchAccount(context, bank, account, uid, backfill.has(account));
    } catch (error) {
      if (!isExpected(error)) throw error;
      failed.push(account);
      for (const line of failureLines(account, error)) deps.out(line);
      if (error instanceof ApiError && error.code === "WRONG_TRANSACTIONS_PERIOD") {
        deps.out(`${account}: the bank does not serve that period unattended. Run: auth ${bank}`);
      }
      if (error instanceof ApiError && error.consentGone) {
        deps.out(`${bank}: the consent is gone. Run: auth ${bank}`);
        failed.push(...accounts.slice(index + 1).map(([key]) => key));
        break;
      }
    }
  }
  return { failed, newlyMissing: newly };
};
