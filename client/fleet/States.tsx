// States: the shared quiet-state presenters for the fleet column — the
// shimmer skeleton rows shown while a list is loading and the icon-led
// empty state shown when a list settles with nothing to show. Pure
// presentation over the shared CSS module; lists keep their own data.

import clsx from 'clsx'
import type { ReactNode } from 'react'
import css from './PrimePanel.module.css'

/** SkeletonRows props: row count and the accessibility label. */
export interface SkeletonRowsProps {
  /** How many placeholder rows to render. */
  rows?: number
  /** Accessible label for the placeholder group. */
  label: string
}

/**
 * Render shimmering placeholder rows for a loading list.
 * @param props - row count + label.
 * @returns the placeholder group.
 */
export function SkeletonRows({ rows = 4, label }: SkeletonRowsProps) {
  return (
    <div className={css.skeletonGroup} role="status" aria-label={label}>
      {Array.from({ length: Math.max(1, rows) }, (_, index) => (
        <div key={index} className={css.skeletonRow} aria-hidden>
          <span className={clsx(css.skeletonLine, css.skeletonTitle)} />
          <span className={clsx(css.skeletonLine, css.skeletonText)} />
          <span className={clsx(css.skeletonLine, css.skeletonTextShort)} />
        </div>
      ))}
    </div>
  )
}

/** EmptyState props: the leading icon plus the message pair. */
export interface EmptyStateProps {
  /** Small leading icon element. */
  icon: ReactNode
  /** The bold first line. */
  title: string
  /** The quiet explanatory second line, when one helps. */
  body?: string
}

/**
 * Render the icon-led empty state for a settled-empty list.
 * @param props - icon + title + optional body.
 * @returns the empty-state block.
 */
export function EmptyState({ icon, title, body }: EmptyStateProps) {
  return (
    <div className={css.emptyState}>
      <span className={css.emptyIcon} aria-hidden>{icon}</span>
      <div className={css.emptyTitle}>{title}</div>
      {body !== undefined && <div className={css.emptyBody}>{body}</div>}
    </div>
  )
}
