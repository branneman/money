// The nightly run: every bank, and every open account the API can reach. Then what waits
// in the inbox for every other account.
import { consentAt } from "../consent.ts";
import type { Context } from "../context.ts";
import { isExpected } from "../errors.ts";
import { readState } from "../state.ts";
import { timestampOf } from "../time.ts";
import { fetchable, fetchAccounts, NOTHING_FETCHED } from "./account.ts";
import { sweep } from "./sweep.ts";

// `started` names the accounts whose fetch was begun. A bank that fails before fetching
// begins none, so every one of its accounts is swept.
type Outcome = { failed: string[]; newlyMissing: number; started: string[] };

const syncBank = async (
  context: Context,
  bank: string,
  accounts: readonly string[],
  now: string,
): Promise<Outcome> => {
  const { settings, deps, log } = context;
  const state = await readState(settings.stateDir, bank);
  if (state === null) {
    deps.out(`${bank}: no consent is stored. Run: auth ${bank}`);
    return { failed: [bank], newlyMissing: 0, started: [] };
  }
  const consent = consentAt(state.valid_until, now, settings.consentWarnDays);
  if (consent.expired) {
    // Known without asking, and a request would only spend one of the day's few.
    deps.out(`${bank}: the consent has expired. Run: auth ${bank}`);
    return { failed: [bank], newlyMissing: 0, started: [] };
  }

  const failed: string[] = [];
  const covered: [string, string][] = [];
  for (const account of accounts) {
    const entry = state.accounts[account];
    if (entry === undefined) {
      failed.push(account);
      deps.out(`${account}: the stored consent does not cover it. Run: auth ${bank}`);
    } else covered.push([account, entry.uid]);
  }
  const outcome = await fetchAccounts(context, bank, covered, { attended: false });
  // A warning only. What alerts is `status`, which exits non-zero inside this window.
  if (consent.warn) log("consent-expiring", { bank, days: consent.daysLeft });
  return {
    failed: [...failed, ...outcome.failed],
    newlyMissing: outcome.newlyMissing,
    started: outcome.started,
  };
};

// Banks fail separately, and so do accounts. Everything that can be done is done, and
// only then does the run exit non-zero, naming what failed.
export const runSync = async (context: Context): Promise<number> => {
  const { config, deps, log } = context;
  const banks = fetchable(config);
  if (banks.size === 0) {
    // Every account closed is the one configuration in which nothing would ever merge what
    // waits, so the sweep comes first, and the run still stops as it would without it.
    const swept = await sweep(context, new Set());
    deps.out(NOTHING_FETCHED);
    if (swept.length > 0) deps.out(`failed: ${swept.join(", ")}`);
    return 1;
  }
  const now = timestampOf(deps.clock());
  const failed: string[] = [];
  const started = new Set<string>();
  let newlyMissing = 0;
  for (const [bank, accounts] of banks) {
    try {
      const outcome = await syncBank(context, bank, accounts, now);
      failed.push(...outcome.failed);
      newlyMissing += outcome.newlyMissing;
      for (const account of outcome.started) started.add(account);
    } catch (error) {
      if (!isExpected(error)) throw error;
      failed.push(bank);
      deps.out(`${bank}: ${error.message}`);
    }
  }
  failed.push(...(await sweep(context, started)));
  // An account passed over before the sweep can fail again in it. It is one account, named
  // once, where it first failed.
  const named = [...new Set(failed)];
  log("done", { failed: named.length, newly_missing: newlyMissing });
  if (named.length > 0) deps.out(`failed: ${named.join(", ")}`);
  return named.length > 0 || newlyMissing > 0 ? 1 : 0;
};
