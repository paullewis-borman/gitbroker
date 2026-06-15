# AGENTS.md — gitbroker

**📍 This is the `gitbroker` utility's contract** — read it when publishing a repo
*through* gitbroker.

> Operating contract for an AI agent that publishes a repo through **gitbroker**.
> Humans should read `README.md` instead — it explains how the broker works,
> how to install it, and the full security model. This file is the short,
> imperative version an agent needs at work time.

## Self-scoping convention (read first when vendoring)

This utility ships as a **single self-named folder** (`gitbroker/`) that contains
everything it needs: this `AGENTS.md`, `broker-publish.mjs`, and its own local
`.env` / `.broker-host` cache. To add it to a host project, **copy the whole
folder in and leave it intact** — don't scatter its files, and never merge it
with another utility.

Why the folder matters: `AGENTS.md` is a magic, auto-discovered filename that
agents treat as *whole-project* instructions. If two vendored utilities each drop
an `AGENTS.md` into the **same** folder, they collide and an agent merges their
contracts. Keeping each utility in its own named folder prevents that, and the
pattern scales to any number of utilities:

```
<host-project>/
  gitbroker/AGENTS.md        ← this folder
  <other-utility>/AGENTS.md  ← a different utility, its own named folder
  <another-utility>/AGENTS.md← …and so on, one folder each
```

Nested `AGENTS.md` is **nearest-wins**: an agent reads only the one closest to
the files it's touching, never sibling folders — so any number of self-scoped
utilities coexist without clashing. **Hard rule: one utility, one folder; never
flatten two into a shared folder** — that is exactly what re-creates the clash.
The host's root `AGENTS.md`/`CLAUDE.md` should point explicitly at each folder (a
vendored `AGENTS.md` in a subfolder is not always auto-discovered).

> **Where this folder's files resolve.** `broker-publish.mjs` reads its
> `BROKER_SECRET` and caches the broker URL **in this folder** (next to the
> script). The `--add` / `--rm` paths you pass are always relative to the **git
> repo root**, which the broker resolves on the host — so the helper works
> unchanged wherever the folder is dropped.

## What gitbroker is (one line)

A native git push service on the operator's host. You (an agent in a sandbox)
**never run git on the mounted repo**; you make one HTTP call and the broker
runs `git add` / `commit` / `push` (and `git rm`) in the real working copy with
the operator's own credentials.

## First: which scenario are you in? (setup vs. just publishing)

If this project is **already wired to the broker** — this folder's gitignored
`.env` has a `BROKER_SECRET` and `broker-publish.mjs` is present — it's set up;
skip to *How to publish*. Otherwise you're wiring it in, and there are two cases.
Detect which **before** you clone or install anything:

**Scenario A — the broker is already installed on this machine.** The common
case: you're adding a 2nd/3rd project to a broker that already serves others.
One broker is *designed* to serve many repos, so there is **nothing to install**.
Signals, cheapest first:
- A `GET /health` probe (or `node broker-publish.mjs --message probe
  --allow-empty` once a secret exists) answers `{ok:true}` → a broker is live on
  this host.
- The operator says "the broker's already running", or a sibling project already
  publishes through it.
- *(host-side, if you can see it)* `~/.config/gitbroker/registry.json` exists.

→ Adding this project is three small steps — two are **host-side** and need the
operator, because the sandbox can't reach `~/.config` or `launchd`:
  1. *(operator, host)* `openssl rand -hex 32` → append
     `{ "name": "<proj>", "path": "<abs host path>", "secret": "<new>" }` to
     `~/.config/gitbroker/registry.json`. **No broker restart** — the registry is
     re-read on every request.
  2. Put that same secret in **this folder's** gitignored `.env` as
     `BROKER_SECRET=…`.
  3. Copy this `gitbroker/` folder into the project (it carries
     `broker-publish.mjs` with it).

**Scenario B — fresh install on this machine.** Nothing answers `/health`, no
registry exists, and the host is awake. → Walk the operator through the README's
*Install* section first (clone, create registry, launchd), then do Scenario-A
steps 2–3 to wire in this project.

> If `/health` is silent you cannot tell "not installed" from "host asleep / not
> logged in". **Ask the operator which it is** — don't assume a fresh install and
> re-clone over a perfectly good one.

## How to publish

You have two equivalent options. Prefer the helper if it's present in the repo.

### Option A — the helper (`broker-publish.mjs`)

```bash
node gitbroker/broker-publish.mjs \
  --message "your commit message" \
  --add path/relative/to/repo/root \
  --add another/path \
  --rm  a/file/to/delete            # repeat --rm per file; omit if none
# flags: --allow-empty (commit with nothing staged), --url http://host:port (override)
```

It reads `BROKER_SECRET` from this folder's gitignored `.env`, finds the broker
(caching the working URL in `.broker-host`), and POSTs `/publish`. **The secret
is never printed.**

**Exit codes — act on them:**

| code | meaning | what you do |
| --- | --- | --- |
| `0` | published, OR nothing to commit | success — proceed |
| `1` | broker reported a failure (e.g. diverged) | STOP. Report the broker's reason. Do not retry blindly. |
| `2` | could not reach the broker (host asleep/offline) | STOP. Report "broker unreachable". |
| `3` | bad usage / no secret in `.env` | STOP. Fix the call or config. |

### Option B — POST directly

```bash
SECRET=$(grep '^BROKER_SECRET=' gitbroker/.env | cut -d= -f2-)
curl -s -X POST "$BROKER_URL/publish" \
  -H "x-broker-secret: $SECRET" \
  -H "content-type: application/json" \
  -d '{"message":"...","pathspec":["data/articles.json"],"rm":[]}'
```

Response is JSON with `ok`, `committed`, `sha`, and a `steps[]` trace. HTTP `409`
with `reason:"diverged-from-origin"` means the branch diverged — STOP and report;
nothing was changed or destroyed.

## Hard rules — do not break these

1. **Never run native `git add` / `commit` / `push` / `rm` against the mounted
   repo.** It is fragile on a bindfs mount (stale `index.lock`, `SIGBUS`,
   permission-gated deletes). All git goes through the broker.
2. **On any non-zero exit / error, STOP and report. Never claim success you
   didn't get.** A scheduled task should log ERROR and halt.
3. **Never send, print, log, or commit `BROKER_SECRET` or any token.** It lives
   only in this folder's gitignored `.env`.
4. **One secret = one repo.** The secret is the capability; you can only ever
   touch the repo it maps to. Don't try to name or path to another repo.
5. **Paths are relative to the repo root** in `--add` / `--rm` / `pathspec`.
6. **Deletes use `--rm` / the `rm` field** — let the broker delete natively. Do
   not delete files on the mount yourself.

## Preconditions to check first

- This folder's `.env` exists and contains `BROKER_SECRET` (else exit 3).
- The broker is reachable (`GET /health` returns `{ok:true}`); if not, the host
  is likely asleep — STOP and report rather than falling back to native git.
