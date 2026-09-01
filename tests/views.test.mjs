import test from 'node:test'
import assert from 'node:assert/strict'
import { rlmChildView, modelView, messageView } from '../lib/index.js'

test('rlmChildView keeps known fields and drops empty errors', () => {
  const view = rlmChildView({
    id: 'child-1', sessionName: 'worker', label: 'build', status: 'running',
    model: '@cf/glm-5.3', tokenCount: 1200, toolUseCount: 8, durationMs: 45_000,
    repliedSinceTask: true, answerPreview: 'done'.repeat(300), sessionDir: '/tmp/s', error: '',
  })
  assert.equal(view.id, 'child-1')
  assert.equal(view.tokens, 1200)
  assert.equal(view.replied, true)
  assert.ok(view.answerPreview.length <= 400)
  assert.equal('error' in view, false)
})

test('rlmChildView surfaces child errors', () => {
  const view = rlmChildView({ id: 'child-2', error: 'spawn failed' })
  assert.equal(view.error, 'spawn failed')
})

test('modelView projects the model catalog row', () => {
  const view = modelView({
    provider: 'cloudflare-ai-gateway', id: 'glm-5.3', name: 'GLM 5.3',
    reasoning: true, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 64_000,
    cost: { input: 1, output: 5 },
  })
  assert.equal(view.provider, 'cloudflare-ai-gateway')
  assert.deepEqual(view.input, ['text', 'image'])
  assert.equal(view.reasoning, true)
})

test('messageView extracts text from blocks and bounds it', () => {
  const view = messageView({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'internal reasoning', thinkingSignature: 'x' },
      { type: 'text', text: 'ORCHESTRATION OK' },
    ],
  }, 500)
  assert.equal(view.text, 'ORCHESTRATION OK')
})

test('messageView handles plain string content and missing fields', () => {
  assert.equal(messageView({ role: 'user', content: 'hello' }).text, 'hello')
  assert.equal(messageView({}).role, undefined)
})
