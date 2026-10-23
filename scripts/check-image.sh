#!/usr/bin/env bash
# Checks a built image the way the host will use it, by running it.
#
#   scripts/check-image.sh <image>
#
# Everything it gives the image is made up here and thrown away: a key generated for the
# run, a configuration of invented banks, and an export of one invented row.
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: scripts/check-image.sh <image>" >&2
    exit 2
fi
IMAGE=$1

# Under the checkout and not the system's temporary directory, which Docker on a Mac
# cannot mount. Found from this script's own path, so it works from any directory.
# Ignored by git, and removed on exit.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "$ROOT/.image-check.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

fail() {
    echo "FAIL: $1" >&2
    exit 1
}
ok() { echo "ok   $1"; }
# Never pulls, so a mistyped name fails instead of running a stranger's image, and has no
# network, which shows that what it runs needs none.
run() { docker run --rm --pull=never --network none "$@"; }

# 1. With no command, the usage line, and a failure: a job that typed it wrong must alert.
if out=$(run "$IMAGE" money 2>&1); then fail "money with no command exited 0"; fi
grep -q '^usage: auth <bank>' <<<"$out" || fail "money with no command did not print the usage line"
ok "money with no command prints the usage line and fails"

# 2. Without configuration, every command refuses to start, and says what is missing.
if out=$(run "$IMAGE" money status 2>&1); then fail "money status without configuration exited 0"; fi
grep -qx 'CONFIG_PATH is not set' <<<"$out" || fail "money status did not name the missing CONFIG_PATH"
ok "money status without configuration names what is missing"

# 3. The image runs as uid 1000, the one uid the host's owner-only mounts can be read by,
#    and the directories volumes are mounted over belong to that user.
uid=$(run "$IMAGE" id -u) || fail "the image's uid could not be read"
[ "$uid" = 1000 ] || fail "the image runs as uid $uid, not 1000"
ok "the image runs as uid 1000"
run "$IMAGE" sh -c '
    for dir in /data /state; do
        [ "$(stat -c %U "$dir")" = "$(id -un)" ] && [ -w "$dir" ] || exit 1
    done' || fail "/data and /state are not owned and writable by the image's user"
ok "/data and /state are owned and writable by the image's user"

# 4. The application directory holds the source and the workspace links, and nothing else.
listing=$(run "$IMAGE" sh -c 'ls -A /app | tr "\n" " "; echo; ls -A /app/node_modules | tr "\n" " "') \
    || fail "/app could not be listed"
[ "$(sed -n 1p <<<"$listing")" = "node_modules package-lock.json package.json shared sync " ] \
    || fail "/app holds more or less than the source: $(sed -n 1p <<<"$listing")"
[ "$(sed -n 2p <<<"$listing")" = ".package-lock.json @money " ] \
    || fail "node_modules holds more than the workspace links: $(sed -n 2p <<<"$listing")"
ok "/app holds the source and the workspace links only"

# 5. No test, test helper, fixture, environment file or nested node_modules reached the
#    image. Only /app/node_modules is pruned, and step 4 checks it.
found=$(run "$IMAGE" find /app -path /app/node_modules -prune -o \
    \( -name '*.test.ts' -o -name testing -o -name fixtures -o -name docs -o -name tmp \
    -o -name node_modules -o -name '.env*' \) -print) \
    || fail "the image could not be searched for what it must not hold"
[ -z "$found" ] || fail "the image holds what it must not: $found"
ok "no tests, fixtures, docs, environment files or nested node_modules"

# 6. An import check, through the configuration and the store: the one run that crosses
#    every workspace inside the image. The mounted directory is readable by any user,
#    because the image does not run as the user that created it.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORK/key.pem" 2>/dev/null
mkdir "$WORK/import"
cat >"$WORK/import/config.json" <<'JSON'
{
  "banks": { "bnka": { "aspsp": { "name": "Example Bank", "country": "NL" } } },
  "accounts": { "bnka-current": { "bank": "bnka", "iban": "NL00BNKA0000000001" } },
  "imports": {
    "example-export": {
      "delimiter": ";",
      "encoding": "utf-8",
      "account": { "column": "Account" },
      "id": { "column": "Sequence" },
      "date": { "column": "Booked", "format": "YYYY-MM-DD" },
      "amount": { "column": "Amount", "decimal": "," },
      "currency": { "column": "Currency" }
    }
  }
}
JSON
printf 'Account;Sequence;Booked;Amount;Currency\r\nNL00BNKA0000000001;1;2025-01-02;-12,34;EUR\r\n' \
    >"$WORK/import/export.csv"
chmod 755 "$WORK/import"
chmod 644 "$WORK/import/config.json" "$WORK/import/export.csv"
out=$(run \
    -e EB_APP_ID=00000000-0000-4000-8000-00000000aaaa \
    -e "EB_PRIVATE_KEY=$(base64 <"$WORK/key.pem" | tr -d '\n')" \
    -e EB_REDIRECT_URL=https://localhost/auth-callback \
    -e CONFIG_PATH=/import/config.json \
    -v "$WORK/import:/import:ro" \
    "$IMAGE" money import example-export /import/export.csv 2>&1) \
    || fail "an import check failed: $out"
grep -qx 'import-checked format=example-export accounts=1 rows=1 written=no' <<<"$out" \
    || fail "an import check did not print its summary: $out"
ok "an import check reads a mounted file and prints its summary"

echo "image checked"
