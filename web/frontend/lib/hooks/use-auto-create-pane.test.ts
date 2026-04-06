import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useAutoCreatePane } from './use-auto-create-pane'

const mockFetchPaneCount = vi.fn()
vi.mock('./a-term-panes-api', () => ({
  fetchPaneCount: () => mockFetchPaneCount(),
}))

describe('useAutoCreatePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not auto-create before pane state has loaded at least once', async () => {
    const createAdHocPane = vi.fn()
    const switchToSession = vi.fn()

    renderHook(() =>
      useAutoCreatePane({
        panes: [],
        hasVisibleExternalSlot: false,
        isLoading: false,
        hasLoadedOnce: false,
        isPaneCreating: false,
        createAdHocPane,
        switchToSession,
      }),
    )

    expect(mockFetchPaneCount).not.toHaveBeenCalled()
    expect(createAdHocPane).not.toHaveBeenCalled()
    expect(switchToSession).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(mockFetchPaneCount).not.toHaveBeenCalled()
      expect(createAdHocPane).not.toHaveBeenCalled()
      expect(switchToSession).not.toHaveBeenCalled()
    }, { timeout: 100 })
  })

  it('auto-creates exactly one ad-hoc pane after an empty initial load is confirmed', async () => {
    const createAdHocPane = vi.fn().mockResolvedValue({
      sessions: [{ id: 'session-1', mode: 'shell' }],
    })
    const switchToSession = vi.fn()

    mockFetchPaneCount.mockResolvedValueOnce({ count: 0 })

    renderHook(() =>
      useAutoCreatePane({
        panes: [],
        hasVisibleExternalSlot: false,
        isLoading: false,
        hasLoadedOnce: true,
        isPaneCreating: false,
        createAdHocPane,
        switchToSession,
      }),
    )

    await waitFor(() => {
      expect(createAdHocPane).toHaveBeenCalledTimes(1)
    })

    expect(switchToSession).toHaveBeenCalledWith('session-1')
  })

  it('does not auto-create when an external slot is still visible', async () => {
    const createAdHocPane = vi.fn()
    const switchToSession = vi.fn()

    renderHook(() =>
      useAutoCreatePane({
        panes: [],
        hasVisibleExternalSlot: true,
        isLoading: false,
        hasLoadedOnce: true,
        isPaneCreating: false,
        createAdHocPane,
        switchToSession,
      }),
    )

    await waitFor(() => {
      expect(createAdHocPane).not.toHaveBeenCalled()
    }, { timeout: 100 })

    expect(mockFetchPaneCount).not.toHaveBeenCalled()
    expect(switchToSession).not.toHaveBeenCalled()
  })
})
