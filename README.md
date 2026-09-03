# dsh-prime-orchestrator

Prime Agent orchestration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), in one installable plugin package.

It turns a dsh agent into an orchestrator over [Prime Agent](https://pypi.org/project/prime-agent/) (the `prime-agent` CLI) sessions:

- **Host engine** (`ctx.prime`): the shared delegation table, one-shot CLI runs, the protocol-7 daemon socket client, the `/prime` JSON API, and the `prime-orchestrator` settings namespace.
- **Model-facing surface**: the `prime_agent` tool (delegate, monitor, steer, coordinate, set and manage persistent goals, heartbeats, prompt running sessions, read transcripts, inspect and manage recursive subagents, switch models mid-session, control queue and recursion depth, fork branches, export transcripts, and manage prime-agent sessions), the `prime-orchestrator:workflow` prompt section, and the bundled `prime-agent` skill.
- **Web UI**: the Prime fleet column (right side of the Web GUI, toggle at the sidebar foot) with live delegation/session/event streams, and the Settings → Prime Orchestration section. Drill into any running prime-agent session for its live transcript, a prompt box (text or slash commands), turn controls (abort, queue, goal, model switch), and the `prime-agent attach` command to take it over in a TUI — the web view and the TUI share the same daemon session.
- **Agent preset**: `prime-orchestrator` — the full coding agent plus the orchestration surface, derived from `standard`. Sessions can pick it from the preset picker.

## Install

Requires the `dsh` CLI (`@deepseek-ai/dsh`) on the host and the `prime-agent` CLI (`pip install prime-agent`) on PATH for the engine's `bin` (configurable).

```sh
# from npm (when published)
dsh plugin --profile web add dsh-prime-orchestrator

# from a git checkout (pnpm ≥10 builds it via the prepare script after you
# allowlist the build once — the failed install prints the exact remedy)
dsh plugin --profile web add github:mrme000m/dsh-prime-orchestrator
# if pnpm blocks the build: add to <profile>/pnpm-workspace.yaml, then re-run:
#   allowBuilds:
#     dsh-prime-orchestrator: true

# from a local checkout (ships the current lib/ as-is)
dsh plugin --profile web add ./path/to/dsh-prime-orchestrator
```

Then create a session with the **prime-orchestrator** preset (or set it as the default through Settings → Agent presets).

The preset is materialized into your user preset root (`$DSH_HOME/.agent-presets/prime-orchestrator/`) at startup:

- untouched → an updated package re-materializes it in place;
- edited by you → never overwritten again (delete the directory to re-materialize);
- the `Settings → Prime Orchestration` section and the `prime-orchestrator` settings namespace configure the engine (bin, stateDir, daemonSocket, maxDelegations, defaults for delegated sessions).

## Compatibility

| dsh | supported |
| --- | --- |
| 0.1.0-rc.7, 0.1.1-rc.2 (npm `latest`) | ✅ |
| 0.1.0-rc.5 and older | ❌ |
| 0.1.2-alpha (npm `alpha`) | ❌ — the client plugin API changed (`dsh-client-runtime` was removed); a port is planned |

The dsh-family packages are declared as peer dependencies with exact version chains, resolved at runtime from the running dsh installation (dsh materializes module-fallback links into `$DSH_HOME/profiles/node_modules`), so the plugin shares the host's module instances instead of installing duplicates.

## Package layout

One package, four mounted surfaces:

| Surface | Mount | Content |
| --- | --- | --- |
| `exports "."` | bundle row `prime-orchestration` (from `cordis.patch.yml`) | host engine + preset materialization |
| `exports "./agent-tool"` | preset composition row | `prime_agent` tool + prompt section + skill |
| `exports "./cf-tools"` | preset composition row | `cf_ai_run` + `cf_ai_models` Workers AI tools |
| `exports "./llm-cf-provider"` | bundle row `llm-cf-provider` (from `cordis.patch.yml`) | Workers AI LLM adapter on the host `llm` service |
| `exports "./client"` (`dsh.client`) | browser roster (scanned from mounted entries) | fleet column + settings section |

### The layout override

The fleet column needs a fourth shell column (the `prime` slot, live across session switches), which stock dsh layouts do not ship. The package carries `lib/layout-override.js` — the **stock** ui-layout bundle (0.1.1-rc.2 sources) plus the prime-column patch — and installs it at boot through two host-side pieces:

- an exact route `/prime/layout-override.js` serving the artifact;
- an index tap rewriting the boot manifest entry for `@deepseek-ai/dsh-client-ui-layout` to that URL.

The browser module system registers one factory per module id (a second registration throws), so redirecting the entry URL — never a second registration — is the supported way to replace one browser plugin's implementation. No file inside the dsh installation is touched; uninstalling the package restores the stock three-column shell on the next page load. A future dsh that ships its own `prime` slot keeps working: the rewrite only swaps entries whose URL still points at `/plugins/...`.

## Cloudflare Workers AI (cf-tools)

The preset's `cf-tools` row mounts `dsh-prime-orchestrator/cf-tools`, a second agent-plane entry giving the model direct access to the account's Cloudflare Workers AI REST API. It registers two tools (and nothing else):

- **`cf_ai_run`** — run one Workers AI model (`POST /accounts/{account}/ai/run/{model}`). `task` selects the input shape (text-generation, text-embeddings, image-generation, automatic-speech-recognition, text-to-speech, translation, summarization, image-to-text, text-classification, object-detection). JSON responses come back as parsed objects (text-generation `{ response, usage }`, embeddings `{ data, shape }`, other tasks their documented text fields). Binary outputs (images, audio) are written as `<model-slug>-<timestamp>.<ext>` into `outputDir` — relative to the session workspace, default the workspace root — and returned as `{ file, bytes, mediaType }`, so the model references the artifact path instead of raw bytes.
- **`cf_ai_models`** — list/search the account's model catalog (`GET /accounts/{account}/ai/models/search`) with `query`, `author`, and `taskType` filters plus a `limit` (default 50, max 100). Returns `{ count, models: [{ id, name, taskType, description }] }` with descriptions truncated; if the response envelope differs from the documented one, the raw `result` keys are surfaced in the output instead of failing.

Config keys (on the preset row):

| key | default | meaning |
| --- | --- | --- |
| `accountId` | `CF_ACCOUNT_ID` env var | Cloudflare account id (config wins; missing → clear error) |
| `tokenEnv` | `CLOUDFLARE_AI_TOKEN` | credential reference holding a Workers AI API token; resolved per request through the host `credentials` seam, never cached |
| `timeoutMs` | `120000` | per-request fetch timeout, combined with the tool call's cancellation signal |

Errors surface the HTTP status, the Cloudflare error code and message, and a stable reason per code: `5007` no such model, `3006` request too large, `3007`/`3008` timed out or aborted by the platform, `3036` free neuron allocation exhausted, `3040` out of capacity, `401`/`403` authentication, `429` rate limit (per-model limits: frontier models 20 req/min, text generation 300 req/min), `5xx` server error. Non-JSON error bodies fall back to status-only mapping (e.g. an empty-body `408` reads as a timeout).

**Model experience.** The model sees `cf_ai_run`/`cf_ai_models` as ordinary tools: JSON results verbatim, binary results as an artifact path (never raw bytes in the conversation), the model catalog as a compact markdown table, and all rendered output bounded to ~12k characters with a truncation marker. Every `cf_ai_run` call costs neurons against the account allocation — 10,000 per day on the free Workers plan; once exhausted, Cloudflare returns code `3036` until the window resets or the account upgrades to Workers Paid.

## Cloudflare Workers AI as a harness LLM provider (llm-cf-provider)

The bundle's second host row (`llm-cf-provider` in `cordis.patch.yml`) mounts `dsh-prime-orchestrator/llm-cf-provider`, a host-plane LLM adapter that registers on the host `llm` service under the provider route **`cf-workers-ai-native`**. It streams OpenAI-compatible chat completions directly from `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions` over `fetch` + SSE — no pi-ai SDK layer — and translates chunks into the harness `StreamChunk` protocol.

Config keys (on the host row):

| key | default | meaning |
| --- | --- | --- |
| `accountId` | `CF_ACCOUNT_ID` env var | Cloudflare account id (config wins; missing → clear error naming both) |
| `tokenEnv` | `CLOUDFLARE_AI_TOKEN` | credential reference holding a Workers AI API token; resolved per request through the host `credentials` seam, never cached |
| `timeoutMs` | `120000` | per-request timeout, combined with the caller's cancellation signal |
| `streamIdleTimeoutMs` | `300000` | maximum provider silence while one stream read is outstanding (per-read idle watchdog) |
| `retryPolicy` | normal defaults | provider-owned retry policy (`RetryPolicySchema` from dsh-llm) |
| `models` | curated catalog below | advisory model catalog (`{ id, name?, contextWindow?, maxTokens? }`) |

Default catalog (advisory; any Workers AI model id is routable): `@cf/deepseek-ai/deepseek-v4-flash-0731` and `@cf/deepseek-ai/deepseek-v4-pro-0813` (131072 context / 16384 output), `@cf/zai-org/glm-5.2`, `@cf/zai-org/glm-5.3`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/qwen/qwen3.8-27b` (262144 / 16384), and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (131072 / 16384).

Failures map to the stable harness `LlmError` codes: HTTP `401`/`403` or bad token → `AUTH`; `429`, CF `3036` (free neuron allocation exhausted — 10k/day on the free plan), and CF `3040` (out of capacity) → `RATE_LIMIT`; HTTP `408` and CF `3007`/`3008` (platform timeout/abort) → `TIMEOUT` — the class llm-retry treats as retryable; `400` and CF `5007` (no such model) → `INVALID_REQUEST`; `5xx` → `SERVER`. An empty body on `408` reads as `TIMEOUT`; a missing response body reads as `EMPTY_RESPONSE`; a truncated SSE stream (EOF before `[DONE]`) reads as `STREAM_CLOSED`. Status, `retry-after`, and the `cf-ray` request id are attached to the error where present.

**Model experience.** Streamed text, reasoning (DeepSeek V4 `reasoning_content` becomes a `reasoning` block), and tool calls (argument fragments concatenate into the raw JSON string end-to-end) all flow as incremental deltas; usage arrives before the terminal finish (from the trailing OpenAI usage chunk when present, otherwise from the `cf-ai-usage` response header); a degenerate empty completion surfaces as an `EMPTY_RESPONSE` error finish instead of a silent empty message; timeouts are retried by the harness retry layer via the `TIMEOUT` code.

## Development

```sh
pnpm install
pnpm run build      # lib/index.js, lib/agent-tool.js, lib/cf-tools.js, lib/llm-cf-provider.js, lib/client.js
pnpm run typecheck
```

- `src/` — host half (engine, agent tool, preset materializer).
- `client/` — browser half (`client/index.tsx` is the plugin entry; `fleet/` and `settings/` carry the UI).
- `presets/prime-orchestrator/` — the agent preset payload; `skills/prime-agent/` — the bundled skill.
- `tsdown.config.ts` — host ESM build (peers external) + browser CJS closure-factory build (CSS Modules compiled by lightningcss, module-table externals preserved).

## Migrating from a workspace-based deployment

If you previously mounted the Prime feature through hand-copied workspace
builds (`@deepseek-ai/dsh-prime-orchestration`, `@deepseek-ai/dsh-prime-agent-tool`,
`@deepseek-ai/dsh-client-ui-prime`, `@deepseek-ai/dsh-client-ui-prime-settings`):

1. Remove their rows from your profile's `cordis.patch.yml` and any `ui-prime` /
   `ui-prime-settings` rows patched into the stock web composition.
2. Remove their `link:` entries from the profile's `package.json`.
3. Delete the old `$DSH_HOME/.agent-presets/prime-orchestrator/` (if you never
   edited it) so this package materializes its own on the next boot.

## Uninstall

```sh
dsh plugin --profile web remove dsh-prime-orchestrator
```

A materialized preset the user never modified is removed with the package; an edited one is kept (delete `$DSH_HOME/.agent-presets/prime-orchestrator/` yourself).

## License

MIT
