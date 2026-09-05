/**
 * Model-facing Cloudflare Workers AI tools over the REST API.
 *
 * This plugin contributes two model-facing tools: `cf_ai_run` (run one
 * Workers AI model) and `cf_ai_models` (list/search the account's model
 * catalog). It owns no state: every call resolves the account id and the
 * bearer token per request — the token through the host credential seam
 * (`ctx.credentials`), so a rotated credential reaches the next call without
 * a restart — and talks to `https://api.cloudflare.com/client/v4` with the
 * global `fetch` of the dsh host process.
 * @module dsh-prime-orchestrator/cf-tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const name = 'cf-tools'

/** Hard service dependencies: the tool registry and the credential seam. */
export const inject = ['tools', 'credentials']

/** Workers AI REST API root. */
const API_BASE = 'https://api.cloudflare.com/client/v4'

/** Credential-reference env name resolved for the bearer token. */
const DEFAULT_TOKEN_ENV = 'CLOUDFLARE_AI_TOKEN'

/** Env var consulted when the config carries no account id. */
const ACCOUNT_ENV = 'CF_ACCOUNT_ID'

/** Default per-request fetch timeout. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Bound for rendered text blocks, like the agent tool's `renderJson`. */
const RENDER_CHAR_LIMIT = 12_000

/** Per-row description truncation in `cf_ai_models` results. */
const MODEL_DESCRIPTION_LIMIT = 120

/** Cloudflare caps `/ai/models/search` at 100 rows per page. */
const MODELS_PAGE_MAX = 100

/** Default and maximum row count for `cf_ai_models`. */
const MODELS_LIMIT_DEFAULT = 50

/** Retry configuration for transient failures. */
interface RetryConfig {
  /** Maximum number of retry attempts. */
  maxRetries: number
  /** Initial delay in milliseconds. */
  initialDelayMs: number
  /** Maximum delay in milliseconds. */
  maxDelayMs: number
  /** Exponential backoff multiplier. */
  backoffMultiplier: number
  /** Jitter ratio (0-1). */
  jitterRatio: number
}

/** Default retry config: 3 retries, 5s initial delay, 60s max, exponential backoff. */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
  jitterRatio: 0.1,
}

/** HTTP status codes that are retryable. */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

/** Cloudflare error codes that are retryable. */
const RETRYABLE_CF_CODES = new Set([3007, 3008, 3036, 3040])

/** Check if an error is retryable based on status and CF error code. */
function isRetryableError(status: number, cfCode: number | undefined): boolean {
  if (RETRYABLE_STATUS_CODES.has(status)) return true
  if (cfCode !== undefined && RETRYABLE_CF_CODES.has(cfCode)) return true
  return false
}

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Execute a fetch with retry logic for transient failures. */
async function fetchWithRetry<T>(
  fetchFn: () => Promise<Response>,
  parseFn: (res: Response) => Promise<T>,
  tool: string,
  endpoint: string,
  timeoutMs: number,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  errorContext: Pick<CfErrorContext, 'model'> = {},
): Promise<T> {
  let lastError: Error | undefined
  let delay = retryConfig.initialDelayMs
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    let res: Response
    try {
      res = await fetchFn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Network errors (timeout, abort) are retryable
      if (attempt < retryConfig.maxRetries) {
        await sleep(delay)
        delay = Math.min(
          delay * retryConfig.backoffMultiplier * (1 + Math.random() * retryConfig.jitterRatio),
          retryConfig.maxDelayMs,
        )
        continue
      }
      throw wrapNetworkError(err, tool, endpoint, timeoutMs)
    }

    if (res.ok) {
      return parseFn(res)
    }

    // Read error body for CF error code
    const text = await res.text()
    let envelope: unknown
    try {
      envelope = JSON.parse(text)
    } catch {
      envelope = undefined
    }
    const cfCode = isRecord(envelope) && Array.isArray(envelope.errors)
      ? envelope.errors.find((e): e is Record<string, unknown> => isRecord(e))?.code as number | undefined
      : undefined

    lastError = mapCfError(res.status, envelopeErrors(envelope), { tool, endpoint, ...errorContext })

    if (attempt < retryConfig.maxRetries && isRetryableError(res.status, cfCode)) {
      await sleep(delay)
      delay = Math.min(
        delay * retryConfig.backoffMultiplier * (1 + Math.random() * retryConfig.jitterRatio),
        retryConfig.maxDelayMs,
      )
      continue
    }

    throw lastError
  }

  throw lastError ?? new Error(`${tool} ${endpoint}: failed after ${retryConfig.maxRetries} retries`)
}

/** The task types Workers AI routes models by. */
const CF_TASKS = [
  'text-generation', 'text-embeddings', 'image-generation',
  'automatic-speech-recognition', 'text-to-speech', 'translation',
  'summarization', 'image-to-text', 'text-classification', 'object-detection',
] as const

/** One Workers AI task type. */
type CfTask = typeof CF_TASKS[number]

/**
 * Model id grammar: at least `vendor/name` segments of `[A-Za-z0-9._-]`,
 * optionally leading `@` (e.g. `@cf/meta/llama-3.1-8b-instruct`). Rejects
 * path tricks before the id is placed into a URL path.
 */
const MODEL_ID_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/

/** Plugin config: account, credential reference, and request timeout. */
export interface Config {
  /** Cloudflare account id; falls back to the `CF_ACCOUNT_ID` env var. */
  accountId?: string
  /** Credential-reference env name holding the Workers AI API token. */
  tokenEnv?: string
  /** Per-request fetch timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  accountId: z.string().min(1),
  tokenEnv: z.string().min(1).default(DEFAULT_TOKEN_ENV),
  timeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(DEFAULT_TIMEOUT_MS),
})

/** Typed view of the `cf_ai_run` tool's parameter object. */
interface CfAiRunArgs {
  model: string
  task: CfTask
  input: Record<string, unknown>
  outputDir?: string
}

/** Typed view of the `cf_ai_models` tool's parameter object. */
interface CfAiModelsArgs {
  query?: string
  author?: string
  taskType?: string
  limit?: number
}

/** Where an error occurred, for `mapCfError` message assembly. */
export interface CfErrorContext {
  /** Tool name for the message prefix. */
  readonly tool: string
  /** Full request URL the failure is about. */
  readonly endpoint: string
  /** Model id, when the request named one. */
  readonly model?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bound one text with the shared ellipsis marker. */
function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text
}

/** Truncate one string in place (no marker; used for row descriptions). */
function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Encode one path piece, preserving `/` segment separators. */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

/** Build the `POST /accounts/{accountId}/ai/run/{model}` endpoint URL. */
export function buildRunUrl(accountId: string, model: string): string {
  return `${API_BASE}/accounts/${encodePath(accountId)}/ai/run/${encodePath(model)}`
}

/** Query params `GET /ai/models/search` accepts; only provided ones are sent. */
export interface ModelsSearchParams {
  /** Free-text filter. */
  query?: string
  /** Author/publisher filter, e.g. `deepseek-ai`. */
  author?: string
  /** Task-type filter (`task_type` on the wire). */
  taskType?: string
  /** Page size; capped at 100. */
  perPage?: number
  /** 1-based page number. */
  page?: number
}

/** Build the `GET /accounts/{accountId}/ai/models/search` endpoint URL. */
export function buildModelsUrl(accountId: string, params: ModelsSearchParams = {}): string {
  const url = new URL(`${API_BASE}/accounts/${encodePath(accountId)}/ai/models/search`)
  const search: Array<[string, string]> = []
  if (params.query !== undefined) search.push(['query', params.query])
  if (params.author !== undefined) search.push(['author', params.author])
  if (params.taskType !== undefined) search.push(['task_type', params.taskType])
  if (params.perPage !== undefined) search.push(['per_page', String(Math.min(params.perPage, MODELS_PAGE_MAX))])
  if (params.page !== undefined) search.push(['page', String(params.page)])
  url.search = new URLSearchParams(search).toString()
  return url.toString()
}

/**
 * Map one Cloudflare failure to a stable, readable `Error` naming the HTTP
 * status, the CF error code/message when present, and a task-specific reason.
 * @param status - HTTP status of the response.
 * @param errors - the envelope's `errors` array, when the body was JSON.
 * @param context - tool name, endpoint URL, and model for the message.
 */
export function mapCfError(
  status: number,
  errors: readonly unknown[] | undefined,
  context: CfErrorContext,
): Error {
  const first = errors?.find((entry): entry is Record<string, unknown> => isRecord(entry))
  const code = typeof first?.code === 'number' ? first.code : undefined
  const cfMessage = typeof first?.message === 'string' && first.message.trim() !== ''
    ? first.message.trim()
    : undefined

  let reason: string
  if (code === 5007) {
    reason = context.model !== undefined
      ? `no such model: ${context.model} is not available on Workers AI`
      : 'no such model'
  } else if (code === 3006) {
    reason = 'request too large for the Workers AI endpoint'
  } else if (code === 3007 || code === 3008) {
    reason = 'the request timed out / was aborted by the platform'
  } else if (code === 3036) {
    reason = 'free neuron allocation exhausted (10k/day); upgrade to Workers Paid'
  } else if (code === 3040) {
    reason = 'Workers AI is out of capacity for this model; retry later'
  } else if (status === 401 || status === 403) {
    reason = 'authentication failed: check the Workers AI API token (the configured tokenEnv credential reference) and its account access'
  } else if (status === 408) {
    reason = 'the request timed out'
  } else if (status === 429) {
    reason = 'rate limited (per-model limits: frontier models 20 req/min, text generation 300 req/min); wait and retry'
  } else if (status >= 500) {
    reason = 'Cloudflare server error'
  } else {
    reason = 'request failed'
  }

  const codePart = code !== undefined ? ` (CF error ${code})` : ''
  const messagePart = cfMessage !== undefined ? `: ${cfMessage}` : ''
  return new Error(`${context.tool} ${context.endpoint}: HTTP ${status}${codePart}${messagePart} — ${reason}`)
}

/** Per-task input shapes, kept next to the `input` parameter description. */
const INPUT_DESCRIPTION = 'Run input object, shaped per task: '
  + 'text-generation `{ messages: [{ role, content }] }`; '
  + 'text-embeddings `{ text: string | string[] }`; '
  + 'image-generation `{ prompt, num_steps?, guidance? }`; '
  + 'automatic-speech-recognition `{ audio: number[] }` (Uint8Array as a byte array); '
  + 'text-to-speech `{ text }`; translation `{ text, source_lang, target_lang }`; '
  + 'summarization `{ input_text, max_length? }`; image-to-text `{ image: number[] }` (byte array); '
  + 'text-classification `{ text }`; object-detection `{ image: number[] }` (byte array).'

const RUN_DESCRIPTION = 'Run one Cloudflare Workers AI model via the REST API '
  + '(POST /accounts/{account}/ai/run/{model}). Use cf_ai_models first to find model ids. '
  + 'JSON responses are returned as parsed objects (text-generation: `{ response, usage }`; '
  + 'text-embeddings: `{ data, shape }`; other tasks: their documented text fields). '
  + 'Binary responses (images, audio) are written to a file named `<model-slug>-<timestamp>.<ext>` '
  + 'and returned as `{ file, bytes, mediaType }` — reference the artifact path instead of the bytes. '
  + 'Costs neurons against the account allocation (10k/day on the free plan).'

const MODELS_DESCRIPTION = 'List or search the Workers AI models available to the account '
  + '(GET /accounts/{account}/ai/models/search). Returns `{ count, models: [{ id, name, taskType, description }] }` '
  + 'with descriptions truncated. Filter with query/author/taskType; cap rows with limit.'

/** Filesystem slug for one model id (e.g. `@cf/x/y` → `cf-x-y`). */
function modelSlug(model: string): string {
  const slug = model.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'model' : slug
}

/** Extension for one binary media type. */
function binaryExtension(mediaType: string): string {
  const sub = mediaType.split('/')[1] ?? ''
  const clean = sub.replace(/[^a-z0-9]/gi, '')
  return clean !== '' ? clean : 'bin'
}

/** Whether a response content type is a binary Workers AI output. */
function isBinaryMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/') || mediaType.startsWith('audio/')
}

/**
 * Signal combining the caller's cancellation with the request timeout.
 * `AbortSignal.any` exists on every supported engine (Node >= 20.3);
 * the manual fallback keeps older runtimes correct.
 */
function requestSignal(exec: { signal: AbortSignal }, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([exec.signal, timeout])
  return fallbackCombinedSignal(exec.signal, timeout)
}

/** Pre-`AbortSignal.any` fallback: forward whichever signal aborts first. */
function fallbackCombinedSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (a.aborted) {
    controller.abort(a.reason)
    return controller.signal
  }
  if (b.aborted) {
    controller.abort(b.reason)
    return controller.signal
  }
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason)
  const onA = forward(a)
  const onB = forward(b)
  a.addEventListener('abort', onA, { once: true })
  b.addEventListener('abort', onB, { once: true })
  return controller.signal
}

/** Session workspace root: the agent session's cwd, else the process cwd. */
function workspaceRoot(exec: { agent?: { session: { header: { cwd?: string } } } }): string {
  return exec.agent?.session.header.cwd ?? process.cwd()
}

/** Wrap one fetch-phase failure as an endpoint-naming `Error`. */
function wrapNetworkError(err: unknown, tool: string, endpoint: string, timeoutMs: number): Error {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') {
      return new Error(`${tool} ${endpoint}: request timed out after ${timeoutMs}ms`)
    }
    if (err.name === 'AbortError') {
      return new Error(`${tool} ${endpoint}: request aborted`)
    }
    return new Error(`${tool} ${endpoint}: network request failed: ${err.message}`, { cause: err })
  }
  return new Error(`${tool} ${endpoint}: network request failed`, { cause: err })
}

/** Extract the `errors` array from a parsed error envelope, if any. */
function envelopeErrors(body: unknown): unknown[] | undefined {
  return isRecord(body) && Array.isArray(body.errors) ? body.errors : undefined
}

/** Pure model rendering of one `cf_ai_run` result: key facts plus artifact path. */
export function renderRunResult(args: { model?: string; task?: string }, value: unknown): ContentBlock[] {
  const lines: string[] = [`cf_ai_run ${args.model ?? '?'} (${args.task ?? '?'}): succeeded`]
  if (isRecord(value)) {
    if (typeof value.file === 'string') {
      const bytes = typeof value.bytes === 'number' ? value.bytes : 0
      const mediaType = typeof value.mediaType === 'string' ? value.mediaType : 'unknown media type'
      lines.push(`artifact: ${value.file} (${bytes} bytes, ${mediaType})`)
    }
    if (typeof value.response === 'string' && value.response.length > 0) {
      const excerpt = value.response.length > 500 ? `${value.response.slice(0, 500)}…` : value.response
      lines.push(`response: ${excerpt}`)
    }
    if (Array.isArray(value.data)) {
      const shape = Array.isArray(value.shape) ? `, shape [${value.shape.join(', ')}]` : ''
      lines.push(`embeddings: ${value.data.length} vector(s)${shape}`)
    }
    if (isRecord(value.usage)) {
      const { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } = value.usage
      if (typeof prompt === 'number' && typeof completion === 'number' && typeof total === 'number') {
        lines.push(`usage: prompt ${prompt}, completion ${completion}, total ${total} tokens`)
      }
    }
  }
  return [{ type: 'text', text: bounded(lines.join('\n'), RENDER_CHAR_LIMIT) }]
}

/** Markdown-table cell text: pipe-escaped, newline-flattened. */
function cell(value: unknown): string {
  const raw = typeof value === 'string' ? value
    : value === undefined || value === null || typeof value === 'object' ? ''
      : String(value)
  return raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Pure model rendering of one `cf_ai_models` result: a compact table. */
export function renderModelsResult(_args: unknown, value: unknown): ContentBlock[] {
  const rows = isRecord(value) && Array.isArray(value.models) ? value.models : []
  const count = isRecord(value) && typeof value.count === 'number' ? value.count : rows.length
  const lines = [
    `cf_ai_models: ${count} model(s)`,
    '',
    '| id | name | taskType | description |',
    '| --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    if (isRecord(row)) {
      lines.push(`| ${cell(row.id)} | ${cell(row.name)} | ${cell(row.taskType)} | ${cell(row.description)} |`)
    }
  }
  return [{ type: 'text', text: bounded(lines.join('\n'), RENDER_CHAR_LIMIT) }]
}

/** Strict `cf_ai_run` argument validation, before any network I/O. */
function validateRunArgs(args: unknown): CfAiRunArgs {
  if (!isRecord(args)) {
    throw new Error('cf_ai_run: arguments must be an object')
  }
  if (typeof args.model !== 'string' || args.model.trim() === '') {
    throw new Error('cf_ai_run: "model" is required and must be a non-empty string (e.g. "@cf/meta/llama-3.1-8b-instruct")')
  }
  if (!MODEL_ID_PATTERN.test(args.model)) {
    throw new Error(`cf_ai_run: "model" must look like a Workers AI model id such as "@cf/meta/llama-3.1-8b-instruct" (got ${JSON.stringify(args.model)})`)
  }
  if (typeof args.task !== 'string' || !(CF_TASKS as readonly string[]).includes(args.task)) {
    throw new Error(`cf_ai_run: "task" must be one of: ${CF_TASKS.join(', ')}`)
  }
  if (!isRecord(args.input)) {
    throw new Error(`cf_ai_run: "input" is required and must be an object shaped for the ${args.task} task (see the parameter description)`)
  }
  if (args.outputDir !== undefined && (typeof args.outputDir !== 'string' || args.outputDir.trim() === '')) {
    throw new Error('cf_ai_run: "outputDir" must be a non-empty directory path relative to the session workspace')
  }
  return {
    model: args.model,
    // Enum membership checked above.
    task: args.task as CfTask,
    // Narrowed by the isRecord check above.
    input: args.input as Record<string, unknown>,
    outputDir: args.outputDir,
  }
}

/** Strict `cf_ai_models` argument validation, before any network I/O. */
function validateModelsArgs(args: unknown): CfAiModelsArgs {
  if (!isRecord(args)) {
    throw new Error('cf_ai_models: arguments must be an object')
  }
  for (const key of ['query', 'author', 'taskType'] as const) {
    const value = args[key]
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`cf_ai_models: "${key}" must be a non-empty string when provided`)
    }
  }
  if (args.taskType !== undefined && (typeof args.taskType !== 'string' || !(CF_TASKS as readonly string[]).includes(args.taskType))) {
    throw new Error(`cf_ai_models: "taskType" must be one of: ${CF_TASKS.join(', ')}`)
  }
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error('cf_ai_models: "limit" must be a positive integer')
  }
  return {
    // Each field was type-checked above; the casts only recover the checked types.
    query: args.query as string | undefined,
    author: args.author as string | undefined,
    taskType: args.taskType as CfTask | undefined,
    limit: args.limit as number | undefined,
  }
}

/**
 * Register the two model-facing Workers AI tools. Both resolve the host
 * `tools` and `credentials` services and hold no state of their own.
 * @param ctx - Cordis context carrying the host services.
 * @param config - resolved config (account id, token env, timeout).
 */
export function apply(ctx: Context, config: Config): void {
  const tokenEnv = config.tokenEnv ?? DEFAULT_TOKEN_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const resolveAccount = (): string => {
    const accountId = config.accountId ?? process.env[ACCOUNT_ENV]
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      throw new Error(`cf-tools: no Cloudflare account id — set the plugin config key "accountId" or the ${ACCOUNT_ENV} environment variable`)
    }
    return accountId
  }

  // Per-request resolution: a changed credential reaches the next call.
  const resolveToken = async (): Promise<string> => {
    const resolved = await ctx.credentials.resolve(credentialRef(tokenEnv))
    if (resolved === undefined) {
      throw new Error(`cf-tools: MISSING_CREDENTIAL — ${tokenEnv} is not set: store a Cloudflare Workers AI API token under the ${tokenEnv} credential reference`)
    }
    return resolved.value
  }

  ctx.tools.register(defineTool({
    name: 'cf_ai_run',
    description: RUN_DESCRIPTION,
    parameters: {
      model: { type: 'string', required: true, description: 'Workers AI model id, e.g. "@cf/meta/llama-3.1-8b-instruct". Find ids with cf_ai_models.' },
      task: { type: 'string', required: true, enum: CF_TASKS, description: 'The task type; must match the model\'s task_type from cf_ai_models.' },
      input: { type: 'json', required: true, description: INPUT_DESCRIPTION },
      outputDir: { type: 'string', description: 'Directory relative to the session workspace where binary outputs (images/audio) are written; default: the session workspace root.' },
    },
    output: {
      schema: { type: 'json' },
      render: renderRunResult,
    },
    async execute(args, exec) {
      const a = validateRunArgs(args)
      const accountId = resolveAccount()
      const token = await resolveToken()
      const endpoint = buildRunUrl(accountId, a.model)

      const result = await fetchWithRetry(
        async () => {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(a.input),
            signal: requestSignal(exec, timeoutMs),
          })
          return res
        },
        async (res) => {
          const mediaType = (res.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
          if (isBinaryMediaType(mediaType)) {
            const bytes = new Uint8Array(await res.arrayBuffer())
            const root = workspaceRoot(exec)
            const dir = a.outputDir !== undefined ? resolvePath(root, a.outputDir) : root
            await mkdir(dir, { recursive: true })
            const file = join(dir, `${modelSlug(a.model)}-${Date.now()}.${binaryExtension(mediaType)}`)
            await writeFile(file, bytes)
            return { file, bytes: bytes.byteLength, mediaType } as JsonValue
          }

          const text = await res.text()
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            return { mediaType, text: bounded(text, 2_000) } as JsonValue
          }
          if (isRecord(parsed) && parsed.success === false) {
            throw mapCfError(res.status, envelopeErrors(parsed), { tool: 'cf_ai_run', endpoint, model: a.model })
          }
          // Workers AI wraps the model output in `result` for successful run calls;
          // unwrap so the model sees the documented task shapes ({ response },
          // { data, shape }, …). Envelopes without an object result pass through.
          if (isRecord(parsed) && isRecord(parsed.result)) {
            return parsed.result as JsonValue
          }
          // JSON.parse output is by construction JSON-serializable.
          return parsed as JsonValue
        },
        'cf_ai_run',
        endpoint,
        timeoutMs,
        DEFAULT_RETRY_CONFIG,
        { model: a.model },
      )

      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cf_ai_models',
    description: MODELS_DESCRIPTION,
    parameters: {
      query: { type: 'string', description: 'Free-text filter over model ids, names, and descriptions.' },
      author: { type: 'string', description: 'Filter by author/publisher, e.g. "deepseek-ai", "zai-org", "baai".' },
      taskType: { type: 'string', enum: CF_TASKS, description: 'Filter by task type (same list as cf_ai_run).' },
      limit: { type: 'integer', description: 'Maximum model rows to return (default 50, capped at 100).' },
    },
    output: {
      schema: { type: 'json' },
      render: renderModelsResult,
    },
    async execute(args, exec) {
      const a = validateModelsArgs(args)
      const limit = Math.min(a.limit ?? MODELS_LIMIT_DEFAULT, MODELS_PAGE_MAX)
      const accountId = resolveAccount()
      const token = await resolveToken()
      const endpoint = buildModelsUrl(accountId, { query: a.query, author: a.author, taskType: a.taskType, perPage: limit })

      const result = await fetchWithRetry(
        async () => {
          return fetch(endpoint, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
            signal: requestSignal(exec, timeoutMs),
          })
        },
        async (res) => {
          const text = await res.text()
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            throw mapCfError(res.status, undefined, { tool: 'cf_ai_models', endpoint })
          }
          if (!res.ok || (isRecord(parsed) && parsed.success === false)) {
            throw mapCfError(res.status, envelopeErrors(parsed), { tool: 'cf_ai_models', endpoint })
          }

          const result = isRecord(parsed) ? parsed.result : undefined
          let rows: unknown[]
          let note: string | undefined
          if (isRecord(result) && Array.isArray(result.models)) {
            rows = result.models
          } else if (Array.isArray(result)) {
            rows = result
          } else {
            rows = []
            note = `unexpected response envelope: result keys ${JSON.stringify(isRecord(result) ? Object.keys(result) : typeof result)}`
          }
          const models = rows.filter(isRecord).slice(0, limit).map((row) => ({
            id: typeof row.id === 'string' ? row.id : '',
            name: typeof row.name === 'string' ? row.name : '',
            taskType: typeof row.task_type === 'string' ? row.task_type : typeof row.taskType === 'string' ? row.taskType : '',
            description: truncate(typeof row.description === 'string' ? row.description : '', MODEL_DESCRIPTION_LIMIT),
          }))
          return { count: models.length, models, ...(note !== undefined ? { note } : {}) } as JsonValue
        },
        'cf_ai_models',
        endpoint,
        timeoutMs,
      )

      return result
    },
  }))
}
