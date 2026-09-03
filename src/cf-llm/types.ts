/**
 * Cloudflare Workers AI chat-completions wire format (OpenAI-compatible),
 * spoken through `POST /client/v4/accounts/{accountId}/ai/v1/chat/completions`.
 * Types only. Facts verified live 2026-09-02: streaming responses are SSE
 * `data:` chunks with the OpenAI delta shape and a `[DONE]` terminator;
 * non-stream responses wrap the payload in `{ result: {...} }`; failures use
 * the Cloudflare envelope `{ success: false, errors: [{ code, message }] }`.
 * DeepSeek-V4-family models expose `delta.reasoning_content` in streams.
 *
 * @module dsh-prime-orchestrator/cf-llm/types
 */

/** Request body for the OpenAI-compatible chat-completions route. */
export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream: true
  tools?: ChatTool[]
  temperature?: number
  max_tokens?: number
}

/** System-role message: a single string of instructions. */
export interface ChatSystemMessage {
  role: 'system'
  content: string
}

/** User-role message: a single string of user input. */
export interface ChatUserMessage {
  role: 'user'
  content: string
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface ChatToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/**
 * Assistant-role history message. Text-less turns carry `content: ""` (never
 * null — the Workers AI route rejects null-content assistant messages).
 */
export interface ChatAssistantMessage {
  role: 'assistant'
  content: string
  /** Reasoning replay (DeepSeek V4 reasoning models honor it). */
  reasoning_content?: string
  tool_calls?: ChatToolCall[]
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type ChatMessage =
  | ChatSystemMessage
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatToolMessage

/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface ChatTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface ChatResponseChunk {
  choices?: ChatChoice[]
  /** Arrives as a trailing usage-only chunk before `[DONE]`. */
  usage?: ChatUsage | null
}

/** One streamed choice; `finish_reason` is non-null only on its terminal chunk. */
export interface ChatChoice {
  delta?: ChatDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface ChatDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /** DeepSeek-V4-family reasoning channel on Workers AI. */
  reasoning_content?: string | null
  tool_calls?: ChatToolCallDelta[]
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface ChatToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Present on the first delta of each call only. */
  id?: string
  type?: 'function'
  function?: {
    /** Present on the first delta of each call only. */
    name?: string
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string
  }
}

/** Wire token accounting (OpenAI spelling Workers AI emits in the usage chunk). */
export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/**
 * Cloudflare error envelope on a non-2xx response:
 * `{ success: false, errors: [{ code, message }] }`.
 */
export interface CfErrorEnvelope {
  success?: false
  errors?: { code?: number; message?: string }[]
}

/**
 * The `cf-ai-usage` response header: comma-separated `key=value` pairs
 * (e.g. `prompt_tokens=1,total_tokens=3,neurons=...`). Workers AI emits it
 * when usage accounting is available.
 */
export type CfAiUsageHeader = string
