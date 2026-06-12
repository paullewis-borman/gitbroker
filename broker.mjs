#!/usr/bin/env node
// gitbroker — a native git push service for sandboxed agents.
//
// PROBLEM IT SOLVES
//   AI agents (e.g. Claude Cowork) run inside a sandbox that surfaces your real
//   project folder as a bindfs mount. On that mount, git is fragile (sporadic
//   SIGBUS when it mmaps pack files) and *deletes* are permission-gated, so an
//   unattended agent can't reliably run add/commit/push or remove files. Worst
//   of all, the usual workarounds (force-resync with `git reset --hard`, /tmp
//   clones, scoped push tokens living in the sandbox) are fragile and risk
//   destroying local work.
//
// THE FIX
//   Run git NATIVELY on the host, outside the sandbox, behind a tiny HTTP API.
//   The agent calls POST /publish; gitbroker runs add/commit/push in the real
//   working directory with the host's healthy git and the user's own
//   credentials. No reset --hard, no /tmp clone, no token in the sandbox.
//
// AUTHORIZATION — the secret selects the directory ("secret as capability").
//   A registry on the host maps each secret to exactly one repo:
//     [ { "name":"projectA", "path":"/abs/repo", "secret":"<sA>" }, ... ]
//   A request presents ONLY its secret (header x-broker-secret). gitbroker
//   resolves secret -> directory and operates there and nowhere else. A caller
//   cannot name, path-traverse to, or guess a directory whose secret it does
//   not hold; an unknown secret is 401. Each project's secret lives in that
//   project's own gitignored .env, readable only inside that project's sandbox,
//   so secrets never cross projects.
//
//   The registry file holds every secret + path — keep it OUTSIDE every repo,
//   chmod 600, never committed. Per-project secret theft exposes only that
//   project; only compromise of the registry/host process exposes all.
//
// SAFETY
//   * fetch + `merge --ff-only` REFUSES on divergence instead of destroying.
//   * Path guards reject pathspec/rm entries that escape the resolved repo.
//   * Per-repo mutex serializes writes to the same repo.
//   * Surface is two endpoints; there is NO arbitrary-git/run-command endpoint.
//
// RUN
//   node broker.mjs        (or via the launchd agent — see the .plist)
// ENV
//   GITBROKER_REGISTRY  default ~/.config/gitbroker/registry.json
//   GITBROKER_PORT      default 4747
//   GITBROKER_HOST      default 0.0.0.0  (must be reachable from the sandbox;
//                       loopback won't work — the sandbox reaches the host on a
//                       real interface)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.GITBROKER_PORT || 4747);
const HOST = process.env.GITBROKER_HOST || '0.0.0.0';
const REGISTRY_PATH = process.env.GITBROKER_REGISTRY || path.join(os.homedir(), '.config', 'gitbroker', 'registry.json');

// --- registry: read fresh each request so projects can be added w/o restart ---
function loadRegistry() {
  const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : (parsed.projects || []);
  return entries.filter((e) => e && e.path && e.secret);
}

function timingEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;            // length leak is fine; secrets are high-entropy
  return crypto.timingSafeEqual(ab, bb);
}

// Resolve a presented secret to its registered project, or null.
function resolveBySecret(secret) {
  if (!secret) return null;
  let entries;
  try { entries = loadRegistry(); } catch { return null; }
  for (const e of entries) if (timingEq(secret, e.secret)) return { name: e.name || '(unnamed)', repo: path.resolve(e.path) };
  return null;
}

// --- git helper bound to a specific repo ------------------------------------
function git(repo, args) {
  try {
    const out = execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { cmd: `git ${args.join(' ')}`, ok: true, code: 0, out: String(out).trim() };
  } catch (e) {
    return { cmd: `git ${args.join(' ')}`, ok: false, code: e.status ?? null,
      out: String(e.stdout || '').trim(), err: String(e.stderr || e.message || '').trim() };
  }
}

// --- per-repo mutex: same repo serializes; different repos run concurrently ---
const lockTails = new Map();
function withRepoLock(repo, task) {
  const prev = lockTails.get(repo) || Promise.resolve();
  const result = prev.then(task, task);
  lockTails.set(repo, result.then(() => {}, () => {}));
  return result;
}

function insideRepo(repo, p) {
  const resolved = path.resolve(repo, p);
  return resolved === repo || resolved.startsWith(repo + path.sep);
}

// --- POST /publish core, scoped to the resolved repo ------------------------
// body: { message, pathspec?=["-A"], rm?:[], allowEmpty?:bool, project?:string }
function doPublish(repo, name, body) {
  if (body.project && body.project !== name) return { ok: false, error: `secret maps to "${name}", not "${body.project}"` };
  const message = (body.message || '').toString().trim();
  if (!message) return { ok: false, error: 'message is required' };
  if (!fs.existsSync(path.join(repo, '.git'))) return { ok: false, error: `not a git repo: ${repo}` };

  const pathspec = Array.isArray(body.pathspec) && body.pathspec.length ? body.pathspec.map(String) : ['-A'];
  const rm = Array.isArray(body.rm) ? body.rm.map(String) : [];
  const allowEmpty = !!body.allowEmpty;
  const steps = [];

  // 0. sync to origin without destroying anything (ff-only refuses on divergence)
  steps.push({ step: 'fetch', ...git(repo, ['fetch', 'origin', 'main']) });
  const ff = git(repo, ['merge', '--ff-only', 'origin/main']);
  steps.push({ step: 'ff-sync', ...ff });
  if (!ff.ok) return { ok: false, reason: 'diverged-from-origin',
    hint: 'local main and origin/main diverged; resolve by hand (nothing changed/destroyed).', project: name, steps };

  // 1. removals (native delete — the mount delete-gate does not apply on the host)
  for (const entry of rm) {
    if (!insideRepo(repo, entry)) { steps.push({ step: 'rm', target: entry, ok: false, err: 'escapes repo — refused' }); return { ok: false, project: name, steps }; }
    if (git(repo, ['ls-files', '--error-unmatch', '--', entry]).ok) {
      steps.push({ step: 'rm', target: entry, ...git(repo, ['rm', '-f', '--', entry]) });
    } else {
      try { fs.rmSync(path.resolve(repo, entry), { force: true }); steps.push({ step: 'rm', target: entry, ok: true, note: 'untracked — removed from disk' }); }
      catch (e) { steps.push({ step: 'rm', target: entry, ok: false, err: String(e && e.message || e) }); }
    }
  }

  // 2. stage (drop any paths we just rm'd — git rm already staged those, and
  //    re-adding a now-deleted path would error harmlessly but noisily)
  const rmSet = new Set(rm);
  const addSpec = pathspec.filter((ps) => !rmSet.has(ps));
  for (const ps of addSpec) if (ps !== '-A' && ps !== '.' && !insideRepo(repo, ps)) {
    steps.push({ step: 'add', target: ps, ok: false, err: 'escapes repo — refused' }); return { ok: false, project: name, steps };
  }
  if (addSpec.length) steps.push({ step: 'add', ...git(repo, ['add', ...addSpec]) });

  // 3. anything staged?
  if (git(repo, ['diff', '--cached', '--quiet']).ok && !allowEmpty)
    return { ok: true, project: name, committed: false, note: 'nothing staged — nothing to commit', steps };

  // 4. commit + push
  steps.push({ step: 'commit', ...git(repo, ['commit', '-m', message]) });
  const push = git(repo, ['push', 'origin', 'main']);
  steps.push({ step: 'push', ...push });
  if (!push.ok) return { ok: false, reason: 'push-failed', project: name, steps };

  return { ok: true, project: name, committed: true, sha: git(repo, ['rev-parse', 'HEAD']).out, steps };
}

// --- audit log: one line per request to stdout (launchd routes it to the log) ---
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// --- HTTP server -------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const reply = (code, obj) => {
    log(`${req.method} ${url.pathname} -> ${code} from=${req.socket.remoteAddress}`);   // timestamped access line for EVERY request
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  };

  // Unauthenticated: liveness + project COUNT only (never names/paths/secrets).
  if (req.method === 'GET' && url.pathname === '/health') {
    let count = null; try { count = loadRegistry().length; } catch {}
    return reply(200, { ok: true, service: 'gitbroker', registry: REGISTRY_PATH, projects: count, time: new Date().toISOString() });
  }

  if (url.pathname === '/publish') {
    if (req.method !== 'POST') return reply(405, { ok: false, error: 'use POST' });
    const who = resolveBySecret(req.headers['x-broker-secret']);
    if (!who) return reply(401, { ok: false, error: 'unknown or missing x-broker-secret' });   // access line logs the 401
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch { log(`publish project=${who.name} BADREQUEST invalid JSON`); return reply(400, { ok: false, error: 'invalid JSON body' }); }
      const add = (Array.isArray(body.pathspec) && body.pathspec.length ? body.pathspec.length : 1);
      const rm = (Array.isArray(body.rm) ? body.rm.length : 0);
      withRepoLock(who.repo, () => doPublish(who.repo, who.name, body))
        .then((result) => {
          const s = result.ok ? (result.committed ? `OK committed ${result.sha}` : 'OK no-op (nothing to commit)') : `FAIL ${result.reason || result.error || 'error'}`;
          log(`publish project=${who.name} ${s} add=${add} rm=${rm} from=${req.socket.remoteAddress}`);
          reply(result.ok ? 200 : 409, result);
        })
        .catch((e) => { log(`publish project=${who.name} ERROR ${e && e.message || e}`); reply(500, { ok: false, error: String(e && e.message || e) }); });
    });
    return;
  }

  reply(404, { ok: false, error: 'not found', endpoints: ['GET /health', 'POST /publish'] });
});

server.on('error', (e) => { log(`gitbroker FATAL ${e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => {
  let count = '?'; try { count = loadRegistry().length; } catch (e) { count = `!! registry unreadable: ${e.message}`; }
  log(`gitbroker listening on http://${HOST}:${PORT}  registry=${REGISTRY_PATH} projects=${count}`);
  log(`routes: GET /health | POST /publish { message, pathspec?, rm?, allowEmpty?, project? }  (header: x-broker-secret)`);
});
