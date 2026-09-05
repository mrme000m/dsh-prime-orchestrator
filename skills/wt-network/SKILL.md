---
name: "wt-network"
description: "Investigate and operate WunderTrading (wundertrading.com) via the wt CLI and the wt_* tools: bdg-driven headful CloakBrowser web sessions, session cookies persisted in the Bitwarden vault, the HMAC-signed REST API under /open_api, and the official MCP server. Use for login/session recovery, bot and exchange research, API-key lifecycle, and any dashboard flow the REST API does not cover."
version: 1
created: "2026-09-04"
updated: "2026-09-04"
---
## When to Use
Use when operating WunderTrading: checking why a session died, re-logging in, scraping dashboard pages (bots, positions, exchanges, terminal, backtesting UI), calling the REST API, managing API keys, or wiring the official MCP server. Prefer the `wt_*` tools (`wt_status`, `wt_session`, `wt_login`, `wt_browse`, `wt_api`, `wt_apikey`, `wt_mcp`) — they resolve the Bitwarden session credential through the host seam. Use this skill when you need the raw CLI, verified selectors, or the gotchas below.

## Three Access Surfaces — Which to Pick

| Surface | Use when | Auth |
|---|---|---|
| **Web UI via bdg** (headful CloakBrowser) | Anything the REST API lacks: bot configuration, discovery/research, backtesting UI, exchange management, API-key creation | Session cookies (`PHPSESSID` + `cf_clearance`) |
| **REST API** (HMAC, `/open_api/…`) | Strategies live/history, place/patch/cancel trades, market-enter, swing, market-close, api_profiles, exchanges, markets | API key + secret (`X-API-Key`, `X-Signature`, `X-Timestamp`) |
| **MCP server** (`https://wundertrading.com:2083/mcp`) | The 14 official tools (get_live_strategies, place_strategy_trade, edit_trade_strategy, cancel_strategy, …) from an MCP client | Same API key + secret (`X-API-Key`, `X-Secret-Key` headers) |

Rule of thumb: REST/MCP for anything they expose; bdg web automation for everything else; `wt session check` / `wt login` to keep the web surface alive.

## wt CLI Cookbook

The CLI is `bin/wt.mjs` in the dsh-prime-orchestrator package (zero deps, Node ≥ 22). The `wt_*` tools spawn it with `BW_SESSION` (credential seam) and `WT_CLOAK_DIR` already set; run it manually only for flows the tools do not cover (`wt net list`, `wt shot`).

```bash
export WT_CLOAK_DIR=/Volumes/ExMac/code/tradingview/minimal-mjs   # default; override per machine
node bin/wt.mjs status --json            # browser/bdg/session/vault/api/mcp state — run first

# Session lifecycle
node bin/wt.mjs session check            # {loggedIn, url, email}
node bin/wt.mjs session restore           # load vault cookies + check
node bin/wt.mjs login                     # headful login (~40s), saves cookies to vault
node bin/wt.mjs session save              # browser cookies → vault

# Browser + web UI
node bin/wt.mjs browse https://wundertrading.com/en/trader/positions
node bin/wt.mjs net list --filter strategies   # bdg network log, compact
node bin/wt.mjs shot                      # screenshot → shots/wt-<ts>.png

# REST API (HMAC; creds from env WT_API_KEY/WT_API_SECRET or vault wundertrading-api)
node bin/wt.mjs api GET /open_api/strategies/live
node bin/wt.mjs api GET '/open_api/api_profiles?exchanges=BINANCE'
node bin/wt.mjs api POST /open_api/strategies/trade --body '{"strategy_id":123,"price":"auto","amount":"0.001"}' --recv 5000

# API keys
node bin/wt.mjs apikey list
node bin/wt.mjs apikey create my-bot-key   # full key+secret printed ONCE, then upserted to vault

# MCP config (masked)
node bin/wt.mjs mcp config --mask
```

Raw bdg (when driving the UI directly): `node $WT_CLOAK_DIR/bdg/dist/index.js status|stop`, `dom eval '<js>'`, `cdp <Method> --params '<json>'`, `network list --json`, `dom screenshot <path>`.

## Verified Live Facts (2026-09-04, live session)

### Browser stack
- `node launch.mjs` (in the cloak dir) starts the headful stealth CloakBrowser Chromium; CDP on 9222 or the next free port up to 9321; profile at `<cloakDir>/profile` (`CB_PROFILE` overrides). **NEVER pass `--headless`** — see that repo's AGENTS.md.
- bdg attaches with `--chrome-ws-url "ws://127.0.0.1:PORT/devtools/page/<id>" --no-headless <url>` — page-level WS required; browser-level fails. `bdg status` → ACTIVE + target URL; `bdg stop` detaches.

### Login flow (verified selectors)
1. Navigate `https://wundertrading.com/en/login` (title "Login — WunderTrading").
2. Cookie banner: click the button matching `/allow all cookies/i` if visible.
3. Fill `input#email[name="_username"]` and `input#password[name="_password"]` via the React-safe native setter (`Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set`), then `focus()`, set, dispatch `input` + `change` (bubbles), `blur()`. Hidden `_csrf_token` is automatic.
4. Click the visible button whose trimmed text matches `/^login$/i`.
5. Success: redirect to `/en/trader/dashboard/…`; account menu shows the email. Failure: stays on /login. No 2FA on this account; no bot flag observed with the stealth browser.

### Session cookies
- `PHPSESSID` — httpOnly, secure, Lax, ~2-day expiry. `cf_clearance` — Cloudflare, httpOnly, secure, sameSite None, ~1 year.
- Capture: `bdg cdp Network.getCookies --params '{"urls":["https://wundertrading.com/"]}'`; inject: `Network.setCookies` with the captured fields verbatim.
- Vault item `wundertrading-session` holds `WT_PHPSESSID`, `WT_CF_CLEARANCE`, `WT_COOKIES_JSON` (full cookie array), `WT_SESSION_SAVED_AT`, `WT_SESSION_BASE`.

### Dashboard routes (session-authenticated)
`/en/trader/dashboard/traders` (landing), `/en/trader/positions`, `/en/trader/my-exchanges`, `/en/trader/terminal`, `/en/trader/open_api`, `/en/trader/signal_bots`, `/en/trader/grid_bots`, `/en/trader/dca_bots`, `/en/trader/multi_pair_grid_bot`, `/en/trader/dashboard/market_neutral_bot`, `/en/trader/dashboard/bots`. Logged-out navigation to `/en/trader/*` redirects to `/en/login` — that redirect is the session check.

### REST API (HMAC)
- Base `https://wundertrading.com`, private paths under `/open_api/…`. Docs: https://wundertrading.com/docs.
- Headers: `X-API-Key`, `X-Signature` (base64 HMAC-SHA256), `X-Timestamp` (unix ms), optional `X-Recv-Window` (ms).
- Payload string: `METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + RECV_WINDOW + "\n" + BODY` — PATH includes the query string, empty body = empty string, RECV_WINDOW = empty string when the header is omitted (verified 200 both ways).
- Endpoints: `GET /open_api/api_profiles?exchanges=…`, `GET /open_api/exchanges`, `GET /open_api/markets`, `GET /open_api/strategies/live`, `GET /open_api/strategies/history`, `GET /open_api/strategies/{id}`, `POST /open_api/strategies/trade`, `PUT /open_api/strategies/{id}/market-enter`, `POST /open_api/strategies/{id}/swing`, `PATCH /open_api/strategies/trade`, `DELETE /open_api/strategies/{id}/cancel`, `DELETE /open_api/strategies/{id}/market-close`.
- Schemas: `/docs/rest-api/schemas/{apiprofile,exchange,market,strategy,order,newstrategy,editclassicstrategy,editdcastrategy,profilestrategy}`.
- Verified exchanges (GET /open_api/exchanges): BINANCE, BINANCE_DELIVERY, BINANCE_FUTURES, BINGX, BINGX_SWAP, BITFINEX, BITGET, BITGET_SWAP, BITGET_SWAP_INVERSE, BITMEX, BLOFIN_FUTURES, …

### API-key creation (verified selectors, /en/trader/open_api)
1. Click the button matching `/create api keys/i` → "Create API Keys" modal.
2. The modal's Name input is the FIRST VISIBLE `input[type=text]` — React auto-ids like `:rr:` change between renders; never target the id.
3. Permission checkboxes (API Profile: Read / Strategy: Read / Strategy: Write) default all-checked — leave them.
4. Leave the IPs textarea empty (no whitelist → 3-month expiry; up to 10 keys per account).
5. Click the LAST visible button whose trimmed text matches `/^create$/i` (anchor the regex so "Create API Keys" does not match).
6. The "Created API keys" modal shows `API Key\n<key>\nSecret Key\n<secret>` — extract both from `document.body.innerText` around the "Created API keys" index. **Shown ONLY ONCE.**
7. Dismiss with the button matching `/saved my keys/i`.

### MCP server
`https://wundertrading.com:2083/mcp`, HTTP transport, headers `X-API-Key` + `X-Secret-Key`. 14 tools: cancel_strategy, close_strategy_market, edit_trade_strategy, export_strategies_history, export_strategy_orders_history, get_api_profiles, get_exchange_markets, get_live_strategies, get_strategies_history, get_strategy, get_strategy_orders_history, get_supported_exchanges, place_strategy_market_enter, place_strategy_swing, place_strategy_trade.

## Gotchas
- **bdg JSON envelope**: output is `{version, success, data:{…}}` with Node warning lines mixed into stdout — parse from the first `{` with balanced braces.
- **`bdg cdp Page.captureScreenshot` is BLOCKED** — use `bdg dom screenshot <path>`.
- React inputs need the native-setter fill (see login flow step 3); plain `input.value = …` does not stick.
- Never pass `--headless` to the stealth Chromium.
- Bitwarden `bw create item <b64>` / `bw edit item <id>` need **base64-encoded JSON** (`bw create item` = base64 of the full template: type 2 + `secureNote {type:0}`).
- PHPSESSID dies after ~2 days — check before long UI flows; `wt session restore` then `wt login` if dead.

## Extension Patterns
- **Adding a new UI flow**: `wt browse` to the route, discover selectors with `bdg dom eval` (e.g. `[...document.querySelectorAll('button')].map(b => b.innerText.trim())`), drive with the verified-fill pattern, then promote the flow into `bin/wt.mjs` as a subcommand and (if model-facing) a tool in `src/wt-tools.ts`.
- **Wrapping a new REST endpoint**: check `/docs` for the path + schema, then `wt api METHOD /open_api/… --body …` directly — no code change needed; only add a dedicated tool if the model needs guidance or output massaging.

## Security Rules
- The Bitwarden vault (server https://keys.00m.indevs.in) is the ONLY secret store: `wundertrading-login`, `wundertrading-session`, `wundertrading-api`. Never write credentials to disk, env files, or chat.
- Never print secrets (passwords, `PHPSESSID`, `cf_clearance`, API secret) in full. Tool output masks them; the raw values live in the vault items. The API secret is shown exactly once at creation — capture straight into the vault.
