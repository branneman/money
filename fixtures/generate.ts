// Generates fixtures/archive/<year>.json: a synthetic archive in the same format `sync`
// writes in production. Everything here is invented. No value is derived from real data.
//
//   node fixtures/generate.ts
//
// The output is deterministic: a fixed seed and a fixed date range, no clock and no
// Math.random. Re-running without changing this file leaves the archive byte-for-byte
// identical, and test/fixtures.test.ts fails if the committed files drift from it.
//
// The `raw` shape is the `Transaction` schema from Enable Banking's API reference
// (https://enablebanking.com/docs/api/reference/, checked 2026-10-08): every documented
// top-level field is present. It is NOT an observed bank response. The reference marks only
// `transaction_amount`, `credit_debit_indicator` and `status` as required, so which of the
// other fields a given bank fills in, and how, is unknown until a real response has been seen.
// Fields this generator has no basis to invent (agents, balances, merchant category codes,
// reference numbers, transaction ids) are null, so nothing built on this data can come to
// depend on them. The contents of `remittance_information` and `bank_transaction_code`,
// and the format of `entry_reference`, are invented.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Amount = { currency: string; amount: string };

export type ExchangeRate = {
  unit_currency: string;
  exchange_rate: string;
  rate_type: string;
  contract_identification: string | null;
  instructed_amount: Amount;
};

export type RawTransaction = {
  entry_reference: string;
  transaction_amount: Amount;
  credit_debit_indicator: "CRDT" | "DBIT";
  status: "BOOK";
  booking_date: string;
  value_date: string;
  transaction_date: string;
  creditor: { name: string } | null;
  creditor_account: { iban: string } | null;
  creditor_agent: null;
  debtor: { name: string } | null;
  debtor_account: { iban: string } | null;
  debtor_agent: null;
  bank_transaction_code: { description: string; code: string; sub_code: string | null };
  merchant_category_code: string | null;
  remittance_information: string[];
  exchange_rate: ExchangeRate | null;
  balance_after_transaction: Amount | null;
  reference_number: string | null;
  reference_number_schema: null;
  debtor_account_additional_identification: null;
  creditor_account_additional_identification: null;
  note: string | null;
  transaction_id: string | null;
};

export type Revision = { replaced_at: string; raw: RawTransaction };

export type ArchiveRecord = {
  account: string;
  entry_reference: string;
  first_seen: string;
  revisions: Revision[];
  raw: RawTransaction;
};

// ---------------------------------------------------------------------------
// Dates, as whole days since the Unix epoch in UTC
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const utcDay = (year: number, month: number, dayOfMonth: number): number =>
  Date.UTC(year, month - 1, dayOfMonth) / MS_PER_DAY;

const parts = (day: number) => {
  const date = new Date(day * MS_PER_DAY);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    wd: date.getUTCDay(), // 0 = Sunday
  };
};

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
const iso = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
const dutchDate = (day: number): string => {
  const { y, m, d } = parts(day);
  return `${pad(d)}-${pad(m)}-${y}`;
};

const isWeekend = (day: number): boolean => [0, 6].includes(parts(day).wd);
const businessDayOnOrAfter = (day: number): number =>
  isWeekend(day) ? businessDayOnOrAfter(day + 1) : day;
const businessDayOnOrBefore = (day: number): number =>
  isWeekend(day) ? businessDayOnOrBefore(day - 1) : day;

type Shift = "after" | "before" | "exact";

// True when `day` is where a monthly item with this day-of-month lands once it is moved
// off a weekend. A shift can cross a month boundary, so the neighbouring months count too.
const due = (day: number, dayOfMonth: number, shift: Shift = "after"): boolean => {
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

const MONTHS = [
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

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const START = utcDay(2021, 1, 12);
const END = utcDay(2026, 10, 6);
// The bank serves two years of history, so the first sync reached back to START.
const FIRST_SYNC = utcDay(2023, 1, 12);
// Nights without a successful sync (lapsed consent, a broken deploy). Transactions booked
// in these windows were first seen on the night the sync came back.
const OUTAGES: readonly (readonly [number, number])[] = [
  [utcDay(2023, 7, 11), utcDay(2023, 7, 19)],
  [utcDay(2024, 11, 2), utcDay(2024, 11, 4)],
  [utcDay(2025, 7, 6), utcDay(2025, 7, 13)],
];

type AccountKey = "personal" | "joint";

// Every IBAN in this file has check digits 00, which no valid IBAN can have. That makes it
// impossible for a generated account number to belong to anyone.
export const ACCOUNTS: Record<AccountKey, { iban: string; holder: string }> = {
  personal: { iban: "NL00BANK0000000001", holder: "M. Visser" },
  joint: { iban: "NL00BANK0000000002", holder: "M. Visser en/of T. Bakker" },
};
const SAVINGS_IBAN = "NL00BANK0000000003";
const JOINT_SAVINGS_IBAN = "NL00BANK0000000005";
const PARTNER = { name: "T. Bakker", iban: "NL00BNKC0000000004" };
const CITY = "UTRECHT";

type Kind = "card" | "ideal" | "debit" | "transfer" | "standing" | "atm" | "fee";

const KINDS: Record<Kind, { description: string; code: string }> = {
  card: { description: "Betaalautomaat", code: "BEA" },
  ideal: { description: "iDEAL", code: "IDB" },
  debit: { description: "Incasso", code: "INC" },
  transfer: { description: "Overboeking", code: "OVB" },
  standing: { description: "Periodieke overboeking", code: "STO" },
  atm: { description: "Geldautomaat", code: "GEA" },
  fee: { description: "Kosten", code: "KST" },
};

type Event = {
  account: AccountKey;
  kind: Kind;
  cents: number; // signed: negative is money leaving the account
  party: string | null;
  iban: string | null;
  remittance: string[];
  daysBeforeBooking?: number;
  exchange?: ExchangeRate;
};

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

// FNV-1a. Used where a value must depend on a name or a date, not on how many random
// numbers were drawn before it.
const hash = (text: string): number => {
  let h = 0x811c9dc5;
  for (const char of text) {
    h ^= char.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

type Rng = {
  chance: (probability: number) => boolean;
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  cents: (minEuros: number, maxEuros: number) => number;
};

// mulberry32
const makeRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    chance: (probability) => next() < probability,
    int,
    pick: (items) => items[int(0, items.length - 1)],
    // Skewed low: most purchases are small, a few are large.
    cents: (minEuros, maxEuros) => {
      const u = next();
      return Math.round((minEuros + (maxEuros - minEuros) * u * u) * 100);
    },
  };
};

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

const fakeIban = (name: string): string => {
  const banks = ["BNKA", "BNKB", "BNKC", "BNKD", "BNKE", "BNKF"];
  const h = hash(name);
  return `NL00${banks[h % banks.length]}${pad(h % 10_000_000_000, 10)}`;
};

const clock = (r: Rng, fromHour: number, toHour: number): string =>
  `${pad(r.int(fromHour, toHour))}:${pad(r.int(0, 59))}`;

type CardOptions = { country?: string; city?: string; hours?: [number, number]; pas?: string };

const card = (
  r: Rng,
  day: number,
  account: AccountKey,
  terminal: string,
  cents: number,
  options: CardOptions = {},
): Event => {
  const daysBeforeBooking = r.chance(0.1) ? 1 : 0;
  const pas = options.pas ?? (account === "personal" ? "003" : r.pick(["001", "001", "002"]));
  const [fromHour, toHour] = options.hours ?? [9, 20];
  return {
    account,
    kind: "card",
    cents: -cents,
    party: terminal,
    iban: null,
    remittance: [
      `${terminal} ${options.city ?? CITY} ${options.country ?? "NLD"}`,
      `Pasvolgnr ${pas} ${dutchDate(day - daysBeforeBooking)} ${clock(r, fromHour, toHour)}`,
    ],
    daysBeforeBooking,
  };
};

const debit = (account: AccountKey, creditor: string, cents: number, lines: string[]): Event => {
  const h = hash(`${creditor}:${account}`);
  return {
    account,
    kind: "debit",
    cents: -cents,
    party: creditor,
    iban: fakeIban(creditor),
    remittance: [
      ...lines,
      `Machtiging M${pad(h % 1_000_000_000, 9)}`,
      `Incassant NL${pad(h % 97)}ZZZ${pad(hash(creditor) % 100_000_000, 8)}0000`,
    ],
  };
};

const ideal = (
  r: Rng,
  account: AccountKey,
  shop: string,
  cents: number,
  lines: string[],
): Event => ({
  account,
  kind: "ideal",
  cents: -cents,
  party: shop,
  iban: fakeIban(shop),
  remittance: [`${pad(r.int(0, 99_999_999), 8)} ${pad(r.int(0, 99_999_999), 8)}`, ...lines],
});

const credit = (
  account: AccountKey,
  kind: Kind,
  party: string,
  iban: string,
  cents: number,
  lines: string[],
): Event => ({ account, kind, cents, party, iban, remittance: lines });

// A transfer between the two archived accounts shows up twice, once on each side.
const internal = (
  from: AccountKey,
  to: AccountKey,
  kind: Kind,
  cents: number,
  lines: string[],
): Event[] => [
  {
    account: from,
    kind,
    cents: -cents,
    party: ACCOUNTS[to].holder,
    iban: ACCOUNTS[to].iban,
    remittance: lines,
  },
  {
    account: to,
    kind,
    cents,
    party: ACCOUNTS[from].holder,
    iban: ACCOUNTS[from].iban,
    remittance: lines,
  },
];

const indexed = (baseCents: number, year: number, yearlyRate: number): number =>
  Math.round(baseCents * (1 + yearlyRate) ** (year - 2021));

// ---------------------------------------------------------------------------
// Fixed costs and income
// ---------------------------------------------------------------------------

const SALARY: Record<number, number> = {
  2021: 312_044,
  2022: 321_407,
  2023: 343_890,
  2024: 361_125,
  2025: 374_218,
  2026: 386_102,
};
const JOB_CHANGE = utcDay(2024, 3, 1);
const HEALTH_PREMIUM: Record<number, number> = {
  2021: 24_750,
  2022: 25_590,
  2023: 27_780,
  2024: 29_700,
  2025: 31_650,
  2026: 32_610,
};
const ENERGY_ADVANCE: Record<number, number> = {
  2021: 14_200,
  2022: 18_900,
  2023: 26_500,
  2024: 19_800,
  2025: 17_600,
  2026: 18_100,
};
const GYM_START = utcDay(2021, 6, 7);

type Trip = {
  start: number;
  days: number;
  country: string;
  city: string;
  currency: string;
  unitsPerEuro: number;
  operator: string;
  merchants: readonly (readonly [string, number, number])[];
};

const TRIPS: readonly Trip[] = [
  {
    start: utcDay(2021, 8, 7),
    days: 14,
    country: "NLD",
    city: "DE KOOG",
    currency: "EUR",
    unitsPerEuro: 1,
    operator: "Landal GreenParks B.V.",
    merchants: [
      ["Jumbo De Koog", 12, 85],
      ["Strandpaviljoen Paal 17", 14, 70],
      ["TESO Bootdienst", 20, 45],
      ["Fietsverhuur Kikkert", 18, 60],
      ["IJssalon Labora", 4, 18],
    ],
  },
  {
    start: utcDay(2022, 7, 16),
    days: 14,
    country: "FRA",
    city: "VALLON PONT D ARC",
    currency: "EUR",
    unitsPerEuro: 1,
    operator: "Eurocamp Travel B.V.",
    merchants: [
      ["CARREFOUR MARKET", 15, 110],
      ["E.LECLERC", 20, 130],
      ["BOULANGERIE DU PONT", 3, 14],
      ["RESTAURANT LE CHARABIA", 30, 95],
      ["TOTALENERGIES", 45, 90],
      ["APRR AUTOROUTE", 8, 42],
    ],
  },
  {
    start: utcDay(2023, 7, 22),
    days: 14,
    country: "DNK",
    city: "SKAGEN",
    currency: "DKK",
    unitsPerEuro: 7.4512,
    operator: "Novasol A/S",
    merchants: [
      ["SUPERBRUGSEN", 15, 120],
      ["NETTO", 10, 75],
      ["SKAGEN FISKERESTAURANT", 35, 120],
      ["CIRCLE K", 45, 95],
      ["BAGERIET", 4, 20],
    ],
  },
  {
    start: utcDay(2024, 8, 3),
    days: 14,
    country: "ITA",
    city: "CANNOBIO",
    currency: "EUR",
    unitsPerEuro: 1,
    operator: "Eurocamp Travel B.V.",
    merchants: [
      ["COOP CANNOBIO", 15, 100],
      ["ESSELUNGA", 20, 120],
      ["GELATERIA DEL LAGO", 4, 16],
      ["TRATTORIA LA STREPPA", 30, 100],
      ["AUTOSTRADE PER L ITALIA", 6, 38],
      ["ENI STATION", 45, 90],
    ],
  },
  {
    start: utcDay(2025, 7, 12),
    days: 14,
    country: "GBR",
    city: "KESWICK",
    currency: "GBP",
    unitsPerEuro: 0.8531,
    operator: "Sykes Cottages Ltd",
    merchants: [
      ["BOOTHS", 15, 110],
      ["CO-OP FOOD", 8, 60],
      ["THE DOG AND GUN", 25, 85],
      ["NATIONAL TRUST", 10, 45],
      ["SHELL KESWICK", 45, 95],
    ],
  },
  {
    start: utcDay(2026, 7, 18),
    days: 14,
    country: "SWE",
    city: "SMOGEN",
    currency: "SEK",
    unitsPerEuro: 11.1834,
    operator: "Novasol A/S",
    merchants: [
      ["ICA NARA", 15, 110],
      ["COOP SMOGEN", 12, 90],
      ["SMOGENS FISKAUKTION", 20, 80],
      ["CIRCLE K", 45, 95],
      ["KAFFEDOPPET", 5, 22],
    ],
  },
];

const fixedRules = (r: Rng, day: number): Event[] => {
  const { y, m } = parts(day);
  const period = `${MONTHS[m - 1]} ${y}`;
  const events: Event[] = [];
  const quarterStart = [1, 4, 7, 10].includes(m);

  if (due(day, 1)) {
    const contribution = indexed(165_000, y, 0.04);
    events.push(
      ...internal("personal", "joint", "standing", contribution, [
        "Bijdrage gezamenlijke rekening",
      ]),
    );
    events.push(
      credit("joint", "standing", PARTNER.name, PARTNER.iban, contribution, [
        "Bijdrage huishouden",
      ]),
    );
    events.push(
      debit("joint", "Florius", day < utcDay(2025, 6, 1) ? 118_542 : 124_317, [
        `Hypotheek ${period}`,
        "Leningnummer 0000000000",
      ]),
    );
    events.push(
      debit("joint", "Zilveren Kruis Zorgverzekeringen N.V.", HEALTH_PREMIUM[y], [
        `Premie zorgverzekering ${period}`,
        "2 verzekerden",
      ]),
    );
  }
  if (due(day, 2) && quarterStart) {
    const line = "Kosten gebruik betaalrekening inclusief 1 betaalpas";
    events.push({
      account: "personal",
      kind: "fee",
      cents: -indexed(675, y, 0.06),
      party: null,
      iban: null,
      remittance: [line],
    });
    events.push({
      account: "joint",
      kind: "fee",
      cents: -indexed(975, y, 0.06),
      party: null,
      iban: null,
      remittance: [line.replace("1 betaalpas", "2 betaalpassen")],
    });
  }
  if (due(day, 3)) {
    events.push(
      debit("joint", "DPG Media B.V.", indexed(3_400, y, 0.06), [
        "de Volkskrant digitaal + zaterdag",
        period,
      ]),
    );
  }
  if (due(day, 5)) {
    events.push(
      debit("personal", "NS Groep iz NS Reizigers", r.cents(15, y === 2021 ? 60 : 170), [
        `NS Flex factuur ${period}`,
      ]),
    );
  }
  if (due(day, 9, "exact")) {
    events.push({
      account: "joint",
      kind: "card",
      cents: day < utcDay(2023, 3, 1) ? -1_399 : -1_599,
      party: "NETFLIX.COM",
      iban: null,
      remittance: ["NETFLIX.COM AMSTERDAM NLD", `Pasvolgnr 001 ${dutchDate(day)} 03:12`],
    });
  }
  if (due(day, 15)) {
    events.push(
      debit("joint", "Odido Netherlands B.V.", 4_750 + 175 * (y - 2021 + (m >= 7 ? 1 : 0)), [
        `Internet en TV ${period}`,
      ]),
    );
  }
  if (due(day, 17, "exact")) {
    // The descriptor changes every month, as it does on real statements.
    const reference = hash(`spotify:${day}`).toString(16).toUpperCase().padStart(8, "0");
    const cents = day < utcDay(2023, 9, 1) ? 1_299 : day < utcDay(2025, 8, 1) ? 1_499 : 1_699;
    events.push({
      account: "joint",
      kind: "card",
      cents: -cents,
      party: `Spotify P${reference}`,
      iban: null,
      remittance: [`SPOTIFY P${reference} STOCKHOLM SWE`, `Pasvolgnr 002 ${dutchDate(day)} 04:40`],
    });
  }
  if (due(day, 20)) {
    events.push(debit("personal", "Simyo", y < 2024 ? 1_250 : 1_400, [`Simyo factuur ${period}`]));
    if (quarterStart) {
      events.push(
        debit("joint", "Vitens N.V.", indexed(4_725, y, 0.03), [
          `Drinkwater voorschot kwartaal ${Math.ceil(m / 3)} ${y}`,
        ]),
      );
    }
  }
  if (due(day, 22)) {
    events.push(
      debit("joint", "Belastingdienst", indexed(3_800, y, 0.03), [
        "Motorrijtuigenbelasting",
        `Tijdvak ${period}`,
      ]),
    );
  }
  if (due(day, 24, "before")) {
    const employer =
      day < JOB_CHANGE ? "Noordkade Software B.V." : "Stichting Digitaal Erfgoed Utrecht";
    const holidayPay = m === 5 ? Math.round(SALARY[y] * 0.92) : 0;
    const yearEnd = m === 12 ? 118_000 + 4_000 * (y - 2021) : 0;
    const suffix = m === 5 ? " incl. vakantiegeld" : m === 12 ? " incl. eindejaarsuitkering" : "";
    events.push(
      credit(
        "personal",
        "transfer",
        employer,
        fakeIban(employer),
        SALARY[y] + holidayPay + yearEnd,
        [`Salaris ${period}${suffix}`],
      ),
    );
  }
  if (due(day, 25) && m >= 2 && m <= 11) {
    events.push(
      debit("joint", "BghU", indexed(7_450, y, 0.05), [
        `Gemeentelijke belastingen ${y}`,
        `Termijn ${m - 1} van 10`,
      ]),
    );
  }
  if (due(day, 26)) {
    events.push(
      debit("joint", "Vattenfall Sales Nederland N.V.", ENERGY_ADVANCE[y], [
        `Termijnbedrag ${period}`,
        "Stroom en gas",
      ]),
    );
    events.push({
      account: "personal",
      kind: "standing",
      cents: y < 2024 ? -30_000 : -40_000,
      party: ACCOUNTS.personal.holder,
      iban: SAVINGS_IBAN,
      remittance: ["Sparen"],
    });
  }
  if (due(day, 27)) {
    events.push(
      debit("personal", "Stichting Artsen zonder Grenzen", y < 2023 ? 750 : 1_000, [
        "Maandelijkse donatie",
        "Dank voor uw steun",
      ]),
    );
  }
  if (due(day, 28)) {
    events.push(
      debit("joint", "Centraal Beheer", indexed(8_635, y, 0.045), [
        "Pakketpolis",
        "Auto, inboedel en aansprakelijkheid",
      ]),
    );
  }

  if (day >= GYM_START && (day - GYM_START) % 28 === 0) {
    events.push(
      debit("personal", "Basic-Fit Nederland B.V.", y < 2023 ? 2_499 : 2_999, [
        "Lidmaatschap Comfort",
        `Periode vanaf ${dutchDate(day)}`,
      ]),
    );
  }

  // Yearly items
  if (m === 1 && due(day, 8)) {
    events.push(
      debit("joint", "ANWB B.V.", indexed(10_450, y, 0.04), [`Wegenwacht Europa Standaard ${y}`]),
    );
  }
  if (m === 2 && due(day, 10)) {
    events.push(
      debit("personal", "Vereniging Natuurmonumenten", indexed(3_250, y, 0.03), [
        `Lidmaatschap ${y}`,
      ]),
    );
  }
  if (m === 3 && due(day, 14) && y > 2021) {
    const settlement = (hash(`energy:${y}`) % 75_000) - 30_000;
    const lines = [`Jaarafrekening ${y - 1}`, "Stroom en gas"];
    const supplier = "Vattenfall Sales Nederland N.V.";
    events.push(
      settlement >= 0
        ? credit("joint", "transfer", supplier, fakeIban(supplier), settlement + 1_000, lines)
        : debit("joint", supplier, -settlement, lines),
    );
  }
  if (day === utcDay(y, 5, 10) + (hash(`tax:${y}`) % 60) && !isWeekend(day)) {
    events.push(
      credit(
        "joint",
        "transfer",
        "Belastingdienst",
        fakeIban("Belastingdienst"),
        38_000 + (hash(`refund:${y}`) % 70_000),
        [`Teruggaaf inkomstenbelasting ${y - 1}`],
      ),
    );
  }
  if (day === businessDayOnOrAfter(utcDay(y, 10, 8 + (hash(`apk:${y}`) % 10)))) {
    events.push(
      card(r, day, "joint", "Autobedrijf Van Dijk", r.cents(189, 640), {
        pas: "001",
        hours: [15, 17],
      }),
    );
  }
  for (const trip of TRIPS) {
    if (day === trip.start - 140) {
      events.push(
        ideal(r, "joint", trip.operator, r.cents(950, 1_900), [
          `Boeking ${pad(r.int(0, 9_999_999), 7)}`,
          `Aankomst ${dutchDate(trip.start)}`,
        ]),
      );
    }
  }
  return events;
};

// ---------------------------------------------------------------------------
// Day-to-day spending
// ---------------------------------------------------------------------------

// Repeats are weights. Case and store numbers vary the way terminal names do.
const GROCERS = [
  "Albert Heijn 1411",
  "Albert Heijn 1411",
  "Albert Heijn 1411",
  "ALBERT HEIJN 8563",
  "Albert Heijn 8563",
  "Jumbo Utrecht Kanaalstraat",
  "Jumbo Utrecht Kanaalstraat",
  "JUMBO FOODMARKT",
  "Lidl 286 Utrecht",
  "Lidl 286 Utrecht",
  "Ekoplaza Nachtegaalstraat",
  "Dirk vd Broek fil4018",
] as const;
const SATURDAY_MARKET = [
  "Kaasboer Van Rijn",
  "Bakkerij Blom",
  "Groenteman Vredenburg",
  "Vishandel De Zeester",
] as const;
const DRUGSTORES = [
  "Kruidvat 7124",
  "Etos 7781",
  "KRUIDVAT 7124",
  "Apotheek Wittevrouwen",
] as const;
const FUEL = ["Shell Station Kardinaal", "Tango Utrecht", "TINQ Utrecht", "BP Lunetten"] as const;
const HOME = [
  "GAMMA Utrecht",
  "Praxis 132",
  "IKEA Utrecht",
  "Action 1087",
  "HEMA EV143",
  "Intratuin Utrecht",
  "Blokker 392",
] as const;
const RESTAURANTS = [
  "Restaurant De Zwaan",
  "Pizzeria Il Pozzo",
  "Eetcafe De Poort",
  "Sushi Lombok",
  "Brasserie Ledig Erf",
  "CCV*Cafe Olivier",
  "Zettle_*Foodhal Vaartsche",
] as const;
const LUNCH = [
  "AH to go 5802",
  "Bakker Bart 214",
  "Koffiebar De Ontmoeting",
  "Broodje Ben",
  "SumUp *Soepkar",
] as const;
const BARS = [
  "Cafe De Zaak",
  "Kafe Belgie",
  "Stadsbrouwerij Oproer",
  "CCV*Cafe Olivier",
  "Bioscoop Springhaver",
] as const;
const CLOTHING = [
  "H&M 0412",
  "UNIQLO Utrecht",
  "Decathlon Utrecht",
  "Van Haren 153",
  "WE Fashion 71",
] as const;
const ONLINE: readonly (readonly [string, number, number])[] = [
  ["bol.com b.v.", 8, 120],
  ["bol.com b.v.", 8, 120],
  ["Zalando Payments GmbH", 25, 160],
  ["Coolblue B.V.", 30, 650],
  ["Stichting Mollie Payments", 10, 90],
  ["Adyen N.V.", 10, 140],
  ["Boekhandel Savannah Bay", 12, 45],
];
const FRIENDS = [
  "J. Smits",
  "L. de Boer",
  "S. Yilmaz",
  "R. Koster",
  "N. El Amrani",
  "P. Hendriks",
] as const;
const TIKKIE_REASONS = [
  "Etentje",
  "Cadeau Lotte",
  "Boodschappen weekend",
  "Bioscoop",
  "Borrel",
  "Concertkaartjes",
  "Lunch",
  "Benzine",
] as const;
const TIKKIE = "AAB INZ TIKKIE";

type Schedule = (day: number, event: Event) => void;

const tikkieLines = (r: Rng): string[] => [
  `Tikkie ID ${pad(r.int(0, 999_999), 6)}${pad(r.int(0, 999_999), 6)}`,
  r.pick(TIKKIE_REASONS),
  r.pick(FRIENDS),
];

const dailyRules = (r: Rng, day: number, schedule: Schedule): Event[] => {
  const { y, m, wd } = parts(day);
  const prices = 1.035 ** (y - 2021);
  const festive = m === 12 ? 1.35 : 1;
  const workday = wd >= 1 && wd <= 5;
  const events: Event[] = [];

  // Joint account: the household
  const groceryChance = wd === 6 ? 0.85 : wd === 0 ? 0.35 : 0.6;
  if (r.chance(groceryChance)) {
    const visits = r.chance(0.18) ? 2 : 1;
    for (let visit = 0; visit < visits; visit++) {
      events.push(
        card(
          r,
          day,
          "joint",
          r.pick(GROCERS),
          r.cents(6 * prices, (wd === 6 ? 150 : 75) * prices),
          { hours: [8, 20] },
        ),
      );
    }
  }
  if (wd === 6 && r.chance(0.55)) {
    const stalls = r.int(1, 3);
    for (let stall = 0; stall < stalls; stall++) {
      events.push(
        card(r, day, "joint", r.pick(SATURDAY_MARKET), r.cents(4 * prices, 28 * prices), {
          hours: [9, 13],
        }),
      );
    }
  }
  if (r.chance(0.07))
    events.push(card(r, day, "joint", r.pick(DRUGSTORES), r.cents(4 * prices, 38 * prices)));
  if (r.chance(0.045))
    events.push(
      card(r, day, "joint", r.pick(FUEL), r.cents(42 * prices, 88 * prices), { hours: [7, 21] }),
    );
  if (r.chance(0.045 * festive))
    events.push(card(r, day, "joint", r.pick(HOME), r.cents(6 * prices, 190 * prices)));
  if (r.chance(wd >= 5 ? 0.12 : 0.04)) {
    events.push(
      card(r, day, "joint", r.pick(RESTAURANTS), r.cents(28 * prices, 115 * prices), {
        hours: [18, 22],
      }),
    );
  }
  if (r.chance(wd === 0 || wd >= 5 ? 0.09 : 0.03)) {
    events.push(
      ideal(r, "joint", "Thuisbezorgd.nl via Takeaway.com", r.cents(19 * prices, 48 * prices), [
        "Thuisbezorgd.nl bestelling",
      ]),
    );
  }
  if (r.chance(0.012)) {
    // A dentist's bill, and the insurer paying most of it back a week or two later.
    const bill = r.cents(45, 260);
    events.push(
      ideal(r, "joint", "Infomedics B.V.", bill, [
        "Tandartspraktijk Wittevrouwen",
        `Factuur ${pad(r.int(0, 99_999_999), 8)}`,
      ]),
    );
    if (r.chance(0.7)) {
      const insurer = "Zilveren Kruis Zorgverzekeringen N.V.";
      schedule(
        businessDayOnOrAfter(day + r.int(6, 15)),
        credit("joint", "transfer", insurer, fakeIban(insurer), Math.round(bill * 0.75), [
          "Vergoeding declaratie",
          `Declaratienummer ${pad(r.int(0, 999_999_999), 9)}`,
        ]),
      );
    }
  }
  if (r.chance(0.02)) {
    events.push(
      card(
        r,
        day,
        "joint",
        r.pick(["Q-Park Vredenburg", "P+R Westraven", "Parkeren Gemeente Utrecht"]),
        r.cents(2, 24),
      ),
    );
  }

  // Personal account
  if (workday && r.chance(y === 2021 ? 0.15 : 0.5)) {
    const canteen = day < JOB_CHANGE ? "Bedrijfsrestaurant Noordkade" : "Kantine Erfgoedhuis";
    const place = r.chance(0.4) ? canteen : r.pick(LUNCH);
    const lunch = card(r, day, "personal", place, r.cents(2.8 * prices, 13 * prices), {
      hours: [11, 14],
    });
    events.push(lunch);
    // Two purchases that look exactly alike on the same day are still two purchases.
    if (r.chance(0.05)) events.push({ ...lunch, remittance: [...lunch.remittance] });
  }
  if (r.chance(wd >= 5 ? 0.22 : 0.06)) {
    events.push(
      card(r, day, "personal", r.pick(BARS), r.cents(6 * prices, 62 * prices), { hours: [17, 23] }),
    );
  }
  if (r.chance(0.03 * festive))
    events.push(card(r, day, "personal", r.pick(CLOTHING), r.cents(15 * prices, 150 * prices)));
  if (r.chance(0.05 * festive)) {
    const [shop, min, max] = r.pick(ONLINE);
    const cents = r.cents(min * prices, max * prices);
    events.push(ideal(r, "personal", shop, cents, [`Bestelling ${pad(r.int(0, 999_999_999), 9)}`]));
    if (r.chance(0.12)) {
      const refund = r.chance(0.6) ? cents : Math.round(cents * 0.4);
      schedule(
        businessDayOnOrAfter(day + r.int(4, 14)),
        credit("personal", "transfer", shop, fakeIban(shop), refund, [
          "Terugbetaling retour",
          `Bestelling ${pad(r.int(0, 999_999_999), 9)}`,
        ]),
      );
    }
  }
  if (r.chance(0.035)) {
    events.push({
      account: "personal",
      kind: "ideal",
      cents: -r.cents(5, 48),
      party: TIKKIE,
      iban: fakeIban(TIKKIE),
      remittance: tikkieLines(r),
    });
  }
  if (r.chance(0.03)) {
    events.push(
      credit("personal", "transfer", TIKKIE, fakeIban(TIKKIE), r.cents(5, 60), tikkieLines(r)),
    );
  }
  if (r.chance(0.012)) {
    const cents = r.pick([2_000, 5_000, 5_000, 10_000]);
    events.push({
      account: "personal",
      kind: "atm",
      cents: -cents,
      party: "Geldmaat Vredenburg",
      iban: null,
      remittance: [
        `Geldmaat Vredenburg ${CITY} NLD`,
        `Pasvolgnr 003 ${dutchDate(day)} ${clock(r, 9, 22)}`,
      ],
    });
  }
  if ((day - START) % 41 === 17) {
    events.push(
      card(r, day, "personal", "Kapsalon Knip & Co", indexed(2_800, y, 0.05), { hours: [9, 17] }),
    );
  }
  return events;
};

const tripRules = (r: Rng, day: number, trip: Trip): Event[] => {
  const abroad = (account: AccountKey): Event => {
    const [terminal, min, max] = r.pick(trip.merchants);
    const cents = r.cents(min, max);
    const event = card(r, day, account, terminal, cents, {
      country: trip.country,
      city: trip.city,
      hours: [8, 22],
    });
    if (trip.currency === "EUR") return event;
    return {
      ...event,
      exchange: {
        unit_currency: "EUR",
        exchange_rate: trip.unitsPerEuro.toFixed(4),
        rate_type: "SPOT",
        contract_identification: null,
        instructed_amount: {
          currency: trip.currency,
          amount: (Math.round(cents * trip.unitsPerEuro) / 100).toFixed(2),
        },
      },
    };
  };
  const events: Event[] = [];
  const purchases = r.int(1, 4);
  for (let purchase = 0; purchase < purchases; purchase++) events.push(abroad("joint"));
  if (r.chance(0.3)) events.push(abroad("personal"));
  return events;
};

// Keeps both balances inside a believable band, the way people move money around at the
// end of the month. Balances never reach the archive; they only steer these transfers.
const balancingRules = (day: number, balances: Record<AccountKey, number>): Event[] => {
  if (!due(day, 28)) return [];
  const events: Event[] = [];
  let personal = balances.personal;
  if (balances.joint < 60_000) {
    const topUp = Math.ceil((100_000 - balances.joint) / 10_000) * 10_000;
    events.push(...internal("personal", "joint", "transfer", topUp, ["Aanvulling huishoudpot"]));
    personal -= topUp;
  } else if (balances.joint > 400_000) {
    events.push({
      account: "joint",
      kind: "transfer",
      cents: -150_000,
      party: ACCOUNTS.joint.holder,
      iban: JOINT_SAVINGS_IBAN,
      remittance: ["Buffer"],
    });
  }
  // The contribution to the joint account leaves on the 1st, so this has to cover it.
  if (personal > 330_000) {
    const extra = Math.floor((personal - 280_000) / 5_000) * 5_000;
    events.push({
      account: "personal",
      kind: "transfer",
      cents: -extra,
      party: ACCOUNTS.personal.holder,
      iban: SAVINGS_IBAN,
      remittance: ["Extra sparen"],
    });
  } else if (personal < 200_000) {
    const fromSavings = Math.ceil((250_000 - personal) / 25_000) * 25_000;
    events.push(
      credit("personal", "transfer", ACCOUNTS.personal.holder, SAVINGS_IBAN, fromSavings, [
        "Van spaarrekening",
      ]),
    );
  }
  return events;
};

// ---------------------------------------------------------------------------
// From events to archive records
// ---------------------------------------------------------------------------

const inOutage = (day: number): boolean => OUTAGES.some(([from, to]) => day >= from && day <= to);
const nextSyncNight = (day: number): number => (inOutage(day) ? nextSyncNight(day + 1) : day);
// The sync runs at 03:00 UTC and takes a few seconds, never the same number twice running.
const syncInstant = (day: number): string =>
  `${iso(day)}T03:00:${pad(3 + (hash(`sync:${day}`) % 50))}Z`;

const euros = (cents: number): string => (cents / 100).toFixed(2);

export const buildArchive = (): ArchiveRecord[] => {
  const r = makeRng(20261007);
  const balances: Record<AccountKey, number> = { personal: 185_000, joint: 124_000 };
  const sequences = new Map<string, number>();
  const scheduled = new Map<number, Event[]>();
  const records: ArchiveRecord[] = [];

  const schedule: Schedule = (day, event) => {
    scheduled.set(day, [...(scheduled.get(day) ?? []), event]);
  };

  const record = (day: number, event: Event): ArchiveRecord => {
    const account = ACCOUNTS[event.account];
    const sequenceKey = `${event.account}:${day}`;
    const sequence =
      (sequences.get(sequenceKey) ?? 10_000_000 + (hash(sequenceKey) % 80_000_000)) + r.int(1, 997);
    sequences.set(sequenceKey, sequence);
    balances[event.account] += event.cents;

    const isCredit = event.cents > 0;
    const self = { name: account.holder };
    const selfAccount = { iban: account.iban };
    const other = event.party === null ? null : { name: event.party };
    const otherAccount = event.iban === null ? null : { iban: event.iban };
    const bookingDate = iso(day);
    const raw: RawTransaction = {
      entry_reference: `${bookingDate.replaceAll("-", "")}-${sequence}`,
      transaction_amount: { currency: "EUR", amount: euros(Math.abs(event.cents)) },
      credit_debit_indicator: isCredit ? "CRDT" : "DBIT",
      status: "BOOK",
      booking_date: bookingDate,
      value_date: bookingDate,
      transaction_date: iso(day - (event.daysBeforeBooking ?? 0)),
      creditor: isCredit ? self : other,
      creditor_account: isCredit ? selfAccount : otherAccount,
      creditor_agent: null,
      debtor: isCredit ? other : self,
      debtor_account: isCredit ? otherAccount : selfAccount,
      debtor_agent: null,
      bank_transaction_code: { ...KINDS[event.kind], sub_code: null },
      merchant_category_code: null,
      remittance_information: event.remittance,
      exchange_rate: event.exchange ?? null,
      balance_after_transaction: null,
      reference_number: null,
      reference_number_schema: null,
      debtor_account_additional_identification: null,
      creditor_account_additional_identification: null,
      note: null,
      transaction_id: null,
    };

    const lastNight = END + 1;
    const firstSeenDay = Math.min(
      lastNight,
      nextSyncNight(Math.max(FIRST_SYNC, day + (r.chance(0.15) ? 2 : 1))),
    );
    // Now and then the bank changes a transaction after we first stored it. Here the
    // earlier version lacked its last remittance line.
    const revisedDay = nextSyncNight(firstSeenDay + r.int(1, 3));
    const revised = r.chance(0.005) && event.remittance.length > 1 && revisedDay <= lastNight;
    return {
      account: account.iban,
      entry_reference: raw.entry_reference,
      first_seen: syncInstant(firstSeenDay),
      revisions: revised
        ? [
            {
              replaced_at: syncInstant(revisedDay),
              raw: { ...raw, remittance_information: event.remittance.slice(0, -1) },
            },
          ]
        : [],
      raw,
    };
  };

  for (let day = START; day <= END; day++) {
    const trip = TRIPS.find(
      (candidate) => day >= candidate.start && day < candidate.start + candidate.days,
    );
    const events = [
      ...(scheduled.get(day) ?? []),
      ...fixedRules(r, day),
      ...(trip ? tripRules(r, day, trip) : dailyRules(r, day, schedule)),
    ];
    for (const event of events) records.push(record(day, event));
    for (const event of balancingRules(day, balances)) records.push(record(day, event));
  }

  const sortKey = (item: ArchiveRecord): string =>
    `${item.raw.booking_date} ${item.account} ${item.entry_reference}`;
  return records.toSorted((a, b) =>
    sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0,
  );
};

// File name to file contents, one file per booking year.
export const renderYearFiles = (records: readonly ArchiveRecord[]): Map<string, string> => {
  const byYear = Map.groupBy(records, (item) => item.raw.booking_date.slice(0, 4));
  return new Map(
    [...byYear].map(([year, items]) => [`${year}.json`, `${JSON.stringify(items, null, 2)}\n`]),
  );
};

export const ARCHIVE_DIR = join(import.meta.dirname, "archive");

if (import.meta.main) {
  const files = renderYearFiles(buildArchive());
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const stale of readdirSync(ARCHIVE_DIR).filter(
    (name) => name.endsWith(".json") && !files.has(name),
  )) {
    rmSync(join(ARCHIVE_DIR, stale));
  }
  for (const [name, contents] of files) writeFileSync(join(ARCHIVE_DIR, name), contents);
  console.log(`wrote ${files.size} files to ${ARCHIVE_DIR}`);
}
