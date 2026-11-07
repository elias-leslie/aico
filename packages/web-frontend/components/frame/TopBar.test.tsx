import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  markAnswered,
  markFailed,
  resetServerReachForTest,
} from '@/lib/frame/server-reach'
import { publishShownSession } from '@/lib/frame/shown-session'
import type { Frame } from './FrameContext'
import { TopBar } from './TopBar'

const state = vi.hoisted(() => ({
  frame: null as Partial<Frame> | null,
  refetch: vi.fn(),
  popOut: vi.fn(() => true),
  openNeedsYou: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('./FrameContext', () => ({ useFrame: () => state.frame }))
vi.mock('@tanstack/react-query', async (real) => ({
  ...(await real<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ refetchQueries: state.refetch }),
}))
vi.mock('@/lib/hooks/use-asks', () => ({
  useOwnerAsks: () => ({ asks: [{ id: 'a' }, { id: 'b' }] }),
  useApprovals: () => ({ approvals: { taps: [{ id: 't' }] } }),
  openAsks: (asks: unknown[]) => asks,
}))
vi.mock('@/lib/hooks/use-status', () => ({
  useStatus: () => ({
    view: {
      generated_at: new Date().toISOString(),
      summary: { worst: 'warn', problems: 2 },
      rows: [
        {
          id: 'usage/claude',
          what: 'Claude usage',
          meaning: '82% left this week.',
          state: 'ok',
          shown: 'ok',
        },
      ],
    },
    failed: false,
    stale: false,
  }),
}))
vi.mock('@/lib/status', async (real) => ({
  ...(await real<typeof import('@/lib/status')>()),
  summaryLine: () => '2 problems',
}))
vi.mock('@/lib/notes-window', () => ({ popOutNotes: state.popOut }))
vi.mock('../asks/NeedsYou', () => ({ openNeedsYou: state.openNeedsYou }))
vi.mock('../AgentIcon', () => ({
  AgentIcon: () => null,
  getAgentColor: () => '',
}))

const frame = (patch: Partial<Frame> = {}): Partial<Frame> => ({
  docked: true,
  tier: 'rail',
  setTier: vi.fn(),
  setSheetOpen: vi.fn(),
  open: vi.fn(),
  ...patch,
})

beforeEach(() => {
  state.frame = frame()
  publishShownSession({
    id: 's1',
    name: 'aico',
    agent: 'claude',
    agentName: 'Claude',
    status: 'connected',
    attention: null,
  })
})
afterEach(() => {
  resetServerReachForTest()
  publishShownSession(null)
  vi.clearAllMocks()
})

describe('TopBar', () => {
  it('leads with the session on screen and its state', () => {
    render(<TopBar />)
    const session = screen.getByTestId('top-bar-session')
    expect(session).toHaveTextContent('aico')
    expect(session).toHaveTextContent('Live')
    fireEvent.click(session)
    expect(state.frame?.setTier).toHaveBeenCalledWith('panel')
  })

  it('counts questions and approvals in Needs you and opens it in the panel', () => {
    render(<TopBar />)
    const needs = screen.getByTestId('top-bar-needs-you')
    expect(needs).toHaveAttribute('data-count', '3')
    fireEvent.click(needs)
    expect(state.frame?.setTier).toHaveBeenCalledWith('panel')
    expect(state.openNeedsYou).toHaveBeenCalled()
  })

  it('opens health and quota beside the session, and Notes in its own window on a new note', () => {
    render(<TopBar />)
    expect(screen.getByTestId('top-bar-health')).toHaveTextContent('2problems')
    fireEvent.click(screen.getByTestId('top-bar-health'))
    expect(state.frame?.open).toHaveBeenCalledWith('/status', 'wide')
    expect(screen.getByTestId('top-bar-quota')).toHaveTextContent('Claude 82%')
    fireEvent.click(screen.getByTestId('top-bar-quota'))
    expect(state.frame?.open).toHaveBeenCalledWith('/status?q=usage', 'wide')
    fireEvent.click(screen.getByTestId('top-bar-notes'))
    expect(state.popOut).toHaveBeenCalledWith('/notes?new=note')
  })

  it('when the server is gone, says since when with Retry in health’s place', () => {
    render(<TopBar />)
    act(() => {
      const today = new Date()
      today.setHours(9, 5, 0, 0)
      markAnswered(today.getTime())
      markFailed()
    })
    expect(screen.queryByTestId('top-bar-health')).toBeNull()
    expect(screen.getByTestId('top-bar')).toHaveTextContent(
      /Offline · can’t reach Aico since 9:05\s?AM/,
    )
    fireEvent.click(screen.getByTestId('top-bar-retry'))
    expect(state.refetch).toHaveBeenCalledWith({ type: 'active' })
  })

  it('on a phone, keeps the menu with the Needs you count and leaves quota and Notes to the sheet', () => {
    state.frame = frame({ docked: false })
    render(<TopBar />)
    const menu = screen.getByTestId('frame-menu')
    expect(menu).toHaveAccessibleName(/3 need you/)
    fireEvent.click(menu)
    expect(state.frame?.setSheetOpen).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId('top-bar-quota')).toBeNull()
    expect(screen.queryByTestId('top-bar-notes')).toBeNull()
  })
})
