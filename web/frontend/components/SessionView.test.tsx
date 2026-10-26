import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalPane } from '@/lib/hooks/use-terminal-panes'
import type { TerminalSession } from '@/lib/hooks/use-terminal-sessions'
import {
  getSlotSessionId,
  type PaneSlot,
  paneToSlot,
  sessionToSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import {
  OWN_TMUX_CAN,
  ROOT_CAN,
  SESSION_BASE,
  SLOT_BASE,
  TETHER_CAN,
} from '@/test-stubs/session-fixtures'
import { SessionView, type SessionViewProps } from './SessionView'

function session(
  id: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    ...SESSION_BASE,
    id,
    name: id,
    project_id: 'project-1',
    working_dir: '/tmp/project-1',
    mode: 'codex',
    is_alive: true,
    is_external: false,
    source: 'tether',
    ...overrides,
  }
}

function projectPane(
  paneId: string,
  overrides: Partial<TerminalSession> = {},
): TerminalPane {
  return {
    id: paneId,
    pane_type: 'project',
    project_id: 'project-1',
    pane_order: 0,
    pane_name: 'Project 1',
    active_mode: 'codex',
    is_detached: false,
    created_at: null,
    sessions: [session(`${paneId}-session`, overrides)],
    width_percent: 100,
    height_percent: 100,
    grid_row: 0,
    grid_col: 0,
  }
}

/** An Own tmux session shown as a free-standing View. */
function ownTmuxView(): TerminalSlot {
  return sessionToSlot(
    session('external-codex', {
      ...OWN_TMUX_CAN,
      name: 'codex-agent-hub',
      project_id: null,
      working_dir: '/home/testuser/agent-hub',
      source: 'tmux_external',
      is_external: true,
    }),
    { as: 'adhoc', place: 'free' },
  )
}

const terminalProps = vi.hoisted(
  () =>
    [] as Array<{
      sessionId: string
      sessionMode?: string
      isVisible?: boolean
    }>,
)
const headerProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)

const sizeHolderHooks = vi.hoisted(() => ({
  change: null as ((holder: string | null) => void) | null,
  claimSize: vi.fn(),
}))

vi.mock('@/components/Terminal', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    TerminalComponent: forwardRef(function MockTerminal(
      {
        sessionId,
        sessionMode,
        isVisible,
        onSizeHolderChange,
      }: {
        sessionId: string
        sessionMode?: string
        isVisible?: boolean
        onSizeHolderChange?: (holder: string | null) => void
      },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        claimSize: sizeHolderHooks.claimSize,
      }))
      terminalProps.push({ sessionId, sessionMode, isVisible })
      sizeHolderHooks.change = onSizeHolderChange ?? null
      return <div data-testid={`terminal-${sessionId}`} />
    }),
  }
})

vi.mock('@/components/terminal-header', () => ({
  UnifiedTerminalHeaderContent: (props: Record<string, unknown>) => {
    headerProps.push(props)
    const slot = props.slot as { paneId?: string; sessionId?: string }
    const id = slot.paneId ?? slot.sessionId ?? 'unknown'
    return <div data-testid={`terminal-header-${id}`} />
  },
}))

vi.mock('./KeptCheckIns', () => ({ KeptCheckIns: () => null }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({ agentTools: [] }),
}))

vi.mock('@/lib/hooks/use-terminal-panes', () => ({
  usePaneListError: () => ({ isError: false, retry: vi.fn() }),
}))

vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => ({ forSlot: () => null, needsYouCount: 0 }),
}))

function renderView(
  props: Partial<SessionViewProps> & { slots: SessionViewProps['slots'] },
) {
  terminalProps.length = 0
  headerProps.length = 0
  return render(<SessionView fontSize={14} {...props} />)
}

/** Each slot shown as the active session, one after another. */
function headersFor(
  slots: Array<TerminalSlot | PaneSlot>,
  props: Partial<SessionViewProps> = {},
) {
  const all: Array<Record<string, unknown>> = []
  for (const slot of slots) {
    const view = renderView({
      ...props,
      slots: [slot],
      activeSessionId: getSlotSessionId(slot),
    })
    all.push(headerProps[headerProps.length - 1] as Record<string, unknown>)
    view.unmount()
  }
  return all
}

function ownSlot(id: string): PaneSlot {
  return {
    type: 'project',
    ...SLOT_BASE,
    paneId: `pane-${id}`,
    projectId: 'project-1',
    projectName: `Project ${id}`,
    rootPath: '/tmp/project-1',
    activeMode: 'shell',
    activeSessionId: `session-${id}`,
    sessionBadge: null,
  }
}

describe('SessionView', () => {
  it('names the device holding the size while connected, and Use here takes it back', () => {
    const statuses = new Map([['session-1', 'connected' as const]])
    renderView({ slots: [ownSlot('1')], terminalStatuses: statuses })
    expect(screen.queryByTestId('size-holder-notice')).toBeNull()

    act(() => sizeHolderHooks.change?.('Chrome on Android'))
    expect(screen.getByText('Viewing on Chrome on Android')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use here' }))
    expect(sizeHolderHooks.claimSize).toHaveBeenCalledTimes(1)

    act(() => sizeHolderHooks.change?.(null))
    expect(screen.queryByTestId('size-holder-notice')).toBeNull()
  })

  it('shows only the active session, with every session in its switcher', () => {
    const slots = [ownSlot('1'), ownSlot('2'), ownTmuxView()]
    renderView({ slots, activeSessionId: 'session-2' })

    expect(terminalProps.map((p) => p.sessionId)).toEqual(['session-2'])
    expect(headerProps[0]?.allSlots).toBe(slots)
  })

  it("with nothing chosen, shows one of the user's own sessions", () => {
    renderView({ slots: [ownTmuxView(), ownSlot('1')] })

    expect(terminalProps.map((p) => p.sessionId)).toEqual(['session-1'])
  })

  it("never opens another agent's session unasked: lists it with New session", () => {
    const onSwitch = vi.fn()
    const onNewSession = vi.fn()
    const view = ownTmuxView()
    renderView({ slots: [view], onSwitch, onNewSession })

    expect(terminalProps).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNewSession).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /codex-agent-hub/ }))
    expect(onSwitch).toHaveBeenCalledWith(view)
  })

  it('offers Reset and End only where the backend allows them', () => {
    const onReset = vi.fn()
    const onCloseSession = vi.fn()
    const slots: Array<TerminalSlot | PaneSlot> = [
      paneToSlot(projectPane('pane-agent', { ...TETHER_CAN })),
      paneToSlot(projectPane('pane-root', { ...ROOT_CAN, is_root: true })),
      paneToSlot({
        ...projectPane('pane-adhoc-root', { ...ROOT_CAN, is_root: true }),
        pane_type: 'adhoc',
        project_id: null,
      }),
      // A free-standing Tether View: the session can be respawned, but a
      // View that no pane shows never offers Reset.
      sessionToSlot(
        session('free-tether', { ...TETHER_CAN, is_external: true }),
        { as: 'adhoc', place: 'free' },
      ),
      ownTmuxView(),
    ]

    const headers = headersFor(slots, { onReset, onCloseSession })

    expect(headers.map((props) => typeof props.onReset)).toEqual([
      'function',
      'undefined',
      'undefined',
      'undefined',
      'undefined',
    ])
    // Aico never ends an Own tmux session.
    expect(headers.map((props) => typeof props.onCloseSession)).toEqual([
      'function',
      'function',
      'function',
      'function',
      'undefined',
    ])
    ;(headers[0]?.onReset as () => void)?.()
    expect(onReset).toHaveBeenCalledWith(slots[0])
  })

  it('routes upload to the session and offers redraw without a parent callback', () => {
    const onUpload = vi.fn()
    const [header] = headersFor([ownTmuxView()], { onUpload })

    ;(header?.onUpload as () => void)?.()
    expect(onUpload).toHaveBeenCalledWith('external-codex')
    expect(header?.onRefresh).toBeTypeOf('function')
  })
})
