# DSH × Cloudflare Workers AI: 408 diagnosis, model catalog, plugin design

Scope: why the harness shows `This turn failed 408 status code (no body)`, the current
Cloudflare Workers AI model catalog, and a concrete plan for a DSH plugin that uses
Workers AI as a first-class model provider and the rest of the Cloudflare platform
(AI Gateway, Vectorize, R2, KV, D1, Queues) as agent capabilities.

## 1. The 408 failure — root cause

### 1.1 Where the message comes from (certain)

`408 status code (no body)` is the exact output of the Anthropic SDK's
`APIError.makeMessage(status, error, message)`:

```ts
if (status && msg) return `${status} ${msg}`
if (status) return `${status} status code (no body)`   // 408 + empty body → this string
```

The harness ships this SDK inside pi-ai (`@earendil-works/pi-ai/dist/api/anthropic-messages.js`
imports `@anthropic-ai/sdk`), so a turn that failed through the pi-ai
`anthropic-messages` protocol (Claude-format endpoint, e.g. Cloudflare AI Gateway's
Anthropic-compatible path) surfaces exactly this string. The OpenAI-completions path
uses the OpenAI SDK and would render differently (`Error code: 408 - …`), so the
message string proves the failing request went through an Anthropic-messages route.
Current `~/.dsh/settings.yaml` has no `api: anthropic-messages` route (all CF routes
use `openai-completions`), so the failing turn predates the current config or ran
against a Claude-format gateway route that was later removed.

### 1.2 Why Cloudflare answers 408 (verified against CF docs)

Cloudflare's Workers AI error table maps HTTP 408 to two internal codes:

| Name | Internal code | HTTP | Meaning |
| --- | --- | --- | --- |
| Timeout | `3007` | `408` | Request timeout |
| Aborted | `3008` | `408` | Request was aborted |

`Timeout` fires when the inference exceeds the platform limit — long cold starts of
large frontier models, huge prompt context, or very large `max_tokens` output caps.
`Aborted` fires when the client connection drops mid-request (user stop, harness
idle watchdog, network loss). Both come back with an empty body, which is why the
SDK renders "no body". AI Gateway adds a second 408 source: a configurable request
timeout (`cf-aig-request-timeout`, measured to the first response byte) that cuts
requests whose provider does not start answering in time; streaming keeps the
connection alive only while chunks keep arriving.

The previous default route (`cf-workers-deepseek` /
`@cf/deepseek-ai/deepseek-v4-flash-0731` with `contextWindow: 1000000`,
`maxTokens: 256000`) invited the Timeout case: a 1M-context request with a 256K
output cap was exactly the kind of long inference Cloudflare cuts. The
`cf-workers-ai-native` route (this bundle's `llm-cf-provider`) now defaults
delegations to `@cf/zai-org/glm-5.3-flash` (1,310,720 ctx / 16,384 out) — the
large context stays, but the conservative 16K output cap avoids the long-inference
timeout. The duplicate `cloudflare-workers-ai` pi-ai profile caps the same model
at 131072/16384 and is the safer pi-ai profile.

### 1.3 Immediate mitigations (no code)

- Consolidate the two duplicate CF provider profiles in `settings.yaml`
  (`cf-workers-deepseek` and `cloudflare-workers-ai` point at the same baseURL).
- Use the conservative caps (contextWindow 131072, maxTokens 16384) for CF-hosted
  DeepSeek until the account's real limits are known; raise only what a turn needs.
- Stream every chat call (SSE). pi-ai `transport` supports `sse`/`auto`; the gateway
  timeout is measured to the first byte, so streaming changes what counts as progress.
- Route through an AI Gateway and set `cf-aig-request-timeout` + `cf-aig-max-attempts`
  (up to 5) + `cf-aig-backoff` on the provider profile's `headers`; the gateway then
  retries Timeout/Aborted instead of the harness seeing a bare 408.
- Set sane `timeoutMs` / `streamIdleTimeoutMs` (default 300 s) and a `retryPolicy`
  that retries 408/5xx with backoff on the pi-ai profile.
- Watch the 20 req/min frontier-model limit (kimi-k2.6, kimi-k2.7-code, glm-5.2
  standard billing; 50 req/min with prepaid AI Gateway credits) — that surfaces as
  429, not 408, but it is the usual agentic-workload ceiling.

### 1.4 Proposed `settings.yaml` hardening (review, then apply)

Under `llm-pi-ai.providers.cf-workers-deepseek` (keep the route name — it is the
agent default), replace the loose caps and add transport hardening. `cf-aig-*`
headers are honored by the Workers AI OpenAI-compatible endpoint and by AI Gateway;
`retryPolicy` is a harness-level retry (llm-retry) that turns the 408 class into a
retried `TIMEOUT`.

```yaml
llm-pi-ai:
  providers:
    cf-workers-deepseek:
      displayName: Cloudflare Workers AI
      apiKeyEnv: CLOUDFLARE_AI_TOKEN
      api: openai-completions
      baseURL: https://api.cloudflare.com/client/v4/accounts/72d6e3279eb70c619d8a0ea4b908475f/ai/v1
      transport: sse            # first-byte progress, never full-completion waits
      timeoutMs: 180000
      streamIdleTimeoutMs: 300000
      headers:
        cf-aig-request-timeout: "180000"   # gateway/edge timeout (ms)
        cf-aig-max-attempts: "3"
        cf-aig-retry-delay: "1000"
        cf-aig-backoff: exponential
      retryPolicy:
        mode: normal
        maxRetries: 3
        retryableCodes: [TIMEOUT, SERVER, RATE_LIMIT, TRANSPORT]
        backoff:
          initialDelayMs: 1000
          maxDelayMs: 60000
          jitterRatio: 0.1
      models:
        - id: "@cf/deepseek-ai/deepseek-v4-flash-0731"
          name: CF Workers AI / DeepSeek V4 Flash 0731
          contextWindow: 1310720
          maxTokens: 16384
        - id: "@cf/deepseek-ai/deepseek-v4-pro-0813"
          name: CF Workers AI / DeepSeek V4 Pro 0813
          contextWindow: 1048576
          maxTokens: 16384
        # … keep the other @cf models with conservative caps
```

Then delete the duplicate `cloudflare-workers-ai` profile (same baseURL, unused by
the default route) once the UI model picker no longer needs it. `retryableCodes`
uses the harness's stable failure codes (llm-retry `RetryPolicyConfig`:
`mode` required, `maxRetries`, `retryableCodes`, `backoff`). One nuance: pi-ai's
`classifyPiAiError` does not recognize a bare "408 status code (no body)" message
(no `timeout`/`5xx` token), so that class currently lands on `PI_AI_ERROR` and
would NOT be retried unless `PI_AI_ERROR` is added to `retryableCodes` or the
classifier learns 408; the `cf-aig-max-attempts` gateway retries cover it
edge-side regardless.

## 2. Workers AI model catalog (CF-hosted `@cf/*`, verified 2026-09)

81 first-party models run on Cloudflare's own GPU fleet. Workers AI also serves
`@hf/*` models hosted by Hugging Face and proxied by Cloudflare; only `@cf/*` are
Cloudflare-hosted. Source: developers.cloudflare.com/workers-ai/models/ (fetched this
session).

### Text generation (chat/instruction) — 36

`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` · `@cf/deepseek-ai/deepseek-v4-flash-0731`
· `@cf/deepseek-ai/deepseek-v4-pro-0813` · `@cf/zai-org/glm-4.7-flash` ·
`@cf/zai-org/glm-5.2` · `@cf/zai-org/glm-5.3-flash` ·
`@cf/moonshotai/kimi-k2.5` · `@cf/moonshotai/kimi-k2.6` · `@cf/moonshotai/kimi-k2.7-code`
· `@cf/qwen/qwen2.5-coder-32b-instruct` · `@cf/qwen/qwen3-30b-a3b-fp8` ·
`@cf/qwen/qwen3.8-27b` · `@cf/qwen/qwq-32b` · `@cf/google/gemma-2b-it-lora` ·
`@cf/google/gemma-3-12b-it` · `@cf/google/gemma-4-26b-a4b-it` ·
`@cf/aisingapore/gemma-sea-lion-v4-27b-it` · `@cf/meta-llama/llama-2-7b-chat-hf-lora`
· `@cf/meta/llama-2-7b-chat-fp16` · `@cf/meta/llama-2-7b-chat-int8` ·
`@cf/meta/llama-3-8b-instruct` · `@cf/meta/llama-3-8b-instruct-awq` ·
`@cf/meta/llama-3.1-70b-instruct` · `@cf/meta/llama-3.1-8b-instruct` ·
`@cf/meta/llama-3.1-8b-instruct-awq` · `@cf/meta/llama-3.1-8b-instruct-fast` ·
`@cf/meta/llama-3.1-8b-instruct-fp8` · `@cf/meta/llama-3.2-1b-instruct` ·
`@cf/meta/llama-3.2-3b-instruct` · `@cf/meta/llama-3.3-70b-instruct-fp8-fast` ·
`@cf/meta/llama-4-scout-17b-16e-instruct` · `@cf/meta/llama-guard-3-8b` ·
`@cf/mistral/mistral-7b-instruct-v0.1` · `@cf/mistral/mistral-7b-instruct-v0.2-lora`
· `@cf/mistralai/mistral-small-3.1-24b-instruct` · `@cf/openai/gpt-oss-120b` ·
`@cf/openai/gpt-oss-20b` · `@cf/nvidia/nemotron-3-120b-a12b` ·
`@cf/microsoft/phi-2` · `@cf/ibm-granite/granite-4.0-h-micro` ·
`@cf/defog/sqlcoder-7b-2`

### Vision / image-to-text — 5

`@cf/llava-hf/llava-1.5-7b-hf` · `@cf/moondream/moondream3.1-9b-a2b` ·
`@cf/unum/uform-gen2-qwen-500m` · `@cf/facebook/detr-resnet-50` (object detection)
· `@cf/microsoft/resnet-50` (image classification)

### Embeddings + rerank — 7

`@cf/baai/bge-base-en-v1.5` · `@cf/baai/bge-large-en-v1.5` · `@cf/baai/bge-m3` ·
`@cf/baai/bge-small-en-v1.5` · `@cf/baai/bge-reranker-base` ·
`@cf/google/embeddinggemma-300m` · `@cf/qwen/qwen3-embedding-0.6b` ·
`@cf/pfnet/plamo-embedding-1b`

### Image generation — 9

`@cf/black-forest-labs/flux-1-schnell` · `@cf/black-forest-labs/flux-2-dev` ·
`@cf/black-forest-labs/flux-2-klein-4b` · `@cf/black-forest-labs/flux-2-klein-9b` ·
`@cf/bytedance/stable-diffusion-xl-lightning` · `@cf/stabilityai/stable-diffusion-xl-base-1.0`
· `@cf/runwayml/stable-diffusion-v1-5-img2img` · `@cf/runwayml/stable-diffusion-v1-5-inpainting`
· `@cf/lykon/dreamshaper-8-lcm` · `@cf/leonardo/lucid-origin` · `@cf/leonardo/phoenix-1.0`

### Speech (ASR + TTS) — 9

`@cf/openai/whisper` · `@cf/openai/whisper-large-v3-turbo` · `@cf/openai/whisper-tiny-en`
· `@cf/deepgram/aura-1` · `@cf/deepgram/aura-2-en` · `@cf/deepgram/aura-2-es` ·
`@cf/deepgram/flux` · `@cf/myshell-ai/melotts` · `@cf/pipecat-ai/smart-turn-v2`

### Translation / summarization / classification — 5

`@cf/meta/m2m100-1.2b` · `@cf/ai4bharat/indictrans2-en-indic-1b` ·
`@cf/facebook/bart-large-cnn` · `@cf/huggingface/distilbert-sst-2-int8`

Rate limits (per task): text generation 300 req/min; embeddings 3000 req/min
(bge-large-en 1500); ASR 720; image 720; summarization 1500; frontier models
(kimi-k2.6, kimi-k2.7-code, glm-5.2) 20 req/min standard / 50 with prepaid AI
Gateway credits.

## 3. Plugin design

Two tracks, per the harness capability-seam conventions (Service Definition /
Provider / Consumer; registrations are effects; model-visible ⟺ logged).

### Track A — first-class provider: `llm-cf-provider` (bundle-hosted adapter)

Decision (2026-09-02): implement the adapter INSIDE this bundle as a host row
(`dsh-prime-orchestrator/llm-cf-provider`), not as a DSH-repo package. The user's
runtime is the global `@deepseek-ai/dsh` install; an in-repo package would not
reach the running harness until the global is rebuilt. The bundle already depends
on `@deepseek-ai/dsh-llm`, so it can register an adapter on the host `llm` service
directly.

Clone the `packages/llm/llm-deepseek` reference layout (read the installed
`node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts` for the authoritative
`LlmAdapter`/`StreamChunk`/`GenerateOptions`/`attributionHeaders` contract), pointed
at the Workers AI OpenAI-compatible endpoint
`https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1`:

- `adapter.ts` — `CfWorkersAiAdapter extends LlmAdapter`; fetch + SSE against
  `/chat/completions`; honors `options.signal`; maps 408/3007/3008→`TIMEOUT`,
  5xx→`SERVER`, 429→`RATE_LIMIT`, 401/403→`AUTH`, 400→`INVALID_REQUEST` (stable
  LlmError codes so llm-retry retries the 408 class); stream idle watchdog;
  `attributionHeaders()` on every wire request.
- `serialize.ts` — OpenAI-compatible request body (messages, stream, max_tokens,
  temperature, tools); thinking/effort mapping for DeepSeek V4 reasoning models.
- `sse.ts` — SSE framing (eventsource-parser), `[DONE]` terminator, trailing usage.
- `translate.ts` — StreamChunk translation per the harness protocol: usage before
  finish, raw JSON tool-call argument strings, reasoning deltas in first-seen order.
- `types.ts` — wire types incl. the CF error envelope `{success, errors:[{code,
  message}]}` and `cf-ai-usage` response headers (tokens + neurons).
- Registration: host row in `cordis.patch.yml`; `ctx.llm.registerAdapter(
  ['cf-workers-ai-native'], adapter)` in `apply()`; Config: `accountId`, `tokenEnv`
  (default `CLOUDFLARE_AI_TOKEN`), model catalog with per-model contextWindow/
  maxTokens, `timeoutMs`, `streamIdleTimeoutMs`, `retryPolicy`. Route name is
  distinct from pi-ai's (`cf-workers-deepseek`/`cloudflare-workers-ai`) so both
  can coexist; switch `agent-default-model` to `provider: cf-workers-ai-native`
  to use the native path.

### Track A — first-class provider: `llm-cf-workers-ai` (in-repo package)

Superseded by the bundle-hosted variant above; kept for reference. The in-repo
package would follow the same layout as a DSH-repo workspace package
(`packages/llm/llm-cf-workers-ai`) for a future upstream contribution; the user's
runtime does not consume repo packages until the global dsh install is rebuilt.

Why the adapter at all: today CF rides the pi-ai adapter, whose SDK layers flatten
transport detail and whose error taxonomy loses the CF internal codes; a
first-class adapter gives the harness stable codes (TIMEOUT vs SERVER vs
RATE_LIMIT), correct neuron/token usage, and direct retry control — the 408 class
becomes a retried `TIMEOUT` instead of a terminal `PI_AI_ERROR`.

### Track B — user-level capability plugin: `cf-capability` (in this repo)

A host-side plugin that gives the agent tools over the rest of Cloudflare via the
REST API (all `POST/GET https://api.cloudflare.com/client/v4/accounts/{id}/…` with
`Authorization: Bearer $CLOUDFLARE_AI_TOKEN`):

- `cf_ai_run` — Workers AI REST run for non-chat tasks: embeddings (bge-m3 /
  qwen3-embedding), image gen (flux-2), transcription (whisper), TTS (aura-2),
  translation (m2m100), vision (llava/moondream), summarization (bart). This is the
  tool surface that makes the 29 non-chat models useful to the agent.
- `cf_ai_models` — list/search available models + neuron costs (GET
  `/ai/models/search`) for budget-aware selection.
- `cf_vectorize` — insert/query embeddings (`/vectorize/indexes/{index}/insert|query`)
  for RAG; a candidate backing store for the harness's long-term memory instead of
  local-only persistence.
- `cf_kv` / `cf_r2` / `cf_d1` — KV values (`/storage/kv/namespaces/{ns}/values/{key}`)
  for fast session metadata, R2 (S3-compatible) for session archives/artifacts/
  checkpoints, D1 (`/d1/database/{id}/query`) for a SQLite mirror of session logs.
- `cf_gateway` — AI Gateway management: point the LLM route at
  `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/workers-ai`, set
  `cf-aig-request-timeout`, `cf-aig-max-attempts`, `cf-aig-retry-delay`,
  `cf-aig-backoff`, `cf-aig-cache`/`cf-aig-cache-ttl` for prompt caching, and read
  gateway logs/analytics. This is the single highest-value change: caching cuts
  neuron cost, retries absorb the 408 class, and logs give per-request visibility.
- Model routing: a per-task selector (flash for chat, glm-5.x for reasoning,
  kimi-k2.7-code for code, qwen3-embedding for embeddings) with neuron-budget
  tracking, mounted as the agent's default-model provider.

Mounting: host composition row (Service Definition + Provider) plus tool consumers;
every registration is an effect with a disposer; every model-visible input logs a
session event; the plugin keeps a `./invariant` installer. Queues/Workflows are
Workers-side only and are out of scope for a host plugin (they need a deployed
Worker; the plugin can call a deployed Worker's HTTP endpoint instead).

## 4. Suggested order of work

1. Apply the §1.3 settings mitigations (no code) and confirm 408 stops recurring.
2. Track B minimal: `cf_ai_run` + `cf_ai_models` tools in this repo (fastest value).
3. Track A: `llm-cf-workers-ai` adapter package in the DSH repo (needs repo PR).
4. AI Gateway route + caching; then Vectorize/R2/D1 tool surfaces as needed.