import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getClaudeModelOptions } from '@/lib/utils/agent-hub-models'
import { ControlBar } from './ControlBar'
import { ModifierProvider } from './ModifierContext'

vi.mock('@/lib/utils/agent-hub-models', () => ({
  getClaudeModelOptions: vi.fn().mockResolvedValue([]),
}))

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderControlBar(
  overrides: Partial<ComponentProps<typeof ControlBar>> = {},
) {
  const onSend = vi.fn()
  const onReconnect = vi.fn()

  render(
    <ModifierProvider>
      <ControlBar
        onSend={onSend}
        connectionStatus="connected"
        onReconnect={onReconnect}
        {...overrides}
      />
    </ModifierProvider>,
  )

  return { onSend, onReconnect }
}

function renderNativeControlBar() {
  const onSend = vi.fn()
  render(
    <ModifierProvider>
      <ControlBar
        onSend={onSend}
        onVoice={vi.fn()}
        onToggleMinimize={vi.fn()}
        showShiftControl
      />
    </ModifierProvider>,
  )
  return { onSend }
}

describe('ControlBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getClaudeModelOptions).mockResolvedValue([])
  })

  it('hides status banner for connected sessions (status shown in header badge)', async () => {
    renderControlBar({ activeMode: 'shell' })

    // Banner should NOT render for connected (success tone) — status is in header
    await waitFor(() => {
      expect(screen.queryByText('Live')).not.toBeInTheDocument()
    })
  })

  it('does not load Claude model options for non-Claude tools', () => {
    renderControlBar({ activeMode: 'codex' })

    expect(getClaudeModelOptions).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Voice input unavailable' }),
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /model/i }),
    ).not.toBeInTheDocument()
  })

  it('shows the persistent utility controls and only reveals four arrows in the toolbox', () => {
    const onToggleMinimize = vi.fn()
    renderControlBar({
      onToggleMinimize,
      onVoice: vi.fn(),
      onCtrlToggle: vi.fn(),
      activeMode: 'codex',
    })

    expect(
      screen.getByRole('button', { name: 'Hide keyboard' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tab' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Voice input' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ESC' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CTRL' })).toBeInTheDocument()
    const toolbox = screen.getByRole('button', { name: 'Show arrow keys' })
    expect(toolbox).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '←' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /shift/i }),
    ).not.toBeInTheDocument()

    fireEvent.click(toolbox)
    expect(
      screen.getByRole('button', { name: 'Hide arrow keys' }),
    ).toHaveAttribute('aria-expanded', 'true')
    for (const arrow of ['←', '↑', '↓', '→']) {
      expect(screen.getByRole('button', { name: arrow })).toBeInTheDocument()
    }
    const arrowPanel = screen.getByLabelText('Arrow keys')
    const utilityRow = screen.getByRole('button', { name: 'Tab' }).parentElement
    expect(arrowPanel.nextElementSibling).toBe(utilityRow)
    expect(arrowPanel.querySelectorAll('button')).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'Hide keyboard' }))
    expect(onToggleMinimize).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Hide arrow keys' }),
    ).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Hide arrow keys' }))
    expect(screen.queryByRole('button', { name: '←' })).not.toBeInTheDocument()
  })

  it('hides status banner for voice active sessions', async () => {
    renderControlBar({
      activeMode: 'claude',
      voiceActive: true,
    })

    // Voice active is success tone — banner hidden
    await waitFor(() => {
      expect(screen.queryByText('Voice active')).not.toBeInTheDocument()
    })
  })

  it('renders reconnect affordance for reconnectable failures', async () => {
    const { onReconnect } = renderControlBar({
      connectionStatus: 'disconnected',
    })

    const reconnectButton = await screen.findByRole('button', {
      name: 'Reconnect',
    })
    fireEvent.click(reconnectButton)

    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText('Reconnect to resume this A-Term'),
    ).toBeInTheDocument()
  })

  it('logs model option loading failures and keeps the picker usable', async () => {
    const error = new Error('network down')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getClaudeModelOptions).mockRejectedValueOnce(error)

    renderControlBar({ activeMode: 'claude' })

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to load Claude model options',
        error,
      )
    })

    expect(getClaudeModelOptions).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /model/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch Claude model' }))
    expect(
      screen.getByRole('button', { name: 'Switch Claude model' }),
    ).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps Claude model selection available from the compact row', async () => {
    vi.mocked(getClaudeModelOptions).mockResolvedValueOnce([
      { id: 'sonnet', label: 'Sonnet', command: '/model sonnet\r' },
    ])
    const { onSend } = renderControlBar({ activeMode: 'claude' })

    fireEvent.click(screen.getByRole('button', { name: 'Switch Claude model' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sonnet' }))

    expect(onSend).toHaveBeenCalledWith('/model sonnet\r')
    expect(
      screen.getByRole('button', { name: 'Switch Claude model' }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not update picker state after unmount when model loading fails', async () => {
    const deferred =
      createDeferred<Awaited<ReturnType<typeof getClaudeModelOptions>>>()
    const error = new Error('request aborted')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getClaudeModelOptions).mockReturnValueOnce(deferred.promise)

    const view = render(
      <ModifierProvider>
        <ControlBar
          onSend={vi.fn()}
          activeMode="claude"
          connectionStatus="connected"
        />
      </ModifierProvider>,
    )

    view.unmount()
    deferred.reject(error)

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to load Claude model options',
        error,
      )
    })
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('keeps the phone keyboard open when a bar key is pressed', () => {
    // A plain button takes focus on pointerdown, and losing focus on the input
    // dismisses the on-screen keyboard.
    renderControlBar({
      onCtrlToggle: vi.fn(),
      onVoice: vi.fn(),
      onToggleMinimize: vi.fn(),
    })

    for (const name of [
      'Hide keyboard',
      'Tab',
      'Voice input',
      'ESC',
      'CTRL',
      'Show arrow keys',
    ]) {
      // fireEvent returns false when the handler called preventDefault.
      expect(fireEvent.pointerDown(screen.getByRole('button', { name }))).toBe(
        false,
      )
    }
    fireEvent.click(screen.getByRole('button', { name: 'Show arrow keys' }))
    for (const arrow of ['←', '↑', '↓', '→']) {
      expect(
        fireEvent.pointerDown(screen.getByRole('button', { name: arrow })),
      ).toBe(false)
    }
  })

  it('still fires the key after refusing focus', () => {
    const { onSend } = renderControlBar()

    expect(
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Tab' })),
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }))

    expect(onSend).toHaveBeenCalledWith('\t')
  })

  it('sends Shift+Tab from shared one-shot Shift, then plain Tab', () => {
    const { onSend } = renderNativeControlBar()
    const shift = screen.getByRole('button', { name: 'Shift' })
    const tab = screen.getByRole('button', { name: 'Tab' })

    expect(fireEvent.pointerDown(shift)).toBe(false)
    fireEvent.click(shift)
    expect(shift).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(tab)
    fireEvent.click(tab)

    expect(onSend.mock.calls).toEqual([['\x1b[Z'], ['\t']])
    expect(shift).toHaveAttribute('aria-pressed', 'false')
  })

  it('sends Shift+Left once, then an unmodified Left', () => {
    const { onSend } = renderNativeControlBar()

    fireEvent.click(screen.getByRole('button', { name: 'Shift' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show arrow keys' }))
    const left = screen.getByRole('button', { name: '←' })
    expect(fireEvent.pointerDown(left)).toBe(false)
    fireEvent.click(left)
    fireEvent.click(left)

    expect(onSend.mock.calls).toEqual([['\x1b[1;2D'], ['\x1b[D']])
    expect(screen.getByRole('button', { name: 'Shift' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('lets the compose input handle shifted arrows', () => {
    const onArrow = vi.fn().mockReturnValue(true)
    const onSend = vi.fn()
    render(
      <ModifierProvider>
        <ControlBar onSend={onSend} onArrow={onArrow} showShiftControl />
      </ModifierProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Shift' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show arrow keys' }))
    fireEvent.click(screen.getByRole('button', { name: '←' }))

    expect(onArrow).toHaveBeenCalledWith('left', {
      shift: true,
      ctrl: false,
      alt: false,
    })
    expect(onSend).not.toHaveBeenCalled()
  })
})
