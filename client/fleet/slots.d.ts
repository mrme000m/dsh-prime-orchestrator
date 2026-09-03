/**
 * Compile-time slot/locale surface for the fleet sources in this folder.
 *
 * The runtime registrations (the 'prime' column occupant, the sidebar-foot
 * trigger, and the 'prime' dictionary) moved to the harness core's
 * `@deepseek-ai/dsh-client-ui-prime` package — see client/index.tsx. These
 * sources remain as the reference fleet implementation for compositions
 * without the core package, so they keep a local, type-only view of the
 * slot contracts they were written against: the layout package's SlotMap
 * merge (the 'prime' column), the sidebar package's merge (the footer
 * action slot), and this folder's dictionary keys under the 'prime'
 * namespace.
 */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PrimeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Prime fleet panel and trigger copy. */
    'prime': PrimeKey
  }
}
