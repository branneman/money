// Starts or renews the consent for one bank, then fetches. Interactive: the user approves
// at the bank and pastes back the address the browser was sent to.
import { plainIban } from "@money/shared";

import type { Context } from "../context.ts";
import { isExpected, SyncError } from "../errors.ts";
import { readRedirect } from "../redirect.ts";
import { readState, renewed, writeState } from "../state.ts";
import { dateOf, timestampOf } from "../time.ts";
import { fetchable, fetchAccounts, readAhead } from "./account.ts";

// What the user is told when the consent is stored and the fetch that followed is not
// whole. The nightly sync goes on, unattended: for an account with no success yet it stores
// what the bank then serves, and fails, every night until auth completes with the user
// present.
const consentStored = (bank: string, unfetched: readonly string[]): string =>
  `The consent is stored. Not fetched in full: ${unfetched.join(", ")}. ` +
  `Run auth ${bank} again now: only then can the bank be asked for the whole history. ` +
  "Until then the nightly sync stores only what the bank serves unattended, and fails.";

// Closes a session at the bank. Returns null when it is closed, and otherwise the reason it
// was not, for the caller to print: a bank that refuses is not a failure of the command.
// An error nobody expected is not that, and stops the command.
const closeSession = async (context: Context, sessionId: string): Promise<string | null> => {
  try {
    await context.client.closeSession(sessionId);
    return null;
  } catch (error) {
    if (!isExpected(error)) throw error;
    return error.message;
  }
};

// `showIbans` is the one place an iban is printed, and only because it was asked for: a
// sandbox bank's test accounts are not known beforehand, and the configuration needs them.
export const runAuth = async (
  context: Context,
  bank: string,
  showIbans = false,
): Promise<number> => {
  const { settings, config, client, deps, log } = context;
  // What was typed is not repeated: it may be anything.
  if (!Object.hasOwn(config.banks, bank)) {
    throw new SyncError("that bank is not in the configuration");
  }
  const accounts = fetchable(config).get(bank) ?? [];
  if (accounts.length === 0) {
    throw new SyncError(
      `${bank} has no open account with an iban, so there is nothing to authorise`,
    );
  }
  // Read first, so that state the sync cannot use is found before the user goes to the bank.
  const previous = await readState(settings.stateDir, bank);
  // And so is an archive or an inbox the fetch could not read.
  for (const account of accounts) await readAhead(context, account);

  const { aspsp } = config.banks[bank];
  const listed = await client.findAspsp(aspsp.name, aspsp.country);
  if (listed === null) {
    throw new SyncError(
      `${bank}: Enable Banking lists no bank under the configured name and country. Run banks <country> for the names it lists; the name must match exactly.`,
    );
  }
  const required = listed.requiredPsuHeaders.join(", ");
  deps.out(`PSU headers this bank lists as required: ${required === "" ? "none" : required}`);

  const state = deps.randomState();
  const validUntil = timestampOf(
    new Date(deps.clock().getTime() + listed.maximumConsentValidity * 1000),
  );
  const { url } = await client.startAuth({
    aspsp,
    state,
    redirectUrl: settings.redirectUrl,
    validUntil,
  });
  deps.out(
    "Open this address and approve. The browser is then sent to a page that does not load; that is expected.",
  );
  deps.out(url);
  const pasted = await deps.readLine("Paste the whole address of that page: ");
  const session = await client.createSession(readRedirect(pasted, settings.redirectUrl, state));

  if (showIbans) {
    deps.out("The consent holds these ibans:");
    for (const item of session.accounts) {
      if (item.iban !== null) deps.out(`  ${JSON.stringify(item.iban)}`);
    }
  }

  const uids: Record<string, string> = {};
  const problems: string[] = [];
  for (const account of accounts) {
    const configured = config.accounts[account].iban;
    if (configured === undefined) throw new SyncError(`${account} has no iban`);
    const iban = plainIban(configured);
    const matching = session.accounts.filter(
      (item) => item.iban !== null && plainIban(item.iban) === iban,
    );
    if (matching.length === 0) problems.push(`${account}: the consent does not cover it`);
    else if (matching.length > 1) {
      problems.push(`${account}: the consent covers more than one account with its iban`);
    } else if (matching[0].uid === null) {
      problems.push(`${account}: the consent covers it but gives no way to fetch it`);
    } else uids[account] = matching[0].uid;
  }
  if (problems.length > 0) {
    // Counts tell a wrong iban in the configuration from a bank that names accounts otherwise.
    const withIban = session.accounts.filter((item) => item.iban !== null).length;
    problems.push(
      `The consent holds ${session.accounts.length} account(s), ${withIban} of them with an iban.`,
    );
    // The session was made before the accounts could be matched, and nothing records it. Left
    // open, every retry after ticking the wrong accounts would leave one more.
    const refused = await closeSession(context, session.sessionId);
    problems.push(
      refused === null
        ? "The consent just given was closed again."
        : `The consent just given was not closed, and ends by itself on ${dateOf(session.validUntil)}: ${refused}.`,
    );
    throw new SyncError(problems.join("\n"));
  }

  await writeState(settings.stateDir, bank, renewed(previous, session, uids));
  log("authorised", {
    bank,
    accounts: accounts.length,
    ignored: session.accounts.length - accounts.length,
    until: dateOf(session.validUntil),
  });

  // Closed after the fetch, not before: that time is not spent waiting on an answer about
  // the old session, while the bank serves older history only to a user who just came.
  const closePrevious = async (): Promise<void> => {
    // An expired session has nothing left to close, and the same id is the same session.
    if (previous === null || previous.session_id === session.sessionId) return;
    if (previous.valid_until <= timestampOf(deps.clock())) return;
    const refused = await closeSession(context, previous.session_id);
    if (refused === null) log("previous-closed", { bank });
    else {
      deps.out(
        `The previous consent was not closed, and ends by itself on ${dateOf(previous.valid_until)}: ${refused}.`,
      );
    }
  };

  // At once, before returning: a bank may serve older history only while the user has
  // just authenticated, and that fetch may not be repeatable.
  let outcome: Awaited<ReturnType<typeof fetchAccounts>>;
  try {
    outcome = await fetchAccounts(
      context,
      bank,
      accounts.map((account) => [account, uids[account]] as const),
      {
        attended: true,
        // Decided from the state as it was found, before anything left in the inbox is merged:
        // a completed run from before the state was lost must not stand in for the history.
        backfill: new Set(
          accounts.filter((account) => previous?.accounts[account]?.last_success === undefined),
        ),
      },
    );
  } catch (error) {
    // An error nobody expected, which stops the command. The user has been to the bank and
    // must still learn that the consent is kept. Which accounts were finished before it is
    // not known here, so every one is named.
    deps.out(consentStored(bank, accounts));
    throw error;
  }
  await closePrevious();
  if (outcome.failed.length > 0) {
    deps.out(consentStored(bank, outcome.failed));
    return 1;
  }
  return outcome.newlyMissing > 0 ? 1 : 0;
};
