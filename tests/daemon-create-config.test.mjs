import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDaemonCreateConfig } from '../lib/index.js'

test('buildDaemonCreateConfig maps provider/model/goal/autonomous for a resident session', () => {
  const cfg = buildDaemonCreateConfig('ab12cd34', {
    task: 'do it',
    cwd: '/x',
    provider: 'cloudflare-workers-ai',
    model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    goal: 'ship it',
    autonomous: true,
    autonomousMaxTurns: 5,
  })
  assert.equal(cfg.name, 'orchestrator-ab12cd34')
  assert.equal(cfg.lifecycle, 'resident')
  assert.equal(cfg.config.provider, 'cloudflare-workers-ai')
  assert.equal(cfg.config.model, '@cf/deepseek-ai/deepseek-v4-pro-0813')
  assert.equal(cfg.config.goal, 'ship it')
  assert.equal(cfg.config.autonomous.enabled, true)
  assert.equal(cfg.config.autonomous.maxTurns, 5)
})

test('buildDaemonCreateConfig omits optional fields when absent', () => {
  const cfg = buildDaemonCreateConfig('zz', { task: 't', cwd: '/y' })
  assert.equal(cfg.name, 'orchestrator-zz')
  assert.equal(cfg.lifecycle, 'resident')
  assert.ok(!('provider' in cfg.config))
  assert.ok(!('model' in cfg.config))
  assert.ok(!('goal' in cfg.config))
  assert.ok(!('autonomous' in cfg.config))
})