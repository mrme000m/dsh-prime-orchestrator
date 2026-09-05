#!/usr/bin/env node
// wt.mjs — WunderTrading CLI engine (zero-dependency, Node >= 22).
// Implements docs/WT_PLUGIN_SPEC.md: bdg+CloakBrowser web automation,
// Bitwarden session persistence, HMAC REST API, MCP config, network + shots.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const env = process.env;
const DEFAULT_CLOAK_DIR = '/Volumes/ExMac/code/tradingview/minimal-mjs';
const CLOAK_DIR = env.WT_CLOAK_DIR || DEFAULT_CLOAK_DIR;
const BDG = path.join(CLOAK_DIR, 'bdg', 'dist', 'index.js');
const LAUNCH = path.join(CLOAK_DIR, 'launch.mjs');
const BASE = (env.WT_BASE_URL || 'https://wundertrading.com').replace(/\/+$/, '');
const LOGIN_ITEM = env.WT_BW_LOGIN_ITEM || 'wundertrading-login';
const SESSION_ITEM = env.WT_BW_SESSION_ITEM || 'wundertrading-session';
const API_ITEM = env.WT_BW_API_ITEM || 'wundertrading-api';
const DEFAULT_MCP_URL = 'https://wundertrading.com:2083/mcp';
const DASHBOARD = '/en/trader/dashboard/traders';

// ---------- output / process ----------

function print(obj, code = 0) {
  const pretty = !argv.json;
  console.log(pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  process.exit(code);
}
function fail(error) {
  print({ ok: false, error: String(error && error.message ? error.message : error) }, 1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- argv ----------

const argv = { _: [], json: false, mask: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') { argv.json = true; continue; }
  if (a === '--mask') { argv.mask = true; continue; }
  if (a === '--email' || a === '--password' || a === '--body' || a === '--recv' ||
      a === '--permissions' || a === '--filter') {
    argv[a.slice(2)] = process.argv[++i];
    continue;
  }
  argv._.push(a);
}
const [cmd, sub, ...rest] = argv._;

// ---------- JSON extraction (bdg mixes node warnings into stdout) ----------

function stripNoise(s) {
  return String(s)
    .split('\n')
    .filter((l) => !/^\(node:\d+\)\s/.test(l) && !/trace-warnings/.test(l))
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim();
}

function balancedJson(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ---------- bdg bridge ----------

function bdg(args, timeoutMs = 120000) {
  const r = spawnSync('node', [BDG, ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error) throw new Error(`bdg spawn failed: ${r.error.message}`);
  if (r.status !== 0) {
    const line = stripNoise(r.stderr || r.stdout).split('\n').filter(Boolean)[0];
    throw new Error(`bdg ${args.join(' ')} failed: ${line || `exit ${r.status}`}`);
  }
  return r.stdout || '';
}

function bdgEnvelope(args) {
  const env2 = balancedJson(stripNoise(bdg(args)));
  if (!env2 || typeof env2 !== 'object') throw new Error(`bdg ${args[0]}: no JSON envelope`);
  if (env2.success !== true) throw new Error(`bdg ${args[0]}: success=false`);
  return env2.data || {};
}

async function cdp(method, params = {}) {
  const d = bdgEnvelope(['cdp', method, '--params', JSON.stringify(params)]);
  return d.result;
}

// dom eval: result comes back as a JSON-quoted string — decode twice when needed.
function domEval(js) {
  const raw = stripNoise(bdg(['dom', 'eval', js], 60000));
  if (raw === '' || raw === 'undefined') return null;
  let v;
  try { v = JSON.parse(raw); } catch { v = raw; }
  if (typeof v === 'string') {
    const s = v.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { return JSON.parse(s); } catch { /* keep string */ }
    }
  }
  return v;
}

function bdgStatusInfo() {
  let out;
  try { out = bdg(['status'], 60000); } catch { return { active: false, url: null }; }
  const t = stripNoise(out);
  const m = t.match(/^\s*Status:\s*(\S+)/m);
  const u = t.match(/^\s*URL:\s*(\S+)/m);
  const active = !!(m && m[1].toUpperCase() === 'ACTIVE' && u);
  return { active, url: active && u ? u[1] : null };
}

// ---------- browser ----------

async function findCdpPort() {
  for (let p = 9222; p <= 9321; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(400) });
      if (r.ok) return p;
    } catch { /* not this port */ }
  }
  return null;
}

async function pageTarget(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
    const list = await r.json();
    const pages = list.filter((t) => t.type === 'page');
    return pages.find((t) => (t.url || '').includes('wundertrading.com')) || pages[0] || null;
  } catch { return null; }
}

async function ensureBrowser() {
  let port = await findCdpPort();
  if (port) return port;
  if (!fs.existsSync(LAUNCH)) throw new Error(`launch.mjs not found: ${LAUNCH} (set WT_CLOAK_DIR)`);
  const child = spawn('node', [LAUNCH], { detached: true, stdio: 'ignore', cwd: CLOAK_DIR });
  child.unref();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(1000);
    port = await findCdpPort();
    if (port) return port;
  }
  throw new Error('browser did not start (launch.mjs timeout)');
}

async function ensureBdg(url) {
  const want = new URL(url);
  const st = bdgStatusInfo();
  if (st.active) {
    try {
      if (new URL(st.url).host === want.host) return st;
    } catch { /* fallthrough */ }
    bdg(['stop'], 60000);
  }
  const port = await ensureBrowser();
  const target = await pageTarget(port);
  if (!target) throw new Error('no CDP page target found');
  bdg(['--chrome-ws-url', target.webSocketDebuggerUrl, '--no-headless', url], 120000);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(500);
    const s = bdgStatusInfo();
    if (s.active) {
      try { if (new URL(s.url).host === want.host) return s; } catch { /* retry */ }
    }
  }
  throw new Error(`bdg attach failed for ${url}`);
}

async function wait(fn, timeoutMs = 30000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

async function currentPageHref() {
  try { return await domEval('location.href'); } catch { return null; }
}

async function navigate(url) {
  await cdp('Page.navigate', { url });
  const origin = new URL(url).origin;
  await wait(async () => {
    const h = await currentPageHref();
    return h && h.startsWith(origin);
  }, 30000);
}

// Logged-in probe without navigation: sync XHR follows the /login redirect.
function probeSession() {
  const r = domEval(
    `(function(){try{var x=new XMLHttpRequest();x.open('GET','${DASHBOARD}',false);` +
    `x.send(null);return JSON.stringify({url:x.responseURL,status:x.status})}catch(e){` +
    `return JSON.stringify({err:String(e)})}})()`
  );
  if (!r || typeof r !== 'object' || !r.url) return null;
  return { loggedIn: !String(r.url).includes('/login'), url: r.url };
}

function accountFromDom() {
  try {
    const r = domEval(
      `(function(){var e=document.querySelector('.popover-content-user-name');` +
      `return e?e.textContent.trim():null})()`
    );
    return typeof r === 'string' && r ? r : null;
  } catch { return null; }
}

// ---------- React-safe fill / click helpers (dom eval) ----------

const NATIVE_FILL_JS = (sel, value) =>
  `(function(){var el=document.querySelector(${JSON.stringify(sel)});` +
  `if(!el)return JSON.stringify({ok:false,error:'not found'});` +
  `var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
  `el.focus();set.call(el,${JSON.stringify(value)});` +
  `el.dispatchEvent(new Event('input',{bubbles:true}));` +
  `el.dispatchEvent(new Event('change',{bubbles:true}));el.blur();` +
  `return JSON.stringify({ok:true,value:el.value})})()`;

function nativeFill(sel, value) {
  const r = domEval(NATIVE_FILL_JS(sel, value));
  if (!r || !r.ok) throw new Error(`fill ${sel} failed: ${r && r.error ? r.error : 'unknown'}`);
  return r;
}

const CLICK_TEXT_JS = (source, flags, last) =>
  `(function(){var re=new RegExp(${JSON.stringify(source)},${JSON.stringify(flags)});` +
  `var bs=Array.prototype.slice.call(document.querySelectorAll('button,[role=button]'))` +
  `.filter(function(b){return b.offsetParent!==null});` +
  `var ms=bs.filter(function(b){return re.test(b.textContent.trim())});` +
  `var b=${last ? 'ms[ms.length-1]' : 'ms[0]'};if(!b)return null;` +
  `b.click();return b.textContent.trim()})()`;

function clickText(re, { last = false, timeoutMs = 15000 } = {}) {
  return wait(() => {
    let r = null;
    try { r = domEval(CLICK_TEXT_JS(re.source, re.flags, last)); } catch { r = null; }
    return r || null;
  }, timeoutMs, 500);
}

// ---------- Bitwarden ----------

function bwSession() {
  if (env.BW_SESSION) return env.BW_SESSION;
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const refs = text.match(/^refs:\s*\n((?:[ \t]+\S[^\n]*\n?)*)/m);
    if (refs) {
      const m = refs[1].match(/^[ \t]*BW_SESSION:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m);
      if (m) return m[1];
    }
  } catch { /* no credentials file */ }
  return null;
}

function parseEnvNotes(notes) {
  const map = {};
  if (!notes) return map;
  for (const line of String(notes).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).replace(/\r$/, '');
  }
  return map;
}

function bwGetItemNotes(name, session = bwSession()) {
  if (!session) return null;
  const r = spawnSync('bw', ['get', 'item', name, '--session', session], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return null;
  const item = balancedJson(stripNoise(r.stdout));
  return item ? item.notes || '' : null;
}

function bwUpsertNote(name, notesEnv) {
  const session = bwSession();
  if (!session) throw new Error('vault locked: no BW_SESSION (env or ~/.dsh/.credentials.yaml)');
  const list = spawnSync('bw', ['list', 'items', '--session', session], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  });
  if (list.status !== 0) throw new Error(`bw list items failed: ${stripNoise(list.stderr).split('\n')[0]}`);
  const items = balancedJson(stripNoise(list.stdout)) || [];
  const existing = items.find((it) => it.name === name);
  if (existing) {
    const got = spawnSync('bw', ['get', 'item', existing.id, '--session', session], {
      encoding: 'utf8', timeout: 60000,
    });
    if (got.status !== 0) throw new Error('bw get item failed');
    const item = balancedJson(stripNoise(got.stdout));
    item.notes = notesEnv;
    const b64 = Buffer.from(JSON.stringify(item), 'utf8').toString('base64');
    const edit = spawnSync('bw', ['edit', 'item', existing.id, b64, '--session', session], {
      encoding: 'utf8', timeout: 60000,
    });
    if (edit.status !== 0) throw new Error(`bw edit item failed: ${stripNoise(edit.stderr || edit.stdout).split('\n')[0]}`);
    return { id: existing.id, created: false };
  }
  const template = {
    type: 2, name, notes: notesEnv, secureNote: { type: 0 },
    fields: [], favorite: false, reprompt: 0, passwordHistory: [],
  };
  const b64 = Buffer.from(JSON.stringify(template), 'utf8').toString('base64');
  const create = spawnSync('bw', ['create', 'item', b64, '--session', session], {
    encoding: 'utf8', timeout: 60000,
  });
  if (create.status !== 0) throw new Error(`bw create item failed: ${stripNoise(create.stderr || create.stdout).split('\n')[0]}`);
  const created = balancedJson(stripNoise(create.stdout));
  return { id: created ? created.id : null, created: true };
}

// ---------- credentials ----------

function getLoginCreds(needPassword = false) {
  const email = argv.email || env.WT_EMAIL;
  const password = argv.password || env.WT_PASSWORD;
  if (email && (!needPassword || password)) return { email, password, loginUrl: `${BASE}/en/login` };
  const notes = parseEnvNotes(bwGetItemNotes(LOGIN_ITEM));
  const e = email || notes.WT_EMAIL;
  const p = password || notes.WT_PASSWORD;
  if (!e || (needPassword && !p)) throw new Error('no login credentials: set WT_EMAIL/WT_PASSWORD or vault item ' + LOGIN_ITEM);
  return { email: e, password: p, loginUrl: notes.WT_LOGIN_URL || `${BASE}/en/login` };
}

function getApiCreds() {
  if (env.WT_API_KEY && env.WT_API_SECRET) {
    return { key: env.WT_API_KEY, secret: env.WT_API_SECRET, mcpUrl: env.WT_MCP_URL || DEFAULT_MCP_URL, source: 'env' };
  }
  const notes = parseEnvNotes(bwGetItemNotes(API_ITEM));
  if (!notes.WT_API_KEY || !notes.WT_API_SECRET) {
    throw new Error(`no API credentials: set WT_API_KEY/WT_API_SECRET or vault item ${API_ITEM}`);
  }
  return { key: notes.WT_API_KEY, secret: notes.WT_API_SECRET, mcpUrl: notes.WT_MCP_URL || DEFAULT_MCP_URL, source: 'vault' };
}

// ---------- session persistence ----------

async function captureCookies() {
  const res = await cdp('Network.getCookies', { urls: [`${BASE}/`] });
  return (res && res.cookies) || [];
}

function cookiesForSetCookies(cookies) {
  return cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: !!c.secure, httpOnly: !!c.httpOnly,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
  }));
}

async function saveSessionToVault() {
  const cookies = await captureCookies();
  const byName = (n) => cookies.find((c) => c.name === n);
  const notes = [
    `WT_PHPSESSID=${(byName('PHPSESSID') || {}).value || ''}`,
    `WT_CF_CLEARANCE=${(byName('cf_clearance') || {}).value || ''}`,
    `WT_COOKIES_JSON=${JSON.stringify(cookiesForSetCookies(cookies))}`,
    `WT_SESSION_SAVED_AT=${new Date().toISOString()}`,
    `WT_SESSION_BASE=${BASE}`,
    '',
  ].join('\n');
  const r = bwUpsertNote(SESSION_ITEM, notes);
  return { cookies: cookies.length, ...r };
}

async function loadSessionFromVault() {
  const notes = parseEnvNotes(bwGetItemNotes(SESSION_ITEM));
  if (!notes.WT_COOKIES_JSON) throw new Error(`vault item ${SESSION_ITEM} has no WT_COOKIES_JSON`);
  const cookies = JSON.parse(notes.WT_COOKIES_JSON);
  await cdp('Network.setCookies', { cookies: cookiesForSetCookies(cookies) });
  return cookies.length;
}

async function ensureWtOriginPage() {
  const href = await currentPageHref();
  if (!href || !href.startsWith(BASE)) await navigate(BASE);
}

// ---------- commands ----------

async function cmdStatus() {
  const port = await findCdpPort();
  const target = port ? await pageTarget(port) : null;
  const st = bdgStatusInfo();
  const result = {
    ok: true,
    browser: { running: !!port, cdpPort: port, pageUrl: target ? target.url : null },
    bdg: { active: st.active, targetUrl: st.url },
    session: { loggedIn: null, email: null },
  };
  if (port && st.active) {
    await ensureWtOriginPage().catch(() => {});
    const probe = probeSession();
    result.session.loggedIn = probe ? probe.loggedIn : null;
    if (probe && probe.loggedIn) {
      const acc = accountFromDom();
      let email = null;
      try { email = getLoginCreds(false).email; } catch { email = null; }
      if (acc && acc.includes('@')) email = acc;
      else if (acc && email && email.startsWith(acc)) { /* keep full creds email */ }
      result.session.email = email || acc;
    }
  }
  const session = bwSession();
  let vaultOk = false;
  const items = { login: false, session: false, api: false };
  if (session) {
    const r = spawnSync('bw', ['list', 'items', '--session', session], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    });
    const list = r.status === 0 ? balancedJson(stripNoise(r.stdout)) : null;
    if (Array.isArray(list)) {
      vaultOk = true;
      items.login = list.some((i) => i.name === LOGIN_ITEM);
      items.session = list.some((i) => i.name === SESSION_ITEM);
      items.api = list.some((i) => i.name === API_ITEM);
    }
  }
  let keyPresent = !!(env.WT_API_KEY && env.WT_API_SECRET);
  let baseUrl = BASE, mcpUrl = DEFAULT_MCP_URL;
  const apiNotes = vaultOk ? parseEnvNotes(bwGetItemNotes(API_ITEM)) : {};
  if (apiNotes.WT_API_KEY) keyPresent = true;
  if (apiNotes.WT_API_BASE) baseUrl = apiNotes.WT_API_BASE;
  if (apiNotes.WT_MCP_URL) mcpUrl = apiNotes.WT_MCP_URL;
  result.vault = { unlocked: vaultOk, items };
  result.api = { keyPresent, baseUrl };
  result.mcpUrl = mcpUrl;
  print(result);
}

async function cmdLogin() {
  const creds = getLoginCreds(true);
  await ensureBdg(creds.loginUrl);
  await navigate(creds.loginUrl);
  await wait(() => domEval('!!document.querySelector(\'input#email[name="_username"]\')'), 30000);
  // cookie banner (optional)
  try { clickText(/allow all cookies/i, { timeoutMs: 4000 }); } catch { /* no banner */ }
  nativeFill('input#email[name="_username"]', creds.email);
  nativeFill('input#password[name="_password"]', creds.password);
  clickText(/^login$/i);
  const landed = await wait(
    () => { const h = currentPageHref(); return h && h.includes('/en/trader/') ? h : null; },
    90000, 1000
  );
  if (!landed) {
    const h = await currentPageHref();
    throw new Error(`login failed: still at ${h || 'unknown'}`);
  }
  const saved = await saveSessionToVault();
  print({ ok: true, email: creds.email, savedAt: new Date().toISOString(), cookies: saved.cookies });
}

async function cmdSessionCheck() {
  await ensureBdg(`${BASE}/en/login`);
  await navigate(`${BASE}/en/trader/open_api`);
  const url = (await currentPageHref()) || '';
  const loggedIn = !url.includes('/login');
  const acc = accountFromDom();
  let email = null;
  if (loggedIn) {
    try { email = getLoginCreds(false).email; } catch { email = null; }
    if (acc && acc.includes('@')) email = acc;
  }
  print({ ok: true, loggedIn, url, email: email || (acc && loggedIn ? acc : null) });
}

async function cmdSessionSave() {
  await ensureBdg(BASE);
  await ensureWtOriginPage();
  const saved = await saveSessionToVault();
  print({ ok: true, item: SESSION_ITEM, id: saved.id, created: saved.created, savedAt: new Date().toISOString(), cookies: saved.cookies });
}

async function cmdSessionLoad() {
  await ensureBdg(BASE);
  await ensureWtOriginPage();
  const n = await loadSessionFromVault();
  await navigate(`${BASE}${DASHBOARD}`);
  const url = (await currentPageHref()) || '';
  print({ ok: true, item: SESSION_ITEM, cookies: n, url });
}

async function cmdSessionRestore() {
  await ensureBdg(BASE);
  await ensureWtOriginPage();
  const n = await loadSessionFromVault();
  await navigate(`${BASE}${DASHBOARD}`);
  const probe = probeSession();
  const loggedIn = probe ? probe.loggedIn : false;
  print({
    ok: true, restored: loggedIn, loggedIn,
    url: probe ? probe.url : null,
    cookies: n,
    ...(loggedIn ? {} : { hint: 'session expired — run `wt login`' }),
  });
}

async function cmdBrowse(urlArg) {
  const target = urlArg || `${BASE}${DASHBOARD}`;
  await ensureBdg(target);
  await ensureWtOriginPage();
  let probe = probeSession();
  if (!probe || !probe.loggedIn) {
    if (bwGetItemNotes(SESSION_ITEM)) {
      await loadSessionFromVault();
    }
  }
  await navigate(target);
  probe = probeSession();
  const port = await findCdpPort();
  const t = await pageTarget(port);
  print({
    ok: true,
    cdp: port,
    pageWs: t ? t.webSocketDebuggerUrl : null,
    url: (await currentPageHref()) || target,
    loggedIn: probe ? probe.loggedIn : null,
  });
}

async function cmdApi(method, apiPath) {
  const M = String(method || '').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(M)) throw new Error(`invalid method: ${method}`);
  if (!apiPath || !apiPath.startsWith('/')) throw new Error('path must start with /');
  const creds = getApiCreds();
  let bodyStr = '';
  if (argv.body !== undefined && argv.body !== '') {
    JSON.parse(argv.body); // validate
    bodyStr = argv.body;
  }
  const ts = String(Date.now());
  const recv = argv.recv ? String(argv.recv) : '';
  const payload = [M, apiPath, ts, recv, bodyStr].join('\n');
  const signature = crypto.createHmac('sha256', creds.secret).update(payload).digest('base64');
  const headers = { 'X-API-Key': creds.key, 'X-Signature': signature, 'X-Timestamp': ts };
  if (recv) headers['X-Recv-Window'] = recv;
  if (bodyStr) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${apiPath}`, { method: M, headers, body: bodyStr || undefined });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  print({ ok: res.ok, status: res.status, method: M, path: apiPath, body }, res.ok ? 0 : 1);
}

async function cmdApikeyList() {
  await ensureBdg(`${BASE}/en/trader/open_api`);
  await navigate(`${BASE}/en/trader/open_api`);
  const rows = await wait(() => {
    try {
      return domEval(
        `(function(){var rs=Array.prototype.slice.call(document.querySelectorAll('table tr'));` +
        `if(!rs.length)return null;return JSON.stringify(rs.map(function(r){` +
        `return Array.prototype.slice.call(r.querySelectorAll('th,td'))` +
        `.map(function(c){return (c.innerText||'').trim()})}))})()`
      );
    } catch { return null; }
  }, 30000, 1000);
  if (!rows || !rows.length) throw new Error('no API keys table found on /en/trader/open_api');
  const head = rows[0];
  const idx = (label) => head.findIndex((h) => h.toLowerCase().includes(label.toLowerCase()));
  const iName = idx('Name'), iKey = idx('API Key'), iIp = idx('IP'), iExp = idx('Expired'), iPerm = idx('Permission');
  const keys = rows.slice(1).filter((r) => r.length > 1).map((r) => ({
    name: iName >= 0 ? r[iName] : r[0],
    keyMasked: iKey >= 0 ? r[iKey] : null,
    ip: iIp >= 0 ? r[iIp] : null,
    expiresAt: iExp >= 0 ? r[iExp] : null,
    permissions: iPerm >= 0 ? r[iPerm].split('\n').map((s) => s.trim()).filter(Boolean).join('; ') : null,
  }));
  print({ ok: true, count: keys.length, keys });
}

async function cmdApikeyCreate(name) {
  if (!name) throw new Error('usage: wt apikey create <name>');
  const permissions = argv.permissions || 'API Profile: Read,Strategy: Read,Strategy: Write';
  await ensureBdg(`${BASE}/en/trader/open_api`);
  await navigate(`${BASE}/en/trader/open_api`);
  const opened = await wait(() => {
    try { return domEval(CLICK_TEXT_JS('create api keys', 'i', false)) || null; } catch { return null; }
  }, 30000, 1000);
  if (!opened) throw new Error('create api keys button not found');
  const filled = await wait(() => {
    try {
      return domEval(
        `(function(){var ins=Array.prototype.slice.call(document.querySelectorAll('input[type=text]'))` +
        `.filter(function(e){return e.offsetParent!==null});var el=ins[0];if(!el)return null;` +
        `var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;` +
        `el.focus();set.call(el,${JSON.stringify(name)});` +
        `el.dispatchEvent(new Event('input',{bubbles:true}));` +
        `el.dispatchEvent(new Event('change',{bubbles:true}));el.blur();` +
        `return el.value})()`
      );
    } catch { return null; }
  }, 20000, 800);
  if (!filled) throw new Error('modal name input not found');
  // permission checkboxes default to all checked — set only when a custom list is given
  if (permissions !== 'API Profile: Read,Strategy: Read,Strategy: Write') {
    const wanted = permissions.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    try {
      domEval(
        `(function(wanted){var boxes=Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox]'))` +
        `.filter(function(b){return b.offsetParent!==null});` +
        `boxes.forEach(function(b){var lbl=(b.closest('label')||b.parentElement).innerText.trim();` +
        `var on=wanted.some(function(w){return lbl.toLowerCase().includes(w.toLowerCase())});b.checked=on;` +
        `b.dispatchEvent(new Event('change',{bubbles:true}))});` +
        `return boxes.length})(${JSON.stringify(wanted)})`
      );
    } catch { /* keep defaults */ }
  }
  const created = await wait(() => {
    try { return domEval(CLICK_TEXT_JS('^create$', 'i', true)) || null; } catch { return null; }
  }, 20000, 1000);
  if (!created) throw new Error('create button not found in modal');
  const secret = await wait(() => {
    try {
      const r = domEval(
        `(function(){var t=document.body.innerText;var i=t.indexOf('Created API keys');` +
        `if(i===-1)return null;var seg=t.slice(i,i+600);` +
        `var km=seg.match(/API Key\\s*\\n\\s*(\\S+)\\s*\\n/);var sm=seg.match(/Secret Key\\s*\\n\\s*(\\S+)\\s*\\n/);` +
        `if(!km||!sm)return null;return JSON.stringify({key:km[1],secret:sm[1]})})()`
      );
      return r && r.key && r.secret ? r : null;
    } catch { return null; }
  }, 30000, 1000);
  if (!secret) throw new Error('created keys modal did not appear (or key/secret not extracted)');
  try { clickText(/saved my keys/i, { timeoutMs: 10000 }); } catch { /* modal already gone */ }
  const now = new Date();
  const expires = new Date(now.getTime() + 3 * 30 * 24 * 3600 * 1000); // ~3 months, no IP whitelist
  const expiresAt = expires.toISOString().replace(/.\d+Z$/, '');
  const notes = [
    `WT_API_KEY=${secret.key}`,
    `WT_API_SECRET=${secret.secret}`,
    `WT_API_NAME=${name}`,
    `WT_API_CREATED=${now.toISOString()}`,
    `WT_API_EXPIRES=${expiresAt}`,
    `WT_API_PERMISSIONS=${permissions.split(/[,;]/).map((s) => s.trim()).filter(Boolean).join('; ')}`,
    `WT_API_BASE=${BASE}`,
    `WT_MCP_URL=${DEFAULT_MCP_URL}`,
    '',
  ].join('\n');
  const saved = bwUpsertNote(API_ITEM, notes);
  print({ ok: true, name, apiKey: secret.key, apiSecret: secret.secret, expiresAt, vault: { item: API_ITEM, id: saved.id, created: saved.created } });
}

async function cmdMcpConfig() {
  let key, secret, mcpUrl;
  try {
    const creds = getApiCreds();
    key = creds.key; secret = creds.secret; mcpUrl = creds.mcpUrl;
  } catch (e) {
    throw e;
  }
  const masked = argv.mask === true;
  const headers = { 'X-API-Key': key, 'X-Secret-Key': masked ? '***' : secret };
  print({
    ok: true,
    cursor: { mcpServers: { wundertrading: { url: mcpUrl, headers } } },
    vscode: { servers: { wundertrading: { type: 'http', url: mcpUrl, headers } } },
    ...(masked ? {} : { note: 'full credentials — machine layer' }),
  });
}

async function cmdNetList() {
  await ensureBdg(BASE);
  const d = bdgEnvelope(['network', 'list', '--json']);
  let requests = (d.requests || []).map((r) => ({ method: r.method, status: r.status, url: r.url }));
  if (argv.filter) {
    let re;
    try { re = new RegExp(argv.filter, 'i'); } catch (e) { throw new Error(`bad --filter: ${e.message}`); }
    requests = requests.filter((r) => re.test(r.url || ''));
  }
  print({ ok: true, count: requests.length, requests });
}

async function cmdShot(p) {
  const file = p || path.join('shots', `wt-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  await ensureBdg(BASE);
  bdg(['dom', 'screenshot', file], 60000);
  if (!fs.existsSync(file)) throw new Error('screenshot file was not created');
  print({ ok: true, path: file, bytes: fs.statSync(file).size });
}

// ---------- dispatch ----------

const USAGE = 'usage: wt <status|login|session check|session save|session load|session restore|browse|api|apikey list|apikey create|mcp config|net list|shot> — see docs/WT_PLUGIN_SPEC.md';

try {
  switch (cmd) {
    case 'status': await cmdStatus(); break;
    case 'login': await cmdLogin(); break;
    case 'session':
      if (sub === 'check') await cmdSessionCheck();
      else if (sub === 'save') await cmdSessionSave();
      else if (sub === 'load') await cmdSessionLoad();
      else if (sub === 'restore') await cmdSessionRestore();
      else fail(`unknown session action: ${sub || '(none)'} — ${USAGE}`);
      break;
    case 'browse': await cmdBrowse(sub || rest[0]); break;
    case 'api': await cmdApi(sub, rest[0]); break;
    case 'apikey':
      if (sub === 'list') await cmdApikeyList();
      else if (sub === 'create') await cmdApikeyCreate(rest[0]);
      else fail(`unknown apikey action: ${sub || '(none)'} — ${USAGE}`);
      break;
    case 'mcp':
      if (sub === 'config') await cmdMcpConfig();
      else fail(`unknown mcp action: ${sub || '(none)'} — ${USAGE}`);
      break;
    case 'net':
      if (sub === 'list') await cmdNetList();
      else fail(`unknown net action: ${sub || '(none)'} — ${USAGE}`);
      break;
    case 'shot': await cmdShot(sub || rest[0]); break;
    default: fail(USAGE);
  }
} catch (e) {
  fail(e);
}
