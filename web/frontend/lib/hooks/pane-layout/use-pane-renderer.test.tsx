import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePaneRenderer } from './use-pane-renderer'
import { getSlotPanelId, type PaneSlot, type ATermSlot } from '@/lib/utils/slot'

const aTermProps = vi.hoisted(
  () => [] as Array<{ sessionId: string; sessionMode?: string; isVisible?: boolean }>,
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
}: {
  slots: Array<ATermSlot | PaneSlot>
  onSwapPanes?: (slotIdA: string, slotIdB: string) => void
  onUpload?: (sessionId?: string) => void
}) {
  const renderPane = usePaneRenderer({
    props: {
      isMobile: false,
      isModeSwitching: false,
      fontFamily: 'monospace',
      fontSize: 14,
      scrollback: 1000,
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
      { sessionId: 'session-1', sessionMode: 'shell', preferLessDestructiveSnapshots: undefined, isVisible: undefined },
      { sessionId: 'session-2', sessionMode: 'shell', preferLessDestructiveSnapshots: undefined, isVisible: undefined },
    ])
  })

  it('swaps panes when a dragged pane is dropped anywhere on another pane', () => {
    headerProps.length = 0
    const onSwapPanes = vi.fn()
    const slots: PaneSlot[] = [
      {
        type: 'project',
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

    const slots: ATermSlot[] = [
      {
        type: 'adhoc',
        sessionId: 'external-codex',
        name: 'codex-agent-hub',
        workingDir: '/home/testuser/agent-hub',
        sessionMode: 'codex',
        isExternal: true,
      },
    ]

    render(<RenderHarness slots={slots} />)

    expect(headerProps).toHaveLength(1)
    expect(aTermProps).toEqual([
      { sessionId: 'external-codex', sessionMode: 'codex', isVisible: undefined },
    ])
    expect(headerProps[0]?.showCleanButton).toBe(true)
    expect(headerProps[0]?.onReset).toBeUndefined()
    expect(headerProps[0]?.closeTooltip).toBe('Detach a-term')
  })

  it('routes pane upload actions to the pane session', () => {
    headerProps.length = 0
    const onUpload = vi.fn()

    const slots: ATermSlot[] = [
      {
        type: 'adhoc',
        sessionId: 'external-codex',
        name: 'codex-agent-hub',
        workingDir: '/home/testuser/agent-hub',
        sessionMode: 'codex',
        isExternal: true,
      },
    ]

    render(<RenderHarness slots={slots} onUpload={onUpload} />)

    const handleUpload = headerProps[0]?.onUpload as (() => void) | undefined
    expect(handleUpload).toBeTypeOf('function')

    handleUpload?.()

    expect(onUpload).toHaveBeenCalledWith('external-codex')
  })
})
