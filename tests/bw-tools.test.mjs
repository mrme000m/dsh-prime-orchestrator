import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  makeGetArgs,
  makeListArgs,
  parseOutput,
  renderJson,
} from '../lib/bw-tools.js'

const CONFIG = { sessionEnv: 'BW_SESSION', cliPath: 'bw', timeoutMs: 5000 }

function makeContext(session = 'sess-123') {
  const registered = []
  const ctx = {
    credentials: {
      resolve: async (ref) => (ref?.env === 'BW_SESSION' ? { value: session, source: 'env' } : undefined),
    },
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
  }
  return { ctx, registered }
}

function execContext(signal = new AbortController().signal) {
  return { signal }
}

test('apply registers bw_status, bw_list, and bw_get', () => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  assert.deepEqual(registered.map((tool) => tool.name), ['bw_status', 'bw_list', 'bw_get'])
})

test('makeGetArgs validates object enum and requires id', () => {
  assert.deepEqual(makeGetArgs({ object: 'item', id: 'abc' }), { object: 'item', id: 'abc', raw: false })
  assert.deepEqual(makeGetArgs({ object: 'password', id: ' google ', raw: true }), { object: 'password', id: 'google', raw: true })
  assert.throws(() => makeGetArgs({ object: 'bad', id: 'abc' }), /object/)
  assert.throws(() => makeGetArgs({ object: 'item' }), /id/)
  assert.throws(() => makeGetArgs({ object: 'item', id: '' }), /id/)
  assert.throws(() => makeGetArgs({ object: 'item', id: 'abc', raw: 'yes' }), /raw/)
})

test('makeListArgs validates object enum and optional filters', () => {
  assert.deepEqual(
    makeListArgs({ object: 'items' }),
    { object: 'items', search: undefined, folderid: undefined, collectionid: undefined, trash: undefined },
  )
  assert.deepEqual(
    makeListArgs({ object: 'items', search: 'google', folderid: 'f1', collectionid: 'c1', trash: true }),
    { object: 'items', search: 'google', folderid: 'f1', collectionid: 'c1', trash: true },
  )
  assert.throws(() => makeListArgs({ object: 'bad' }), /object/)
  assert.throws(() => makeListArgs({ object: 'items', search: '' }), /search/)
  assert.throws(() => makeListArgs({ object: 'items', trash: 'yes' }), /trash/)
})

test('makeListArgs rejects unknown boolean filter types', () => {
  assert.throws(() => makeListArgs({ object: 'items', trash: 1 }), /trash/)
})

test('parseOutput returns JSON for JSON stdout', () => {
  assert.deepEqual(parseOutput('{"a":1}'), { ok: true, value: { a: 1 } })
})

test('parseOutput returns null for empty stdout', () => {
  assert.deepEqual(parseOutput('   '), { ok: true, value: null })
})

test('parseOutput falls back to raw text for invalid JSON', () => {
  assert.deepEqual(parseOutput('hello world'), { ok: false, text: 'hello world' })
})

test('renderJson pretty-prints and bounds JSON', () => {
  const value = { a: 'x'.repeat(20_000) }
  const blocks = renderJson({}, value)
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].text.includes('"a"'))
  assert.ok(blocks[0].text.includes('…[truncated]'))
})

test('missing session credential throws a naming error for list/get', async () => {
  const { ctx, registered } = makeContext()
  ctx.credentials.resolve = async () => undefined
  apply(ctx, CONFIG)
  await assert.rejects(registered[1].execute({ object: 'items' }, execContext()), /MISSING_CREDENTIAL.*BW_SESSION/s)
  await assert.rejects(registered[2].execute({ object: 'item', id: 'abc' }, execContext()), /MISSING_CREDENTIAL.*BW_SESSION/s)
})


