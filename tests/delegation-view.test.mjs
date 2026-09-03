import test from 'node:test'
import assert from 'node:assert/strict'
import { delegationView } from '../lib/index.js'

const RECORD = {
  id: 'd1',
  task: 't',
  cwd: '.',
  sessionId: '01abc-def',
  activeSessionId: '2cda24a8d2a9',
  pid: null,
  status: 'running',
  startedAt: new Date().toISOString(),
  endedAt: null,
  exitCode: null,
  lastEventType: null,
  lastText: null,
  error: null,
  logFile: '/tmp/x.jsonl',
}

test('delegationView passes through the activeSessionId', () => {
  const view = delegationView(RECORD)
  assert.equal(view.activeSessionId, '2cda24a8d2a9')
})

test('delegationView yields null activeSessionId when the record lacks it', () => {
  const { activeSessionId, ...withoutActive } = RECORD
  const view = delegationView(withoutActive)
  assert.equal(view.activeSessionId, null)
})
