// Every counterparty the generator can produce, and nothing else. fixtures/archive.test.ts
// holds the generated archive to this list, so a new name is a deliberate addition here,
// and an entry nothing uses any more fails too.
//
// A string is an exact name. A pattern stands for a name with a part that varies, and is
// not held to being used. No entry names a bank, and every payment institution is invented.
export const KNOWN_COUNTERPARTIES: readonly (string | RegExp)[] = [
  // The household and the people around it
  "M. Visser",
  "M. Visser en/of T. Bakker",
  "T. Bakker",
  // What a payment request between friends is booked under
  "INZ BETAALVERZOEK",

  // Employers and the canteens at work
  "Noordkade Software B.V.",
  "Stichting Digitaal Erfgoed Utrecht",
  "Bedrijfsrestaurant Noordkade",
  "Kantine Erfgoedhuis",

  // Housing, insurance and care
  "Thuishaven Hypotheken B.V.",
  "Zilveren Kruis Zorgverzekeringen N.V.",
  "Centraal Beheer",
  "Infomedics B.V.",

  // Utilities, telecom and media
  "Vattenfall Sales Nederland N.V.",
  "Vitens N.V.",
  "Odido Netherlands B.V.",
  "Simyo",
  "DPG Media B.V.",

  // The tax office and other public bodies
  "Belastingdienst",
  "BghU",

  // Memberships and charity
  "Basic-Fit Nederland B.V.",
  "ANWB B.V.",
  "Vereniging Natuurmonumenten",
  "Stichting Artsen zonder Grenzen",

  // Transport, fuel, parking and the car
  "NS Groep iz NS Reizigers",
  "Shell Station Kardinaal",
  "Tango Utrecht",
  "TINQ Utrecht",
  "BP Lunetten",
  "Q-Park Vredenburg",
  "P+R Westraven",
  "Parkeren Gemeente Utrecht",
  "Autobedrijf Van Dijk",

  // Grocers, as their terminals spell them
  "Albert Heijn 1411",
  "ALBERT HEIJN 8563",
  "Albert Heijn 8563",
  "Jumbo Utrecht Kanaalstraat",
  "JUMBO FOODMARKT",
  "Lidl 286 Utrecht",
  "Ekoplaza Nachtegaalstraat",
  "Dirk vd Broek fil4018",

  // The Saturday market
  "Kaasboer Van Rijn",
  "Bakkerij Blom",
  "Groenteman Vredenburg",
  "Vishandel De Zeester",

  // Drugstores and the pharmacy
  "Kruidvat 7124",
  "KRUIDVAT 7124",
  "Etos 7781",
  "Apotheek Wittevrouwen",

  // Household and garden
  "GAMMA Utrecht",
  "Praxis 132",
  "IKEA Utrecht",
  "Action 1087",
  "HEMA EV143",
  "Intratuin Utrecht",
  "Blokker 392",

  // Restaurants and takeaway
  "Restaurant De Zwaan",
  "Pizzeria Il Pozzo",
  "Eetcafe De Poort",
  "Sushi Lombok",
  "Brasserie Ledig Erf",
  "CCV*Cafe Olivier",
  "Zettle_*Foodhal Vaartsche",
  "Thuisbezorgd.nl via Takeaway.com",

  // Lunch
  "AH to go 5802",
  "Bakker Bart 214",
  "Koffiebar De Ontmoeting",
  "Broodje Ben",
  "SumUp *Soepkar",

  // Bars and going out
  "Cafe De Zaak",
  "Kafe Belgie",
  "Stadsbrouwerij Oproer",
  "Bioscoop Springhaver",

  // Clothing and the hairdresser
  "H&M 0412",
  "UNIQLO Utrecht",
  "Decathlon Utrecht",
  "Van Haren 153",
  "WE Fashion 71",
  "Kapsalon Knip & Co",

  // Online shops
  "bol.com b.v.",
  "Coolblue B.V.",
  "Boekhandel Savannah Bay",

  // Payment institutions that collect for online shops. All three are invented.
  "Betaalhuis N.V.",
  "Stichting Derdengelden Webwinkels",
  "Modehuis Online B.V.",

  // Cash
  "Geldmaat Vredenburg",

  // Holiday operators
  "Landal GreenParks B.V.",
  "Eurocamp Travel B.V.",
  "Novasol A/S",
  "Sykes Cottages Ltd",

  // On holiday: the Netherlands
  "Jumbo De Koog",
  "Strandpaviljoen Paal 17",
  "TESO Bootdienst",
  "Fietsverhuur Kikkert",
  "IJssalon Labora",
  // France
  "CARREFOUR MARKET",
  "E.LECLERC",
  "BOULANGERIE DU PONT",
  "RESTAURANT LE CHARABIA",
  "TOTALENERGIES",
  "APRR AUTOROUTE",
  // Denmark
  "SUPERBRUGSEN",
  "NETTO",
  "SKAGEN FISKERESTAURANT",
  "CIRCLE K",
  "BAGERIET",
  // Italy
  "COOP CANNOBIO",
  "ESSELUNGA",
  "GELATERIA DEL LAGO",
  "TRATTORIA LA STREPPA",
  "AUTOSTRADE PER L ITALIA",
  "ENI STATION",
  // Britain
  "BOOTHS",
  "CO-OP FOOD",
  "THE DOG AND GUN",
  "NATIONAL TRUST",
  "SHELL KESWICK",
  // Sweden
  "ICA NARA",
  "COOP SMOGEN",
  "SMOGENS FISKAUKTION",
  "KAFFEDOPPET",

  // Subscriptions charged to the card. The card export has no counterparty column, so
  // these reach the view only as card texts, below; they are patterns so that the list is
  // complete without claiming they are seen as counterparties. The second one's reference
  // changes every month.
  /^NETFLIX\.COM$/,
  /^Spotify P[0-9A-F]{8}$/,
];

// A card-export row has no counterparty column. What identifies the other side is the
// first line of its description, held to this list in the same way.
export const KNOWN_CARD_TEXTS: readonly (string | RegExp)[] = [
  // The monthly settlement from the joint account
  "Afrekening creditcard",

  // Subscriptions
  "NETFLIX.COM AMSTERDAM NLD",
  /^SPOTIFY P[0-9A-F]{8} STOCKHOLM SWE$/,

  // Card purchases on holiday: a merchant, the place and the country. Which merchants the
  // card happens to visit is the generator's draw, so each holiday is one pattern.
  /^(Jumbo De Koog|Strandpaviljoen Paal 17|TESO Bootdienst|Fietsverhuur Kikkert|IJssalon Labora) DE KOOG NLD$/,
  /^(CARREFOUR MARKET|E\.LECLERC|BOULANGERIE DU PONT|RESTAURANT LE CHARABIA|TOTALENERGIES|APRR AUTOROUTE) VALLON PONT D ARC FRA$/,
  /^(SUPERBRUGSEN|NETTO|SKAGEN FISKERESTAURANT|CIRCLE K|BAGERIET) SKAGEN DNK$/,
  /^(COOP CANNOBIO|ESSELUNGA|GELATERIA DEL LAGO|TRATTORIA LA STREPPA|AUTOSTRADE PER L ITALIA|ENI STATION) CANNOBIO ITA$/,
  /^(BOOTHS|CO-OP FOOD|THE DOG AND GUN|NATIONAL TRUST|SHELL KESWICK) KESWICK GBR$/,
  /^(ICA NARA|COOP SMOGEN|SMOGENS FISKAUKTION|CIRCLE K|KAFFEDOPPET) SMOGEN SWE$/,
];
