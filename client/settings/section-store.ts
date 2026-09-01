/**
 * Prime Orchestration settings controller — bridges the `prime-orchestrator`
 * settings namespace onto a staged draft form. The browser half mirrors the
 * host namespace through a {@link SettingsScope}; the section stages what the
 * user types and writes it only on save, so what is on screen is exactly what
 * a save would store (each settings write is a durable, revision-fenced
 * document mutation, not a per-keystroke commit).
 *
 * The namespace is flat by design: the scope's `set(field, value)` writes one
 * scalar field inside the section, and nested objects would need a
 * scope-internal merge this seam does not expose. Host-side field names mirror
 * the `prime-orchestrator` settings schema owned by
 * `@deepseek-ai/dsh-prime-orchestration`.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** The prime-orchestrator settings namespace on the host wire. */
export const PRIME_SETTINGS_NS = 'prime-orchestrator'

/** One section field, as the host schema resolves it (defaults inlined). */
export interface PrimeSettingsValue {
  /** Enable/disable switch for the orchestration feature. */
  enabled: boolean
  /** Upper bound on concurrent delegations one session may run. */
  maxDelegations: number
  /** prime-agent executable name or absolute path. */
  bin: string
  /** Delegation state directory; empty uses the service default. */
  stateDir: string
  /** Daemon socket override; empty uses the default / env var. */
  daemonSocket: string
  /** Heartbeat report interval in ms; 0 inherits the service default. */
  heartbeatIntervalMs: number
  /** Heartbeat staleness threshold in ms; 0 inherits the service default. */
  heartbeatTimeoutMs: number
  /** Model id for delegated sessions; empty inherits the orchestrator's. */
  delegateModel: string
  /** Provider key for delegated sessions; empty inherits the orchestrator's. */
  delegateProvider: string
  /** Thinking level for delegated sessions; '' inherits the orchestrator's. */
  delegateThinking: string
  /** Token budget bound to a persistent goal; 0 = unset. */
  delegateGoalTokenBudget: number
  /** Bound delegated sessions as autonomous by default. */
  delegateAutonomous: boolean
  /** Cap on autonomous continuation turns; 0 = unset / inherits default. */
  delegateAutonomousMaxContinuations: number
}

/** The empty/default section — also the shape the scope decodes toward. */
export const EMPTY_VALUE: PrimeSettingsValue = {
  enabled: true,
  maxDelegations: 8,
  bin: '',
  stateDir: '',
  daemonSocket: '',
  heartbeatIntervalMs: 0,
  heartbeatTimeoutMs: 0,
  delegateModel: '',
  delegateProvider: '',
  delegateThinking: '',
  delegateGoalTokenBudget: 0,
  delegateAutonomous: false,
  delegateAutonomousMaxContinuations: 0,
}

const KEYS = Object.keys(EMPTY_VALUE) as (keyof PrimeSettingsValue)[]

/** Sync state the section renders. */
export type PrimeSettingsStatus = 'loading' | 'ready' | 'unavailable'

/** The section's reactive state. */
export interface PrimeSettingsState {
  /** Namespace sync status from the bound scope. */
  status: PrimeSettingsStatus
  /** Whether the host document accepts writes. */
  writable: boolean
  /** Effective resolved value (user layer over composition over schema). */
  value: PrimeSettingsValue
  /** Staged edits; follows `value` while the draft is clean. */
  draft: PrimeSettingsValue
  /** Whether `draft` differs from `value` (a save would change something). */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Last save failure message (without prefix), or null. */
  error: string | null
  /** Transient "Saved" flag, cleared by the next edit. */
  justSaved: boolean
}

const INITIAL: PrimeSettingsState = {
  status: 'loading',
  writable: false,
  value: EMPTY_VALUE,
  draft: EMPTY_VALUE,
  dirty: false,
  saving: false,
  error: null,
  justSaved: false,
}

/** Human text for a rejected wire call. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether two sections differ on any field. */
function differs(a: PrimeSettingsValue, b: PrimeSettingsValue): boolean {
  for (const k of KEYS) if (a[k] !== b[k]) return true
  return false
}

/** Field keys whose draft differs from the effective value (the save set). */
function changedKeys(a: PrimeSettingsValue, b: PrimeSettingsValue): string[] {
  return KEYS.filter(k => a[k] !== b[k]).map(String)
}

/**
 * Bridges the `prime-orchestrator` scope onto the section's staged draft form.
 *
 * The scope is the single source of truth for `value`; the controller only
 * owns the draft (the user's staged edits) and the save flow. A concurrent
 * host-side change while the draft is dirty does NOT clobber the draft — the
 * edit is the user's, and the next clean sync re-follows the host.
 */
export class PrimeOrchestrationController {
  readonly store: SnapshotStore<PrimeSettingsState> = createSnapshotStore(INITIAL)
  private readonly scope: SettingsScope<PrimeSettingsValue>
  private readonly unsubscribe: () => void

  /** @param scope - the bound settings scope for the `prime-orchestrator` namespace. */
  constructor(scope: SettingsScope<PrimeSettingsValue>) {
    this.scope = scope
    this.unsubscribe = scope.subscribe(() => this.sync())
  }

  /** Re-read the scope snapshot into the store, preserving a dirty draft. */
  private sync(): void {
    const snap = this.scope.getSnapshot()
    const value = snap.value ?? EMPTY_VALUE
    const cur = this.store.getSnapshot()
    const draft = cur.dirty ? cur.draft : value
    this.store.update(s => {
      s.status = snap.status
      s.writable = snap.writable
      s.value = value
      s.draft = draft
      s.dirty = cur.dirty && differs(value, draft)
      s.justSaved = false
    })
  }

  /** Stage one field's new value into the draft. */
  setDraft<K extends keyof PrimeSettingsValue>(field: K, value: PrimeSettingsValue[K]): void {
    this.store.update(s => {
      s.draft[field] = value
      s.dirty = differs(s.value, s.draft)
      s.error = null
      s.justSaved = false
    })
  }

  /** Discard the draft and re-follow the host value. */
  reset(): void {
    this.store.update(s => {
      s.draft = s.value
      s.dirty = false
      s.error = null
      s.justSaved = false
    })
  }

  /** Write every changed field through the scope, one revision-fenced write each. */
  async save(): Promise<void> {
    const cur = this.store.getSnapshot()
    if (!cur.dirty || !cur.writable || cur.saving) return
    const keys = changedKeys(cur.value, cur.draft)
    this.store.update(s => { s.saving = true; s.error = null })
    try {
      for (const k of keys) {
        await this.scope.set(k, cur.draft[k as keyof PrimeSettingsValue])
      }
      this.store.update(s => { s.saving = false; s.dirty = false; s.justSaved = true; s.error = null })
    } catch (error) {
      this.store.update(s => { s.saving = false; s.error = messageOf(error) })
    }
  }

  /** Tear down the scope subscription. */
  dispose(): void {
    this.unsubscribe()
  }
}

/** The registration-side face the section's slot entry injects. */
export interface PrimeOrchestrationSectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as usePrimeSettings. */
    primeSettings: SnapshotStore<PrimeSettingsState>
  }
  /** Stage one field's draft. */
  setDraft: PrimeOrchestrationController['setDraft']
  /** Discard the draft. */
  reset: () => void
  /** Write the staged draft. */
  save: () => Promise<void>
}
