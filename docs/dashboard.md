# Dashboard

A small web app over the archive: tables and charts, with filtering, sorting and grouping, and rule-based categories. Phase 2; nothing here is built yet.

It is two workspaces: `api`, the server, and `app`, the interface that runs in the browser. Both use `shared` for the normalised view and for categorising, so the server and the browser can never disagree about a category.

## Boundaries

- **It never writes bank data.** The archive is mounted read-only, so this is enforced by the mount and not by the code.
- **It never talks to a bank.** It has no bank credentials and no session.
- **It owns exactly one piece of state: the rules.** They live in a directory of their own, `RULES_DIR`, which is the only place this app can write.
- **It reads the normalised view only**, never `raw`. See [archive-format.md](archive-format.md).

## Categories

Every transaction has exactly one category, so the totals per category add up to the whole. The category is not stored anywhere. It is computed from the rules, every time.

```text
category = first rule, in order, whose conditions all match
           otherwise "uncategorised"
```

- **Rules are an ordered list**, and the order is the user's to set. The first match wins. A specific rule placed above a general one is how exceptions are made.
- **Uncategorised is a first-class category**, shown prominently. It is the to-do list for writing rules.
- **Nothing is built in.** A transfer between two of the user's own accounts is not special to this app. It is a rule like any other: "counterparty account is one of these, category `transfer`". The app has no idea which accounts are whose.
- **Every assignment can be explained.** Next to a transaction's category, the dashboard shows the rule that gave it.

### A rule

```json
{
  "id": "r-0042",
  "name": "Groceries",
  "category": "groceries",
  "match": {
    "accounts": ["bnka-joint"],
    "direction": "out",
    "counterparty_name": "albert heijn|jumbo|lidl",
    "amount_max": 30000
  }
}
```

All conditions in `match` must hold. An empty `match` matches everything, which makes a useful last rule.

| Condition               | Matches when                                               |
| ----------------------- | ---------------------------------------------------------- |
| `accounts`              | the account key is in the list                             |
| `direction`             | `"in"` or `"out"`, by the sign of the amount               |
| `counterparty_name`     | the regular expression matches, ignoring case              |
| `counterparty_accounts` | the counterparty account is in the list, exactly           |
| `description`           | the regular expression matches, ignoring case              |
| `amount_min`            | the absolute amount is at least this, in the smallest unit |
| `amount_max`            | the absolute amount is at most this                        |
| `date_from`, `date_to`  | the booking date is in the range, inclusive                |
| `transactions`          | the identity is in the list                                |

`transactions` is what makes bulk tagging by hand work without a second mechanism: selecting rows in a table and giving them a category creates one rule that lists them.

### Storing rules

- One file, `RULES_DIR/rules.json`: the ordered list and a version number.
- Written to a temporary file and renamed, like the archive.
- A save names the version it was based on. If someone else saved in between, it is refused and nothing is lost. Two people editing at once is the normal case here, not an edge case.
- A rule with an invalid regular expression is refused on save.
- The file is backed up with the archive. See [infra.md](infra.md).

Rules hold names of people and employers. They are private data and never belong in this repository.

### Computing categories

Categorising is a pure function of the rules and the normalised view. The server keeps the result in memory and recomputes it when either input changes:

- at start;
- when a year file has changed, checked cheaply by modification time;
- when rules are saved.

So a rule change takes effect on save, and the nightly sync needs no hook into the dashboard. Nothing is cached on disk. At the size this archive can reach, the whole computation takes about as long as a page load. If that stops being true, a cache is added then.

Before saving, the editor previews the change: how many transactions move, and from which category to which. With ordered rules, the effect of moving one is otherwise hard to predict.

## Views

- A transaction table with filter, sort and group by account, category, counterparty, month and year.
- Totals and charts over time, per category and per account.
- The rules editor, with reordering and the preview.

## Interface: `app`

- **Runs in the browser, and may use libraries**: for tables, charts and the editor. Which ones is decided in this slice's spec. The list stays short; see [architecture.md](architecture.md).
- **Bundled at build time into static files**, which `api` serves. This is the only part of the project with a build step.
- **Confined by the Content Security Policy** that `api` sends: scripts, styles and requests from and to its own origin only, with no inline script.
- **Categorising can run here too**, because `shared` does. That is what lets the rules editor preview a change without saving it.

Still undecided, and settled in the slice's spec: whether filtering and grouping run in the browser over the whole normalised view, or on the server per request.

## Server: `api`

- **Node.js, no build step, no runtime dependencies**, like the sync. It is a handful of routes over `node:http`: log in and out, read the normalised view, read and save rules, and serve `app`'s files.
- **Login:** one account per person, from configuration: a name and a password hash, checked with `node:crypto`. There is no sign-up and no password reset.
- **Sessions** are signed cookies, keyed by a secret from the environment, so they survive the restarts that deploys cause.
- **Login attempts are rate-limited.**
- **Requests that change rules are protected against cross-site request forgery.**
- **Content headers** are set here, because they track what the pages do. The Content Security Policy is what makes browser libraries acceptable, so loosening it is a design change, not a fix.
- **Logs** never contain amounts, account numbers, names or descriptions, here as everywhere.
- It serves a health endpoint and a version endpoint returning the built commit.

## Development

Run it against the synthetic archive in `fixtures/`, with rules in `tmp/`. Real data is never needed and never available.
