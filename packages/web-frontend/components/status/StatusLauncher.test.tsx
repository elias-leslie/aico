import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusSummary } from '@/lib/status'
import { StatusLauncher } from './StatusLauncher'

const state = vi.hoisted(() => ({
  read: {} as Record<string, unknown>,
}))
vi.mock('@/lib/hooks/use-status', () => ({ useStatus: () => state.read }))
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const summary = (problems: number): StatusSummary => ({
  problems,
  worst: problems ? 'failed' : null,
  counts: { failed: problems, late: 0, unknown: 0, warn: 0 },
  quiet: 0,
  healthy: 3,
  top: [],
})
const read = (over: Record<string, unknown>) => ({
  view: null,
  failed: false,
  stale: false,
  old: false,
  readAt: Date.now(),
  ...over,
})
const badge = () =>
  screen.getByTestId('status-link').querySelector('.lantern-rail-count')

beforeEach(() => {
  state.read = read({})
})

describe('StatusLauncher', () => {
  it('shows the problem count in the worst state’s colour', () => {
    state.read = read({ view: { summary: summary(2) } })
    render(<StatusLauncher />)
    expect(badge()).toHaveTextContent('2')
    expect(badge()).toHaveAttribute('data-worst', 'failed')
    expect(screen.getByTestId('status-link')).toHaveAccessibleName(
      'Status: 2 problems: 2 failed',
    )
  })

  it('shows "?" when the read failed, never nothing', () => {
    state.read = read({ failed: true })
    render(<StatusLauncher />)
    expect(badge()).toHaveTextContent('?')
    expect(badge()).toHaveAttribute('data-dated')
    expect(screen.getByTestId('status-link')).toHaveAccessibleName(
      'Status: couldn’t load',
    )
  })

  it('mutes an old count and says it couldn’t refresh', () => {
    state.read = read({ view: { summary: summary(2) }, stale: true })
    render(<StatusLauncher />)
    expect(badge()).toHaveTextContent('2')
    expect(badge()).toHaveAttribute('data-dated')
    expect(badge()).not.toHaveAttribute('data-worst')
    expect(
      screen.getByTestId('status-link').getAttribute('aria-label'),
    ).toMatch(/^Status as of .*, couldn’t refresh: 2 problems/)
  })

  it('shows "?" for an old zero, and nothing for a current one', () => {
    state.read = read({ view: { summary: summary(0) }, old: true })
    const { unmount } = render(<StatusLauncher />)
    expect(badge()).toHaveTextContent('?')
    unmount()
    state.read = read({ view: { summary: summary(0) } })
    render(<StatusLauncher />)
    expect(badge()).toBeNull()
  })
})
