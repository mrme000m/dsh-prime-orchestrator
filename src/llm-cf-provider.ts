/**
 * Register a {@link CfWorkersAiAdapter} for the `cf-workers-ai-native`
 * provider route on the host `ctx.llm` service, so the harness can call
 * Cloudflare Workers AI chat completions directly over fetch+SSE without the
 * pi-ai SDK layer. The plugin owns no state: the account id resolves from
 * config (falling back to the `CF_ACCOUNT_ID` env var) once at apply, and the
 * bearer token re-resolves through the host credential seam on every request,
 * so a rotated credential reaches the next call without a restart.
 *
 * @module dsh-prime-orchestrator/llm-cf-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  CfWorkersAiAdapter,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from './cf-llm/adapter.ts'
import type { CfCatalogModel } from './cf-llm/adapter.ts'

export {
  buildUrl,
  CfWorkersAiAdapter,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  mapHttpError,
  usageFromHeader,
} from './cf-llm/adapter.ts'
export type { CfCatalogModel, CfWorkersAiAdapterOptions } from './cf-llm/adapter.ts'
export { serializeMessages, serializeRequest } from './cf-llm/serialize.ts'
export { DONE, parseSse } from './cf-llm/sse.ts'
export { mapFinishReason, mapUsage, translate } from './cf-llm/translate.ts'
export type { ChatMessage, ChatRequest, ChatResponseChunk } from './cf-llm/types.ts'

export const name = 'llm-cf-provider'

/** Hard service dependencies: the host llm registry and the credential seam. */
export const inject = ['llm', 'credentials']

/** The single provider route this plugin owns. */
export const PROVIDER = 'cf-workers-ai-native'

/** Credential-reference env name resolved for the bearer token. */
const DEFAULT_TOKEN_ENV = 'CLOUDFLARE_AI_TOKEN'

/** Env var consulted when the config carries no account id. */
const ACCOUNT_ENV = 'CF_ACCOUNT_ID'

/**
 * Curated conservative catalog of Workers AI chat-completions models
 * (contextWindow/maxTokens in tokens; requests are not restricted to it —
 * catalog membership is advisory).
 */
export const DEFAULT_MODELS: readonly CfCatalogModel[] = [
  { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', contextWindow: 131072, maxTokens: 16384 },
  { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', contextWindow: 131072, maxTokens: 16384 },
  { id: '@cf/zai-org/glm-5.2', contextWindow: 262144, maxTokens: 16384 },
  { id: '@cf/zai-org/glm-5.3', contextWindow: 262144, maxTokens: 16384 },
  { id: '@cf/moonshotai/kimi-k2.7-code', contextWindow: 262144, maxTokens: 16384 },
  { id: '@cf/qwen/qwen3.8-27b', contextWindow: 262144, maxTokens: 16384 },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', contextWindow: 131072, maxTokens: 16384 },
]

/** Plugin config: account, credential reference, timeouts, catalog, retry policy. */
export interface Config {
  /** Cloudflare account id; falls back to the `CF_ACCOUNT_ID` env var. */
  accountId?: string
  /** Credential-reference env name holding the Workers AI API token. */
  tokenEnv?: string
  /** Per-request fetch timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /** Advisory model catalog; defaults to the curated list above. */
  models?: CfCatalogModel[]
}

const catalogModel: z<CfCatalogModel> = z.object({
  id: z.string().min(1).required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  accountId: z.string().min(1),
  tokenEnv: z.string().min(1).default(DEFAULT_TOKEN_ENV),
  timeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(DEFAULT_TIMEOUT_MS),
  streamIdleTimeoutMs: z.number().step(1).min(1_000).max(2_147_483_647).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  models: z.array(catalogModel).default([...DEFAULT_MODELS]),
})

/** Resolve the account id from config or the trusted environment, once. */
export function resolveAccountId(config: Config): string {
  const accountId = config.accountId ?? process.env[ACCOUNT_ENV]
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error(
      `llm-cf-provider: no Cloudflare account id — set the plugin config key "accountId" or the ${ACCOUNT_ENV} environment variable`,
    )
  }
  return accountId
}

/**
 * Register the Workers AI chat-completions adapter on the host `llm` service
 * under the {@link PROVIDER} route. The adapter is transport-only; connection
 * facts resolve here and the token re-resolves per request.
 * @param ctx - Cordis context carrying the host `llm` and `credentials` services.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const accountId = resolveAccountId(config)
  const tokenEnv = config.tokenEnv ?? DEFAULT_TOKEN_ENV
  const models = config.models !== undefined && config.models.length > 0
    ? config.models
    : [...DEFAULT_MODELS]

  // Per-request token resolution: a rotated credential reaches the next call.
  const resolveToken = async (): Promise<string> => {
    const resolved = await ctx.credentials.resolve(credentialRef(tokenEnv))
    if (resolved === undefined) {
      throw new LlmError(
        `llm-cf-provider: MISSING_CREDENTIAL — ${tokenEnv} is not set: store a Cloudflare Workers AI API token under the ${tokenEnv} credential reference`,
        'MISSING_CREDENTIAL',
      )
    }
    return resolved.value
  }

  const adapter = new CfWorkersAiAdapter({
    accountId,
    resolveToken,
    models,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-cf-provider: retryPolicy'),
  })

  // Registration is an effect: the returned disposer runs when this fiber
  // unloads, releasing the route cleanly.
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'llm-cf-provider: adapter registration')
}
