import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSidebar } from './SessionSidebar'

vi.mock('@/lib/hooks/use-session-attention', () => ({
  useSessionAttention: () => ({ forSlot: () => null, needsYouCount: 2 }),
}))
vi.mock('./capture/CaptureLauncher', () => ({
  CaptureLauncher: () => <i data-testid="capture-mock" />,
}))
vi.mock('./HostsButton', () => ({ HostsLauncher: () => null }))
vi.mock('./status/StatusLauncher', () => ({ StatusLauncher: () => null }))
const needsYou = vi.hoisted(() => ({ open: false }))
vi.mock('./asks/NeedsYou', () => ({
  NeedsYouLauncher: () => <i data-testid="needs-you-mock" />,
  NeedsYouPanel: () => <p>Needs you panel</p>,
  useHostNeedsYou: () => {},
  useNeedsYouState: () => ({ open: needsYou.open }),
}))
vi.mock('./SessionList', () => ({
  SessionList: () => <p>Full list</p>,
  SessionRail: () => <p>Rail marks</p>,
  sessionsHeading: () => 'Sessions · 5 · 2 need you',
}))

beforeEach(() => {
  needsYou.open = false
})

describe('SessionSidebar', () => {
  it('puts Capture beside Needs you on the rail and in the panel', () => {
    const { unmount } = render(
      <SessionSidebar slots={[]} onSelect={vi.fn()} variant="rail" />,
    )
    expect(screen.getByTestId('needs-you-mock').nextElementSibling).toBe(
      screen.getByTestId('capture-mock'),
    )
    unmount()
    render(<SessionSidebar slots={[]} onSelect={vi.fn()} />)
    expect(screen.getByTestId('needs-you-mock').nextElementSibling).toBe(
      screen.getByTestId('capture-mock'),
    )
  })

  it('shows Needs you in the panel’s place, and the rail opens out to the panel for it', () => {
    needsYou.open = true
    const { unmount } = render(<SessionSidebar slots={[]} onSelect={vi.fn()} />)
    expect(screen.getByText('Needs you panel')).toBeVisible()
    expect(screen.queryByText('Full list')).toBeNull()
    unmount()
    const onOpenPanel = vi.fn()
    render(
      <SessionSidebar
        slots={[]}
        onSelect={vi.fn()}
        variant="rail"
        onOpenPanel={onOpenPanel}
      />,
    )
    expect(onOpenPanel).toHaveBeenCalled()
  })

  it('folds to a rail that counts who needs you and opens the panel again', () => {
    const onOpenPanel = vi.fn()
    render(
      <SessionSidebar
        slots={[]}
        onSelect={vi.fn()}
        variant="rail"
        onOpenPanel={onOpenPanel}
      />,
    )
    expect(screen.getByText('Rail marks')).toBeVisible()
    expect(screen.queryByText('Full list')).toBeNull()
    const open = screen.getByRole('button', {
      name: 'Open the panel · Sessions · 5 · 2 need you · Alt+2',
    })
    expect(open.textContent).toBe('2')
    fireEvent.click(open)
    expect(onOpenPanel).toHaveBeenCalled()
  })

  it('lists sessions under their heading in the panel', () => {
    render(<SessionSidebar slots={[]} onSelect={vi.fn()} />)
    expect(screen.getByTestId('session-list-heading')).toHaveTextContent(
      'Sessions · 5 · 2 need you',
    )
    expect(screen.getByText('Full list')).toBeVisible()
  })
})
