import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { HeaderNameDisplay } from './HeaderNameDisplay'

const state = vi.hoisted(() => ({
  frame: null as { docked: boolean; tier: string } | null,
}))
vi.mock('../frame/FrameContext', () => ({ useFrame: () => state.frame }))

const slot = {
  ...SLOT_BASE,
  type: 'adhoc',
  sessionId: 'lead',
  name: 'Neri — Daybreak lead',
  workingDir: null,
  sessionMode: 'claude-code',
  badge: { label: 'Coordinator', color: '#6fa8ff' },
  can: { ...SLOT_BASE.can, rename: false },
} as never

const show = () =>
  render(<HeaderNameDisplay slot={slot} isActive isMobile={false} />)

describe('HeaderNameDisplay', () => {
  it('drops the role chip while the rail is showing, since the rail marks it', () => {
    state.frame = { docked: true, tier: 'rail' }
    show()
    expect(screen.queryByTestId('coordinator-badge')).toBeNull()
    expect(screen.getByText(/Daybreak lead/)).toBeVisible()
  })

  it('keeps the role chip beside the panel and outside a frame', () => {
    state.frame = { docked: true, tier: 'panel' }
    const { unmount } = show()
    expect(screen.getByTestId('coordinator-badge')).toHaveTextContent(
      'Coordinator',
    )
    unmount()
    state.frame = null
    show()
    expect(screen.getByTestId('coordinator-badge')).toBeVisible()
  })
})
