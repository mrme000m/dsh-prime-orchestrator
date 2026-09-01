/**
 * dsh-prime-orchestrator — host entry.
 *
 * One package, three mounted surfaces:
 *
 * 1. THIS entry (the bundle's `cordis.patch.yml` row `prime-orchestration`):
 *    the host-plane Prime Orchestration engine (`ctx.prime`, the `/prime`
 *    JSON API over the webServer service, and the `prime-orchestrator`
 *    settings namespace) plus startup materialization of the
 *    `prime-orchestrator` agent preset into your user preset root.
 * 2. The `./agent-tool` subpath (named by the materialized preset's
 *    composition): the model-facing `prime_agent` tool, the
 *    `prime-orchestrator:workflow` prompt section, and the bundled
 *    `prime-agent` skill.
 * 3. The `./client` export (declared through `dsh.client` in package.json):
 *    the browser half — the Prime fleet column, its sidebar-foot trigger, and
 *    the Settings → Prime Orchestration section.
 *
 * @module dsh-prime-orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import { PrimeOrchestration, type Config } from './engine.ts'
import { materializePresetOnBoot } from './preset.ts'
import { installLayoutOverride } from './layout-override.ts'

/** Cordis plugin name for the host row this package's patch inserts. */
export const name = 'dsh-prime-orchestrator'

/** Row-config schema, owned by the engine service (Loader validation and defaults). */
export const Config = PrimeOrchestration.Config

export { PrimeOrchestration } from './engine.ts'
export type { Config as PrimeRowConfig } from './engine.ts'
export type {
  PrimeAction, PrimeConfig, PrimeDelegateRequest, PrimeDelegation, PrimeGeneration,
  PrimeGenerationStep, PrimeSessionFile, PrimeState, PrimeStopResult,
} from './types.ts'

/**
 * Mount the engine service and materialize the `prime-orchestrator` agent
 * preset into the first user-trust preset root.
 * @param ctx - Cordis root context of the row mounting this entry.
 * @param config - resolved row config (bin, stateDir, daemonSocket, maxDelegations).
 */
export function apply(ctx: Context, config: Config): void {
  materializePresetOnBoot(ctx)
  new PrimeOrchestration(ctx, config)
  ctx.inject(['webServer'], (webCtx: Context) => {
    installLayoutOverride(webCtx)
  })
}
