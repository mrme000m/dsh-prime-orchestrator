/**
 * Client-side view of the prime fleet column's deployment contract: the
 * 'prime' SlotMap seat and the two layout controls the installed layout
 * override provides. The override ships the authoritative declarations in
 * its own program (layout-override/src/client); this local mirror types the
 * client bundle against the composed deployment without pulling that
 * program in, whose Context.layout declaration conflicts with the stock
 * layout's inside one TypeScript program.
 */

/** Live fleet-column state from the frame's concession solve (the sidebar contract). */
export interface PrimeOwnerProps {
  /** True when the prime column is closed (the subtree stays mounted at zero width). */
  collapsed: boolean
  /** Rendered column width in px (0 when collapsed). */
  width: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The rightmost fleet column, independent of the current session:
     * running agent instances and background fleets. Occupied by this
     * package's PrimePanel through the layout override's AppFrame.
     */
    'prime': { kind: 'single'; scope: 'root'; owner: PrimeOwnerProps }
  }
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  interface ILayout {
    /** Toggle the fleet column between open and collapsed. */
    togglePrime(): void
    /** Collapse the fleet column. */
    closePrime(): void
  }
}
