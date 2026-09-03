import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyToolCode } from '../lib/index.js'

test('classifyToolCode flags mutations as write', () => {
  for (const code of [
    'edit("a.ts", "x", "y")',
    'Path("a.ts").write_text("hi")',
    'open("a.ts", "w").write("x")',
    "sed -i 's/a/b/' a.ts",
    'npm run build',
    'git add .',
    'mv a b',
  ]) {
    assert.equal(classifyToolCode(code), 'write', `expected write: ${code}`)
  }
})

test('classifyToolCode treats reads as read', () => {
  for (const code of [
    'Path("a.ts").read_text()',
    'cat a.ts',
    'grep -n foo a.ts',
    'git status',
    'ls -la',
    'print(lines)',
  ]) {
    assert.equal(classifyToolCode(code), 'read', `expected read: ${code}`)
  }
})

test('classifyToolCode defaults empty/undefined to read', () => {
  assert.equal(classifyToolCode(''), 'read')
})