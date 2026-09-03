import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionIdentity, readSessionFileEvents, heartbeatView } from '../lib/index.js'

/** Minimal PrimeConfig: the resolver only uses it for the (overridden) roster fetch. */
const CONFIG = {
  bin: 'prime-agent',
  stateDir: '/tmp/prime-orchestrator-test',
  maxDelegations: 8,
  daemonSocket: null,
  defaultModel: null,
  defaultProvider: null,
  defaultThinking: null,
  defaultGoalTokenBudget: 0,
  defaultAutonomous: false,
  defaultAutonomousMaxContinuations: 0,
}

const SESSION_ID = '01a05f8c-9b36-72bc-9177-01e1c57f40dc'
const ACTIVE_ID = '2cda24a8d2a9'
const DELEGATION_ID = 'b46e17ec'
const SESSION_NAME = 'api-reviewer'

/** A roster fetch that always fails: no daemon in tests. */
const noRoster = async () => ({ ok: false, output: 'daemon unavailable (test)' })

/** A temp sessions directory, optionally seeded with session files. */
function tempSessionsDir(files = []) {
  const dir = mkdtempSync(join(tmpdir(), 'prime-sessions-'))
  for (const file of files) writeFileSync(join(dir, file), '{"type":"session"}\n')
  return dir
}

/** The projected roster agent used by the roster-mocked tests. */
function rosterAgent(overrides = {}) {
  return {
    id: ACTIVE_ID,
    sessionId: SESSION_ID,
    sessionFile: join(tmpdir(), SESSION_ID + '.jsonl'),
    sessionName: SESSION_NAME,
    cwd: null, firstMessage: null, model: null, modelId: null, thinking: null,
    lifecycle: null, activity: null, daemonBacked: true, isSessionActive: true,
    isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false,
    hasRunningRlmChildren: false, messageCount: 0, unfinishedActionCount: 0,
    attachedClients: 0, taskState: null, workerState: null, rlmDepth: 0,
    parentSessionId: null, hasRegisteredCronJob: false, hasActiveHeartbeat: false,
    nextRunAt: null, created: null, modified: null, lastActivityAt: null,
    ...overrides,
  }
}

test('resolveSessionIdentity resolves a delegation id to its record and session id', async () => {
  const records = new Map([[DELEGATION_ID, { sessionId: SESSION_ID }]])
  const identity = await resolveSessionIdentity(records, CONFIG, DELEGATION_ID, process.cwd(), undefined, {
    fetchRoster: noRoster,
    sessionsDir: tempSessionsDir(),
  })
  assert.equal(identity.delegationId, DELEGATION_ID)
  assert.equal(identity.sessionId, SESSION_ID)
  assert.equal(identity.activeSessionId, null)
  assert.equal(identity.source, 'delegation')
})

test('resolveSessionIdentity resolves a delegation by its underlying session id', async () => {
  const records = new Map([[DELEGATION_ID, { sessionId: SESSION_ID }]])
  const identity = await resolveSessionIdentity(records, CONFIG, SESSION_ID, process.cwd(), undefined, {
    fetchRoster: noRoster,
    sessionsDir: tempSessionsDir([`${SESSION_ID}.jsonl`]),
  })
  assert.equal(identity.delegationId, DELEGATION_ID)
  assert.equal(identity.sessionId, SESSION_ID)
  assert.ok(identity.sessionFile !== null && identity.sessionFile.endsWith(`${SESSION_ID}.jsonl`))
  assert.equal(identity.source, 'delegation')
})

test('resolveSessionIdentity resolves a daemon active session id through the roster', async () => {
  const fetchRoster = async () => ({ ok: true, agents: [rosterAgent()] })
  const identity = await resolveSessionIdentity(new Map(), CONFIG, ACTIVE_ID, process.cwd(), undefined, {
    fetchRoster,
    sessionsDir: tempSessionsDir([`${SESSION_ID}.jsonl`]),
  })
  assert.equal(identity.activeSessionId, ACTIVE_ID)
  assert.equal(identity.sessionId, SESSION_ID)
  assert.equal(identity.sessionName, SESSION_NAME)
  assert.equal(identity.source, 'agent')
})

test('resolveSessionIdentity resolves a full session id through the file system', async () => {
  const dir = tempSessionsDir([`${SESSION_ID}.jsonl`])
  const identity = await resolveSessionIdentity(new Map(), CONFIG, SESSION_ID, process.cwd(), undefined, {
    fetchRoster: noRoster,
    sessionsDir: dir,
  })
  assert.equal(identity.sessionId, SESSION_ID)
  assert.equal(identity.sessionFile, join(dir, `${SESSION_ID}.jsonl`))
  assert.equal(identity.activeSessionId, null)
  assert.equal(identity.source, 'session-file')
})

test('resolveSessionIdentity resolves a unique session id prefix through the file system', async () => {
  const dir = tempSessionsDir([`${SESSION_ID}.jsonl`, 'ffffff00-0000-0000-0000-000000000000.jsonl'])
  const identity = await resolveSessionIdentity(new Map(), CONFIG, '01a05f8c', process.cwd(), undefined, {
    fetchRoster: noRoster,
    sessionsDir: dir,
  })
  assert.equal(identity.sessionId, SESSION_ID)
  assert.equal(identity.sessionFile, join(dir, `${SESSION_ID}.jsonl`))
})

test('resolveSessionIdentity resolves a session name through the roster', async () => {
  const fetchRoster = async () => ({ ok: true, agents: [rosterAgent()] })
  const identity = await resolveSessionIdentity(new Map(), CONFIG, SESSION_NAME, process.cwd(), undefined, {
    fetchRoster,
    sessionsDir: tempSessionsDir(),
  })
  assert.equal(identity.activeSessionId, ACTIVE_ID)
  assert.equal(identity.sessionId, SESSION_ID)
  assert.equal(identity.sessionName, SESSION_NAME)
  assert.equal(identity.source, 'name')
})

test('resolveSessionIdentity merges the roster with the file system for an active session id', async () => {
  const dir = tempSessionsDir([`${SESSION_ID}.jsonl`])
  const fetchRoster = async () => ({ ok: true, agents: [rosterAgent({ sessionFile: null })] })
  const identity = await resolveSessionIdentity(new Map(), CONFIG, ACTIVE_ID, process.cwd(), undefined, {
    fetchRoster,
    sessionsDir: dir,
  })
  assert.equal(identity.activeSessionId, ACTIVE_ID)
  assert.equal(identity.sessionId, SESSION_ID)
  assert.equal(identity.sessionFile, join(dir, `${SESSION_ID}.jsonl`))
  assert.equal(identity.source, 'agent')
})

test('resolveSessionIdentity keeps the daemon sessionFile when the file is not written yet', async () => {
  const sessionFile = join(tmpdir(), `unwritten-${SESSION_ID}.jsonl`)
  const fetchRoster = async () => ({ ok: true, agents: [rosterAgent({ sessionFile })] })
  const identity = await resolveSessionIdentity(new Map(), CONFIG, ACTIVE_ID, process.cwd(), undefined, {
    fetchRoster,
    sessionsDir: tempSessionsDir(),
  })
  assert.equal(identity.activeSessionId, ACTIVE_ID)
  assert.equal(identity.sessionFile, sessionFile)
})

test('resolveSessionIdentity throws on an ambiguous session id prefix', async () => {
  const dir = tempSessionsDir(['aaaa1111-1111-1111-1111-111111111111.jsonl', 'aaaa2222-2222-2222-2222-222222222222.jsonl'])
  await assert.rejects(
    resolveSessionIdentity(new Map(), CONFIG, 'aaaa', process.cwd(), undefined, {
      fetchRoster: noRoster,
      sessionsDir: dir,
    }),
    /ambiguous session id "aaaa"/,
  )
})

test('resolveSessionIdentity throws a helpful error on an unknown id', async () => {
  await assert.rejects(
    resolveSessionIdentity(new Map(), CONFIG, 'deadbeef', process.cwd(), undefined, {
      fetchRoster: noRoster,
      sessionsDir: tempSessionsDir(),
    }),
    (error) => {
      assert.match(error.message, /unknown prime-agent id "deadbeef"/)
      assert.match(error.message, /delegation records/)
      assert.match(error.message, /daemon roster/)
      assert.match(error.message, /session files/)
      return true
    },
  )
})

test('resolveSessionIdentity allowUnresolved returns an all-null identity instead of throwing', async () => {
  const identity = await resolveSessionIdentity(new Map(), CONFIG, 'deadbeef', process.cwd(), undefined, {
    fetchRoster: noRoster,
    sessionsDir: tempSessionsDir(),
    allowUnresolved: true,
  })
  assert.equal(identity.delegationId, null)
  assert.equal(identity.activeSessionId, null)
  assert.equal(identity.sessionId, null)
  assert.equal(identity.sessionFile, null)
  assert.equal(identity.sessionName, null)
})

test('resolveSessionIdentity throws on an empty id', async () => {
  await assert.rejects(
    resolveSessionIdentity(new Map(), CONFIG, '', process.cwd(), undefined, { fetchRoster: noRoster }),
    /non-empty id/,
  )
})

test('readSessionFileEvents filters streaming deltas and bounds the tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prime-events-'))
  const file = join(dir, `${SESSION_ID}.jsonl`)
  writeFileSync(file, [
    JSON.stringify({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }),
    JSON.stringify({ type: 'tool_execution_update', toolName: 'read' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    JSON.stringify({ type: 'goal_update', goal: { status: 'active', active: true, tokensUsed: 42, objective: 'ship it' } }),
    '',
  ].join('\n'))
  const events = readSessionFileEvents(file, 20)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'message')
  assert.equal(events[0].text, 'done')
  assert.equal(events[1].type, 'goal_update')
  assert.equal(events[1].goalState.tokensUsed, 42)
  // A limit of 1 keeps only the newest milestone.
  const last = readSessionFileEvents(file, 1)
  assert.equal(last.length, 1)
  assert.equal(last[0].type, 'goal_update')
})

test('heartbeatView fills sessionId and sessionName from the identity extra', () => {
  const job = { id: 'job-1', status: 'active' }
  const view = heartbeatView(job, { sessionId: SESSION_ID, sessionName: SESSION_NAME })
  assert.equal(view.sessionId, SESSION_ID)
  assert.equal(view.sessionName, SESSION_NAME)
  // The job's own sessionId still wins when present.
  const own = heartbeatView({ ...job, sessionId: 'other' }, { sessionId: SESSION_ID })
  assert.equal(own.sessionId, 'other')
  // No extra: nulls, as before.
  const bare = heartbeatView(job, {})
  assert.equal(bare.sessionId, null)
  assert.equal(bare.sessionName, null)
})
