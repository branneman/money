// Where each consent and each account stands. Reads the state only: no request, no lock.
import { consentAt } from "../consent.ts";
import type { Context } from "../context.ts";
import { readState } from "../state.ts";
import { dateOf, timestampOf } from "../time.ts";
import { fetchable } from "./account.ts";

// Exits non-zero when a person is needed: a bank without a consent, or a consent that has
// expired or will within the warning window. In production nobody reads a warning, so the
// exit code is the warning.
export const runStatus = async (context: Context): Promise<number> => {
  const { settings, config, deps } = context;
  const now = timestampOf(deps.clock());
  let attention = false;
  for (const [bank, accounts] of fetchable(config)) {
    const state = await readState(settings.stateDir, bank);
    if (state === null) {
      deps.out(`${bank}: no consent is stored. Run: auth ${bank}`);
      attention = true;
      continue;
    }
    const consent = consentAt(state.valid_until, now, settings.consentWarnDays);
    const until = dateOf(state.valid_until);
    if (consent.expired) {
      deps.out(`${bank}: the consent expired on ${until}. Run: auth ${bank}`);
    } else {
      const renew = consent.warn ? `. Run: auth ${bank}` : "";
      deps.out(
        `${bank}: the consent lasts until ${until}, ${consent.daysLeft} days from now${renew}`,
      );
    }
    if (consent.warn) attention = true;
    for (const account of accounts) {
      const last = state.accounts[account]?.last_success;
      deps.out(
        last === undefined
          ? `  ${account}: never fetched in full`
          : `  ${account}: last fetched in full on ${dateOf(last)}`,
      );
    }
  }
  return attention ? 1 : 0;
};
