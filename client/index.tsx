/**
 * dsh-prime-orchestrator — browser half: the Prime fleet column plus its
 * sidebar-foot trigger, and the Settings → Prime Orchestration section, in
 * one plugin.
 *
 * The fleet seats register only after a same-origin probe confirms the
 * host `/prime` API is mounted — a deployment without the host row carries
 * zero footprint (no toggle, no column, no polling). The settings section
 * registers through `ctx.inject` on the settings shell's scope service, so
 * a composition without the settings UI skips the section without stalling
 * the fleet.
 *
 * @module dsh-prime-orchestrator/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the 'prime' SlotMap merge + ctx.layout contract in.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the 'sidebar.footer.action' SlotMap merge in.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section') and ctx.settingsScope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.remote/ctx.connection merges the scope binder needs.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createPrimeApi, type PrimeApi } from './fleet/api.ts'
import { createPrimeStore } from './fleet/store.ts'
import { PrimePanel, type PrimePanelInjected } from './fleet/PrimePanel.tsx'
import { PrimeToggle, type PrimeToggleInjected } from './fleet/PrimeToggle.tsx'
import { en as fleetEn, zh as fleetZh, type PrimeKey } from './fleet/locales.ts'
import { PrimeOrchestrationSection } from './settings/PrimeOrchestrationSection.tsx'
import {
  PRIME_SETTINGS_NS, PrimeOrchestrationController, type PrimeOrchestrationSectionInjected,
} from './settings/section-store.ts'
import { en as settingsEn, zh as settingsZh, type PrimeOrchestrationKey } from './settings/locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Prime fleet panel and trigger copy. */
    'prime': PrimeKey
    /** Prime-orchestration settings section copy. */
    'settings.primeOrchestration': PrimeOrchestrationKey
  }
}

/** Dictionary namespaces owned by this plugin. */
const FLEET_NS = 'prime'
const SETTINGS_NS = 'settings.primeOrchestration'

/** Required services: slot registration, copy, and panel geometry. */
export const inject = ['slots', 'locale', 'layout']

/**
 * Probe the host API once; register the fleet seats only when it answers.
 * @param ctx - client root context.
 * @param api - the minted api face (the probe rides the same transport).
 */
function probeAndRegister(ctx: ClientContext, api: PrimeApi): void {
  void api.state().then(
    () => {
      // The fiber may have unloaded while the probe was in flight; a
      // registration onto a dead plugin would throw, and there is nothing
      // to register for anymore.
      try {
        ctx.effect(() => registerSeats(ctx, api), 'prime-orchestrator: seats (probe passed)')
      } catch {
        // Plugin already unloaded — the probe lost the race, nothing to do.
      }
    },
    () => {
      // Host row absent: no seats, no polling, zero footprint.
    })
}

/** Register the column occupant and the sidebar trigger over one shared store. */
function registerSeats(ctx: ClientContext, api: PrimeApi): () => void {
  const store = createPrimeStore()
  const disposePanel = ctx.slots.inject('prime', () => ctx.slots.register({
    name: 'prime',
    store,
    locale: FLEET_NS,
    inject: (): PrimePanelInjected => ({
      api,
      close: () => { ctx.layout.closePrime() },
    }),
  }, PrimePanel))
  const disposeToggle = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'prime',
    order: 10,
    store,
    locale: FLEET_NS,
    inject: (): PrimeToggleInjected => ({
      toggle: () => { ctx.layout.togglePrime() },
    }),
  }, PrimeToggle))
  return () => {
    disposePanel()
    disposeToggle()
  }
}

/**
 * Client plugin body: dictionaries always; the fleet seats after the probe;
 * the settings section once the settings shell's scope service appears.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(FLEET_NS, { zh: fleetZh, en: fleetEn }), 'prime-orchestrator: fleet dictionaries')
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh: settingsZh, en: settingsEn }), 'prime-orchestrator: settings dictionaries')

  probeAndRegister(ctx, createPrimeApi())

  // Scoped registration: a composition without the settings UI (or without
  // the remote/connection services backing the scope binder) keeps the fleet
  // working and simply carries no section.
  ctx.inject(['settingsScope', 'remote', 'connection'], (scoped: ClientContext) => {
    const controller = new PrimeOrchestrationController(
      scoped.settingsScope.bind({ namespace: PRIME_SETTINGS_NS }),
    )

    const sectionInjected = (): PrimeOrchestrationSectionInjected => ({
      hooks: { primeSettings: controller.store },
      setDraft: controller.setDraft.bind(controller),
      reset: () => controller.reset(),
      save: () => controller.save(),
    })

    scoped.effect(() => scoped.slots.inject('settings.section', () => scoped.slots.register({
      name: 'settings.section',
      id: 'prime-orchestration',
      order: 30,
      label: () => scoped.locale.bind(SETTINGS_NS)('nav'),
      locale: SETTINGS_NS,
      inject: sectionInjected,
    }, PrimeOrchestrationSection)), 'prime-orchestrator: settings section')
  })
}
