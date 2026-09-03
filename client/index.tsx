/**
 * dsh-prime-orchestrator — browser half: the Settings → Prime Orchestration
 * section. The Prime fleet column and sidebar-foot trigger live in the harness
 * core's `@deepseek-ai/dsh-client-ui-prime` package, which owns the `prime`
 * locale namespace and the `prime` layout slot; this plugin must not duplicate
 * either.
 *
 * The settings section registers through `ctx.inject` on the settings shell's
 * scope service, so a composition without the settings UI skips the section
 * without stalling.
 *
 * @module dsh-prime-orchestrator/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section') and ctx.settingsScope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.remote/ctx.connection merges the scope binder needs.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { PrimeOrchestrationSection } from './settings/PrimeOrchestrationSection.tsx'
import {
  PRIME_SETTINGS_NS, PrimeOrchestrationController, type PrimeOrchestrationSectionInjected,
} from './settings/section-store.ts'
import { en as settingsEn, zh as settingsZh, type PrimeOrchestrationKey } from './settings/locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Prime-orchestration settings section copy. */
    'settings.primeOrchestration': PrimeOrchestrationKey
  }
}

/** Dictionary namespace owned by this plugin. */
const SETTINGS_NS = 'settings.primeOrchestration'

/** Required service: copy for the settings dictionaries. */
export const inject = ['locale']

/**
 * Client plugin body: dictionaries always; the settings section once the
 * settings shell's scope service appears.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh: settingsZh, en: settingsEn }), 'prime-orchestrator: settings dictionaries')

  // Scoped registration: a composition without the settings UI (or without
  // the remote/connection services backing the scope binder) carries no section.
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
