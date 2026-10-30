import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { TerminalTabs } from './TerminalTabs'

const endSession = vi.hoisted(() => vi.fn())
const sessions = vi.hoisted(() => ({
  list: [{ id: 'session-a', name: 'Work shell' }] as Array<
    Record<string, unknown>
  >,
}))
const slots = vi.hoisted(() => ({
  list: [] as unknown[],
  ending: null as unknown,
}))
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
    sessions: sessions.list,
    terminalSlots: slots.list,
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
    <button
      type="button"
      onClick={() => onSlotCloseSession((slots.ending as TerminalSlot) ?? slot)}
    >
      End control
    </button>
  ),
}))
vi.mock('./NewSessionDialog', () => ({ NewSessionDialog: () => null }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({
    agentTools: [{ slug: 'pi', name: 'Pi' }],
  }),
}))

describe('TerminalTabs session controls', () => {
  beforeEach(() => {
    endSession.mockReset()
    sessions.list = [{ id: 'session-a', name: 'Work shell' }]
    slots.list = [slot]
    slots.ending = null
  })

  it('names the session as its row does, with its agent and host', () => {
    // Two remote Pi sessions share a name; the second is the one to end.
    const first: TerminalSlot = {
      ...slot,
      sessionId: 'session-0',
      name: 'Agent-Hub',
      sessionMode: 'pi',
      host: 'agent-work',
      createdAt: '2026-10-30T10:00:00Z',
    }
    const second: TerminalSlot = {
      ...first,
      sessionId: 'session-a',
      createdAt: '2026-10-30T11:00:00Z',
    }
    slots.list = [first, second]
    slots.ending = second
    render(<TerminalTabs />)
    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    expect(
      screen.getByText(
        'End “Agent-Hub #2” (Pi on agent-work)? This stops its process in every view.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // One on this computer says so.
    slots.list = [slot]
    slots.ending = slot
    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    expect(
      screen.getByText(/^End “Work shell” \(Shell on this computer\)\?/),
    ).toBeInTheDocument()
  })

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

  it('offers no keep option when the session has no check-ins', () => {
    render(<TerminalTabs />)
    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    expect(screen.queryByText(/check-in/)).not.toBeInTheDocument()
  })

  it('says ending cancels a check-in and offers to keep it', async () => {
    sessions.list = [
      {
        id: 'session-a',
        name: 'Work shell',
        check_ins: [{ id: 'aaaaaaaaaaaa', due_at: 1, time: '5:30 PM' }],
      },
    ]
    endSession.mockResolvedValue(undefined)
    render(<TerminalTabs />)
    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    expect(
      screen.getByText(/This also cancels its check-in at 5:30 PM\./),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'End, keep check-in' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    expect(endSession).toHaveBeenCalledWith(slot, { keepCheckIns: true })

    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(endSession).toHaveBeenCalledTimes(2))
    expect(endSession).toHaveBeenLastCalledWith(slot, { keepCheckIns: false })
  })

  it('uses plurals for several check-ins', () => {
    sessions.list = [
      {
        id: 'session-a',
        name: 'Work shell',
        check_ins: [
          { id: 'a', due_at: 1, time: '5:30 PM' },
          { id: 'b', due_at: 2, time: 'Tue 9:00 AM' },
        ],
      },
    ]
    render(<TerminalTabs />)
    fireEvent.click(screen.getByRole('button', { name: 'End control' }))
    expect(
      screen.getByText(
        /cancels its check-ins at 5:30 PM and Tue 9:00 AM\. Keep them/,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'End, keep check-ins' }),
    ).toBeInTheDocument()
  })
})
