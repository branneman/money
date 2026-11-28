import { view } from "@money/shared";
import type { Config } from "@money/shared";
import { readArchive } from "@money/shared/node";

// The placeholder's numbers: transactions in the view, per account. The archive is cut to
// the accounts asked for before anything is counted, so nothing of any other account is
// worked on, let alone sent. Every account asked for has a count, 0 when it has none.
export const countByAccount = async (
  dataDir: string,
  config: Config,
  accounts: readonly string[],
): Promise<Record<string, number>> => {
  const wanted = new Set(accounts);
  const records = (await readArchive(dataDir)).filter((record) => wanted.has(record.account));
  const transactions = view(records, config.imports);
  return Object.fromEntries(
    accounts.map((account) => [
      account,
      transactions.filter((transaction) => transaction.account === account).length,
    ]),
  );
};
