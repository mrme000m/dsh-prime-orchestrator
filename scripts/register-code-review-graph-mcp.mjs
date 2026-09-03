#!/usr/bin/env node
/**
 * Register the code-review-graph MCP server with prime-agent (B3) so delegated
 * workers can call the graph tools natively instead of shelling out to grep.
 *
 * Idempotent: adds the server only if absent (use --force to overwrite).
 * Backs up settings.json before mutating.
 *
 * Usage:   node scripts/register-code-review-graph-mcp.mjs [--force]
 * Env:     CODE_REVIEW_GRAPH_BIN   override the binary path
 *          PRIME_SETTINGS_PATH     override ~/.prime/agent/settings.json
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const force = process.argv.includes('--force')
const settingsPath = process.env.PRIME_SETTINGS_PATH ?? join(homedir(), '.prime', 'agent', 'settings.json')

/** Resolve the code-review-graph binary: env override, known mise path, then PATH. */
function resolveBin() {
  if (process.env.CODE_REVIEW_GRAPH_BIN) return process.env.CODE_REVIEW_GRAPH_BIN
  const known = '/Volumes/Spare/mise/installs/python/3.12.0/bin/code-review-graph'
  if (existsSync(known)) return known
  try {
    return execFileSync('which', ['code-review-graph'], { encoding: 'utf8' }).trim()
  } catch {
    return 'code-review-graph'
  }
}

// Comprehension-focused subset of the 30 code-review-graph tools (B3): the
// entry points, graph traversal, communities, change detection, and flows.
const ENABLED_TOOLS = [
  'get_minimal_context_tool',
  'query_graph_tool',
  'semantic_search_nodes_tool',
  'list_communities_tool',
  'detect_changes_tool',
  'list_flows_tool',
  'get_flow_tool',
  'traverse_graph_tool',
]

const serverConfig = {
  type: 'stdio',
  command: resolveBin(),
  // `serve` auto-detects the repo root from the MCP process cwd. Add a fixed
  // `--repo <path>` arg here if workers always operate on one repository.
  args: ['serve'],
  enabledTools: ENABLED_TOOLS,
  startupTimeoutMs: 30000,
}

if (!existsSync(settingsPath)) {
  console.error(`settings.json not found: ${settingsPath}`)
  process.exit(1)
}

const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
const existing = settings.mcpServers?.['code-review-graph']
if (existing && !force) {
  console.log('code-review-graph MCP already registered; no change (use --force to overwrite).')
  console.log(JSON.stringify(existing, null, 2))
  process.exit(0)
}

const backup = `${settingsPath}.bak-${Date.now()}`
copyFileSync(settingsPath, backup)
settings.mcpServers = { ...(settings.mcpServers ?? {}), 'code-review-graph': serverConfig }
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
console.log(`registered code-review-graph MCP (backup: ${backup})`)
console.log(JSON.stringify(serverConfig, null, 2))