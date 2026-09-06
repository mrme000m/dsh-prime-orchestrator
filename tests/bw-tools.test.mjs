import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  makeGetArgs,
  makeListArgs,
  parseOutput,
  readAccountArg,
  renderJson,
  resolveAccount,
} from '../lib/bw-tools.js'

const CONFIG = {
  accounts: {
    work: { sessionEnv: 'BW_SESSION_WORK' },
    personal: { sessionEnv: 'BW_SESSION_PERSONAL', dataDir: '/tmp/bw-personal' },
  },
  defaultAccount: 'work',
  cliPath: 'bw',
  timeoutMs: 5000,
}
function makeContext(sessions = { BW_SESSION_WORK: 'sess-work', BW_SESSION_PERSONAL: 'sess-personal' }) {
  const registered = []
  const ctx = {
    credentials: {
      resolve: async (ref) => {
        const value = sessions?.[ref]
        return value === undefined ? undefined : { value, source: 'env' }
      },
    },
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
  }
  return { ctx, registered }
}

function execContext(signal = new AbortController().signal) {
  return { signal }
}

/**
 * Build a fake `bw` CLI that logs each invocation (argv without the session
 * key, plus BITWARDENCLI_APPDATA_DIR) to <dir>/call.log and prints the given
 * JSON on stdout.
 */
function fakeBw(printJson) {
  const dir = mkdtempSync(join(tmpdir(), 'bw-fake-'))
  const cli = join(dir, 'bw')
  writeFileSync(cli, [
    '#!/bin/bash',
    `echo "$*" | tr '\\n' ' ' > "$BW_CALL_LOG"`,
    `echo '${JSON.stringify(printJson)}'`,
    '',
  ].join('\n'))
  chmodSync(cli, 0o755)
  return { dir, cli, logPath: join(dir, 'call.log') }
}

function readLog(logPath) {
  return readFileSync(logPath, 'utf8').replace(/\bsess-[a-z]+/g, '').trim().replace(/  +/g, ' ')
}

test('apply registers bw_accounts, bw_use, bw_status, bw_list, and bw_get', () => {
  const { ctx, registered } = makeContext()
  apply(ctx, CONFIG)
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['bw_accounts', 'bw_use', 'bw_status', 'bw_list', 'bw_get'],
  )
})

test('resolveAccount falls back to the default account', () => {
  const resolved = resolveAccount(CONFIG, undefined)
  assert.equal(resolved.account, 'work')
  assert.equal(resolved.sessionEnv, 'BW_SESSION_WORK')
})

test('resolveAccount picks a named account with its dataDir', () => {
  const resolved = resolveAccount(CONFIG, ' personal ')
  assert.deepEqual(
    { account: resolved.account, sessionEnv: resolved.sessionEnv, dataDir: resolved.dataDir },
    { account: 'personal', sessionEnv: 'BW_SESSION_PERSONAL', dataDir: '/tmp/bw-personal' },
  )
})

test('resolveAccount with no accounts falls back to the implicit BW_SESSION entry', () => {
  const resolved = resolveAccount({ ...CONFIG, accounts: {}, defaultAccount: 'default' }, undefined)
  assert.deepEqual(resolved, { account: 'default', sessionEnv: 'BW_SESSION' })
})

test('resolveAccount fails loud on unknown account', () => {
  assert.throws(() => resolveAccount(CONFIG, 'nope'), /UNKNOWN_ACCOUNT.*work.*personal/s)
})

test('readAccountArg trims and blanks to undefined', () => {
  assert.equal(readAccountArg({ account: ' work ' }), 'work')
  assert.equal(readAccountArg({ account: '' }), undefined)
  assert.equal(readAccountArg({}), undefined)
  assert.throws(() => readAccountArg({ account: 7 }), /string/)
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

test('bw_use switches the account bw_status resolves the session for', async () => {
  const { cli, dir } = fakeBw({ status: 'locked' })
  const logPath = join(dir, 'call.log')
  process.env.BW_CALL_LOG = logPath
  const { ctx, registered } = makeContext()
  apply(ctx, { ...CONFIG, cliPath: cli })
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  try {
    // default account (work): call carries the work session key
    await byName.bw_status.execute({}, execContext())
    assert.ok(readFileSync(logPath, 'utf8').includes('sess-work'))

    // after bw_use personal: same command, personal session key
    await byName.bw_use.execute({ account: 'personal' }, execContext())
    writeFileSync(logPath, '')
    const result = await byName.bw_status.execute({}, execContext())
    assert.equal(result.status, 'locked')
    assert.ok(readFileSync(logPath, 'utf8').includes('sess-personal'))
  } finally {
    delete process.env.BW_CALL_LOG
  }
})

test('per-account data dir is passed through the child environment', async () => {
  const { cli, dir } = fakeBw({ status: 'locked' })
  // Capture the child env by having the fake CLI dump it alongside argv
  const envDump = join(dir, 'env.log')
  writeFileSync(cli, [
    '#!/bin/bash',
    `printf '%s' "$@" > "$BW_CALL_LOG"`,
    `printf '%s' "\${BITWARDENCLI_APPDATA_DIR:-<unset>}" > "$(dirname "$BW_CALL_LOG")/appdata.log"`,
    `echo '{"status":"locked"}'`,
    '',
  ].join('\n'))
  const logPath = join(dir, 'call.log')
  process.env.BW_CALL_LOG = logPath
  const { ctx, registered } = makeContext()
  apply(ctx, { ...CONFIG, cliPath: cli })
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  try {
    await byName.bw_status.execute({ account: 'personal' }, execContext())
    assert.equal(readFileSync(join(dir, 'appdata.log'), 'utf8'), '/tmp/bw-personal')

    await byName.bw_status.execute({ account: 'work' }, execContext())
    assert.equal(readFileSync(join(dir, 'appdata.log'), 'utf8'), '<unset>')
  } finally {
    delete process.env.BW_CALL_LOG
  }
})

test('missing session credential throws an error naming the account', async () => {
  const { ctx, registered } = makeContext({})
  apply(ctx, CONFIG)
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  await assert.rejects(
    byName.bw_list.execute({ object: 'items' }, execContext()),
    /MISSING_CREDENTIAL.*BW_SESSION_WORK.*"work"/s,
  )
  await assert.rejects(
    byName.bw_get.execute({ object: 'item', id: 'abc', account: 'personal' }, execContext()),
    /MISSING_CREDENTIAL.*BW_SESSION_PERSONAL.*"personal"/s,
  )
})

test('bw_accounts lists registered accounts with the active flag', async () => {
  const { cli, dir } = fakeBw({ status: 'locked', userEmail: 'a@b.c', serverUrl: 'https://vault.example' })
  process.env.BW_CALL_LOG = join(dir, 'call.log')
  const { ctx, registered } = makeContext()
  apply(ctx, { ...CONFIG, cliPath: cli })
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  try {
    const result = await byName.bw_accounts.execute({}, execContext())
    assert.deepEqual(result.accounts.map((a) => [a.account, a.active]), [['work', true], ['personal', false]])
    assert.equal(result.accounts[1].sessionEnv, 'BW_SESSION_PERSONAL')
    assert.equal(result.accounts[1].dataDir, '/tmp/bw-personal')
    assert.equal(result.accounts[0].userEmail, 'a@b.c')
    assert.equal(result.accounts[0].status, 'locked')

    await byName.bw_use.execute({ account: 'personal' }, execContext())
    const after = await byName.bw_accounts.execute({}, execContext())
    assert.deepEqual(after.accounts.map((a) => [a.account, a.active]), [['work', false], ['personal', true]])
  } finally {
    delete process.env.BW_CALL_LOG
  }
})
