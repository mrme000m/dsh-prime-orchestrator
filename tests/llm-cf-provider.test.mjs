import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  buildUrl,
  CfWorkersAiAdapter,
  DEFAULT_MODELS,
  mapFinishReason,
  mapHttpError,
  mapUsage,
  parseSse,
  PROVIDER,
  serializeMessages,
  serializeRequest,
  translate,
  usageFromHeader,
} from '../lib/llm-cf-provider.js'

/** Resolved plugin config mirroring what the host passes after schemastery. */
const CONFIG = { accountId: 'acct123', tokenEnv: 'CLOUDFLARE_AI_TOKEN', timeoutMs: 5000 }

/** Minimal harness messages for GenerateOptions. */
function userMessage(text, id = 'u1') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantToolTurn() {
  return {
    id: 'a1',
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'think' },
      { type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"SF"}' },
    ],
    source: { kind: 'model', provider: 'cf-workers-ai-native', model: '@cf/x' },
  }
}

function toolResultMessage() {
  return {
    id: 't1',
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'sunny' }] }],
    source: { kind: 'tool', callId: 'call-1' },
  }
}

/** Build one GenerateOptions request for the adapter. */
function request(messages, extra = {}) {
  return { provider: PROVIDER, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages, ...extra }
}

/** JSON/HTTP doubles. */
function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** SSE body from data payloads; `[DONE]` is appended when terminate is true. */
function sseBody(payloads, { terminate = true, crlf = false } = {}) {
  const nl = crlf ? '\r\n' : '\n'
  const text = payloads.map((p) => `data: ${p}${nl}${nl}`).join('')
    + (terminate ? `data: [DONE]${nl}${nl}` : '')
  return new TextEncoder().encode(text)
}

function sseResponse(payloads, opts) {
  return new Response(sseBody(payloads, opts), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** Collect one async iterable into an array. */
async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

/** Adapter double config for direct construction. */
const ADAPTER_OPTIONS = {
  accountId: 'acct123',
  resolveToken: async () => 'tok-123',
  models: [...DEFAULT_MODELS],
  timeoutMs: 5000,
  streamIdleTimeoutMs: 5000,
  retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['TIMEOUT'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
}

test('buildUrl composes the chat-completions endpoint for one account', () => {
  assert.equal(
    buildUrl('72d6e3279eb70c619d8a0ea4b908475f'),
    'https://api.cloudflare.com/client/v4/accounts/72d6e3279eb70c619d8a0ea4b908475f/ai/v1/chat/completions',
  )
})

test('serializeRequest maps system, user, assistant tool turns, and tool results', () => {
  const wire = serializeRequest(request(
    [userMessage('hi'), assistantToolTurn(), toolResultMessage()],
    { system: 'be brief', temperature: 0.2, maxTokens: 256 },
  ))
  assert.equal(wire.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  assert.equal(wire.stream, true)
  assert.deepEqual(wire.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'think',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'sunny' },
  ])
  assert.equal(wire.temperature, 0.2)
  assert.equal(wire.max_tokens, 256)
  assert.equal(wire.tools, undefined)
})

test('serializeRequest maps tools as OpenAI function tools and omits absent optionals', () => {
  const wire = serializeRequest(request([userMessage('hi')], {
    tools: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object' } }],
  }))
  assert.deepEqual(wire.tools, [
    { type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object' } } },
  ])
  assert.equal('temperature' in wire, false)
  assert.equal('max_tokens' in wire, false)
})

test('serializeRequest rejects stop sequences and reasoning effort as unsupported', () => {
  assert.throws(() => serializeRequest(request([userMessage('hi')], { stop: ['END'] })),
    (err) => err.code === 'UNSUPPORTED' && /stop/.test(err.message))
  assert.throws(() => serializeRequest(request([userMessage('hi')], { reasoningEffort: 'high' })),
    (err) => err.code === 'UNSUPPORTED' && /reasoning/.test(err.message))
})

test('serializeMessages rejects image content before any I/O', () => {
  assert.throws(
    () => serializeMessages([{ id: 'i', role: 'user', content: [{ type: 'image', attachment: {} }], source: { kind: 'user' } }]),
    (err) => err.code === 'UNSUPPORTED_CONTENT',
  )
})

test('parseSse reassembles events across arbitrary read splits, CRLF, comments, and event fields', async () => {
  const source = ': keepalive\n\nevent: message\ndata: {"a":1}\n\ndata: {"b":\ndata: 2}\r\n\ndata: [DONE]\n\n'
  // Split the source into awkward chunks: mid-line, mid-UTF-8 handled by TextDecoder streaming.
  const chunks = [
    source.slice(0, 20),
    source.slice(20, 24),
    source.slice(24, 40),
    source.slice(40, 61),
    source.slice(61),
  ]
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
    },
  })
  const payloads = []
  for await (const data of parseSse(stream, () => {})) payloads.push(data)
  // Multi-data lines join with \n per the event-stream algorithm.
  assert.deepEqual(payloads, ['{"a":1}', '{"b":\n2}', '[DONE]'])
})

test('parseSse throws STREAM_CLOSED when the stream ends without [DONE]', async () => {
  const stream = new Response(sseBody(['{"a":1}'], { terminate: false })).body
  await assert.rejects(
    async () => { for await (const _ of parseSse(stream)) { /* drain */ } },
    (err) => err.code === 'STREAM_CLOSED',
  )
})

/** Async generator over literal payload strings. */
async function *ofPayloads(payloads) {
  yield* payloads
}

test('translate maps text, reasoning, tool-call deltas; usage precedes finish; nothing after', async () => {
  const payloads = [
    '{"choices":[{"delta":{"role":"assistant","content":""}}]}',
    '{"choices":[{"delta":{"reasoning_content":"thinking "}}]}',
    '{"choices":[{"delta":{"reasoning_content":"hard"}}]}',
    '{"choices":[{"delta":{"content":"Hel"}}]}',
    '{"choices":[{"delta":{"content":"lo"}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-9","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"SF\\"}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '{"usage":{"prompt_tokens":12,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":4}}}',
    '[DONE]',
  ]
  const chunks = await collect(translate(ofPayloads(payloads)))
  assert.deepEqual(chunks.map((c) => c.type), [
    'block-start', 'reasoning-delta', 'reasoning-delta',
    'block-start', 'text-delta', 'text-delta',
    'block-start', 'tool-call-delta', 'tool-call-delta',
    'block-end', 'block-end', 'block-end',
    'usage', 'finish',
  ])
  // Block indices are first-seen order: reasoning 0, text 1, tool-call 2.
  assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => [c.index, c.blockType]),
    [[0, 'reasoning'], [1, 'text'], [2, 'tool-call']])
  assert.deepEqual(chunks.filter((c) => c.type === 'text-delta').map((c) => [c.index, c.text]),
    [[1, 'Hel'], [1, 'lo']])
  const toolDeltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(toolDeltas[0].id, 'call-9')
  assert.equal(toolDeltas[0].name, 'get_weather')
  assert.equal(toolDeltas[0].argumentsDelta, '{"ci')
  assert.equal(toolDeltas[1].argumentsDelta, 'ty":"SF"}')
  // block-end carries assembled raw JSON arguments end-to-end.
  const toolEnd = chunks.find((c) => c.type === 'block-end' && c.index === 2)
  assert.equal(toolEnd.block.type, 'tool-call')
  assert.equal(toolEnd.block.arguments, '{"city":"SF"}')
  // Usage precedes finish and nothing follows finish.
  const usageIdx = chunks.findIndex((c) => c.type === 'usage')
  const finishIdx = chunks.findIndex((c) => c.type === 'finish')
  assert.ok(usageIdx < finishIdx)
  assert.equal(chunks.length, finishIdx + 1)
  // Disjoint cache accounting: 12 prompt - 4 cached = 8 input.
  assert.deepEqual(chunks[usageIdx].usage, { inputTokens: 8, outputTokens: 7, cacheReadTokens: 4 })
  assert.deepEqual(chunks[finishIdx].reason, { kind: 'tool-calls' })
})

test('translate keeps id/name when continuation deltas re-send them empty', async () => {
  // Workers AI's openai-completions stream re-sends id and function.name as
  // EMPTY STRINGS on continuation deltas; the first delta alone carries the
  // real values. Accepting the empties clobbered the call into `unknown tool ""`.
  const chunks = await collect(translate(ofPayloads([
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-77","type":"function","function":{"name":"bash","arguments":"{\\"command\\":"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","type":"function","function":{"name":"","arguments":"\\"pwd\\"}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '[DONE]',
  ])))
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(deltas[0].id, 'call-77')
  assert.equal(deltas[1].id, 'call-77')
  assert.equal(deltas[1].name, 'bash')
  const end = chunks.find((c) => c.type === 'block-end')
  assert.equal(end.block.id, 'call-77')
  assert.equal(end.block.name, 'bash')
  assert.equal(end.block.arguments, '{"command":"pwd"}')
})

test('translate maps stop/length finish reasons and empty completions', async () => {
  const stop = await collect(translate(ofPayloads([
    '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    '[DONE]',
  ])))
  assert.deepEqual(stop.at(-1).reason, { kind: 'stop' })
  const length = await collect(translate(ofPayloads([
    '{"choices":[{"delta":{"content":"ok"},"finish_reason":"length"}]}',
    '[DONE]',
  ])))
  assert.deepEqual(length.at(-1).reason, { kind: 'max-tokens' })
  const empty = await collect(translate(ofPayloads([
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '[DONE]',
  ])))
  const finish = empty.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('translate uses the header-derived usage fallback when the wire sends none', async () => {
  const chunks = await collect(translate(
    ofPayloads(['{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}', '[DONE]']),
    { inputTokens: 3, outputTokens: 2 },
  ))
  const usage = chunks.find((c) => c.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 3, outputTokens: 2 })
})

test('mapFinishReason maps the wire vocabulary', () => {
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('content_filter'), {
    kind: 'error',
    failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
  })
})

test('mapUsage subtracts cache reads for disjoint counts', () => {
  assert.deepEqual(
    mapUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } }),
    { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3 },
  )
  assert.deepEqual(
    mapUsage({ prompt_tokens: 5, completion_tokens: 1 }),
    { inputTokens: 5, outputTokens: 1 },
  )
})

test('usageFromHeader parses cf-ai-usage key=value pairs', () => {
  assert.deepEqual(usageFromHeader('prompt_tokens=9,completion_tokens=2,total_tokens=11'), {
    inputTokens: 9, outputTokens: 2,
  })
  assert.equal(usageFromHeader(null), undefined)
  assert.equal(usageFromHeader('neurons=5'), undefined)
})

test('mapHttpError maps statuses and CF internal codes to stable harness codes', () => {
  const cases = [
    [5007, 404, { errors: [{ code: 5007, message: 'model not found' }] }, 'INVALID_REQUEST'],
    [3007, 500, { errors: [{ code: 3007, message: 'timeout' }] }, 'TIMEOUT'],
    [3008, 500, { errors: [{ code: 3008, message: 'aborted' }] }, 'TIMEOUT'],
    [3036, 429, { errors: [{ code: 3036, message: 'exhausted' }] }, 'RATE_LIMIT'],
    [3040, 503, { errors: [{ code: 3040, message: 'capacity' }] }, 'RATE_LIMIT'],
    [undefined, 408, undefined, 'TIMEOUT'],
    [undefined, 429, undefined, 'RATE_LIMIT'],
    [undefined, 401, undefined, 'AUTH'],
    [undefined, 403, undefined, 'AUTH'],
    [undefined, 400, { errors: [{ code: 3006, message: 'too large' }] }, 'INVALID_REQUEST'],
    [undefined, 502, undefined, 'SERVER'],
    [undefined, 418, undefined, 'HTTP_418'],
  ]
  for (const [cfCode, status, envelope, expected] of cases) {
    const env = envelope ?? (cfCode === undefined ? undefined : { errors: [{ code: cfCode }] })
    assert.equal(mapHttpError(status, env).code, expected, `status ${status} cf ${cfCode}`)
  }
})

test('mapHttpError attaches status, provider retry delay, and request id', () => {
  const headers = new Headers({ 'retry-after': '2', 'cf-ray': 'ray-abc-123' })
  const err = mapHttpError(429, undefined, headers)
  assert.equal(err.code, 'RATE_LIMIT')
  assert.equal(err.failure.status, 429)
  assert.equal(err.failure.providerRetryAfterMs, 2000)
  assert.equal(err.failure.requestId, 'ray-abc-123')
})

test('mapHttpError names the CF code and message in the thrown error', () => {
  const err = mapHttpError(404, { errors: [{ code: 5007, message: 'no such model' }] })
  assert.match(err.message, /HTTP 404/)
  assert.match(err.message, /CF error 5007/)
  assert.match(err.message, /no such model/)
})

test('adapter.stream streams a fabricated OpenAI SSE stream end-to-end', async (t) => {
  const adapter = new CfWorkersAiAdapter(ADAPTER_OPTIONS)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init })
    return new Response(sseBody([
      '{"choices":[{"delta":{"content":"OK"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '{"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    ]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cf-ai-usage': 'prompt_tokens=3,completion_tokens=1' },
    })
  })
  const chunks = await collect(adapter.stream(request([userMessage('Reply with exactly OK')], { maxTokens: 8 })))
  // One wire call to the chat-completions endpoint, bearer + attribution on it.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-123')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.match(calls[0].init.headers['user-agent'], /^deepseek-harness\//)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 8)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply with exactly OK' }])
  // The chunk sequence: one text block, wire usage (preferred over the header
  // fallback which is identical here), stop finish, nothing after.
  assert.deepEqual(chunks.map((c) => c.type), [
    'block-start', 'text-delta', 'block-end', 'usage', 'finish',
  ])
  assert.equal(chunks[1].text, 'OK')
  assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 3, outputTokens: 1 })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('adapter.stream falls back to header usage when the wire sends none', async (t) => {
  const adapter = new CfWorkersAiAdapter(ADAPTER_OPTIONS)
  t.mock.method(globalThis, 'fetch', async () => new Response(sseBody([
    '{"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}',
  ]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cf-ai-usage': 'prompt_tokens=6,completion_tokens=2' },
  }))
  const chunks = await collect(adapter.stream(request([userMessage('hi')])))
  assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 6, outputTokens: 2 })
})

test('adapter.stream maps a 408 empty body to a TIMEOUT LlmError', async (t) => {
  const adapter = new CfWorkersAiAdapter(ADAPTER_OPTIONS)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 408 }))
  await assert.rejects(
    collect(adapter.stream(request([userMessage('hi')]))),
    (err) => err.code === 'TIMEOUT' && err.failure.status === 408,
  )
})

test('adapter.stream maps a 429 envelope to a RATE_LIMIT LlmError with retry delay', async (t) => {
  const adapter = new CfWorkersAiAdapter(ADAPTER_OPTIONS)
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(
    { success: false, errors: [{ code: 3036, message: 'free neurons exhausted' }] },
    429,
  ))
  await assert.rejects(
    collect(adapter.stream(request([userMessage('hi')]))),
    (err) => err.code === 'RATE_LIMIT' && err.failure.status === 429 && /3036/.test(err.message),
  )
})

test('adapter.stream maps a 401 to an AUTH LlmError', async (t) => {
  const adapter = new CfWorkersAiAdapter(ADAPTER_OPTIONS)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }))
  await assert.rejects(
    collect(adapter.stream(request([userMessage('hi')]))),
    (err) => err.code === 'AUTH' && err.failure.status === 401,
  )
})

test('adapter.stream maps a missing response body to EMPTY_RESPONSE', async (t) => {
  const adapter = new CfWorkersAiAdapter(ADAPTER_OPTIONS)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))
  await assert.rejects(
    collect(adapter.stream(request([userMessage('hi')]))),
    (err) => err.code === 'EMPTY_RESPONSE',
  )
})

test('adapter.stream throws TIMEOUT when the provider goes silent mid-stream', async (t) => {
  const adapter = new CfWorkersAiAdapter({
    ...ADAPTER_OPTIONS,
    streamIdleTimeoutMs: 50,
    timeoutMs: 5000,
  })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // A body that never enqueues and never closes; honoring the request
    // signal the way the real fetch errors its body on abort.
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  await assert.rejects(
    collect(adapter.stream(request([userMessage('hi')]))),
    (err) => err.code === 'TIMEOUT' && /idle timeout/.test(err.message),
  )
})

/** Minimal ctx double: captures adapter registration, mocks the credential seam. */
function makeContext(resolve = async () => ({ value: 'tok-123', source: 'env' })) {
  const registered = []
  const effects = []
  const ctx = {
    credentials: { resolve },
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.push({ providers: [...providers], adapter })
        return () => {}
      },
    },
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
  }
  return { ctx, registered, effects }
}

test('apply registers the adapter under cf-workers-ai-native through an effect', async () => {
  const { ctx, registered, effects } = makeContext()
  apply(ctx, CONFIG)
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].providers, ['cf-workers-ai-native'])
  assert.equal(effects.length, 1)
  assert.match(effects[0].label, /adapter registration/)
  // The registered adapter carries the curated catalog as its advisory list.
  const { adapter } = registered[0]
  assert.equal(typeof adapter.stream, 'function')
  assert.deepEqual((await adapter.listModels(PROVIDER)).map((m) => m.id), DEFAULT_MODELS.map((m) => m.id))
  // resolveModel identity: catalog metadata plus text-only modality.
  const info = await adapter.resolveModel(PROVIDER, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  assert.equal(info.id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  assert.deepEqual(info.context, { contextWindow: 131072 })
  assert.equal(info.defaultMaxTokens, 16384)
  assert.deepEqual(info.inputModalities, ['text'])
  assert.equal(adapter.providerInfo(PROVIDER).name, 'Cloudflare Workers AI')
})

test('apply without an account id throws an error naming both sources', () => {
  const { ctx } = makeContext()
  const saved = process.env.CF_ACCOUNT_ID
  delete process.env.CF_ACCOUNT_ID
  try {
    assert.throws(() => apply(ctx, { ...CONFIG, accountId: undefined }), /accountId.*CF_ACCOUNT_ID/s)
  } finally {
    if (saved === undefined) delete process.env.CF_ACCOUNT_ID
    else process.env.CF_ACCOUNT_ID = saved
  }
})

test('apply reads the account id from CF_ACCOUNT_ID when the config omits it', () => {
  const { ctx, registered } = makeContext()
  const saved = process.env.CF_ACCOUNT_ID
  process.env.CF_ACCOUNT_ID = 'env-acct'
  try {
    apply(ctx, { ...CONFIG, accountId: undefined })
    assert.equal(registered.length, 1)
  } finally {
    if (saved === undefined) delete process.env.CF_ACCOUNT_ID
    else process.env.CF_ACCOUNT_ID = saved
  }
})

test('adapter.stream resolves the token per request and names the env var when absent', async (t) => {
  let resolves = 0
  const { ctx, registered } = makeContext(async () => {
    resolves += 1
    return undefined
  })
  apply(ctx, CONFIG)
  const adapter = registered[0].adapter
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be reached')
  })
  await assert.rejects(
    collect(adapter.stream(request([userMessage('hi')]))),
    (err) => err.code === 'MISSING_CREDENTIAL' && /CLOUDFLARE_AI_TOKEN/.test(err.message),
  )
  assert.equal(resolves, 1)
})

test('adapter.stream re-resolves the token on every call (never cached)', async (t) => {
  let resolves = 0
  const { ctx, registered } = makeContext(async () => {
    resolves += 1
    return { value: `tok-${resolves}`, source: 'env' }
  })
  apply(ctx, CONFIG)
  const adapter = registered[0].adapter
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(init.headers.authorization)
    return new Response(sseBody(['{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  await collect(adapter.stream(request([userMessage('a')])))
  await collect(adapter.stream(request([userMessage('b')])))
  assert.deepEqual(calls, ['Bearer tok-1', 'Bearer tok-2'])
  assert.equal(resolves, 2)
})
