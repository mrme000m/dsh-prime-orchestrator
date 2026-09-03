/**
 * `CfWorkersAiAdapter`: fetch + SSE against the Cloudflare Workers AI
 * OpenAI-compatible chat-completions endpoint, emitting harness StreamChunks
 * on the host `llm` service without the pi-ai SDK layer. The adapter is
 * transport-only: the account id, token resolver, model catalog, and timeouts
 * arrive resolved through the registering plugin, which owns validation,
 * layering, and credential policy.
 *
 * @module dsh-prime-orchestrator/cf-llm/adapter
 */

import { attributionHeaders, LlmAdapter, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { serializeRequest } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { CfErrorEnvelope } from './types.ts'

/** Cloudflare API root for the Workers AI OpenAI-compatible route. */
export const API_BASE = 'https://api.cloudflare.com/client/v4'

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** One optional model entry advertised by the adapter. */
export interface CfCatalogModel {
  /** Wire model id accepted by the endpoint (e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`). */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
}

/** Validated connection facts the plugin resolves before construction. */
export interface CfWorkersAiAdapterOptions {
  /** Cloudflare account id the endpoint is scoped to. */
  accountId: string
  /**
   * Resolve the bearer token for one request. Called once per stream call and
   * never cached, so a rotated credential reaches the next request.
   */
  resolveToken: () => Promise<string>
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly CfCatalogModel[]
  /** Per-request timeout combining with the caller's signal. */
  timeoutMs: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Build the chat-completions endpoint URL for one account. */
export function buildUrl(accountId: string): string {
  return `${API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`
}

/** The first Cloudflare error entry of an envelope, when present. */
function firstCfError(envelope?: CfErrorEnvelope): { code?: number; message?: string } | undefined {
  return envelope?.errors?.find(entry => typeof entry === 'object' && entry !== null)
}

/** Provider-requested retry delay from a `retry-after` header, in milliseconds. */
export function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/**
 * Map an HTTP status (plus the Cloudflare error envelope when the body was
 * JSON) to a stable `LlmError` code: 401/403 → `AUTH`, 429 → `RATE_LIMIT`,
 * 408 or CF 3007/3008 → `TIMEOUT` (the class llm-retry can retry), CF 3036
 * (free neuron allocation exhausted) and 3040 (out of capacity) →
 * `RATE_LIMIT`, CF 5007 → `INVALID_REQUEST`, 400 → `INVALID_REQUEST`,
 * >=500 → `SERVER`, anything else `HTTP_{status}`.
 * @param status - HTTP status of the non-2xx provider response.
 * @param envelope - parsed Cloudflare error envelope, when available.
 * @param headers - response headers carrying retry-after/request id, when available.
 * @returns the ready-to-throw LlmError with status and provider facts attached.
 */
export function mapHttpError(status: number, envelope?: CfErrorEnvelope, headers?: Headers): LlmError {
  const first = firstCfError(envelope)
  const cfCode = typeof first?.code === 'number' ? first.code : undefined
  const cfMessage = typeof first?.message === 'string' && first.message.length > 0 ? first.message : undefined
  let code: string
  if (status === 401 || status === 403) {
    code = 'AUTH'
  } else if (status === 408 || cfCode === 3007 || cfCode === 3008) {
    code = 'TIMEOUT'
  } else if (status === 429 || cfCode === 3036 || cfCode === 3040) {
    code = 'RATE_LIMIT'
  } else if (status === 400 || cfCode === 5007) {
    code = 'INVALID_REQUEST'
  } else if (status >= 500) {
    code = 'SERVER'
  } else {
    code = `HTTP_${status}`
  }
  const cfPart = cfCode !== undefined ? ` (CF error ${cfCode})` : ''
  const messagePart = cfMessage !== undefined ? `: ${cfMessage}` : ''
  const message = `Workers AI chat completions error (HTTP ${status})${cfPart}${messagePart}`
  const delay = headers === undefined ? undefined : providerRetryAfterMs(headers.get('retry-after'))
  const ray = headers?.get('cf-ray') ?? headers?.get('x-request-id')
  const requestId = ray !== null && ray !== undefined && ray.length > 0 ? ProviderRequestId(ray) : undefined
  return new LlmError(message, code, {
    status,
    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
    ...requestId === undefined ? {} : { requestId },
  })
}

/** Parse the `cf-ai-usage` response header into a fallback TokenUsage, if present. */
export function usageFromHeader(value: string | null): TokenUsage | undefined {
  if (value === null || value.trim() === '') return undefined
  let prompt: number | undefined
  let completion: number | undefined
  for (const pair of value.split(',')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = pair.slice(0, eq).trim()
    const num = Number(pair.slice(eq + 1).trim())
    if (!Number.isFinite(num) || num < 0) continue
    if (key === 'prompt_tokens') prompt = num
    else if (key === 'completion_tokens') completion = num
  }
  if (prompt === undefined || completion === undefined) return undefined
  return { inputTokens: prompt, outputTokens: completion }
}

/** Combine the caller's cancellation, the consumer teardown, and the request timeout. */
function combinedSignal(caller: AbortSignal | undefined, consumer: AbortSignal, timeout: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return caller === undefined
      ? AbortSignal.any([consumer, timeout])
      : AbortSignal.any([caller, consumer, timeout])
  }
  return fallbackCombinedSignal(caller === undefined ? consumer : caller, timeout)
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
  a.addEventListener('abort', forward(a), { once: true })
  b.addEventListener('abort', forward(b), { once: true })
  return controller.signal
}

/**
 * Per-read stream idle watchdog: a timer re-armed on every body chunk; firing
 * records the expiry and aborts the consumer, so the outstanding read rejects
 * and the stream maps it to a TIMEOUT `LlmError`.
 */
interface IdleWatchdog {
  /** Reset the idle deadline after one transport read completed. */
  pulse(): void
  /** Whether the idle deadline fired. */
  timedOut(): boolean
  /** Stop the timer (idempotent). */
  dispose(): void
}

function idleWatchdog(ms: number, onExpire: () => void): IdleWatchdog {
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      expired = true
      onExpire()
    }, ms)
  }
  arm()
  return {
    pulse: arm,
    timedOut: () => expired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** Detached display metadata for one catalog entry. */
function modelInfo(provider: string, model: CfCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: ['text'],
  }
}

/**
 * The Workers AI chat-completions adapter registered on the host `llm`
 * service under the `cf-workers-ai-native` route. One instance serves every
 * model name it was registered under (the harness model name IS the wire
 * model name). One stable signal reaches both initial fetch and body reads;
 * caller aborts map to `ABORTED`, the request timeout and the per-read idle
 * watchdog map to `TIMEOUT`.
 */
export class CfWorkersAiAdapter extends LlmAdapter {
  constructor(private readonly config: CfWorkersAiAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Cloudflare Workers AI' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const configured = this.config.models.find(entry => entry.id === model)
    // The chat-completions wire route is text-only regardless of catalog
    // membership, so the uncatalogued fallback declares the same negative
    // capability — "unknown" here would let the host accept and persist
    // images the serializer must then reject.
    const base: LlmModelInfo = configured === undefined
      ? { provider, id: model, name: model, inputModalities: ['text'] }
      : modelInfo(provider, configured)
    return Promise.resolve({
      ...base,
      ...configured?.contextWindow === undefined ? {} : { context: { contextWindow: configured.contextWindow } },
      ...configured?.maxTokens === undefined ? {} : { defaultMaxTokens: configured.maxTokens },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { accountId, timeoutMs, streamIdleTimeoutMs } = this.config
    // One token resolution per stream call, never cached: a rotated
    // credential reaches the next request.
    const token = await this.config.resolveToken()
    const consumer = new AbortController()
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = combinedSignal(options.signal, consumer.signal, timeoutSignal)
    const watchdog = idleWatchdog(streamIdleTimeoutMs, () => {
      consumer.abort('Workers AI stream idle timeout')
    })
    let exhausted = false
    const iterator = this.request(options, signal, token, () => { watchdog.pulse() })[Symbol.asyncIterator]()
    try {
      while (true) {
        const result = await iterator.next()
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (watchdog.timedOut()) {
        throw new LlmError(
          `Workers AI stream idle timeout after ${streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (timeoutSignal.aborted) {
        throw new LlmError(
          `Workers AI request exceeded the ${timeoutMs}ms timeout`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Workers AI request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('Workers AI API stream failed', 'TRANSPORT', { cause: error })
    } finally {
      watchdog.dispose()
      consumer.abort('Workers AI stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns termination; a return-time
          // abort cannot add a second outcome.
        }
      }
    }
  }

  /** One dispatch: fetch, error mapping, and SSE translation under one signal. */
  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    token: string,
    pulse: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options)
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    let response: Response
    try {
      response = await fetch(buildUrl(this.config.accountId), {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation, request timeout,
      // and idle watchdog expiry; everything else is transport.
      if (signal.aborted) throw error
      throw new LlmError('Workers AI API request failed', 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let envelope: CfErrorEnvelope | undefined
      try {
        envelope = JSON.parse(text) as CfErrorEnvelope
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies
        // the failure, so a malformed body must not mask it (the empty-body
        // 408 timeout class is the documented case).
      }
      throw mapHttpError(response.status, envelope, response.headers)
    }
    if (response.body === null) {
      throw new LlmError('Workers AI API returned no response body', 'EMPTY_RESPONSE')
    }

    // Pulse the idle watchdog on every transport read (not just on yielded
    // chunks), so a provider that goes silent mid-stream cannot hang it.
    const pulsing = response.body.pipeThrough(new TransformStream<BufferSource, BufferSource>({
      transform(chunk, controller) {
        pulse()
        controller.enqueue(chunk)
      },
    }))
    yield* translate(
      parseSse(pulsing),
      usageFromHeader(response.headers.get('cf-ai-usage')),
    )
  }
}
