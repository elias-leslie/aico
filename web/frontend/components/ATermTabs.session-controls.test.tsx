import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ATermSlot } from '@/lib/utils/slot'
import { ATermTabs } from './ATermTabs'

const endSession = vi.hoisted(() => vi.fn())
const slot: ATermSlot = {
  type: 'adhoc',
  sessionId: 'session-a',
  name: 'Work shell',
  workingDir: '/tmp',
  sessionMode: 'shell',
}

vi.mock('@/lib/hooks/use-a-term-orchestration', () => ({
  useATermOrchestration: () => ({
    isLoading: false,
    sessions: [{ id: 'session-a', name: 'Work shell' }],
    canAddPane: () => true,
    handleSlotCloseSession: endSession,
  }),
}))
vi.mock('@/lib/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => undefined,
}))
vi.mock('./ATermContent', () => ({
  ATermContent: ({
    onSlotCloseSession,
  }: {
    onSlotCloseSession: (slot: ATermSlot) => void
  }) => (
    <button type="button" onClick={() => onSlotCloseSession(slot)}>
      End control
    </button>
  ),
}))
vi.mock('./ATermManagerModal', () => ({ ATermManagerModal: () => null }))
vi.mock('./KeyboardShortcuts', () => ({ KeyboardShortcuts: () => null }))

describe('ATermTabs session controls', () => {
  beforeEach(() => endSession.mockReset())

  it('requires confirmation and leaves the view available on a failed end request', async () => {
    endSession.mockRejectedValueOnce(new Error('Session owner unavailable'))
    render(<ATermTabs />)

    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    expect(endSession).not.toHaveBeenCalled()
    expect(
      screen.getByText(/stops its process in every view/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Session owner unavailable',
    )
    expect(screen.getByText('End control')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    endSession.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    expect(endSession).toHaveBeenCalledTimes(2)
  })

  it('cancels without ending the session', () => {
    render(<ATermTabs />)
    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(endSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
