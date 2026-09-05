/**
 * dsh-prime-orchestrator — browser half: the pending-questions banner. The
 * Prime fleet column, sidebar-foot trigger, and the Settings → Prime
 * Orchestration section live in the harness core's `@deepseek-ai/dsh-client-ui-prime`
 * and `@deepseek-ai/dsh-client-ui-prime-settings` packages, which own the
 * `prime` and `settings.primeOrchestration` locale namespaces; this plugin
 * must not duplicate any of them.
 *
 * @module dsh-prime-orchestrator/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PendingQuestionsBadge, type PendingQuestionsInjected } from './questions/PendingQuestionsBadge.tsx'
import { en as questionsEn, zh as questionsZh } from './questions/locales.ts'

/** Dictionary namespace owned by the pending-questions banner. */
const QUESTIONS_NS = 'primeQuestions'

/** Required services: copy for the banner dictionaries. */
export const inject = ['locale']

/**
 * Client plugin body: dictionaries always; the pending-questions banner once
 * the slots service appears (guarded — the stock three-column layout has no
 * `shell.overlay` seat and must boot without it).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(QUESTIONS_NS, { zh: questionsZh, en: questionsEn }), 'prime-orchestrator: question banner dictionaries')

  // Pending-questions banner: the safety net for ask_user_question delivery.
  // It polls /prime/api/questions over plain HTTP (immune to the dead event
  // socket that loses composer takeovers) and answers inline.
  ctx.inject(['slots', 'locale'], (scoped: ClientContext) => {
    scoped.effect(() => {
      try {
        return scoped.slots.inject('shell.overlay', () => scoped.slots.register({
          name: 'shell.overlay',
          id: 'prime-questions',
          order: 10,
          locale: QUESTIONS_NS,
          inject: (): PendingQuestionsInjected => ({
            openSession: (sessionId: string): void => {
              // The sessions service is not in this plugin's inject list; the
              // host context carries it when the session surface is composed.
              // Named cast (not inline): the probe is structural by design.
              const host = scoped as unknown as { sessions?: { open(id: string): void } }
              host.sessions?.open(sessionId)
            },
          }),
        }, PendingQuestionsBadge))
      } catch (error) {
        // The stock three-column layout declares no shell.overlay seat; the
        // watchdog (host side) still covers auto-answer without the banner.
        console.warn('[prime-orchestrator] shell.overlay slot absent — pending-questions banner disabled:',
          error instanceof Error ? error.message : String(error))
        return () => {}
      }
    }, 'prime-orchestrator: pending-questions banner')
  })
}
