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

- sorted by `date`, then by `id`;
- formatted with two-space indentation and a trailing newline;
- written to a temporary file and renamed into place, so a file is either the old version or the new one, never half of each.

A run that finds nothing new leaves every file byte-for-byte identical.

### Writing them: the store

The store (`@money/shared/node`) is the only code that touches the files. It writes one account and source at a time, and it is built so that a stored record is never lost.

- **Order.** Which files change, and in what order, is decided by a pure function before anything is written. A file that loses records is first written as the union of its old and new records, and only then as its final text, once the files that gain them are on disk. Files that are no longer needed are removed last. After any prefix of those steps every stored id is still in at least one file.
- **Nothing is deleted through the store.** It refuses any write after which a stored record would be gone, including an empty set over an account that has records.
- **Validate first.** The account key, the source, every file name and every file's text are checked before the disk is touched. Reading checks the account and the source as well, and a name in the archive that is not an account, a source or a year file is an error.

Limits, stated plainly:

- The guarantee covers a process crash. For power loss it relies on the filesystem keeping directory operations in order, because the directory is not flushed.
- After a crash a record can sit in two year files. Reading reports it and stops. Repair is manual until the sync adds a recovery path.
- The store assumes one writer per account and source, which the layout already gives it.

## Records

```json
{
  "account": "bnka-current",
  "source": "api",
  "id": "20261006-12345678",
  "date": "2026-10-06",
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
| `date`       | The booking date, `YYYY-MM-DD`. Decides the year file and the order. See below.         |
| `first_seen` | When this record was first written, in UTC. A real time of day is required.             |
| `revisions`  | Earlier versions of `raw`, oldest first. Each is `{ "replaced_at": "...", "raw": {} }`. |
| `raw`        | The transaction exactly as received.                                                    |

`account` and `source` repeat what the path already says. They are kept so a record still explains itself when it is copied out of its file.

`date` is the one interpreted value stored in a record. It has to be: a record must be filed under a year when it is written, and a file must be checkable against its own name without knowing anything about `raw`. It is read from `raw` by whoever writes the record, and it follows the current `raw`: if a bank revises a booking date, `date` changes with it, and the record moves to another year file if need be.

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
- **Known but different:** move the stored `raw` into `revisions` with the current time, and store the new `raw` and its `date`.
- **The same identity twice in one batch:** stored once if the two are identical, an error if they differ.
- **The same identity twice in what is already stored:** an error. Merging stops rather than drop one.

`merge` returns the full, sorted set of records, the identities it added, the identities it revised and a count of those unchanged. It never reports on what a batch lacks: noticing that a stored record is missing from a fetch needs the fetch window, which belongs to the sync ([sync.md](sync.md)). A stored record absent from a fetch is kept either way.

## Reading: the normalised view

Readers never interpret `raw` directly. One pure function turns a record into a **normalised transaction**, and everything in the dashboard, tagging rules included, works on that.

| Field                  | Type            | Notes                                                       |
| ---------------------- | --------------- | ----------------------------------------------------------- |
| `account`              | string          | The account key.                                            |
| `source`, `id`         | string          | Together with `account`, the identity.                      |
| `date`                 | `YYYY-MM-DD`    | The record's `date`.                                        |
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

- **API records** are normalised by code: the sign comes from `credit_debit_indicator`, and the counterparty is the creditor of a debit or the debtor of a credit. The amount and the instructed amount carry no sign of their own, and a value date, when present, must be a real date. An instructed amount with a currency that cannot be read is an error.
- **Both sources:** a currency and an original currency must be exactly three capital letters, since the number of decimals depends on it. `original_amount` takes the sign of `amount`. Anything that cannot be read is an error that names the record, never a guess. Description cells are looked up defensively: a column that is absent gives nothing.
- **Import records** are normalised by their import format (below). Fixing a mistake in a format changes the view at once and rewrites nothing. The exception is the format's `date` column, which is read once, at import, to set the record's `date`.

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
