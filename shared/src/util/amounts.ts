// ISO 4217: exactly three capital letters. The number of decimals depends on it.
export const CURRENCY_CODE = /^[A-Z]{3}$/;

// ISO 4217 currencies that do not have two decimals.
const NO_DECIMALS = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DECIMALS = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export const minorUnits = (currency: string): number =>
  NO_DECIMALS.has(currency) ? 0 : THREE_DECIMALS.has(currency) ? 3 : 2;

// The whole part of an amount grouped in threes by a declared separator, and what follows
// it: the decimal mark, or the end.
const GROUPED = {
  ".": /^([+-]?)([1-9]\d{0,2}(?:\.\d{3})+)(?![\d.])/,
  ",": /^([+-]?)([1-9]\d{0,2}(?:,\d{3})+)(?![\d,])/,
} as const;

// Removes a declared thousands separator, but only where it groups digits in threes. Text
// that is not grouped so is returned as it is, for the strict reading to accept or refuse.
const ungroup = (text: string, thousands: "." | ","): string => {
  const match = GROUPED[thousands].exec(text);
  if (match === null) return text;
  const [found, sign, whole] = match as unknown as [string, string, string];
  return `${sign}${whole.replaceAll(thousands, "")}${text.slice(found.length)}`;
};

// Reads a decimal number as an integer in the currency's smallest unit. Strict on purpose:
// one optional sign, digits, at most one decimal mark, and it must be the expected one.
// A thousands separator therefore fails instead of producing a different number, unless
// the format declares one, and then only between groups of three digits. A mark with no
// digits after it, as some exports write a whole amount, can mean only that amount.
export const parseAmount = (
  text: string,
  decimal: "." | ",",
  currency: string,
  thousands?: "." | ",",
): number | null => {
  const plain = thousands === undefined ? text : ungroup(text, thousands);
  const match = /^([+-]?)(\d+)(?:([.,])(\d*))?$/.exec(plain);
  if (match === null) return null;
  const sign = match[1];
  const whole = match[2];
  const mark = match[3] as string | undefined;
  const fraction = (match[4] as string | undefined) ?? "";
  if (mark !== undefined && mark !== decimal) return null;
  const digits = minorUnits(currency);
  if (fraction.length > digits) return null;
  const value = Number(`${whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(value)) return null;
  return sign === "-" && value !== 0 ? -value : value;
};
