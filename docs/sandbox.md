# Running against the sandbox

How to run `auth`, `sync` and `status` against Enable Banking's sandbox from a developer's machine. The sandbox holds test accounts with invented transactions; nothing here touches a real account. Production is set up on the host and is described in [infra.md](infra.md).

Everything this needs that is secret or local is gitignored: `.env.sandbox` and `tmp/`. Never commit either, and never paste the private key or a response from the bank anywhere.

## 1. Register a sandbox application

1. Create an account at [enablebanking.com](https://enablebanking.com) and open the Control Panel.
2. Register a new application, in the **sandbox** environment. A sandbox application is usable at once; only a production application needs activating.
3. Give it the redirect address `https://localhost/auth-callback`, exactly. Nothing has to listen there: after approving, the browser fails to load the page, and the address in its address bar is what `auth` asks for.
4. Let the Control Panel generate the key pair. The browser downloads the private key as a `.pem` file, once. Keep it under `tmp/`, or outside the repository.
5. Note the application id, a UUID. The downloaded key file is usually named after it.

## 2. Write `.env.sandbox`

```sh
cp .env.example .env.sandbox
```

Fill in two values and leave the rest as they are:

- `EB_APP_ID`: the application id.
- `EB_PRIVATE_KEY`: the `.pem` file, base64-encoded onto one line:

  ```sh
  base64 < tmp/sandbox/private.pem | tr -d '\n'
  ```

`EB_REDIRECT_URL` must equal the address registered in step 1, character for character.

The paths in the file (`CONFIG_PATH`, `DATA_DIR`, `STATE_DIR`) are relative, so they are read from the directory the command is run in. Run the commands from the root of the checkout.

## 3. Create the directories

```sh
mkdir -p tmp/sandbox/data tmp/sandbox/state
```

The commands never create them: a missing directory is an error, never an empty archive.

## 4. Write the configuration file

A bank is configured by the exact name and country Enable Banking lists it under. Do not type the name from memory or from the Control Panel. Ask for the list:

```sh
node --env-file=.env.sandbox sync/src/cli.ts banks NL
```

The country is two capital letters. The command needs a configuration file that loads, so for this first run write `tmp/sandbox/config.json` as `{ "banks": {}, "accounts": {}, "imports": {} }`.

It prints one name per line, in quotes. Pick a sandbox bank and copy its line, quotes included, into the file, under a made-up key:

```json
{
  "banks": {
    "sbxa": { "aspsp": { "name": "<the line, as printed>", "country": "NL" } }
  },
  "accounts": {
    "sbxa-one": { "bank": "sbxa", "iban": "<a test account's IBAN>" }
  },
  "imports": {}
}
```

- **The bank key** (`sbxa`) is yours to choose, from `[a-z0-9-]`. It is what you pass to `auth`.
- **The account's IBAN** is that of a test account of the sandbox bank. The bank's sandbox documentation gives its test users and their accounts, and the bank's approval page shows the accounts while you approve. `auth` stores nothing if a configured account is not in the consent, so a wrong IBAN costs one more run and nothing else.
- **If the IBAN is published nowhere**, configure any IBAN and run `auth sbxa --show-ibans`. It fails, since the account is not in the consent, but first prints the IBANs the consent does hold. Copy one into the file and run `auth sbxa` again, without the option.
- One account is enough. A second one shows that accounts are kept apart.

[sync.md](sync.md) describes every field of the file.

## 5. Authorise

```sh
node --env-file=.env.sandbox sync/src/cli.ts auth sbxa
```

1. The command prints the PSU headers the bank lists as required, then an address. Open the address in a browser.
2. Log in as one of the sandbox bank's test users and approve access to the configured accounts.
3. The browser is sent to `https://localhost/auth-callback?code=...` and shows an error page. That is expected. Copy the whole address from the address bar and paste it at the prompt.
4. The command stores the consent and fetches each account at once. It prints one `merged` line per account and exits 0.

## 6. Sync, and check

```sh
node --env-file=.env.sandbox sync/src/cli.ts sync
node --env-file=.env.sandbox sync/src/cli.ts status
```

A second `sync` straight after the first should add and revise nothing, and leave every year file byte for byte the same.

## 7. Import a made-up file

The import needs no bank, only a format and a file. Both are made up here: **a real export file is never brought into this directory**, and neither are its column names. Real formats are written on the host.

Add a format to `tmp/sandbox/config.json`, under `imports`. The example in [archive-format.md](archive-format.md) will do, under a key such as `sbxa-export`.

Write a small file by hand under `tmp/`, with the format's header on the first line and one row per line. Every value is invented, except the account cell, which must hold the IBAN of an account in the configuration file:

```text
Account;Sequence;Booked;Value date;Amount;Currency;Counterparty;Counterparty account;Text 1;Text 2;Text 3;Type;Original amount;Original currency
<the configured IBAN>;1;2025-01-02;2025-01-02;-12,34;EUR;"Example Shop; Utrecht";;Line one;;;card;;
<the configured IBAN>;2;2024-12-31;2024-12-31;+5,00;EUR;;;"Said ""so""";;;transfer;;
```

Check it, read the summary, and only then write:

```sh
node --env-file=.env.sandbox sync/src/cli.ts import sbxa-export tmp/made-up.csv
node --env-file=.env.sandbox sync/src/cli.ts import sbxa-export tmp/made-up.csv --write
```

The check prints one line per account, with `new=2`, and says nothing was written. The write prints the same and one `import-written` line. Running the write again prints `new=0` and `unchanged=2`, and leaves every year file as it was.

A refused file is named by row number and by the format's field, never by its contents. [sync.md](sync.md) lists what is refused.

## When it fails

Every command exits 1 with one message. The ones a first run meets:

- **`no account is fetched through the API: none is open and has an iban`**, from `status` or `sync`: the configuration's `accounts` is empty, or every account in it has only an `import_id` or is `closed`. Give each account the API should fetch its `iban`.
- **`Enable Banking lists no bank under the configured name and country`**: the request worked, so the application id and the key are right. The name or the country in the configuration file differs from the list. Run `banks <country>` and copy the name again.
- **`Enable Banking lists no bank for the country XX`**: the country code is wrong, or the application is shown no bank there.
- **`Enable Banking answered 401`** or **`403`**: the application id and the key do not belong together, the key was not encoded whole, or the application is not usable yet.
- **`Enable Banking answered 400`** or **`422`**, with a code in capitals, on `auth`: the code says what was refused. One about the redirect means `EB_REDIRECT_URL` differs from the address registered for the application.
- **`<account>: the consent does not cover it`**: the account's IBAN is not one of the accounts approved at the bank. Nothing was stored; correct the IBAN, or approve that account, and run `auth` again. The line after it counts the accounts the consent holds and how many carry an IBAN. None held: no account was approved at the bank. Some held, none with an IBAN: the bank names its accounts another way, and the code must be taught it. Otherwise the configured IBAN is not one of them.
- **A message about a variable or a directory**, before any request: `.env.sandbox` or `tmp/sandbox/` is not as steps 2 and 3 describe. The message names the variable.

A message never repeats a value from the configuration file or from a response. If a response is refused as having an unexpected shape, the fix is in the code: describe the shape of the response with every value replaced, and never paste the response itself.

## Worktrees

`.env.sandbox` and `tmp/` are gitignored, so they exist only where they were created, and nothing reads them from another checkout: the paths in `.env.sandbox` are relative to where the command runs.

Keep the set in the main checkout. `.worktreeinclude` lists `.env.sandbox` and `tmp/sandbox/`, so a worktree that Claude Code creates starts with a copy of both: the settings, the configuration file, the stored consent and the sandbox archive as they were at that moment.

It is a copy, in one direction. What a worktree's runs fetch or store stays in the worktree and goes when the worktree is removed. A consent renewed in one checkout is not renewed in the other, so run `auth` in the main checkout.
