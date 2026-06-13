#!/usr/bin/env node
// broker-publish.mjs — publish this repo via the gitbroker service.
//
// The scheduled tasks run inside the Cowork sandbox, where committing/pushing
// on the bindfs mount is fragile and deletes are permission-gated. Instead of
// doing git here, they call the native gitbroker running on Paul's Mac, which
// runs git add/commit/push (and git rm) in the real folder with Paul's own
// credentials. This helper wraps that call: it finds the broker, authenticates
// with BROKER_SECRET from .env, and POSTs /publish.
//
// Usage:
//   node backend/scripts/broker-publish.mjs --message "msg" [--add <path>]... [--rm <path>]... [--allow-empty] [--url http://host:port]
// Exit codes: 0 = ok (committed OR nothing-to-commit); 1 = broker said fail;
//             2 = could not reach the broker; 3 = bad usage / no secret.
//
// The secret is never printed. On success the working broker URL is cached to
// .broker-host so the next run finds it instantly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));   // fileURLToPath decodes %20 etc. (e.g. "Schvitz Website")
const REPO = path.resolve(SCRIPT_DIR, '..', '..');           // backend/scripts -> repo root
const CACHE = path.join(REPO, '.broker-host');

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const opts = { add: [], rm: [], message: '', allowEmpty: false, url: '' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--message' || a === '-m') opts.message = args[++i];
  else if (a === '--add') opts.add.push(args[++i]);
  else if (a === '--rm') opts.rm.push(args[++i]);
  else if (a === '--allow-empty') opts.allowEmpty = true;
  else if (a === '--url') opts.url = args[++i];
  else { console.error(`unknown arg: ${a}`); process.exit(3); }
}
if (!opts.message) { console.error('--message is required'); process.exit(3); }

// --- .env -------------------------------------------------------------------
function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i < 0) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}
const env = loadEnv();
const SECRET = env.BROKER_SECRET || process.env.BROKER_SECRET;
if (!SECRET) { console.error('BROKER_SECRET not found in .env'); process.exit(3); }
const PORT = env.BROKER_PORT || process.env.BROKER_PORT || 4747;

// --- candidate broker URLs --------------------------------------------------
function ownSubnets() {
  const bases = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) bases.add(ni.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...bases];
}
function defaultGateway() {
  try { return execSync('ip route 2>/dev/null', { encoding: 'utf8' }).match(/default via (\d+\.\d+\.\d+\.\d+)/)?.[1] || null; }
  catch { return null; }
}
function candidates() {
  const list = [];
  if (opts.url) list.push(opts.url);
  if (env.BROKER_URL) list.push(env.BROKER_URL);
  try { const c = fs.readFileSync(CACHE, 'utf8').trim(); if (c) list.push(c); } catch {}
  for (const base of ownSubnets()) for (const last of [254, 1, 2]) list.push(`http://${base}.${last}:${PORT}`);
  const gw = defaultGateway(); if (gw) list.push(`http://${gw}:${PORT}`);
  return [...new Set(list)];
}

// --- http helpers -----------------------------------------------------------
function request(method, url, { headers = {}, body, timeout = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      let data = ''; res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
async function isBroker(url) {
  try { const r = await request('GET', url + '/health', { timeout: 1500 }); return r.status === 200 && /"service"\s*:\s*"gitbroker"/.test(r.body); }
  catch { return false; }
}

// --- main -------------------------------------------------------------------
(async () => {
  let base = null;
  for (const url of candidates()) { if (await isBroker(url)) { base = url; break; } }
  if (!base) { console.error('ERROR: could not reach gitbroker on any candidate address (is the Mac awake and the agent running?)'); process.exit(2); }

  const payload = { message: opts.message };
  if (opts.add.length) payload.pathspec = opts.add;
  if (opts.rm.length) payload.rm = opts.rm;
  if (opts.allowEmpty) payload.allowEmpty = true;

  let res;
  try {
    res = await request('POST', base + '/publish', {
      headers: { 'content-type': 'application/json', 'x-broker-secret': SECRET },
      body: JSON.stringify(payload), timeout: 60000,
    });
  } catch (e) { console.error(`ERROR: publish request failed: ${e.message}`); process.exit(2); }

  let result; try { result = JSON.parse(res.body); } catch { console.error(`ERROR: non-JSON response (${res.status}): ${res.body}`); process.exit(1); }

  if (result.ok) {
    try { fs.writeFileSync(CACHE, base); } catch {}
    if (result.committed) console.log(`published: ${result.project} ${result.sha}`);
    else console.log(`no-op: ${result.note || 'nothing to commit'}`);
    process.exit(0);
  }
  // surface the failing step for the task log
  const failed = (result.steps || []).filter((s) => s.ok === false).map((s) => `${s.step}: ${s.err || s.error || ''}`.trim());
  console.error(`FAIL: ${result.reason || result.error || 'publish failed'}${failed.length ? ' — ' + failed.join('; ') : ''}`);
  process.exit(1);
})();
