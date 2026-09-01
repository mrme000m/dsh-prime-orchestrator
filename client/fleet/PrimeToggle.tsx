// PrimeToggle: the Prime fleet trigger at the sidebar foot — a labeled row
// while the sidebar is wide, an icon button on the collapsed rail. The
// running-delegation badge rides the shared feed store (the panel's poll is
// the writer), so the column's live state is visible before opening it.

import clsx from 'clsx'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createPrimeStore } from './store.ts'
import { runningCount } from './store.ts'
import css from './PrimeToggle.module.css'

/** Injected share: the open/toggle transition through the layout service. */
export interface PrimeToggleInjected {
  /** Toggle the fleet column (closed ⟷ contract default width). */
  toggle: () => void
}

/** Full toggle props: runtime share (sidebar column state) + store seat + inject face + locale seat. */
export type PrimeToggleProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createPrimeStore>>
  & PrimeToggleInjected
  & PropsLocale<'prime'>

/**
 * Render the sidebar-foot fleet trigger.
 * @param props - composed slot props (sidebar wide flag, feed store, toggle, locale).
 * @returns the trigger element tree.
 */
export function PrimeToggle({ wide, useStore, toggle, t }: PrimeToggleProps) {
  const running = useStore(s => runningCount(s.feed))
  return (
    <button
      type="button"
      className={clsx(css.toggle, !wide && css.rail)}
      aria-label={t('toggle.aria')}
      title={running > 0 ? t('toggle.badge', { n: running }) : t('toggle.label')}
      onClick={toggle}
    >
      <IconAgentPresetOutline16 size={wide ? 16 : 18} />
      {wide && <span className={css.label}>{t('toggle.label')}</span>}
      {running > 0 && <span className={clsx(css.badge, !wide && css.badgeRail)}>{running}</span>}
    </button>
  )
}
