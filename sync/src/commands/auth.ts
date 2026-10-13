// Starts or renews the consent for one bank, then fetches. Interactive: the user approves
// at the bank and pastes back the address the browser was sent to.
import type { Context } from "../context.ts";
import { SyncError } from "../errors.ts";
import { readRedirect } from "../redirect.ts";
import { readState, renewed, writeState } from "../state.ts";
import { dateOf, timestampOf } from "../time.ts";
import { fetchable, fetchAccounts, readAhead } from "./account.ts";

// An IBAN as it is compared: people write them with spaces, banks without.
const plain = (iban: string): string => iban.replaceAll(/\s/g, "").toUpperCase();

// What the user is told when the consent is stored and the fetch that followed is not
// whole. The nightly sync would go on, but unattended: for an account with no success yet
// it would complete with whatever the bank then serves, and record that as its first
// success, after which the older history is never asked for again.
const consentStored = (bank: string, unfetched: readonly string[]): string =>
  `The consent is stored. Not fetched in full: ${unfetched.join(", ")}. ` +
  `Run auth ${bank} again now: only then can the bank be asked for the whole history. ` +
  "The nightly sync will otherwise continue with what the bank serves unattended.";

export const runAuth = async (context: Context, bank: string): Promise<number> => {
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

  const uids: Record<string, string> = {};
  const problems: string[] = [];
  for (const account of accounts) {
    const configured = config.accounts[account].iban;
    if (configured === undefined) throw new SyncError(`${account} has no iban`);
    const iban = plain(configured);
    const matching = session.accounts.filter(
      (item) => item.iban !== null && plain(item.iban) === iban,
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
    throw new SyncError(problems.join("\n"));
  }

  await writeState(settings.stateDir, bank, renewed(previous, session, uids));
  log("authorised", {
    bank,
    accounts: accounts.length,
    ignored: session.accounts.length - accounts.length,
    until: dateOf(session.validUntil),
  });

  // At once, before returning: a bank may serve older history only while the user has
  // just authenticated, and that fetch may not be repeatable.
  let outcome: Awaited<ReturnType<typeof fetchAccounts>>;
  try {
    outcome = await fetchAccounts(
      context,
      bank,
      accounts.map((account) => [account, uids[account]] as const),
      // Decided from the state as it was found, before anything left in the inbox is merged:
      // a completed run from before the state was lost must not stand in for the history.
      new Set(
        accounts.filter((account) => previous?.accounts[account]?.last_success === undefined),
      ),
    );
  } catch (error) {
    // An error nobody expected, which stops the command. The user has been to the bank and
    // must still learn that the consent is kept. Which accounts were finished before it is
    // not known here, so every one is named.
    deps.out(consentStored(bank, accounts));
    throw error;
  }
  if (outcome.failed.length > 0) {
    deps.out(consentStored(bank, outcome.failed));
    return 1;
  }
  return outcome.newlyMissing > 0 ? 1 : 0;
};
