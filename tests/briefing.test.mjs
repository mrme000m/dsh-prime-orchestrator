import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDelegateArgv } from '../lib/index.js'

test('briefing present prepends a verify-first header with the briefing and task', () => {
  const task = 'Implement feature X in src/a.ts and add tests.'
  const briefing = 'Pre-digested: src/a.ts exports X at line 10; tests live in tests/a.test.mjs.'
  const argv = buildDelegateArgv(task, { briefing })
  const last = argv[argv.length - 1]
  assert.ok(last.startsWith('[BRIEFING'), 'last argv element should start with [BRIEFING')
  assert.ok(last.includes(briefing), 'last argv element should contain the briefing text')
  assert.ok(last.includes(task), 'last argv element should contain the original task')
})

test('briefing absent leaves the task unchanged', () => {
  const task = 'Implement feature X in src/a.ts and add tests.'
  const argv = buildDelegateArgv(task, {})
  assert.equal(argv[argv.length - 1], task)
})

test('empty briefing leaves the task unchanged', () => {
  const task = 'Implement feature X in src/a.ts and add tests.'
  const argv = buildDelegateArgv(task, { briefing: '' })
  assert.equal(argv[argv.length - 1], task)
})
