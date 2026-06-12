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
launchctl load ~/Library/LaunchAgents/com.gitbroker.broker.plist
launchctl start com.gitbroker.broker
launchctl list | grep gitbroker     # confirm it's up
tail -f broker.log                  # watch logs
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
