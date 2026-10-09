// What the invented household did, day by day, in terms of roles: the joint account, the
// card, the savings. Which real account a role is on a given day is world.ts's business,
// and how a posting reached the archive is generate.ts's. Everything here is invented.
import {
  businessDayOnOrAfter,
  due,
  dutchDate,
  isWeekend,
  MONTHS,
  pad,
  parts,
  utcDay,
} from "./dates.ts";
import { ACCOUNTS, accountFor, ROLES, SWITCH } from "./world.ts";
import type { AccountKey, Role } from "./world.ts";

export type ExchangeRate = {
  unit_currency: string;
  exchange_rate: string;
  rate_type: string;
  contract_identification: string | null;
  instructed_amount: { currency: string; amount: string };
};

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export const START = utcDay(2021, 1, 12);
export const END = utcDay(2026, 10, 6);

const PARTNER = { name: "T. Bakker", iban: "NL00BNKC0000000004" };
const CITY = "UTRECHT";

type Kind = "card" | "ideal" | "debit" | "transfer" | "standing" | "atm" | "fee" | "interest";

export const KINDS: Record<Kind, { description: string; code: string }> = {
  card: { description: "Betaalautomaat", code: "BEA" },
  ideal: { description: "iDEAL", code: "IDB" },
  debit: { description: "Incasso", code: "INC" },
  transfer: { description: "Overboeking", code: "OVB" },
  standing: { description: "Periodieke overboeking", code: "STO" },
  atm: { description: "Geldautomaat", code: "GEA" },
  fee: { description: "Kosten", code: "KST" },
  interest: { description: "Rente", code: "RNT" },
};

export type Event = {
  role: Role;
  // Set only where an event belongs to one specific account whatever the day.
  account?: AccountKey;
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
export const hash = (text: string): number => {
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
export const makeRng = (seed: number): Rng => {
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
  const banks = ["BNKC", "BNKD", "BNKE", "BNKF", "BNKG", "BNKH"];
  const h = hash(name);
  return `NL00${banks[h % banks.length]}${pad(h % 10_000_000_000, 10)}`;
};

const clock = (r: Rng, fromHour: number, toHour: number): string =>
  `${pad(r.int(fromHour, toHour))}:${pad(r.int(0, 59))}`;

type CardOptions = { country?: string; city?: string; hours?: [number, number]; pas?: string };

const card = (
  r: Rng,
  day: number,
  role: Role,
  terminal: string,
  cents: number,
  options: CardOptions = {},
): Event => {
  const daysBeforeBooking = r.chance(0.1) ? 1 : 0;
  const pas =
    options.pas ??
    (role === "personal"
      ? "003"
      : role === "second-personal"
        ? "004"
        : r.pick(["001", "001", "002"]));
  const [fromHour, toHour] = options.hours ?? [9, 20];
  return {
    role,
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

const debit = (role: Role, creditor: string, cents: number, lines: string[]): Event => {
  const h = hash(`${creditor}:${role}`);
  return {
    role,
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

const ideal = (r: Rng, role: Role, shop: string, cents: number, lines: string[]): Event => ({
  role,
  kind: "ideal",
  cents: -cents,
  party: shop,
  iban: fakeIban(shop),
  remittance: [`${pad(r.int(0, 99_999_999), 8)} ${pad(r.int(0, 99_999_999), 8)}`, ...lines],
});

const credit = (
  role: Role,
  kind: Kind,
  party: string,
  iban: string,
  cents: number,
  lines: string[],
): Event => ({ role, kind, cents, party, iban, remittance: lines });

// A transfer between two of the household's own accounts shows up twice, once on each.
const internal = (
  day: number,
  from: Role,
  to: Role,
  kind: Kind,
  cents: number,
  lines: string[],
): Event[] => {
  const source = ACCOUNTS[accountFor(from, day)];
  const target = ACCOUNTS[accountFor(to, day)];
  return [
    {
      role: from,
      kind,
      cents: -cents,
      party: target.holder,
      iban: target.iban ?? null,
      remittance: lines,
    },
    {
      role: to,
      kind,
      cents,
      party: source.holder,
      iban: source.iban ?? null,
      remittance: lines,
    },
  ];
};

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
      ...internal(day, "personal", "joint", "standing", contribution, [
        "Bijdrage gezamenlijke rekening",
      ]),
    );
    events.push(
      credit("joint", "standing", PARTNER.name, PARTNER.iban, contribution, [
        "Bijdrage huishouden",
      ]),
    );
    events.push(
      debit("joint", "Thuishaven Hypotheken B.V.", day < utcDay(2025, 6, 1) ? 118_542 : 124_317, [
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
      role: "personal",
      kind: "fee",
      cents: -indexed(675, y, 0.06),
      party: null,
      iban: null,
      remittance: [line],
    });
    events.push({
      role: "joint",
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
      role: "card",
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
      role: "card",
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
    events.push(
      ...internal(day, "personal", "personal-savings", "standing", y < 2024 ? 30_000 : 40_000, [
        "Sparen",
      ]),
    );
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
  if (day >= SWITCH) {
    if (due(day, 1))
      events.push(...internal(day, "personal", "second-personal", "standing", 15_000, ["Zakgeld"]));
    if (due(day, 2))
      events.push(
        ...internal(day, "second-personal", "second-savings", "standing", 5_000, ["Sparen"]),
      );
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
const PAYMENT_REQUEST_REASONS = [
  "Etentje",
  "Cadeau Lotte",
  "Boodschappen weekend",
  "Bioscoop",
  "Borrel",
  "Concertkaartjes",
  "Lunch",
  "Benzine",
] as const;
const PAYMENT_REQUEST = "INZ BETAALVERZOEK";

type Schedule = (day: number, event: Event) => void;

const paymentRequestLines = (r: Rng): string[] => [
  `Verzoek ID ${pad(r.int(0, 999_999), 6)}${pad(r.int(0, 999_999), 6)}`,
  r.pick(PAYMENT_REQUEST_REASONS),
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
      role: "personal",
      kind: "ideal",
      cents: -r.cents(5, 48),
      party: PAYMENT_REQUEST,
      iban: fakeIban(PAYMENT_REQUEST),
      remittance: paymentRequestLines(r),
    });
  }
  if (r.chance(0.03)) {
    events.push(
      credit(
        "personal",
        "transfer",
        PAYMENT_REQUEST,
        fakeIban(PAYMENT_REQUEST),
        r.cents(5, 60),
        paymentRequestLines(r),
      ),
    );
  }
  if (r.chance(0.012)) {
    const cents = r.pick([2_000, 5_000, 5_000, 10_000]);
    events.push({
      role: "personal",
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
  if (day >= SWITCH && r.chance(0.12)) {
    events.push(card(r, day, "second-personal", r.pick(LUNCH), r.cents(3 * prices, 14 * prices)));
  }
  return events;
};

const tripRules = (r: Rng, day: number, trip: Trip): Event[] => {
  const abroad = (role: Role): Event => {
    const [terminal, min, max] = r.pick(trip.merchants);
    const cents = r.cents(min, max);
    const event = card(r, day, role, terminal, cents, {
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
  if (r.chance(0.3)) events.push(abroad("card"));
  return events;
};

// Keeps balances inside a believable band, the way people move money around at the end
// of the month. Balances never reach the archive; they only steer these transfers.
const balancingRules = (day: number, balances: Record<Role, number>): Event[] => {
  const events: Event[] = [];
  const { y, m } = parts(day);
  // Interest for the previous year, on whatever the savings hold.
  if (m === 1 && due(day, 2)) {
    for (const role of ["personal-savings", "joint-savings", "second-savings"] as const) {
      const cents = balances[role] > 0 ? Math.round(balances[role] * 0.012) : 0;
      if (cents > 0) {
        events.push({
          role,
          kind: "interest",
          cents,
          party: null,
          iban: null,
          remittance: [`Rente ${y - 1}`],
        });
      }
    }
  }
  if (due(day, 27) && balances.card < 0) {
    events.push(
      ...internal(day, "joint", "card", "debit", -balances.card, ["Afrekening creditcard"]),
    );
  }
  if (!due(day, 28)) return events;

  let personal = balances.personal;
  if (balances.joint < 60_000) {
    const topUp = Math.ceil((100_000 - balances.joint) / 10_000) * 10_000;
    events.push(
      ...internal(day, "personal", "joint", "transfer", topUp, ["Aanvulling huishoudpot"]),
    );
    personal -= topUp;
  } else if (balances.joint > 400_000) {
    events.push(...internal(day, "joint", "joint-savings", "transfer", 150_000, ["Buffer"]));
  }
  // The contribution to the joint account leaves on the 1st, so this has to cover it.
  if (personal > 330_000) {
    const extra = Math.floor((personal - 280_000) / 5_000) * 5_000;
    events.push(
      ...internal(day, "personal", "personal-savings", "transfer", extra, ["Extra sparen"]),
    );
  } else if (personal < 200_000) {
    const back = Math.ceil((250_000 - personal) / 25_000) * 25_000;
    events.push(
      ...internal(day, "personal-savings", "personal", "transfer", back, ["Van spaarrekening"]),
    );
  }
  return events;
};

export type Posting = { day: number; account: AccountKey; event: Event };

// What moves on the day the second bank is added: the card is settled, and the joint
// account and its savings are emptied into their successors.
const switchEvents = (balances: Record<AccountKey, number>): Event[] => {
  const move = (from: AccountKey, to: AccountKey): Event[] => {
    const cents = Math.max(balances[from], 25_000);
    const lines = ["Saldo overboeken"];
    return [
      {
        role: "joint",
        account: from,
        kind: "transfer",
        cents: -cents,
        party: ACCOUNTS[to].holder,
        iban: ACCOUNTS[to].iban ?? null,
        remittance: lines,
      },
      {
        role: "joint",
        account: to,
        kind: "transfer",
        cents,
        party: ACCOUNTS[from].holder,
        iban: ACCOUNTS[from].iban ?? null,
        remittance: lines,
      },
    ];
  };
  const owed = -balances["bnka-card"];
  const settle: Event[] =
    owed <= 0
      ? []
      : [
          {
            role: "joint",
            account: "bnka-joint",
            kind: "debit",
            cents: -owed,
            party: ACCOUNTS["bnka-card"].holder,
            iban: null,
            remittance: ["Afrekening creditcard"],
          },
          {
            role: "card",
            account: "bnka-card",
            kind: "debit",
            cents: owed,
            party: ACCOUNTS["bnka-joint"].holder,
            iban: ACCOUNTS["bnka-joint"].iban ?? null,
            remittance: ["Afrekening creditcard"],
          },
        ];
  return [
    ...settle,
    ...move("bnka-joint", "bnkb-joint"),
    ...move("bnka-joint-savings", "bnkb-joint-savings"),
  ];
};

export const simulate = (): Posting[] => {
  const r = makeRng(20261007);
  const balances = Object.fromEntries(Object.keys(ACCOUNTS).map((key) => [key, 0])) as Record<
    AccountKey,
    number
  >;
  balances["bnka-personal"] = 185_000;
  balances["bnka-joint"] = 124_000;
  const scheduled = new Map<number, Event[]>();
  const postings: Posting[] = [];

  const schedule: Schedule = (day, event) => {
    scheduled.set(day, [...(scheduled.get(day) ?? []), event]);
  };
  const post = (day: number, event: Event): void => {
    const account = event.account ?? accountFor(event.role, day);
    balances[account] += event.cents;
    postings.push({ day, account, event });
  };
  const byRole = (day: number): Record<Role, number> =>
    Object.fromEntries(ROLES.map((role) => [role, balances[accountFor(role, day)]])) as Record<
      Role,
      number
    >;

  for (let day = START; day <= END; day++) {
    if (day === SWITCH) for (const event of switchEvents(balances)) post(day, event);
    const trip = TRIPS.find(
      (candidate) => day >= candidate.start && day < candidate.start + candidate.days,
    );
    const events = [
      ...(scheduled.get(day) ?? []),
      ...fixedRules(r, day),
      ...(trip ? tripRules(r, day, trip) : dailyRules(r, day, schedule)),
    ];
    for (const event of events) post(day, event);
    for (const event of balancingRules(day, byRole(day))) post(day, event);
  }
  return postings;
};
