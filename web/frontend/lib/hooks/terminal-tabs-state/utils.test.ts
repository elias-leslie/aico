import { describe, expect, it } from 'vitest'
import {
  getOrderedIds,
  orderTerminalSlots,
  reconcileOrderedIds,
  swapOrderedIds,
} from './utils'
import type { PaneSlot } from '@/lib/utils/slot'

function makePaneSlot(paneId: string, name: string): PaneSlot {
  return {
    type: 'project',
    paneId,
    projectId: `${paneId}-project`,
    projectName: name,
    rootPath: `/workspace/${paneId}`,
    activeMode: 'shell',
    activeSessionId: `${paneId}-session`,
    sessionBadge: null,
  }
}

describe('terminal-tabs-state utils', () => {
  it('reconciles stored order with the current visible slots', () => {
    const slots = [makePaneSlot('pane-a', 'Alpha'), makePaneSlot('pane-b', 'Beta')]

    expect(reconcileOrderedIds(slots, ['pane-pane-b', 'missing-slot'])).toEqual([
      'pane-pane-b',
      'pane-pane-a',
    ])
  })

  it('orders visible slots using the reconciled ids', () => {
    const slots = [makePaneSlot('pane-a', 'Alpha'), makePaneSlot('pane-b', 'Beta')]
    const ordered = orderTerminalSlots(slots, ['pane-pane-b', 'pane-pane-a'])

    expect(getOrderedIds(ordered)).toEqual(['pane-pane-b', 'pane-pane-a'])
  })

  it('swaps two visible slot ids', () => {
    expect(
      swapOrderedIds(
        ['pane-pane-a', 'adhoc-external-one', 'adhoc-external-two'],
        'adhoc-external-one',
        'adhoc-external-two',
      ),
    ).toEqual(['pane-pane-a', 'adhoc-external-two', 'adhoc-external-one'])
  })
})
