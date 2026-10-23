import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ATermPane } from '@/lib/hooks/use-a-term-panes'
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import {
  type ATermSlot,
  getSlotPanelId,
  type PaneSlot,
  paneToSlot,
  sessionToSlot,
} from '@/lib/utils/slot'
import {
  OWN_TMUX_CAN,
  ROOT_CAN,
  SESSION_BASE,
  SLOT_BASE,
  TETHER_CAN,
  TETHER_LEGACY_CAN,
} from '@/test-stubs/session-fixtures'
import { usePaneRenderer } from './use-pane-renderer'

function session(
  id: string,
  overrides: Partial<ATermSession> = {},
): ATermSession {
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
  overrides: Partial<ATermSession> = {},
): ATermPane {
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
function ownTmuxView(): ATermSlot {
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

const aTermProps = vi.hoisted(
  () =>
    [] as Array<{
      sessionId: string
      sessionMode?: string
      isVisible?: boolean
    }>,
)
const headerProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('@/components/ATerm', () => ({
  ATermComponent: ({
    sessionId,
    sessionMode,
    isVisible,
  }: {
    sessionId: string
    sessionMode?: string
    isVisible?: boolean
  }) => {
    aTermProps.push({ sessionId, sessionMode, isVisible })
    return <div data-testid={`a-term-${sessionId}`} />
  },
}))

vi.mock('@/components/a-term-header', () => ({
  UnifiedATermHeaderContent: (props: Record<string, unknown>) => {
    headerProps.push(props)
    const slot = props.slot as { paneId?: string; sessionId?: string }
    const id = slot.paneId ?? slot.sessionId ?? 'unknown'
    return <div data-testid={`a-term-header-${id}`} />
  },
}))

function RenderHarness({
  slots,
  onSwapPanes,
  onUpload,
  onReset,
  onCloseSession,
}: {
  slots: Array<ATermSlot | PaneSlot>
  onSwapPanes?: (slotIdA: string, slotIdB: string) => void
  onUpload?: (sessionId?: string) => void
  onReset?: (slot: ATermSlot | PaneSlot) => void
  onCloseSession?: (slot: ATermSlot | PaneSlot) => void
}) {
  const renderPane = usePaneRenderer({
    props: {
      isMobile: false,
      isModeSwitching: false,
      fontFamily: 'monospace',
      fontSize: 14,
      cursorStyle: 'block',
      cursorBlink: true,
      theme: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#333333',
        black: '#000000',
        red: '#ff0000',
        green: '#00ff00',
        yellow: '#ffff00',
        blue: '#0000ff',
        magenta: '#ff00ff',
        cyan: '#00ffff',
        white: '#ffffff',
        brightBlack: '#111111',
        brightRed: '#ff1111',
        brightGreen: '#11ff11',
        brightYellow: '#ffff11',
        brightBlue: '#1111ff',
        brightMagenta: '#ff11ff',
        brightCyan: '#11ffff',
        brightWhite: '#f5f5f5',
      },
      onSwapPanes,
      onUpload,
      onReset,
      onCloseSession,
    },
    displaySlots: slots,
    paneCount: slots.length,
  })

  return (
    <div>
      {slots.map((slot, index) => (
        <div key={getSlotPanelId(slot)}>{renderPane(slot, index)}</div>
      ))}
    </div>
  )
}

describe('usePaneRenderer', () => {
  it('keeps all rendered desktop a-terms visible', () => {
    aTermProps.length = 0
    headerProps.length = 0

    const slots: PaneSlot[] = [
      {
        type: 'project',
        ...SLOT_BASE,
        paneId: 'pane-1',
        projectId: 'project-1',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
        activeMode: 'shell',
        activeSessionId: 'session-1',
        sessionBadge: null,
      },
      {
        type: 'project',
        ...SLOT_BASE,
        paneId: 'pane-2',
        projectId: 'project-2',
        projectName: 'Project 2',
        rootPath: '/tmp/project-2',
        activeMode: 'shell',
        activeSessionId: 'session-2',
        sessionBadge: null,
      },
    ]

    render(<RenderHarness slots={slots} />)

    expect(screen.getByTestId('a-term-session-1')).toBeInTheDocument()
    expect(screen.getByTestId('a-term-session-2')).toBeInTheDocument()
    expect(aTermProps).toEqual([
      {
        sessionId: 'session-1',
        sessionMode: 'shell',
        preferLessDestructiveSnapshots: undefined,
        isVisible: undefined,
      },
      {
        sessionId: 'session-2',
        sessionMode: 'shell',
        preferLessDestructiveSnapshots: undefined,
        isVisible: undefined,
      },
    ])
  })

  it('swaps panes when a dragged pane is dropped anywhere on another pane', () => {
    headerProps.length = 0
    const onSwapPanes = vi.fn()
    const slots: PaneSlot[] = [
      {
        type: 'project',
        ...SLOT_BASE,
        paneId: 'pane-1',
        projectId: 'project-1',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
        activeMode: 'shell',
        activeSessionId: 'session-1',
        sessionBadge: null,
      },
      {
        type: 'project',
        ...SLOT_BASE,
        paneId: 'pane-2',
        projectId: 'project-2',
        projectName: 'Project 2',
        rootPath: '/tmp/project-2',
        activeMode: 'shell',
        activeSessionId: 'session-2',
        sessionBadge: null,
      },
    ]

    render(<RenderHarness slots={slots} onSwapPanes={onSwapPanes} />)

    const paneTarget = screen.getByTestId(
      `pane-drop-target-${getSlotPanelId(slots[1])}`,
    )
    const dataTransfer = {
      types: ['application/x-a-term-pane-slot', 'text/plain'],
      effectAllowed: 'move',
      dropEffect: 'move',
      getData: (type: string) =>
        type === 'application/x-a-term-pane-slot' || type === 'text/plain'
          ? getSlotPanelId(slots[0])
          : '',
    }

    fireEvent.dragOver(paneTarget, { dataTransfer })
    fireEvent.drop(paneTarget, { dataTransfer })

    expect(onSwapPanes).toHaveBeenCalledWith(
      getSlotPanelId(slots[1]),
      getSlotPanelId(slots[0]),
    )
  })

  it('renders pane wrappers that can shrink inside flex layouts', () => {
    const slots: PaneSlot[] = [
      {
        type: 'project',
        ...SLOT_BASE,
        paneId: 'pane-1',
        projectId: 'project-1',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
        activeMode: 'shell',
        activeSessionId: 'session-1',
        sessionBadge: null,
      },
      {
        type: 'project',
        ...SLOT_BASE,
        paneId: 'pane-2',
        projectId: 'project-2',
        projectName: 'Project 2',
        rootPath: '/tmp/project-2',
        activeMode: 'shell',
        activeSessionId: 'session-2',
        sessionBadge: null,
      },
    ]

    render(<RenderHarness slots={slots} />)

    expect(
      screen.getByTestId(`pane-drop-target-${getSlotPanelId(slots[0])}`),
    ).toHaveClass('min-w-0')
  })

  it('matches external pane capabilities with supported controls only', () => {
    aTermProps.length = 0
    headerProps.length = 0

    const slots: ATermSlot[] = [ownTmuxView()]

    render(<RenderHarness slots={slots} onCloseSession={vi.fn()} />)

    expect(headerProps).toHaveLength(1)
    expect(aTermProps).toEqual([
      {
        sessionId: 'external-codex',
        sessionMode: 'codex',
        isVisible: undefined,
      },
    ])
    expect(headerProps[0]?.showCleanButton).toBe(true)
    expect(headerProps[0]?.onReset).toBeUndefined()
    // A-Term never ends an Own tmux session: closing it only closes the View.
    expect(headerProps[0]?.onCloseSession).toBeUndefined()
    expect(headerProps[0]?.closeTooltip).toBe('Close view')
  })

  it('offers Reset and End only where the backend allows them', () => {
    headerProps.length = 0
    const onReset = vi.fn()
    const onCloseSession = vi.fn()
    const slots: Array<ATermSlot | PaneSlot> = [
      paneToSlot(projectPane('pane-agent', { ...TETHER_CAN })),
      paneToSlot(projectPane('pane-root', { ...ROOT_CAN, is_root: true })),
      paneToSlot({
        ...projectPane('pane-adhoc-root', { ...ROOT_CAN, is_root: true }),
        pane_type: 'adhoc',
        project_id: null,
      }),
      paneToSlot(
        projectPane('pane-legacy', {
          ...TETHER_LEGACY_CAN,
          source: 'tether',
          status: 'legacy',
          is_legacy: true,
        }),
      ),
      // A desktop free-standing Tether View: the session can be respawned,
      // but a View that no pane shows never offers Reset.
      sessionToSlot(
        session('free-tether', { ...TETHER_CAN, is_external: true }),
        { as: 'adhoc', place: 'free' },
      ),
      ownTmuxView(),
    ]

    render(
      <RenderHarness
        slots={slots}
        onReset={onReset}
        onCloseSession={onCloseSession}
      />,
    )

    expect(headerProps.map((props) => typeof props.onReset)).toEqual([
      'function',
      'undefined',
      'undefined',
      'undefined',
      'undefined',
      'undefined',
    ])
    expect(headerProps.map((props) => typeof props.onCloseSession)).toEqual([
      'function',
      'function',
      'function',
      'function',
      'function',
      'undefined',
    ])
    const reset = headerProps[0]?.onReset as () => void
    reset()
    expect(onReset).toHaveBeenCalledWith(slots[0])
  })

  it('routes pane upload actions to the pane session', () => {
    headerProps.length = 0
    const onUpload = vi.fn()

    const slots: ATermSlot[] = [ownTmuxView()]

    render(<RenderHarness slots={slots} onUpload={onUpload} />)

    const handleUpload = headerProps[0]?.onUpload as (() => void) | undefined
    expect(handleUpload).toBeTypeOf('function')

    handleUpload?.()

    expect(onUpload).toHaveBeenCalledWith('external-codex')
  })

  it('exposes pane refresh from the header without requiring a parent callback', () => {
    headerProps.length = 0

    const slots: PaneSlot[] = [
      {
        type: 'project',
        ...SLOT_BASE,
        paneId: 'pane-1',
        projectId: 'project-1',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
        activeMode: 'shell',
        activeSessionId: 'session-1',
        sessionBadge: null,
      },
    ]

    render(<RenderHarness slots={slots} />)

    expect(headerProps[0]?.onRefresh).toBeTypeOf('function')
  })
})
