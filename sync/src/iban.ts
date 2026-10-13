// An IBAN as it is compared: people write them with spaces, banks without.
export const plainIban = (iban: string): string => iban.replaceAll(/\s/g, "").toUpperCase();
