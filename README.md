# gitbroker

A tiny **native git push service** for sandboxed AI agents.

It lets an agent running inside a sandbox (e.g. Claude Cowork) run `git add` /
`commit` / `push` — and delete files — in your **real** working directories,
by calling a small HTTP API on the host instead of fighting the sandbox's
mounted filesystem. One broker can serve many projects, and **each project is
locked to its own secret**, so a given agent can only ever touch its own repo.

```
   ┌─────────────────────────┐         POST /publish              ┌────────────────────────┐
   │  Agent sandbox (repo A)  │  x-broker-secret: <sA>  ───────▶   │  gitbroker (native,    │
   │  reads <sA> from .env    │                                    │  on your Mac)          │
   └─────────────────────────┘                                    │                        │
   ┌─────────────────────────┐         POST /publish              │  registry: <sA>→/repoA │
   │  Agent sandbox (repo B)  │  x-broker-secret: <sB>  ───────▶   │            <sB>→/repoB │
   │  reads <sB> from .env    │                                    │  runs git natively,    │
   └─────────────────────────┘                                    │  pushes to origin      │
                                                                   └────────────────────────┘
```

---

## Why this exists

AI coding agents often run inside a sandbox that surfaces your project folder as
a **bindfs mount**. Two things go wrong when the agent tries to use git on that
mount:

1. **git is fragile on the mount.** It can hit sporadic `SIGBUS` when it mmaps
   pack files, and stale `index.lock` files can't always be cleared.
2. **Deletes are permission-gated.** Removing a file requires interactive
   approval, so an *unattended* run (a scheduled task) stalls or fails.

The common workarounds are worse than the disease:

- `git reset --hard origin/main` to force the mount back in sync — which
  **silently destroys any uncommitted local work**.
- Cloning to `/tmp`, committing there, and pushing from the clone — leaving the
  real working copy behind and out of date.
- Storing a **push token inside the sandbox** — a credential with a blast radius
  far larger than the one repo.

**gitbroker removes all of it.** Git runs *natively on the host*, where the
filesystem is healthy, deletes are unrestricted, and your normal git
credentials (ssh/keychain) already work. The agent just makes an HTTP call.

---

## A real deployment (and its implications)

This isn't hypothetical — one broker on a single Mac, under `launchd`, currently
serves two registered projects:

- **A website with unattended Cowork tasks** ([schvitz.co](https://www.schvitz.co)).
  A Claude Cowork agent runs scheduled tasks against it: a **daily** job that
  writes an AI-insights article, generates an image, and pushes
  `articles.json` + the image; a **weekly** cleanup that *deletes* orphaned
  images and trims the article list; and a Telegram bridge. These are precisely
  the workloads that break on a bindfs mount — **unattended pushes** and
  **unattended deletes** — and they're exactly what the broker makes reliable.
  The task just calls `POST /publish` (via a thin `broker-publish.mjs` wrapper)
  with that project's secret; Heroku auto-deploys from the resulting `main`.

- **gitbroker itself.** The broker is registered as one of its *own* projects,
  so a Cowork agent can edit the broker's source and docs (this README included)
  and push them **through the running broker** — the tool maintains its own repo
  using itself.

### Implications of self-hosting

- **The live process is insulated from its own pushes.** Publishing a new
  `broker.mjs` commits and pushes the file but does **not** reload the running
  service — the change only takes effect on the next
  `launchctl kickstart -k …`. So a self-edit can't crash the broker
  mid-publish, but you must restart to pick up real fixes, and a broken commit
  only surfaces on restart. Treat broker self-edits with care and keep a
  known-good commit to roll back to.
- **No new blast radius.** gitbroker's secret lives in gitbroker's own `.env`,
  distinct from every other project's. Registering the broker with itself adds
  **zero** cross-project exposure — the secret-as-capability model holds exactly
  as before.
- **Self-pushes are still divergence-safe.** A push to the broker's own repo
  goes through the same `merge --ff-only`, so an agent can't clobber hand-made
  local commits to the broker.
- **One broker, many repos, one mutex each.** Different projects publish
  concurrently; the per-repo mutex still serializes writes within each — so the
  broker editing itself can't collide with a separate task editing the website.

> The takeaway: once the broker is running, *anything an agent can reach it for*
> — including the broker's own maintenance — happens with the same native git,
> the same per-project isolation, and the same safety rails.

---

## Security model — the secret *is* the capability

gitbroker never accepts a path or a project name from the caller as the thing
that selects what to operate on. It accepts **only a secret**, and maps that
secret to exactly one directory via a registry it reads from disk:

```json
[
  { "name": "projectA", "path": "/Users/you/projectA", "secret": "<sA>" },
  { "name": "projectB", "path": "/Users/you/projectB", "secret": "<sB>" }
]
```

- A request carrying `<sA>` resolves to `projectA`'s folder **and nothing else**.
- An unknown secret is `401`.
- A caller **cannot name, path-traverse to, or guess** a directory whose secret
  it doesn't hold.
- Each project's secret lives in **that project's own gitignored `.env`**,
  readable only inside that project's sandbox — so secrets never cross projects.

This gives you per-project isolation from a *single* broker process: it's the
authorization equivalent of running a separate broker per repo, without N
processes to manage.

### What this does and does not protect

| Threat | Protected? |
| --- | --- |
| One project's agent pushing to another project's repo | ✅ Yes — it lacks the other secret |
| Caller asking the broker to operate on an arbitrary path | ✅ Yes — no path is ever accepted from the caller |
| Path traversal in `rm` / `pathspec` (`../../etc/...`) | ✅ Yes — resolved + rejected if it escapes the repo |
| Destroying local work on a diverged branch | ✅ Yes — uses `merge --ff-only`, which *refuses* rather than resets |
| Theft of one project's `.env` secret | ⚠️ Exposes **only that one project** |
| Compromise of the **registry file** or the broker process | ❌ Exposes **all** registered repos |

**The registry file is the crown jewel.** It holds every secret and every path.
Keep it **outside every repo**, `chmod 600`, never committed (gitbroker's
default location is `~/.config/gitbroker/registry.json`). For an *untrusted*
project, run it under its own separate broker instead of sharing this one.

### Other guards
- **Tiny surface.** Only `GET /health` and `POST /publish`. There is **no**
  arbitrary-git or run-command endpoint (that would be remote code-exec).
- **Per-repo mutex** serializes writes to the same repo (so e.g. two scheduled
  tasks for the same project can't collide on `index.lock`).
- **Constant-time** secret comparison.
- **1 MB** request-body cap.
- `/health` is unauthenticated but reveals only a liveness flag and a project
  *count* — never names, paths, or secrets.

> ⚠️ **Not an OS sandbox.** gitbroker confines itself to the registered
> directories in code, but it runs as your normal user. For kernel-enforced
> confinement, run it under `sandbox-exec` or a dedicated low-privilege user
> whose only filesystem access is the registered repos.

---

## Point an AI agent at this repo (which scenario?)

You don't have to wire a new project in by hand. Open that project in Cowork (or
any agent that can read a repo) and tell it, in one line:

> "Use gitbroker from https://github.com/paullewis-borman/gitbroker — read its
> `README.md` and `AGENTS.md`, work out whether the broker is already installed
> on this machine or this is a fresh install, and set this project up
> accordingly."

The agent self-detects one of two scenarios (`AGENTS.md` carries the detection
recipe):

- **Already installed on this Mac** — the common case once you've used the
  broker for one project. It already runs under `launchd` and serves other repos,
  so adding this one is tiny: generate a secret, add **one** registry line
  (host-side — see *Adding a project*), drop that secret in the new project's
  `.env`, and the agent copies in `broker-publish.mjs`. **No second broker, no
  re-clone, no restart.**
- **Fresh install** — first time on this machine. The agent walks you through
  *Install* below (clone, registry, launchd) once, then wires the project in.

The registry edit and any `launchctl` step run on the **host** — the agent's
sandbox can't reach `~/.config` or `launchd`, so it will hand you those exact
commands to run. (If the Mac is asleep the agent can't probe `/health`, so it
should *ask* which scenario you're in rather than assume a fresh install.)

## Install

Requires Node 18+. Clone anywhere on the host (it runs on the host, not in any
sandbox):

```bash
git clone https://github.com/paullewis-borman/gitbroker.git
cd gitbroker
```

### 1. Create the registry

```bash
mkdir -p ~/.config/gitbroker
cat > ~/.config/gitbroker/registry.json <<'JSON'
[
  { "name": "projectA", "path": "/Users/you/Documents/projectA", "secret": "PASTE_A_SECRET" }
]
JSON
chmod 600 ~/.config/gitbroker/registry.json
```

Generate a strong per-project secret with `openssl rand -hex 32`. Put the **same
value** in that project's own `.env` as `BROKER_SECRET` so its agent can read
it.

### 2a. Run it (foreground, for testing)

```bash
node broker.mjs
# gitbroker listening on http://0.0.0.0:4747
#   registry: ~/.config/gitbroker/registry.json  (projects: 1)
```

### 2b. Run it always (launchd)

Edit the two absolute paths in `com.gitbroker.broker.plist` to your clone
location, then:

```bash
cp com.gitbroker.broker.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gitbroker.broker.plist
launchctl print gui/$(id -u)/com.gitbroker.broker | head   # confirm it's up
tail -f ~/Library/Logs/gitbroker.log                        # watch logs
```

Manage it (modern `launchctl`; the old `load`/`start`/`stop` verbs are deprecated):

```bash
# restart in place (after editing broker.mjs or the registry):
launchctl kickstart -k gui/$(id -u)/com.gitbroker.broker
# stop + unload:
launchctl bootout gui/$(id -u)/com.gitbroker.broker
# start again after a bootout:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gitbroker.broker.plist
```

The broker has the **same liveness as the agent**: both only run when your Mac
is awake and you're logged in, so the broker is always available exactly when
an agent could call it.

---

## Reaching the broker from a sandbox

The broker must listen on an interface the sandbox can reach — **loopback won't
work**, because the sandbox reaches the host over a real network interface, not
`127.0.0.1`. The default `GITBROKER_HOST=0.0.0.0` covers this.

From inside the sandbox, find the host's address (often the VM's gateway, or a
sibling address on the same subnet) and probe `/health`:

```bash
# example: the host turned out to be 172.16.10.254 on one Cowork VM
curl -s http://172.16.10.254:4747/health
```

Keep the broker on a **host-only / private** network so it isn't exposed to your
LAN or the internet. The shared secret is the only auth.

---

## API

### `GET /health`
Unauthenticated liveness check.

```json
{ "ok": true, "service": "gitbroker", "registry": "/Users/you/.config/gitbroker/registry.json", "projects": 1, "time": "..." }
```

### `POST /publish`
Header: `x-broker-secret: <the project's secret>`
Body (JSON):

| field | type | default | meaning |
| --- | --- | --- | --- |
| `message` | string | *(required)* | commit message |
| `pathspec` | string[] | `["-A"]` | what to stage (`git add <pathspec>`) |
| `rm` | string[] | `[]` | files to remove (tracked → `git rm`; untracked → unlink), then staged |
| `allowEmpty` | bool | `false` | commit even with nothing staged |
| `project` | string | — | optional assertion: must equal the name the secret maps to |

**What it does, in order:** `fetch origin main` → `merge --ff-only origin/main`
(refuses on divergence) → process `rm` → `git add <pathspec>` → skip if nothing
staged → `commit` → `push origin main`.

**Success:**
```json
{ "ok": true, "project": "projectA", "committed": true, "sha": "a990b4e…", "steps": [ … ] }
```

**Nothing to commit:**
```json
{ "ok": true, "project": "projectA", "committed": false, "note": "nothing staged — nothing to commit", "steps": [ … ] }
```

**Diverged (nothing was changed or destroyed):** HTTP `409`
```json
{ "ok": false, "reason": "diverged-from-origin", "hint": "resolve by hand", "steps": [ … ] }
```

Every response includes a `steps[]` array with each git command and its exit
code / stdout / stderr for debugging.

### Example call

```bash
SECRET=$(grep '^BROKER_SECRET=' .env | cut -d= -f2-)
curl -s -X POST http://172.16.10.254:4747/publish \
  -H "x-broker-secret: $SECRET" \
  -H "content-type: application/json" \
  -d '{"message":"chore: publish article","pathspec":["data/articles.json","public/images"]}'
```

---

## Client helper — `broker-publish.mjs`

You don't have to hand-write the `/publish` call in every project. This repo
ships **`broker-publish.mjs`**, a small zero-dependency Node wrapper (Node 18+,
uses global `fetch`/`http`) that a project's agent calls to publish itself. It's
the reference client — the [schvitz.co](https://www.schvitz.co) scheduled tasks
use a copy of it.

What it does: reads `BROKER_SECRET` from the project's gitignored `.env`, finds
the broker (probing the host and **caching the working URL in `.broker-host`**
so later runs are instant), POSTs `/publish`, and exits with a meaningful code.
The secret is never printed.

```bash
node broker-publish.mjs \
  --message "AI Insights: <title>" \
  --add data/articles.json \
  --add public/images/foo.webp \
  --rm  public/images/old.webp        # repeat --rm per file; omit if none
# also: --allow-empty   --url http://host:port (override the cached/probed URL)
```

| exit | meaning |
| --- | --- |
| `0` | published **or** nothing to commit |
| `1` | broker reported a failure (e.g. diverged) — caller should stop |
| `2` | could not reach the broker (host asleep/offline) |
| `3` | bad usage or no `BROKER_SECRET` in `.env` |

**To wire it into a new project:** copy `broker-publish.mjs` into the project,
register the project in the broker registry, and put that project's
`BROKER_SECRET` in its `.env` (see *Adding a project* below). By convention the
helper resolves the repo root two levels up from its own location
(`<repo>/backend/scripts/broker-publish.mjs`); adjust that path constant if you
place it elsewhere.

> **Note on `AGENTS.md`.** This repo also ships an **`AGENTS.md`** — a short,
> imperative publish contract written for an *AI agent* (how to call the helper,
> what the exit codes mean, and the hard rules: never run native git on the
> mount, stop on any non-zero exit, never expose the secret). The README you're
> reading is for *humans*; `AGENTS.md` is for the agent. **What to do with it:**
> when you copy `broker-publish.mjs` into a new project, copy `AGENTS.md`
> alongside it (or fold its rules into that project's own `CLAUDE.md` /
> agent-rules file) so the project's agent reads the publish contract before it
> ever touches git. Many agent tools auto-discover a top-level `AGENTS.md`.

## Adding a project

1. `openssl rand -hex 32` → a new secret.
2. Append `{ "name": "...", "path": "/abs/repo", "secret": "<new>" }` to
   `~/.config/gitbroker/registry.json`.
3. Put the same secret in that project's `.env` as `BROKER_SECRET`.

No restart needed — the registry is re-read on every request.

## Rotating a secret

Regenerate, update the registry entry **and** that project's `.env`. Old secret
stops working immediately on the next request.

---

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `GITBROKER_REGISTRY` | `~/.config/gitbroker/registry.json` | registry file path |
| `GITBROKER_PORT` | `4747` | listen port |
| `GITBROKER_HOST` | `0.0.0.0` | listen interface (must be sandbox-reachable) |

---

## Logs

The broker writes **one audit line per request** to stdout. Under the `launchd`
agent that's routed to `~/Library/Logs/gitbroker.log` (the agent's
`StandardOutPath`/`StandardErrorPath`). Run in the foreground and it prints to
the terminal instead.

```
[2026-06-12T16:50:00.000Z] gitbroker listening on http://0.0.0.0:4747  registry=/Users/you/.config/gitbroker/registry.json projects=2
[2026-06-12T16:50:00.001Z] routes: GET /health | POST /publish { … }  (header: x-broker-secret)
[2026-06-12T16:51:29.900Z] GET /health -> 200 from=172.16.10.3
[2026-06-12T16:51:30.001Z] POST /publish -> 200 from=172.16.10.3
[2026-06-12T16:51:30.001Z] publish project=projectA OK committed a1e015a add=1 rm=0 from=172.16.10.3
[2026-06-12T17:01:10.220Z] POST /publish -> 401 from=172.16.10.9
[2026-06-12T17:02:00.450Z] POST /publish -> 409 from=172.16.10.3
[2026-06-12T17:02:00.456Z] publish project=projectA FAIL diverged-from-origin add=1 rm=0 from=172.16.10.3
```

Every line is timestamped (ISO-8601 UTC), including startup and fatal errors.

Every request produces a timestamped **access line** — `METHOD path -> status
from=ip` — so health checks, unknown routes, and rejected-auth attempts (`POST
/publish -> 401`) are all captured. A successful or failed `/publish` adds a
**detail line** with the project the secret resolved to, the outcome (`OK
committed <sha>`, `OK no-op`, or `FAIL <reason>`), and the add/rm counts. Secrets
are never logged.

What's *not* in the log: the individual git sub-commands — those are returned in
the HTTP response's `steps[]` array for the caller to inspect. Want full
git-command tracing in the file too? It's a small change — ask.

```bash
tail -f ~/Library/Logs/gitbroker.log
```

## Limitations / roadmap

- Pushes only to `origin main` (the common case). Branch/remote selection is a
  natural extension.
- No deploy verification — pair with a post-push check that the change went live
  if you need it.
- Logical confinement, not OS sandbox (see security note above).
- HTTP + shared secret on a private interface; if you ever need it off a trusted
  network, put it behind mTLS.

## License

MIT.
