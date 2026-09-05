import test from 'node:test'
import assert from 'node:assert/strict'
import { pickOptionLabel, buildAutoAnswer, DEFAULT_QUESTION_WATCHDOG_TIMEOUT_MS } from '../lib/index.js'

const withOptions = {
  id: 'bw_unlock',
  question: 'How should I unlock it?',
  options: [
    { label: 'Give master password now (Recommended)' },
    { label: 'I will paste a session key' },
    { label: 'Skip vault writes for now' },
  ],
}

const zhRecommended = {
  id: 'q',
  question: '选择？',
  options: [{ label: '立即提供（推荐）' }, { label: '跳过' }],
}

const freeText = { id: 'notes', question: 'Anything else?', options: [] }

test('pickOptionLabel: recommended strategy picks the (Recommended) option', () => {
  assert.equal(pickOptionLabel(withOptions, 'recommended'), 'Give master password now (Recommended)')
})

test('pickOptionLabel: recommended strategy also matches the zh suffix and falls back to first', () => {
  assert.equal(pickOptionLabel(zhRecommended, 'recommended'), '立即提供（推荐）')
  assert.equal(pickOptionLabel(freeText, 'recommended'), null)
})

test('pickOptionLabel: first strategy picks the first option; cancel never picks', () => {
  assert.equal(pickOptionLabel(withOptions, 'first'), 'Give master password now (Recommended)')
  assert.equal(pickOptionLabel(withOptions, 'cancel'), null)
})

test('buildAutoAnswer: recommended answers every question with its recommendation', () => {
  const outcome = buildAutoAnswer([withOptions, zhRecommended], 'recommended')
  assert.equal('cancel' in outcome, false)
  assert.deepEqual(outcome.answers, [
    { id: 'bw_unlock', selected: ['Give master password now (Recommended)'] },
    { id: 'q', selected: ['立即提供（推荐）'] },
  ])
})

test('buildAutoAnswer: a batch containing a free-text question is cancelled, not fabricated', () => {
  const outcome = buildAutoAnswer([withOptions, freeText], 'recommended')
  assert.equal('cancel' in outcome, true)
  assert.match(outcome.reason, /no options/)
})

test('buildAutoAnswer: cancel strategy cancels the whole batch', () => {
  const outcome = buildAutoAnswer([withOptions], 'cancel')
  assert.equal('cancel' in outcome, true)
})

test('default timeout is fifteen minutes', () => {
  assert.equal(DEFAULT_QUESTION_WATCHDOG_TIMEOUT_MS, 15 * 60_000)
})
