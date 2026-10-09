export const isIsoDate = (text: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  // An impossible date either fails to parse or rolls over into the next month.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
};

export const isTimestamp = (text: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?Z$/.test(text) &&
  isIsoDate(text.slice(0, 10));

export const DATE_FORMATS = {
  "YYYY-MM-DD": /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})$/,
  "DD-MM-YYYY": /^(?<d>\d{2})-(?<m>\d{2})-(?<y>\d{4})$/,
  "DD/MM/YYYY": /^(?<d>\d{2})\/(?<m>\d{2})\/(?<y>\d{4})$/,
  YYYYMMDD: /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/,
} as const;

export type DateFormat = keyof typeof DATE_FORMATS;

export const parseDate = (text: string, format: DateFormat): string | null => {
  const groups = DATE_FORMATS[format].exec(text)?.groups;
  if (groups === undefined) return null;
  const date = `${groups.y}-${groups.m}-${groups.d}`;
  return isIsoDate(date) ? date : null;
};
