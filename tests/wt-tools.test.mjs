import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  makeStatusArgs,
  makeSessionArgs,
  makeApiArgs,
  makeApikeyArgs,
  makeBrowseArgs,
  maskSecret,
  parseOutput,
  renderJson,
} from '../src/wt-tools.ts'

// Fake CLI used only by these tests: never touches bin/wt.mjs (owned by the
// concurrent worker). Echoes argv + env for most commands, returns a realistic
// apikey-create payload, and fails on demand.
const FAKE_CLI = `
const argv = process.argv.slice(2)
if (argv[0] === 'fail') { console.error('wt-test: simulated failure'); process.exit(1) }
if (argv[0] === 'apikey' && argv[1] === 'create') {
  console.log(JSON.stringify({ name: argv[2], apiKey: 'WT_KEY_ABCDEFGHIJ', apiSecret: 'supersecret-secret-123', expiresAt: '2026-12-04T00:00:00Z' }))
} else {
  console.log(JSON.stringify({ argv, bwSession: process.env.BW_SESSION, cloakDir: process.env.WT_CLOAK_DIR }))
}
`

const tmp = mkdtempSync(join(tmpdir(), 'wt-tools-test-'))
const cliPath = join(tmp, 'fake-wt.mjs')
writeFileSync(cliPath, FAKE_CLI)

test.after(() => rmSync(tmp, { recursive: true, force: true }))

const CONFIG = { cliPath, cloakDir: '/tmp/wt-cloak-test', sessionEnv: 'BW_SESSION', timeoutMs: 5000 }

function makeContext(session = 'sess-123') {
  const registered = []
  const skills = []
  const ctx = {
    credentials: {
      resolve: async (ref) => (ref === 'BW_SESSION' || ref?.env === 'BW_SESSION' ? { value: session, source: 'env' } : undefined),
    },
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    skills: { register: (skill) => { skills.push(skill); return () => {} } },
  }
  return { ctx, registered, skills }
}

function execContext(signal = new AbortController().signal) {
  return { signal }
}

test('apply registers the seven wt tools and the wt-network skill', () => {
  const { ctx, registered, skills } = makeContext()
  apply(ctx, CONFIG)
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['wt_status', 'wt_session', 'wt_login', 'wt_browse', 'wt_api', 'wt_apikey', 'wt_mcp'],
  )
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'wt-network')
  assert.equal(skills[0].source, 'bundled')
  assert.ok(skills[0].content.includes('WunderTrading'))
})

test('makeStatusArgs accepts an empty object and rejects anything else', () => {
  assert.deepEqual(makeStatusArgs({}), {})
  assert.throws(() => makeStatusArgs(null), /must be an object/)
  assert.throws(() => makeStatusArgs('x'), /must be an object/)
  assert.throws(() => makeStatusArgs({ url: 'https://x' }), /unexpected arguments/)
})

test('makeSessionArgs validates the action enum', () => {
  assert.deepEqual(makeSessionArgs({ action: 'check' }), { action: 'check' })
  assert.deepEqual(makeSessionArgs({ action: 'save' }), { action: 'save' })
  assert.deepEqual(makeSessionArgs({ action: 'load' }), { action: 'load' })
  assert.deepEqual(makeSessionArgs({ action: 'restore' }), { action: 'restore' })
  assert.throws(() => makeSessionArgs(null), /must be an object/)
  assert.throws(() => makeSessionArgs({}), /action/)
  assert.throws(() => makeSessionArgs({ action: 'delete' }), /action/)
  assert.throws(() => makeSessionArgs({ action: 7 }), /action/)
})

test('makeApiArgs validates method, path, body, and recv', () => {
  assert.deepEqual(
    makeApiArgs({ method: 'GET', path: '/open_api/strategies/live' }),
    { method: 'GET', path: '/open_api/strategies/live', body: undefined, recv: undefined },
  )
  assert.deepEqual(
    makeApiArgs({ method: 'post', path: '/open_api/strategies/trade', body: '{"a":1}', recv: 5000 }),
    { method: 'POST', path: '/open_api/strategies/trade', body: '{"a":1}', recv: 5000 },
  )
  assert.throws(() => makeApiArgs(null), /must be an object/)
  assert.throws(() => makeApiArgs({ path: '/open_api/exchanges' }), /method/)
  assert.throws(() => makeApiArgs({ method: 'FETCH', path: '/x' }), /method/)
  assert.throws(() => makeApiArgs({ method: 'GET' }), /path/)
  assert.throws(() => makeApiArgs({ method: 'GET', path: 'open_api/exchanges' }), /path/)
  assert.throws(() => makeApiArgs({ method: 'GET', path: '   ' }), /path/)
  assert.throws(() => makeApiArgs({ method: 'GET', path: '/x', body: '' }), /body/)
  assert.throws(() => makeApiArgs({ method: 'GET', path: '/x', body: 42 }), /body/)
  assert.throws(() => makeApiArgs({ method: 'GET', path: '/x', recv: 0 }), /recv/)
  assert.throws(() => makeApiArgs({ method: 'GET', path: '/x', recv: 1.5 }), /recv/)
  assert.throws(() => makeApiArgs({ method: 'GET', path: '/x', recv: '5000' }), /recv/)
})

test('makeApikeyArgs requires a name for create only', () => {
  assert.deepEqual(makeApikeyArgs({ action: 'list' }), { action: 'list', name: undefined })
  assert.deepEqual(makeApikeyArgs({ action: 'create', name: ' my-bot ' }), { action: 'create', name: 'my-bot' })
  assert.throws(() => makeApikeyArgs(null), /must be an object/)
  assert.throws(() => makeApikeyArgs({}), /action/)
  assert.throws(() => makeApikeyArgs({ action: 'delete' }), /action/)
  assert.throws(() => makeApikeyArgs({ action: 'create' }), /name.*required for action create/)
  assert.throws(() => makeApikeyArgs({ action: 'create', name: '' }), /name/)
  assert.throws(() => makeApikeyArgs({ action: 'list', name: 3 }), /name/)
})

test('makeBrowseArgs validates the optional url', () => {
  assert.deepEqual(makeBrowseArgs({}), {})
  assert.deepEqual(makeBrowseArgs({ url: ' https://wundertrading.com/en/trader/terminal ' }), { url: 'https://wundertrading.com/en/trader/terminal' })
  assert.throws(() => makeBrowseArgs(null), /must be an object/)
  assert.throws(() => makeBrowseArgs({ url: '' }), /url/)
  assert.throws(() => makeBrowseArgs({ url: 42 }), /url/)
})

test('maskSecret keeps first 4 + last 2 chars, collapses short values', () => {
  assert.equal(maskSecret('abcdefghijklmnop'), 'abcd***op')
  assert.equal(maskSecret('abcdefgh'), 'abcd***gh')
  assert.equal(maskSecret('abcdefg'), '***')
  assert.equal(maskSecret(''), '***')
  assert.equal(maskSecret(undefined), '***')
  assert.equal(maskSecret(12345678), '***')
})

test('parseOutput returns JSON for JSON stdout and raw text otherwise', () => {
  assert.deepEqual(parseOutput('{"a":1}'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseOutput('   '), { ok: true, value: null })
  assert.deepEqual(parseOutput('hello world'), { ok: false, text: 'hello world' })
})

test('renderJson pretty-prints and bounds JSON', () => {
  const value = { a: 'x'.repeat(20_000) }
  const blocks = renderJson({}, value)
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].text.includes('"a"'))
  assert.ok(blocks[0].text.includes('…[truncated]'))
})

test('tools spawn the CLI with the resolved session and cloak dir', async () => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  const result = await byName.wt_session.execute({ action: 'save' }, execContext())
  assert.deepEqual(result, { argv: ['session', 'save'], bwSession: 'sess-123', cloakDir: '/tmp/wt-cloak-test' })
  const status = await byName.wt_status.execute({}, execContext())
  assert.deepEqual(status.argv, ['status', '--json'])
  const browse = await byName.wt_browse.execute({ url: 'https://wundertrading.com/en/trader/positions' }, execContext())
  assert.deepEqual(browse.argv, ['browse', 'https://wundertrading.com/en/trader/positions'])
  const browseDefault = await byName.wt_browse.execute({}, execContext())
  assert.deepEqual(browseDefault.argv, ['browse'])
  const api = await byName.wt_api.execute(
    { method: 'GET', path: '/open_api/strategies/live', recv: 5000 },
    execContext(),
  )
  assert.deepEqual(api.argv, ['api', 'GET', '/open_api/strategies/live', '--recv', '5000'])
})

test('wt_apikey create masks the apiSecret and notes the vault item', async () => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  const result = await byName.wt_apikey.execute({ action: 'create', name: 'my-bot' }, execContext())
  assert.equal(result.apiSecret, 'supe***23')
  assert.equal(result.apiKey, 'WT_KEY_ABCDEFGHIJ')
  assert.match(result.note, /wundertrading-api/)
  assert.doesNotMatch(JSON.stringify(result), /supersecret-secret-123/)
})

test('non-zero CLI exit rejects with the command and stderr tail', async () => {
  const { ctx, registered } = makeContext()
  apply(ctx, { ...CONFIG, cliPath: cliPath })
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  // The fake CLI fails for argv starting with "fail"; wt session save's
  // validated argv cannot be forced to that, so exercise the same envelope
  // through the low-level runner contract via the api tool's error path.
  const failing = { ...CONFIG, cliPath: join(tmp, 'fail-wt.mjs') }
  writeFileSync(failing.cliPath, "console.error('wt-test: simulated failure'); process.exit(1)\n")
  const ctx2 = makeContext()
  apply(ctx2.ctx, failing)
  const tool = Object.fromEntries(ctx2.registered.map((t) => [t.name, t]))['wt_mcp']
  await assert.rejects(tool.execute({}, execContext()), /wt mcp config --mask: .*simulated failure/)
})
