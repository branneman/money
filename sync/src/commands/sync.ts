// The nightly run: every bank, and every open account the API can reach.
import { consentAt } from "../consent.ts";
import type { Context } from "../context.ts";
import { isExpected } from "../errors.ts";
import { readState } from "../state.ts";
import { timestampOf } from "../time.ts";
import { fetchable, fetchAccounts } from "./account.ts";

type Outcome = { failed: string[]; newlyMissing: number };

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
    return { failed: [bank], newlyMissing: 0 };
  }
  const consent = consentAt(state.valid_until, now, settings.consentWarnDays);
  if (consent.expired) {
    // Known without asking, and a request would only spend one of the day's few.
    deps.out(`${bank}: the consent has expired. Run: auth ${bank}`);
    return { failed: [bank], newlyMissing: 0 };
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
  return { failed: [...failed, ...outcome.failed], newlyMissing: outcome.newlyMissing };
};

// Banks fail separately, and so do accounts. Everything that can be done is done, and
// only then does the run exit non-zero, naming what failed.
export const runSync = async (context: Context): Promise<number> => {
  const { config, deps, log } = context;
  const now = timestampOf(deps.clock());
  const failed: string[] = [];
  let newlyMissing = 0;
  for (const [bank, accounts] of fetchable(config)) {
    try {
      const outcome = await syncBank(context, bank, accounts, now);
      failed.push(...outcome.failed);
      newlyMissing += outcome.newlyMissing;
    } catch (error) {
      if (!isExpected(error)) throw error;
      failed.push(bank);
      deps.out(`${bank}: ${error.message}`);
    }
  }
  log("done", { failed: failed.length, newly_missing: newlyMissing });
  if (failed.length > 0) deps.out(`failed: ${failed.join(", ")}`);
  return failed.length > 0 || newlyMissing > 0 ? 1 : 0;
};
