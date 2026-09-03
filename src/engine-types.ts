/**
 * Type-only re-export of the engine's delegation types for the agent-plane
 * tool entry, kept separate so bundling the tool entry never pulls the
 * engine's runtime (the host row mounts the engine; the tool resolves
 * `ctx.prime` through Cordis DI at runtime).
 * @module dsh-prime-orchestrator/engine-types
 */

export type { PrimeAction, PrimeDelegateRequest, ResolvedIdentity } from './types.ts'
