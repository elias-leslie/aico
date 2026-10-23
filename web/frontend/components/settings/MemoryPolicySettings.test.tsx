import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryPolicyState } from '@/lib/hooks/use-memory-policy'
import { MemoryPolicySettings } from './MemoryPolicySettings'

const save = vi.fn()
let hook: {
  state: MemoryPolicyState | null
  isLoading: boolean
  loadError: string | null
}

vi.mock('@/lib/hooks/use-memory-policy', () => ({
  useMemoryPolicy: () => ({ ...hook, save, saving: false }),
}))

const policy = {
  paneMemoryMaxGib: 12,
  paneSwapMaxGib: 2,
  killEnabled: true,
  killAfterSeconds: 10,
  killGapSeconds: 30,
  killMinGib: 1,
  killOrder: 'largest' as const,
}

describe('MemoryPolicySettings', () => {
  beforeEach(() => {
    save.mockReset()
    save.mockResolvedValue({})
    hook = {
      state: { policy, guard: { running: true, lastKillAt: null } },
      isLoading: false,
      loadError: null,
    }
  })

  it('saves the pane cap and the kill order to Tether', async () => {
    render(<MemoryPolicySettings />)
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: '16' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'background-first' }))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ paneMemoryMaxGib: 16 })
      expect(save).toHaveBeenCalledWith({ killOrder: 'background-first' })
    })
  })

  it('keeps a stored value that is not a preset and hides kill settings when kills are off', () => {
    hook.state = {
      policy: { ...policy, paneMemoryMaxGib: 14, killEnabled: false },
    }
    render(<MemoryPolicySettings />)
    expect(screen.getByRole('option', { name: '14 GiB' })).toBeTruthy()
    expect(screen.queryByText('Kill first')).toBeNull()
  })

  it('says why when Tether cannot be reached, and shows a failed save', async () => {
    hook = {
      state: null,
      isLoading: false,
      loadError: 'Tether is not reachable',
    }
    const { unmount } = render(<MemoryPolicySettings />)
    expect(screen.getByRole('alert').textContent).toContain(
      'Tether is not reachable',
    )
    unmount()
    hook = { state: { policy }, isLoading: false, loadError: null }
    save.mockRejectedValue(
      new Error('paneMemoryMaxGib must be a whole number from 2 to 64'),
    )
    render(<MemoryPolicySettings />)
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: '8' },
    })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('from 2 to 64'),
    )
  })
})
