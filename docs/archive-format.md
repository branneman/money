# Archive format

The contract between the parts of this project. `sync` and `import` write the archive; the dashboard reads it. Everything else can change without touching this; a change here touches everything, and the archive outlives every version of the code.

Three rules hold throughout:

1. **Nothing is ever deleted or rewritten in place.** A record that changes keeps its earlier versions.
2. **The bank's data is stored unmodified.** What arrived is kept as `raw`, and every interpretation of it happens at read time.
3. **Identity never comes from content.** Two transactions that look identical are two transactions.

## Accounts

Every account has an **account key**: a short name chosen by the user, such as `bnka-current`. It matches `[a-z0-9-]+`.

- The key is the account's identity in the archive, in the configuration and in tagging rules. It is permanent. Renaming a key means renaming a directory by hand.
- The key is deliberately not the IBAN. Not every account has one (a credit card does not), and the bank's own account ids change with every new consent.
- Which bank and which account number a key stands for is configuration, described in [sync.md](sync.md).

## Layout

```text
$DATA_DIR/
  <account key>/
    api/
      <year>.json
    import/
      <year>.json
  .inbox/
    ...
```

- **One directory per account.** Fetching and merging happen per account, so storage follows the same unit. A failure in one account cannot damage another, and a closed account's files simply stop changing.
- **One subdirectory per source.** `sync` writes only under `api/`, `import` only under `import/`. No file has two writers.
- **One file per calendar year**, by booking date. Past years stay byte-for-byte identical, which is what makes backups and their verification cheap.
- **Names starting with a dot are not part of the archive.** `.inbox/` is the sync's working area (see [sync.md](sync.md)). Readers skip it.

## Year files

Each file is a JSON array of records:

- sorted by booking date, then by `id`;
- formatted with two-space indentation and a trailing newline;
- written to a temporary file and renamed into place, so a file is either the old version or the new one, never half of each.

A run that finds nothing new leaves every file byte-for-byte identical.

## Records

```json
{
  "account": "bnka-current",
  "source": "api",
  "id": "20261006-12345678",
  "first_seen": "2026-10-07T03:00:00Z",
  "revisions": [],
  "raw": {}
}
```

| Field        | Meaning                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| `account`    | The account key.                                                                        |
| `source`     | `"api"` or `"import"`.                                                                  |
| `id`         | The bank's own identifier for this transaction, as a string. See Identity.              |
| `format`     | Import records only: the key of the import format that describes `raw`.                 |
| `first_seen` | When this record was first written, in UTC.                                             |
| `revisions`  | Earlier versions of `raw`, oldest first. Each is `{ "replaced_at": "...", "raw": {} }`. |
| `raw`        | The transaction exactly as received.                                                    |

`account` and `source` repeat what the path already says. They are kept so a record still explains itself when it is copied out of its file.

### `raw` for API records

The unmodified `Transaction` object from the Enable Banking API. The API requires only `transaction_amount`, `credit_debit_indicator` and `status`; every other field may be missing, and which ones a given bank fills in is only known from real responses.

### `raw` for import records

One row of the exported file, as an object from column header to cell text. Every column is kept, empty ones included, and no value is parsed, trimmed or converted. Numbers stay in the bank's notation, such as `"-10,00"`.

The one conversion is the character encoding. Banks export in various encodings; the archive is always UTF-8. The file is decoded with the encoding its import format names. Because the decoded text is stored for good, a wrong encoding is checked for before anything is written; see [sync.md](sync.md).

## Identity

A transaction is identified by **account, source and `id`**.

- **For API records**, `id` is the `entry_reference`: the bank's own reference, unique and immutable within an account. A booked transaction without one is an error, never a reason to fall back on matching content.
- **For import records**, `id` is the column the import format names as the identifier, such as a sequence number. It must be unique within the account. A file with a missing or repeated identifier is rejected as a whole.
- **Source is part of the identity** because the two identifiers come from different systems. Nothing guarantees that a bank's export numbers its transactions the way its API does.

The same real-world transaction can therefore exist twice: once fetched and once imported. That is resolved when reading, not when writing.

## Merging

The same rules apply to both sources. For each incoming transaction:

- **New identity:** add a record, with `first_seen` set to now.
- **Known and identical:** leave it alone.
- **Known but different:** move the stored `raw` into `revisions` with the current time, store the new `raw`, and log a warning.
- **Stored, but absent from a fetch that should contain it:** keep it, and log a warning.

## Reading: the normalised view

Readers never interpret `raw` directly. One pure function turns a record into a **normalised transaction**, and everything in the dashboard, tagging rules included, works on that.

| Field                  | Type            | Notes                                                       |
| ---------------------- | --------------- | ----------------------------------------------------------- |
| `account`              | string          | The account key.                                            |
| `source`, `id`         | string          | Together with `account`, the identity.                      |
| `date`                 | `YYYY-MM-DD`    | Booking date.                                               |
| `value_date`           | date or null    |                                                             |
| `amount`               | integer         | In the currency's smallest unit. Negative is money leaving. |
| `currency`             | string          | ISO 4217.                                                   |
| `counterparty_name`    | string or null  |                                                             |
| `counterparty_account` | string or null  | An IBAN where there is one.                                 |
| `description`          | string          | All free-text lines, joined with newlines.                  |
| `code`                 | string or null  | The bank's own transaction type, if it gives one.           |
| `original_amount`      | integer or null | For a purchase in another currency.                         |
| `original_currency`    | string or null  |                                                             |
| `first_seen`           | timestamp       |                                                             |
| `revised`              | boolean         | Whether `revisions` is non-empty.                           |

- **API records** are normalised by code: the sign comes from `credit_debit_indicator`, and the counterparty is the creditor of a debit or the debtor of a credit.
- **Import records** are normalised by their import format (below). Fixing a mistake in a format changes the view at once and rewrites nothing.

### When both sources cover the same day

For each account, the earliest booking date among its API records is its **API start**. Import records dated on or after the API start are left out of the view. They stay in the archive.

This rule depends only on what is stored, not on the order things were done in. Importing first and authorising later gives the same view as the other way round.

One known limit: the rule assumes the API has covered every day since its start. If the sync is down for longer than a bank's history reaches, the gap cannot be filled by an import. If that ever happens, the rule has to learn about covered periods.

## Import formats

An import format describes one bank's export file, as data. It contains no code.

```json
{
  "delimiter": ";",
  "encoding": "utf-8",
  "account": { "column": "Account" },
  "id": { "column": "Sequence" },
  "date": { "column": "Booked", "format": "YYYY-MM-DD" },
  "value_date": { "column": "Value date", "format": "YYYY-MM-DD" },
  "amount": { "column": "Amount", "decimal": "," },
  "currency": { "column": "Currency" },
  "counterparty_name": { "column": "Counterparty" },
  "counterparty_account": { "column": "Counterparty account" },
  "description": { "columns": ["Text 1", "Text 2", "Text 3"] },
  "code": { "column": "Type" },
  "original_amount": { "column": "Original amount", "decimal": "," },
  "original_currency": { "column": "Original currency" }
}
```

- `delimiter`, `encoding`, `account`, `id`, `date`, `amount` and `currency` are required.
- `encoding` is one of `utf-8`, `windows-1252` or `iso-8859-15`, spelled exactly so. It is never guessed. Latin-1 (ISO-8859-1) and plain ASCII files are declared as `windows-1252`, which reads both correctly.
- Every format must name an identifier column. A bank's export without one cannot be imported.
- The other fields may be left out, and the matching field in the view is then null.
- `account` names the column that says which account a row belongs to. One file may hold rows for several accounts. A row for an account that is not configured rejects the file.
- `amount` is a signed decimal in one column, with an optional leading `+` or `-`. Other notations are added to this schema when a bank needs them.
- `description` joins several columns, skipping empty ones.

This example describes a made-up bank. Real formats name real banks through their column headers, so they are kept with the production configuration and never in this repository.

## Changing this format

A change to the record wrapper, the layout or the view is a change to every part at once.

- Old files are never migrated wholesale. The code keeps reading every format it ever wrote.
- Each superseded format gets a small frozen fixture and a test that reads it. See [testing.md](testing.md).
