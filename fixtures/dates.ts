// Dates as whole days since the Unix epoch, in UTC. Used only by the fixture generator.

export const MS_PER_DAY = 86_400_000;
export const utcDay = (year: number, month: number, dayOfMonth: number): number =>
  Date.UTC(year, month - 1, dayOfMonth) / MS_PER_DAY;

export const parts = (day: number) => {
  const date = new Date(day * MS_PER_DAY);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    wd: date.getUTCDay(), // 0 = Sunday
  };
};

export const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
export const iso = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
export const dutchDate = (day: number): string => {
  const { y, m, d } = parts(day);
  return `${pad(d)}-${pad(m)}-${y}`;
};

export const isWeekend = (day: number): boolean => [0, 6].includes(parts(day).wd);
export const businessDayOnOrAfter = (day: number): number =>
  isWeekend(day) ? businessDayOnOrAfter(day + 1) : day;
export const businessDayOnOrBefore = (day: number): number =>
  isWeekend(day) ? businessDayOnOrBefore(day - 1) : day;

export type Shift = "after" | "before" | "exact";

// True when `day` is where a monthly item with this day-of-month lands once it is moved
// off a weekend. A shift can cross a month boundary, so the neighbouring months count too.
export const due = (day: number, dayOfMonth: number, shift: Shift = "after"): boolean => {
  const { y, m } = parts(day);
  return [-1, 0, 1].some((offset) => {
    const nominal = utcDay(y, m + offset, dayOfMonth);
    const landed =
      shift === "after"
        ? businessDayOnOrAfter(nominal)
        : shift === "before"
          ? businessDayOnOrBefore(nominal)
          : nominal;
    return landed === day;
  });
};

export const MONTHS = [
  "januari",
  "februari",
  "maart",
  "april",
  "mei",
  "juni",
  "juli",
  "augustus",
  "september",
  "oktober",
  "november",
  "december",
];
