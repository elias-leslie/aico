import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { TerminalTabs } from './TerminalTabs'

const endSession = vi.hoisted(() => vi.fn())
const slot: TerminalSlot = {
  type: 'adhoc',
  ...SLOT_BASE,
  sessionId: 'session-a',
  name: 'Work shell',
  workingDir: '/tmp',
  sessionMode: 'shell',
}

vi.mock('@/lib/hooks/use-terminal-orchestration', () => ({
  useTerminalOrchestration: () => ({
    isLoading: false,
    sessions: [{ id: 'session-a', name: 'Work shell' }],
    handleSlotCloseSession: endSession,
  }),
}))
vi.mock('@/lib/hooks/use-session-attention', () => ({
  useMarkActiveSeen: () => {},
  useAttentionTitle: () => {},
  useSessionAttention: () => ({ forSlot: () => null, needsYouCount: 0 }),
}))

vi.mock('@/lib/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => undefined,
}))
vi.mock('./TerminalContent', () => ({
  TerminalContent: ({
    onSlotCloseSession,
  }: {
    onSlotCloseSession: (slot: TerminalSlot) => void
  }) => (
    <button type="button" onClick={() => onSlotCloseSession(slot)}>
      End control
    </button>
  ),
}))
vi.mock('./NewSessionDialog', () => ({ NewSessionDialog: () => null }))

describe('TerminalTabs session controls', () => {
  beforeEach(() => endSession.mockReset())

  it('requires confirmation and leaves the view available on a failed end request', async () => {
    endSession.mockRejectedValueOnce(new Error('Session owner unavailable'))
    render(<TerminalTabs />)

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
    render(<TerminalTabs />)
    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(endSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
