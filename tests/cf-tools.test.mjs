import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply, buildRunUrl, buildModelsUrl, mapCfError, renderRunResult, renderModelsResult,
} from '../lib/cf-tools.js'

/** Resolved plugin config mirroring what the host passes after schemastery. */
const CONFIG = { accountId: 'acct123', tokenEnv: 'CLOUDFLARE_AI_TOKEN', timeoutMs: 5000 }

/** Minimal ctx double: captures tool registrations, mocks the credential seam. */
function makeContext(resolve = async () => ({ value: 'tok-123', source: 'env' })) {
  const registered = []
  const ctx = {
    credentials: { resolve },
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
  }
  return { ctx, registered }
}

/** ToolRunContext double: cancellation plus the session workspace root. */
function execContext(cwd) {
  return {
    signal: new AbortController().signal,
    ...(cwd === undefined ? {} : { agent: { session: { header: { cwd } } } }),
  }
}

/** JSON Response double. */
function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const RUN_ARGS = {
  model: '@cf/meta/llama-3.1-8b-instruct',
  task: 'text-generation',
  input: { messages: [{ role: 'user', content: 'hi' }] },
}

test('buildRunUrl composes the run endpoint with account id and model', () => {
  // Segments are percent-encoded ('@' → %40) while '/' separators stay literal,
  // matching what fetch puts on the wire.
  assert.equal(
    buildRunUrl('acct123', '@cf/meta/llama-3.1-8b-instruct'),
    'https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/%40cf/meta/llama-3.1-8b-instruct',
  )
})

test('buildModelsUrl composes search params in order, capping per_page at 100', () => {
  assert.equal(
    buildModelsUrl('acct123'),
    'https://api.cloudflare.com/client/v4/accounts/acct123/ai/models/search',
  )
  assert.equal(
    buildModelsUrl('acct123', { query: 'llama', author: 'meta', taskType: 'text-generation', perPage: 250, page: 2 }),
    'https://api.cloudflare.com/client/v4/accounts/acct123/ai/models/search?query=llama&author=meta&task_type=text-generation&per_page=100&page=2',
  )
})

test('apply registers exactly cf_ai_run and cf_ai_models', () => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  assert.deepEqual(registered.map((tool) => tool.name), ['cf_ai_run', 'cf_ai_models'])
})

test('cf_ai_run POSTs to the run endpoint with the resolved bearer token', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ response: 'Hello!', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
  })
  const result = await registered[0].execute(RUN_ARGS, execContext())
  assert.equal(calls.length, 1)
  // fetch normalizes the URL (percent-encodes '@' in the path); compare decoded.
  assert.equal(
    decodeURIComponent(new URL(calls[0].url).pathname),
    '/client/v4/accounts/acct123/ai/run/@cf/meta/llama-3.1-8b-instruct',
  )
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), RUN_ARGS.input)
  assert.deepEqual(result, { response: 'Hello!', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
})

test('cf_ai_run unwraps the success envelope so the model sees the task shape', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ success: true, result: { data: [[0.1, 0.2]], shape: [1, 2] } }))
  const result = await registered[0].execute(
    { model: '@cf/baai/bge-small-en-v1.5', task: 'text-embeddings', input: { text: ['hi'] } },
    execContext(),
  )
  assert.deepEqual(result, { data: [[0.1, 0.2]], shape: [1, 2] })
})

test('cf_ai_models GETs the search endpoint with only the provided params', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      success: true,
      result: { models: [{ id: '@cf/baai/bge-m3', name: 'BGE-M3', task_type: 'Text Embeddings', description: 'x'.repeat(300) }] },
    })
  })
  const result = await registered[1].execute({ query: 'bge', limit: 10 }, execContext())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/models/search?query=bge&per_page=10')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123')
  assert.equal(result.count, 1)
  assert.equal(result.models[0].id, '@cf/baai/bge-m3')
  assert.equal(result.models[0].taskType, 'Text Embeddings')
  assert.ok(result.models[0].description.length <= 120, 'row descriptions are truncated')
})

test('cf_ai_models surfaces raw result keys when the envelope differs', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ success: true, result: { unexpected: true } }))
  const result = await registered[1].execute({}, execContext())
  assert.equal(result.count, 0)
  assert.deepEqual(result.models, [])
  assert.match(result.note, /unexpected/)
  assert.match(result.note, /result keys/)
})

test('cf_ai_run maps a 5007 envelope to an error naming the model', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ success: false, errors: [{ code: 5007, message: 'No such model' }] }, 404))
  await assert.rejects(
    registered[0].execute(RUN_ARGS, execContext()),
    (err) => {
      assert.match(err.message, /HTTP 404/)
      assert.match(err.message, /CF error 5007/)
      assert.match(err.message, /@cf\/meta\/llama-3\.1-8b-instruct/)
      assert.match(err.message, /No such model/)
      return true
    },
  )
})

test('cf_ai_run maps an empty-body 408 to a timeout message', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 408 }))
  await assert.rejects(
    registered[0].execute(RUN_ARGS, execContext()),
    (err) => {
      assert.match(err.message, /HTTP 408/)
      assert.match(err.message, /timed out/)
      return true
    },
  )
})

test('cf_ai_run maps a 429 to a rate-limit error naming per-model limits', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }))
  await assert.rejects(
    registered[0].execute(RUN_ARGS, execContext()),
    (err) => {
      assert.match(err.message, /HTTP 429/)
      assert.match(err.message, /rate limit/)
      assert.match(err.message, /20 req\/min/)
      assert.match(err.message, /300 req\/min/)
      return true
    },
  )
})

test('cf_ai_run maps a 3036 envelope to the neuron-allocation message', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ success: false, errors: [{ code: 3036, message: 'allocation exhausted' }] }, 429))
  await assert.rejects(
    registered[0].execute(RUN_ARGS, execContext()),
    (err) => {
      assert.match(err.message, /CF error 3036/)
      assert.match(err.message, /free neuron allocation exhausted/)
      assert.match(err.message, /Workers Paid/)
      return true
    },
  )
})

test('cf_ai_run maps a 401 to an authentication error', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }))
  await assert.rejects(registered[0].execute(RUN_ARGS, execContext()), /authentication failed/)
})

test('mapCfError names the endpoint, status, CF code, and CF message', () => {
  const err = mapCfError(400, [{ code: 3006, message: 'request too large' }], {
    tool: 'cf_ai_run',
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/a/ai/run/@cf/x/y',
    model: '@cf/x/y',
  })
  assert.match(err.message, /cf_ai_run https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/a\/ai\/run\/@cf\/x\/y/)
  assert.match(err.message, /HTTP 400/)
  assert.match(err.message, /CF error 3006/)
  assert.match(err.message, /request too large/)
  assert.match(err.message, /request too large for the Workers AI endpoint/)
})

test('cf_ai_run writes binary output into the workspace and returns the artifact', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  const workspace = mkdtempSync(join(tmpdir(), 'cf-tools-test-'))
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }))
  const result = await registered[0].execute(
    {
      model: '@cf/black-forest-labs/flux-1-schnell',
      task: 'image-generation',
      input: { prompt: 'a cat' },
      outputDir: 'art/out',
    },
    execContext(workspace),
  )
  assert.equal(result.mediaType, 'image/png')
  assert.equal(result.bytes, bytes.byteLength)
  assert.ok(result.file.startsWith(join(workspace, 'art', 'out')), `artifact under outputDir: ${result.file}`)
  assert.match(result.file, /cf-black-forest-labs-flux-1-schnell-\d+\.png$/)
  assert.deepEqual(new Uint8Array(readFileSync(result.file)), bytes)
  rmSync(workspace, { recursive: true, force: true })
})

test('cf_ai_run validates arguments before any network I/O', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  let called = false
  t.mock.method(globalThis, 'fetch', async () => {
    called = true
    return jsonResponse({})
  })
  await assert.rejects(registered[0].execute({ task: 'text-generation', input: {} }, execContext()), /"model"/)
  await assert.rejects(registered[0].execute({ ...RUN_ARGS, model: 'not a model id!' }, execContext()), /model id/)
  await assert.rejects(registered[0].execute({ ...RUN_ARGS, task: 'nope' }, execContext()), /"task"/)
  await assert.rejects(registered[0].execute({ ...RUN_ARGS, input: 'nope' }, execContext()), /"input"/)
  await assert.rejects(registered[0].execute({ ...RUN_ARGS, outputDir: '' }, execContext()), /"outputDir"/)
  assert.equal(called, false)
})

test('missing credential throws an error naming the env var', async (t) => {
  const { ctx, registered } = makeContext(async () => undefined)
  apply(ctx, CONFIG)
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be reached')
  })
  await assert.rejects(
    registered[0].execute(RUN_ARGS, execContext()),
    /MISSING_CREDENTIAL.*CLOUDFLARE_AI_TOKEN/s,
  )
})

test('missing account id throws an error naming CF_ACCOUNT_ID', async (t) => {
  const { ctx, registered } = makeContext()
  apply(ctx, { ...CONFIG, accountId: undefined })
  const saved = process.env.CF_ACCOUNT_ID
  delete process.env.CF_ACCOUNT_ID
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be reached')
  })
  try {
    await assert.rejects(registered[0].execute(RUN_ARGS, execContext()), /CF_ACCOUNT_ID/)
    await assert.rejects(registered[1].execute({}, execContext()), /CF_ACCOUNT_ID/)
  } finally {
    if (saved === undefined) delete process.env.CF_ACCOUNT_ID
    else process.env.CF_ACCOUNT_ID = saved
  }
})

test('renderRunResult renders key facts and the artifact path', () => {
  const blocks = renderRunResult(
    { model: '@cf/x/y', task: 'image-generation' },
    { file: '/tmp/a/@cf-x-y-1.png', bytes: 42, mediaType: 'image/png' },
  )
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /cf_ai_run @cf\/x\/y \(image-generation\): succeeded/)
  assert.match(blocks[0].text, /artifact: \/tmp\/a\/@cf-x-y-1\.png \(42 bytes, image\/png\)/)
})

test('renderRunResult renders text-generation facts', () => {
  const blocks = renderRunResult(
    { model: '@cf/meta/llama-3.1-8b-instruct', task: 'text-generation' },
    { response: 'Hello', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  )
  assert.match(blocks[0].text, /response: Hello/)
  assert.match(blocks[0].text, /usage: prompt 1, completion 2, total 3 tokens/)
})

test('renderModelsResult renders a deterministic, bounded table', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    id: `@cf/vendor/model-${i}`,
    name: `Model ${i}`,
    taskType: 'Text Generation',
    description: 'd'.repeat(300),
  }))
  const value = { count: rows.length, models: rows }
  const first = renderModelsResult({}, value)
  const second = renderModelsResult({}, value)
  assert.deepEqual(first, second)
  const text = first[0].text
  assert.ok(text.includes('| id | name | taskType | description |'))
  assert.ok(text.includes('| @cf/vendor/model-0 | Model 0 | Text Generation | '))
  assert.ok(text.length <= 12000 + '\n…[truncated]'.length, `render bounded, got ${text.length}`)
})
