# Hosting

How this runs in production, seen from this repo. The commands and the image exist ([sync.md](sync.md)); the hosting is declared in the infra repo.

Production is a single Docker host that is provisioned and deployed from a separate, private infra repo. That repo owns everything about the host: the compose files, the TLS front door, the cron schedule, secrets, backups and alerting. This repo owns the images and the behaviour inside them.

**The arrow points one way.** Infra knows about this app; this app knows nothing about infra. No compose file, reverse-proxy config, hostname, network name, volume name or host path belongs in this repo, and that includes this document. Whenever a concrete value is needed, it lives in infra's declaration for this app.

## Overview

```text
Bank(s)
   |
   v
Enable Banking
   |
   v
+----------------+      host cron (nightly)
| sync container | <--- runs `sync`
+----------------+
   |         ^
   |         +--------> state volume
   v
data volume ----------> nightly archive
   |                         |
   | read-only               v
   v                    offsite storage
+----------------+
| web container  | <--> app data volume
+----------------+           |
   ^                         v
   |                    nightly archive,
   |                    offsite storage
front door
   ^
   | HTTPS
   |
browser
```

Two phases:

1. **Sync and backup.** One container that writes the archive into its data directory, triggered nightly, with the data backed up offsite.
2. **The app.** A second container serving a web app over the same files, with data of its own: a session secret, and later the category rules.

What the parts do is in [architecture.md](architecture.md). This document covers only how they are hosted.

## What this repo provides

The host accepts any app that meets a short contract. For this repo that means:

- **A public image on GHCR**, built by CI on every push to the main branch and tagged `:latest` and `:<commit-sha>`, by the `publish` job, once every other job has passed. The package is public: the first push left an image that pulls without a login, so it needed no step by hand. The host polls for a new `:latest` and restarts the container within about a minute. Two CI jobs concern the image. The `image` job builds it and runs `scripts/check-image.sh` over it on every push and pull request, so a Dockerfile that no longer builds is found on the branch. The `publish` job runs on `main` only, builds the image again, checks it again and pushes it with the workflow's own token. It builds again because the job that runs a branch's Dockerfile must never hold a token that can write packages, and `publish` is the only job that does. `publish` runs one at a time, and pushes `:<commit-sha>` always but `:latest` only when `main` still points at its commit, which it asks the remote just before: a concurrency group serialises runs without ordering them, so an older commit's publish can finish last. No checkout in any job keeps the workflow's token (`persist-credentials: false`).
- **Configuration from environment variables and one file.** The variables are the names in `.env.example`; production values come from infra's encrypted vault. The file lists banks, accounts, import formats and the app's people ([sync.md](sync.md)); infra holds the real one in its vault, renders it into a directory of its own on the host, and mounts that directory read-only into both containers. The directory and not the file, because the host replaces the file by renaming a new one over it, which a mount of the file alone would never see. Every command reads the file when it starts, so a changed configuration counts from the next run, with no restart. The server checks it on every request and reads it again when it has changed ([app.md](app.md)). The Enable Banking private key is one of the variables, `EB_PRIVATE_KEY`, base64-encoded. There is no key file.
- **Safe to restart without warning.** A deploy can land mid-sync. The data directory and the state directory are both written atomically (temporary file, then rename), and state only after the data it describes. Every page a bank returned is on disk before the next is asked for, and the next run merges it ([sync.md](sync.md)). A run that dies leaves its lock in the state directory; the next run sees that its process is gone and takes the lock over.
- **No data or secrets in the image.** The repository holds neither, so there is nothing real to leak. A `.dockerignore` still refuses everything and admits only the source of `shared`, `sync` and `server`, `package.json`, `package-lock.json` and `bin/money`, leaving test files, `testing/` folders and any nested `node_modules` out too. So `fixtures/`, `tmp/` and any `.env` file never reach the build, and a production container can never serve synthetic data by mistake.
- **For the web container only:** a documented port, a health endpoint, and a version endpoint that returns the built commit SHA so CI can tell when a deploy has landed. The sync container has no such signal. Its first nightly run on a new image is the evidence.

One image serves both containers; they differ in command, mounts and environment.

The image is built in one stage today, and in two once the client exists. Today it is the official Node 24 image, pinned by digest, with the source of `shared`, `sync` and `server` copied in from the repository and `npm ci --omit=dev --ignore-scripts` run over it. That creates `node_modules/@money/`, the links Node resolves the workspaces by, and nothing else: nothing on the server has a third-party dependency ([architecture.md](architecture.md)), and `scripts/check-image.sh` fails if anything else appears there. When `client` exists, a first stage installs the development tools and bundles it, and the image takes the bundled files from that stage and nothing else.

What the image gives the host:

- **The command `money`**, on the path. `money auth bnka` is `auth bnka`; the image's own paths need not be remembered. `money serve`, `money hash-password` and `money rotate-session-secret` go to the server, and every other command to the sync.
- **`/data` and `/state`**, owned by the image's user (`node`). The image does not set `DATA_DIR` or `STATE_DIR`: `money` sets them to `/data` and `/state` for the sync's commands, when they are unset. The server's commands get neither, so the web container holds no `STATE_DIR` for the server's tripwire to refuse ([app.md](app.md)). Infra runs every sync command through `money`, so the sync container sees what it always did. The web container sets `DATA_DIR` itself. A volume mounted over either directory takes its ownership. `CONFIG_PATH` is not set: where the file is mounted is the host's choice.
- **`/app-data`**, owned by the image's user with mode `0700`, and `APP_DATA_DIR` set to it. A volume mounted over it takes that ownership.
- **`/app/client`**, empty until the client is built, and `CLIENT_DIR` set to it.
- **`PORT=8080`**, declared with `EXPOSE`. The documented port of the contract above.
- **`REVISION`**, set from the build argument the revision label is set from, so `/version` and the label always agree.
- **One user, uid 1000.** The host's mounts of the configuration and of import files are readable by their owner only, and the host gives them to uid 1000, so an image whose user had another uid could read neither. `scripts/check-image.sh` fails on any other uid.
- **A container that idles.** The default command is `sleep infinity` and the stop signal `SIGKILL`: nothing in the container answers a signal, and a run that is killed is safe, so a deploy does not wait for one. The web container is started with `money serve` instead, which is infra's declaration. The server holds nothing a kill can lose, and every write is a temporary file and a rename, so it stops by `SIGKILL` too.
- **Its commit**, as the label `org.opencontainers.image.revision`.

## Phase 1: the sync container

### How it runs

The container stays up and idle. Once a night the host's cron runs `sync` inside it.

The schedule lives on the host rather than in the container for two reasons:

- **Alerting comes for free.** Every scheduled job on the host runs through a wrapper that reports start, exit code and the tail of the output to an external monitoring service. A non-zero exit alerts, and so does a job that stops running at all. An in-container cron would have to rebuild that, and would need the monitoring credentials to do it.
- **It is the host's trigger, not the app's.** The app defines what `sync` does. When it runs is a deployment decision.

The container stays up, instead of being started per run, so that the host's image updater keeps it current and there is always something to run `auth` and `status` in.

Consequences for the code:

- **Exit codes are the alerting interface.** Nobody reads logs on the host. A problem that needs a human must exit non-zero; a warning with exit 0 reaches no one. `sync` exits 1 when a bank or an account failed, or when a stored record went missing from a fetch that should hold it. `status` exits 1 when a consent is absent, expired or close to its end. Both exit 1 when the configuration gives them no account to fetch, so a configuration that reaches nothing cannot pass night after night.
- **Job output leaves the host.** The last 10 KB of output goes to the monitoring service on every run. The rule that logs hold counts, dates and keys only is what keeps bank data from leaking through that path. An error the code did not expect prints its class and code and nothing else.
- **One run per night.** Banks allow four unattended fetches a day, so a manual re-run after a failure is fine, but a retry loop is not. Missed nights catch up on their own, because the fetch window is anchored on the last successful sync.
- **The sync runs before the backup**, so each night's archive contains that night's transactions.
- **A consent near its end alerts through `status`.** A second daily job runs `status`, which exits non-zero inside the warning window, so the alert arrives without changing what `sync`'s exit code means.

And for how the commands are run:

- **Every command that writes runs in the same process-id namespace.** `auth` and `sync` exclude each other with a lock in the state directory that names a process id ([sync.md](sync.md)). That works between commands run inside the one running container, as described above. It does not work between containers: two commands that are each process 1 in a container of their own, over the same state volume, do not exclude each other. So `auth` and `sync` are never run at once from separate containers.
- **A lock can outlive its container.** A deploy that lands mid-run kills the run and leaves its lock. The next run takes it over when the process it names is gone, or has the run's own id. If another process in the new container happens to have that id, the run refuses and says which file to remove.
- **The state volume is on a filesystem with hard links.** The lock is created by linking.
- **`auth` needs a terminal.** If its input ends before the redirected URL is pasted, it fails.

### Storage

Production data lives in three Docker volumes on the host, and nowhere in this repository. All are created by hand before the first deploy and declared as pre-existing, so a missing volume is a hard error rather than a silently empty archive.

| Volume   | Holds                                                    | Sync container | Web container | Backed up |
| -------- | -------------------------------------------------------- | -------------- | ------------- | --------- |
| data     | The archive: `<account>/<source>/<year>.json`            | read-write     | read-only     | yes       |
| state    | Sessions, consent expiry, last successful sync           | read-write     | not mounted   | no        |
| app data | What the app writes: the session secret, later the rules | not mounted    | read-write    | yes       |

What losing each one costs:

- **data:** whatever the banks no longer serve is gone for good. Unattended access can reach back as little as 90 days, and a bank's one-time deep history may not be fetchable twice. This is what the backup exists for.
- **state:** nothing permanent. Run `auth` again for each bank; every account is then fetched as far back as the bank gives, and merged into the existing data.
- **app data:** the session secret is gone, so the server refuses to start until `money rotate-session-secret` is run, and everyone logs in again. Once rules exist, every category disappears from the app until they are restored or rewritten. No bank data is affected.

How the app finds them:

- **The app only knows directories and one file.** `DATA_DIR`, `STATE_DIR` and `APP_DATA_DIR` name the directories, `CONFIG_PATH` the configuration file. The code reads and writes nothing outside them. In development they point into `tmp/` and `fixtures/`.
- **The commands never create `DATA_DIR`, `STATE_DIR` or `APP_DATA_DIR`.** They refuse to start when one they need is not an existing directory, so a missing mount is an error on every run. The server also refuses an `APP_DATA_DIR` it cannot write. `auth` and `sync` also refuse a `DATA_DIR` they cannot write, before asking a bank for anything.
- **Infra decides what is behind them.** Its compose file mounts each volume at a path inside the container and sets the variable to that path. Volume names and mount modes live there, not here.
- **Access is enforced by the mounts, not by the code.** The web container cannot write to the archive even if it has a bug, and it cannot see a bank session at all. The sync container cannot touch what the app writes.
- **The image runs as a non-root user**, and creates the directories owned by that user. A new volume takes its ownership from the directory it is first mounted over, so each container can write without any setup on the host. Both containers use the same image and therefore the same user, so the web container can read what the sync wrote.

### Consent renewal

`auth <bank>` is interactive and runs at most every 180 days per bank. The user runs it by hand inside the running container, over SSH, and pastes the redirected URL back as usual. That includes the very first authorisation: there is no local production setup to do it from. The exact command is documented in the infra repo, because it names the host.

`auth` also fetches each new account's history before it returns, and that fetch may not be repeatable ([sync.md](sync.md)). The data volume and its backup must be in place before the first authorisation at any bank, and the volume must be writable by the container's user. What `auth` and `sync` check of that, before any request, is that they can write where a fetch writes first, the inbox under `DATA_DIR`; they do not prove the rest of the volume writable. `auth` also reads each account's archive and inbox before it sends the user to the bank.

**If the first `auth` at a bank does not fetch every account in full, run `auth` for that bank again, at once.** The session is kept and the command says which accounts are affected. Until it is run, the nightly `sync` fetches those accounts without the user present: it stores what the bank serves unattended, records no success, and exits 1 every night, saying to run `auth` ([sync.md](sync.md)). Recent transactions keep arriving meanwhile; only the older history waits for the user.

### Import

An export file reaches the container through a directory the host mounts read-only. The user copies the file into it, runs `money import <format> <file>` inside the container, reads the summary, runs the same command with `--write`, and deletes the file from the host. Nothing of the export is written inside the container, so there is nothing to clean up there. The exact commands name the host, and are documented in the infra repo.

## Backup

The data and app data volumes are backed up the same way as the host's other persistent state:

- **Nightly:** each volume is archived into a timestamped tarball, mounted read-only for the purpose, and copied over SSH to offsite storage. Local copies are kept for 30 days.
- **Weekly:** a restore check downloads the newest _offsite_ archive, the one a real recovery would use, and proves it is usable. It fails if the archive is missing, older than two days, corrupt, or does not hold up against the live data.
- Both jobs run through the same alerting wrapper as `sync`.

What makes the restore check cheap here is that the archive is append-only: nothing is ever deleted, so record counts only grow. The check can assert that the restore holds the same year files as live, that each parses as a JSON array, and that the restored record count is at least a fixed fraction of the live count. For the app data volume it asserts that `session-secret` is present, and, once rules exist, that the rules file is present and parses. A session secret in the backup adds nothing an attacker with the archive's backup lacks, and restoring an old one revives only sessions younger than seven days.

Each archive is a complete copy of every transaction, so it is as sensitive as the data itself: readable by its owner only, at every step.

Archives are not encrypted before they leave the host. The owner decided on 2026-10-14 that the access control at the offsite storage is enough.

State is not backed up. It is rebuildable, and it contains a live session ID.

Restoring is a manual operation documented in the infra repo: stop the containers, unpack an archive into its volume, start them again. Because merge never deletes and identity is the bank's own identifier, a `sync` after a restore fills in whatever the archive was missing, as far back as each bank still serves.

## Phase 2: the app

The web app described in [app.md](app.md). What matters for hosting:

- **Separate container, same image.** Its command is `money serve`. It mounts the data volume read-only, the configuration's directory read-only and the app data volume read-write, with `PORT` as the image sets it. It gets neither the state volume nor the Enable Banking credentials. The only container reachable from the internet is the one that cannot fetch from a bank or change bank data.
- **An environment of its own.** Not the app's shared environment file, which holds the Enable Banking key: the server refuses to start when any `EB_*` variable or `STATE_DIR` reaches it, and says which ([app.md](app.md)). It needs `CONFIG_PATH` and `DATA_DIR`; the image sets the rest.
- **No network shared with the sync container.** The sync container listens on nothing and its commands are run by the host, so there is not even a connection to refuse.
- **Hardened past a non-root user.** A read-only root filesystem with a small temporary directory in memory, every capability dropped, no new privileges, no Docker socket, and a memory limit. What is left is an escape from the container itself, which no declaration can rule out.
- **Behind the host's front door.** The front door terminates TLS, sets HSTS, passes the original `Host` through, and proxies to the container, which then publishes no port of its own. The server refuses every login whose `Origin` does not name the `Host` it receives, so a rewritten `Host` shows at the first login. Content headers are this app's job, because they track what its pages do.
- **Logins are configuration.** Each person's username and password hash are in the configuration file, in `people`, beside the accounts they own ([sync.md](sync.md)). They are not in the environment: they are structured, they belong beside the accounts they unlock, and the real file is already in infra's vault. Changing one is a new configuration, deployed as usual; the server sees it without a restart ([app.md](app.md)).
- **The session secret is a file in the app data volume,** made once by `money rotate-session-secret`, run inside the container, before the server's first start succeeds. Until then the server refuses to start, and says why. Running it again logs everyone out, without a restart.
- **It keeps everything else in memory.** It reads the year files, recomputes when a file or the rules change, and caches nothing on disk. The nightly sync needs no hook into it.

The logging rule is unchanged: the web app shows amounts and names to the logged-in person, and still never logs them.

**What remains, stated so it is not mistaken for solved.** The web container has to reach the front door, and the front door's network also has a route to the internet, so a compromised server can send out what it reads. Shutting that needs a network of its own between the front door and this container, which changes the front door, a live app. It is a later step, the owner's call.

### Deployment order

Infra changes stay additive: the live apps' rendered configuration stays byte-for-byte unchanged until the step that routes to this one.

1. **The image that holds the server reaches production first.** The sync container runs it, and nothing changes for the sync. The configuration's validator refuses unknown fields, so a file with `people` would stop every nightly command on an older image.
2. **Then the vault's configuration gains `people`, with usernames and hashes, and every account's `owners`.** The hashes come from `money hash-password`, run on the owner's own machine.
3. **A new volume for `APP_DATA_DIR`,** created by hand and declared as pre-existing, as the other two are, and added to the nightly backup and its restore check.
4. **The web container,** as above.
5. **`money rotate-session-secret`, once,** inside it, before its first start succeeds.
6. **Not reachable from outside** until the security reviews after the server and after the client have both passed. Until then the front door has no route to it, and its port is published on the host's loopback address only, so the owner can try it through an SSH tunnel. `/health` and `/version` can also be read from inside it.
7. **Exposed after the client's review.** The container joins the front door's network as the other apps do, the loopback port goes, and the front door gains a route. The route is the one change to a live app's configuration. The owner then logs in through it once, which proves the `Host` arrives intact.
8. **Later, the owner's call:** the network of its own described above.

## Data protection in production

- **Production only.** Real bank data exists on the host and in its offsite backups, and nowhere else. This repository and every developer machine hold synthetic data only (`fixtures/archive/`).
- **EU only.** The host and the offsite storage are both in the EU, and bank data goes nowhere else. The monitoring service and CI sit outside that boundary, which is why neither may ever receive it.
- **CI never sees bank data.** It builds and tests against synthetic fixtures and the sandbox only.
- **The rules in `CLAUDE.md` still apply.** Production runs are done by the user. AI tools do not read production data, logs that could contain it, or the vault.

## Open decisions

- **Offsite retention.** Local copies expire after 30 days; how long offsite copies are kept is not yet decided for any app.
