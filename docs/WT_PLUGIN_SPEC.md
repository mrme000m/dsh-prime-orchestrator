# WunderTrading bdg plugin (wt) — design spec

## Objective

Give DSH agents full programmatic access to WunderTrading (wundertrading.com):
headful CloakBrowser login automation, session-cookie persistence in the
Bitwarden vault (keys.00m.indevs.in), the official REST API (HMAC) and MCP
server, plus bdg-driven web-UI automation for everything the REST API does
not cover (bot configuration, discovery, research, backtesting UI, exchange
management, API-key lifecycle).

Two parts in this repo:

- `bin/wt.mjs` — zero-dependency Node CLI engine (Node >= 22, node: builtins +
  global fetch only).
- `src/wt-tools.ts` — DSH plugin module registering model-facing tools + the
  `wt-network` skill, wired through `cordis.patch.yml` (host row) exactly like
  `bw-tools`.

## Verified live facts (2026-09-04, proven in a live session)

### Account + vault

- Account: mrme000.m0@gmail.com, Free plan. Dashboard landing after login:
  `https://wundertrading.com/en/trader/dashboard/traders`.
- Bitwarden vault: server https://keys.00m.indevs.in, user
  misterme00@icloud.com. Session key is resolved from env `BW_SESSION`
  (the DSH credential seam `~/.dsh/.credentials.yaml` ref `BW_SESSION`).
- Vault items (secure notes, `KEY=value` env lines in `notes`, same pattern as
  the existing `tvcli-primary-env` item):
  - `wundertrading-login`: WT_EMAIL, WT_PASSWORD, WT_LOGIN_URL
  - `wundertrading-session`: WT_PHPSESSID, WT_CF_CLEARANCE,
    WT_COOKIES_JSON (full cookie array), WT_SESSION_SAVED_AT (ISO),
    WT_SESSION_BASE
  - `wundertrading-api`: WT_API_KEY, WT_API_SECRET, WT_API_NAME,
    WT_API_CREATED, WT_API_EXPIRES, WT_API_PERMISSIONS, WT_API_BASE,
    WT_MCP_URL

### Browser stack (minimal-mjs workspace)

- Cloak dir: `/Volumes/ExMac/code/tradingview/minimal-mjs` (env
  `WT_CLOAK_DIR` overrides).
- `node launch.mjs` launches the headful stealth CloakBrowser Chromium, CDP on
  port 9222 (or next free up to 9321), profile dir `<cloakDir>/profile`
  (env `CB_PROFILE` overrides). NEVER pass `--headless` (see repo AGENTS.md).
- bdg CLI: `node <cloakDir>/bdg/dist/index.js …` — attach with
  `--chrome-ws-url "ws://127.0.0.1:PORT/devtools/page/<id>" --no-headless <url>`
  (backgrounds a daemon; `bdg status` shows ACTIVE + target URL; `bdg stop`
  detaches). Page-level WS required — browser-level fails.
- bdg quirks: JSON output envelope is `{version, success, data:{…}}` with node
  warning lines mixed into stdout — parse from the first `{` (balanced braces).
  `bdg cdp Page.captureScreenshot` is BLOCKED — use `bdg dom screenshot <path>`.
- Useful bdg commands: `cdp <Method> --params '<json>'`, `dom eval '<js>'`,
  `network list --json`, `dom screenshot [path]`, `stop`, `status`.

### Login flow (verified selectors)

1. Navigate `https://wundertrading.com/en/login` (title "Login — WunderTrading").
2. If visible, click the button matching /allow all cookies/i (cookie banner).
3. Form inputs: `input#email[name="_username"]`, `input#password[name="_password"]`,
   hidden `_csrf_token` (auto). Fill via the React-safe native setter:
   `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set`,
   then `focus()`, set, dispatch `input` + `change` (bubbles), `blur()`.
4. Click the visible button whose trimmed text matches /^login$/i.
5. Success: redirect to `/en/trader/dashboard/…`; the account menu contains the
   email. Failure: stays on /login (clean rejection; no bot flag observed with
   the stealth browser; no 2FA on this account).
6. Session cookie: `PHPSESSID` (httpOnly, secure, Lax, ~2-day expiry) on
   wundertrading.com; `cf_clearance` (Cloudflare, httpOnly, secure, sameSite
   None, ~1 year). Capture with
   `bdg cdp Network.getCookies --params '{"urls":["https://wundertrading.com/"]}'`;
   inject with `Network.setCookies` (round-trip the captured fields verbatim).

### REST API (HMAC) — VERIFIED WORKING

- Base: `https://wundertrading.com`, private paths under `/open_api/…`.
- Headers: `X-API-Key`, `X-Signature` (base64 HMAC-SHA256), `X-Timestamp`
  (unix ms), optional `X-Recv-Window` (ms).
- Payload string: `METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + RECV_WINDOW + "\n" + BODY`
  (PATH includes query string; empty body = empty string; RECV_WINDOW empty
  string when the header is omitted — verified 200 both ways).
- Endpoints (docs: https://wundertrading.com/docs):
  - GET /open_api/api_profiles?exchanges=BINANCE,… (verified 200)
  - GET /open_api/exchanges (verified 200: BINANCE, BINANCE_DELIVERY,
    BINANCE_FUTURES, BINGX, BINGX_SWAP, BITFINEX, BITGET, BITGET_SWAP,
    BITGET_SWAP_INVERSE, BITMEX, BLOFIN_FUTURES, …)
  - GET /open_api/markets, GET /open_api/strategies/live,
    GET /open_api/strategies/history, GET /open_api/strategies/{id},
    POST /open_api/strategies/trade,
    PUT /open_api/strategies/{id}/market-enter,
    POST /open_api/strategies/{id}/swing,
    PATCH /open_api/strategies/trade, DELETE /open_api/strategies/{id}/cancel,
    DELETE /open_api/strategies/{id}/market-close
  - Schemas: /docs/rest-api/schemas/{apiprofile,exchange,market,strategy,order,
    newstrategy,editclassicstrategy,editdcastrategy,profilestrategy}
- API key: HMAC key+secret pair, shown once at creation; without IP whitelist
  it expires after 3 months. Up to 10 keys per account.

### MCP server (official)

- URL: `https://wundertrading.com:2083/mcp`, headers `X-API-Key` +
  `X-Secret-Key` (the same API key + secret), HTTP transport.
- 14 tools: cancel_strategy, close_strategy_market, edit_trade_strategy,
  export_strategies_history, export_strategy_orders_history, get_api_profiles,
  get_exchange_markets, get_live_strategies, get_strategies_history,
  get_strategy, get_strategy_orders_history, get_supported_exchanges,
  place_strategy_market_enter, place_strategy_swing, place_strategy_trade.

### API-key creation flow (verified selectors, /en/trader/open_api)

1. Click button /create api keys/i → modal opens ("Create API Keys").
2. The modal's Name input is the FIRST VISIBLE `input[type=text]` (React
   auto-id like `:rr:` changes between renders — never target the id).
3. Permission checkboxes (API Profile: Read / Strategy: Read / Strategy:
   Write) default to all checked — leave them.
4. IPs textarea may stay empty (no whitelist → 3-month expiry).
5. Click the LAST visible button whose trimmed text matches /^create$/i
   (case-insensitive; "Create API Keys" must not match — anchor the regex).
6. A "Created API keys" modal shows `API Key\n<key>\nSecret Key\n<secret>` —
   extract both from `document.body.innerText` around the "Created API keys"
   index (shown ONLY ONCE).
7. Dismiss with the button /saved my keys/i.

### Web-UI routes worth knowing (dashboard, session-authenticated)

- /en/trader/dashboard/traders (landing), /en/trader/positions,
  /en/trader/my-exchanges, /en/trader/terminal, /en/trader/open_api,
  /en/trader/signal_bots, /en/trader/grid_bots, /en/trader/dca_bots,
  /en/trader/multi_pair_grid_bot, /en/trader/dashboard/market_neutral_bot,
  /en/trader/dashboard/bots, /en/trader/is-running-positions (XHR poll).
- Logged-out navigation to /en/trader/* redirects to /en/login — use this as
  the session check.

## bin/wt.mjs — CLI contract

Zero deps, `#!/usr/bin/env node`, ESM. Every command prints JSON (one line or
pretty; `--json` for machine output where relevant) and exits non-zero on
error. Shared helpers: `bwSession()` (env BW_SESSION → else parse
`~/.dsh/.credentials.yaml` `refs.BW_SESSION` → else null), `bwGetItemNotes(name)`
(`bw get item <name> --session <s>` → parse notes into KEY=value map),
`bwUpsertNote(name, notesEnv)` (list items to find the id; `bw edit item <id>`
with base64-encoded JSON — `bw create item <b64>` needs base64 of the full
template: type 2 + secureNote {type:0}), `findCdpPort()` (probe
9222..9321 `/json/version`), `pageWsUrl()` (pick the wundertrading.com page
from `/json`, else the first `page` target), `bdg(...args)` (spawn
`node <cloakDir>/bdg/dist/index.js …`), `ensureBrowser()`, `ensureBdg(url)`
(status → attach if needed; re-attach if target differs), `domEval(js)`
(balanced-brace JSON parse of bdg output), `wait(fn, timeoutMs)` polling.

Commands:

- `wt status [--json]` — {browser: {running, cdpPort, pageUrl}, bdg: {active,
  targetUrl}, session: {loggedIn (only when browser+bdg up), email},
  vault: {unlocked, items: {login, session, api}}, api: {keyPresent, baseUrl},
  mcpUrl}.
- `wt login [--email X] [--password Y]` — creds: flags > env WT_EMAIL/WT_PASSWORD
  > bw item wundertrading-login. Ensures browser + bdg, runs the verified login
  flow, verifies landing on /en/trader/, captures cookies, upserts
  wundertrading-session, prints {ok, email, savedAt, cookies: n}.
- `wt session check` — navigate /en/trader/open_api; loggedIn = final URL does
  NOT contain "/login". Prints {loggedIn, url, email (from account menu when
  available)}.
- `wt session save` — browser cookies → bw wundertrading-session.
- `wt session load` — bw item → `Network.setCookies` (round-trip captured
  fields) into the running browser (must be on a wundertrading.com page or
  about:blank; cookies are domain-scoped so any page works, then navigate).
- `wt session restore` — load + check; if still not logged in, report (caller
  decides to `wt login`).
- `wt browse [url]` — ensure browser + bdg + session (load cookies if missing
  when a session item exists; navigate to url or dashboard); prints
  {cdp, pageWs, url, loggedIn}.
- `wt api <METHOD> <PATH> [--body '<json>'] [--recv N]` — HMAC call; creds:
  env WT_API_KEY/WT_API_SECRET > bw wundertrading-api. Prints status + body.
- `wt apikey list` — UI scrape of /en/trader/open_api table: [{name, keyMasked,
  ip, expiresAt, permissions}]. Requires session.
- `wt apikey create <name> [--permissions "API Profile: Read,Strategy: Read,Strategy: Write"]`
  — verified creation flow; captures key+secret; upserts wundertrading-api;
  prints {name, apiKey, apiSecret, expiresAt} (full values — this is the
  machine layer; the DSH tool masks).
- `wt mcp config [--mask]` — prints the MCP client JSON configs (cursor +
  vscode shapes) using the API key; `--mask` replaces the secret with ***.
- `wt net list [--filter <re>]` — bdg network list, compact
  [{method, status, url}].
- `wt shot [path]` — `bdg dom screenshot` (default shots/wt-<ts>.png).

Env: WT_CLOAK_DIR (default the minimal-mjs path above), WT_EMAIL/WT_PASSWORD,
WT_API_KEY/WT_API_SECRET, BW_SESSION, WT_BW_LOGIN_ITEM / WT_BW_SESSION_ITEM /
WT_BW_API_ITEM (defaults wundertrading-login/-session/-api), WT_BASE_URL
(default https://wundertrading.com), CB_PROFILE (browser profile dir).

## src/wt-tools.ts — tool module contract

Mirror `src/bw-tools.ts` structure exactly (name `wt-tools`, inject
`['tools', 'credentials', 'skills']`, Config via schemastery, execFile the CLI
`node <cliPath>` with env BW_SESSION from `credentialRef('BW_SESSION')`).
Default cliPath: `join(dirname(fileURLToPath(import.meta.url)), '..', 'bin',
'wt.mjs')`. Config keys: cliPath, cloakDir (WT_CLOAK_DIR for the child env),
sessionEnv (default BW_SESSION), timeoutMs (default 120000 — login takes ~40s).

Tools (all JSON output, bounded render like bw-tools):

- `wt_status` {} → `wt status --json`
- `wt_session` {action: check|save|load|restore} → mapped CLI call
- `wt_login` {} → `wt login` (creds come from vault/env; never args)
- `wt_browse` {url?} → `wt browse [url]`
- `wt_api` {method, path, body?, recv?} → `wt api …` (validate method ∈
  GET/POST/PUT/PATCH/DELETE, path starts with /)
- `wt_apikey` {action: list|create, name?} → masked output for create (replace
  secret with ***, note the vault item), full for list
- `wt_mcp` {} → `wt mcp config --mask`

Also register the bundled skill (`ctx.skills.register`): name `wt-network`,
path `../skills/wt-network/SKILL.md` relative to the module
(resourceBase directory), description + whenToUse mirroring the tv-network
skill's voice: "Investigate and operate WunderTrading via the wt CLI (bdg +
CloakBrowser headful sessions, Bitwarden-persisted cookies, HMAC REST API,
official MCP server)…".

## Wire-up checklist

1. `tsdown.config.ts`: add `'wt-tools': 'src/wt-tools.ts'` to the host entry map
   (beside `'bw-tools': 'src/bw-tools.ts'`).
2. `package.json`: exports `"./wt-tools"` (types + default like bw-tools);
   files: `lib/wt-tools.js`, `lib/wt-tools.js.map`, `lib/wt-tools.d.ts`,
   `bin/wt.mjs`.
3. `cordis.patch.yml`: add host row after the bw-tools row:
   `- id: wt-tools` / `name: 'dsh-prime-orchestrator/wt-tools'` with a short
   comment.
4. `skills/wt-network/SKILL.md`: the agent manual (see below).
5. `tests/wt-tools.test.mjs`: unit tests for argument validation exports
   (mirror tests/bw-tools.test.mjs style) — makeStatusArgs/makeSessionArgs/
   makeApiArgs/makeApikeyArgs/makeBrowseArgs/maskSecret.
6. Build: `pnpm build` (or `npm run build`) must pass; `node --test` green.

## skills/wt-network/SKILL.md — contents

Front-matter style matching skills/prime-agent/SKILL.md (check its exact
format). Sections: purpose + when to use; the three access surfaces (bdg
web-session automation, HMAC REST, MCP) and when to pick which; the wt CLI
command cookbook; verified live facts from this spec (selectors, cookie names,
endpoints, routes, gotchas); extension patterns (adding a new UI flow; adding
a REST endpoint wrapper); security rules (never print secrets; the vault is
the only secret store; mask in tool output).
