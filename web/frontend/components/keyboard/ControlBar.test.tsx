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
      screen.queryByRole('button', { name: /model/i }),
    ).not.toBeInTheDocument()
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
})
