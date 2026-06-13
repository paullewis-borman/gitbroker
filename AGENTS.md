# AGENTS.md — gitbroker

> Operating contract for an AI agent that publishes a repo through **gitbroker**.
> Humans should read `README.md` instead — it explains how the broker works,
> how to install it, and the full security model. This file is the short,
> imperative version an agent needs at work time.

## What gitbroker is (one line)

A native git push service on the operator's host. You (an agent in a sandbox)
**never run git on the mounted repo**; you make one HTTP call and the broker
runs `git add` / `commit` / `push` (and `git rm`) in the real working copy with
the operator's own credentials.

## How to publish

You have two equivalent options. Prefer the helper if it's present in the repo.

### Option A — the helper (`broker-publish.mjs`)

```bash
node broker-publish.mjs \
  --message "your commit message" \
  --add path/relative/to/repo/root \
  --add another/path \
  --rm  a/file/to/delete            # repeat --rm per file; omit if none
# flags: --allow-empty (commit with nothing staged), --url http://host:port (override)
```

It reads `BROKER_SECRET` from the repo's gitignored `.env`, finds the broker
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
SECRET=$(grep '^BROKER_SECRET=' .env | cut -d= -f2-)
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
   only in the gitignored `.env`.
4. **One secret = one repo.** The secret is the capability; you can only ever
   touch the repo it maps to. Don't try to name or path to another repo.
5. **Paths are relative to the repo root** in `--add` / `--rm` / `pathspec`.
6. **Deletes use `--rm` / the `rm` field** — let the broker delete natively. Do
   not delete files on the mount yourself.

## Preconditions to check first

- `.env` exists and contains `BROKER_SECRET` (else exit 3).
- The broker is reachable (`GET /health` returns `{ok:true}`); if not, the host
  is likely asleep — STOP and report rather than falling back to native git.
