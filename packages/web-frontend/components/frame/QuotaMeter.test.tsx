import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuotaMeter } from './QuotaMeter'

const state = vi.hoisted(() => ({ usage: {} as Record<string, unknown> }))
vi.mock('@/lib/hooks/use-usage', () => ({ useUsage: () => state.usage }))

const window = (left: number) => ({
  label: 'weekly',
  state: 'ok',
  left_percent: left,
  resets_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  length_seconds: 1000,
  resets_in_seconds: 400,
  text: `weekly ${left}% left`,
})
const provider = (id: string, name: string, left: number, used = false) => ({
  id,
  name,
  status: used ? 'used_up' : 'ok',
  answer: 'Available',
  plan: 'Max',
  windows: [
    used ? { ...window(0), state: 'used_up', left_percent: 0 } : window(left),
  ],
  credits: null,
  problem: null,
  spend: { unit: null, recorded_since: null, days: [] },
  by_project: { tracked: false, unit: null, total: 0, items: [] },
})
const usage = (providers: unknown[], over: object = {}) => ({
  report: { as_of: '', collected_at: new Date().toISOString(), providers },
  query: { isError: false, isFetching: false, refetch: vi.fn() },
  loading: false,
  failed: false,
  stale: false,
  ...over,
})
const view = (icon = false) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuotaMeter icon={icon} />
    </QueryClientProvider>,
  )

beforeEach(() => {
  state.usage = usage([provider('claude', 'Claude', 82)])
})

describe('QuotaMeter', () => {
  it('shows the lowest amount left across subscriptions', () => {
    state.usage = usage([
      provider('claude', 'Claude', 82),
      provider('codex', 'Codex', 12),
    ])
    view()
    expect(screen.getByTestId('quota-meter').textContent).toBe('12%')
  })

  it('reads the lowest among subscriptions that still have quota, and flags one used up', () => {
    state.usage = usage([
      provider('claude', 'Claude', 69),
      provider('opencode', 'OpenCode Go', 0, true),
    ])
    view()
    const meter = screen.getByTestId('quota-meter')
    expect(meter.textContent).toBe('69%')
    expect(meter.getAttribute('aria-label')).toMatch(
      /^Quota: OpenCode Go used up/,
    )
    expect(screen.getByTestId('quota-danger')).toBeInTheDocument()
    fireEvent.click(meter)
    expect(screen.getByRole('dialog', { name: 'Quota' }).textContent).toContain(
      'OpenCode Go',
    )
  })

  it('has no danger dot while every subscription has quota', () => {
    view()
    expect(screen.queryByTestId('quota-danger')).toBeNull()
  })

  it('reads 0% only when every subscription is used up', () => {
    state.usage = usage([provider('opencode', 'OpenCode Go', 0, true)])
    view()
    expect(screen.getByTestId('quota-meter').textContent).toBe('0%')
    expect(screen.getByTestId('quota-danger')).toBeInTheDocument()
  })

  it('pops out the full quota breakdown', () => {
    view()
    const meter = screen.getByTestId('quota-meter')
    expect(meter).toHaveAttribute('aria-haspopup', 'dialog')
    fireEvent.click(meter)
    expect(screen.getByRole('dialog', { name: 'Quota' })).toBeVisible()
  })

  it('names itself for the rail icon too', () => {
    view(true)
    expect(
      screen.getByTestId('quota-meter').getAttribute('aria-label'),
    ).toMatch(/^Quota: /)
  })

  it('says it is checking, failed or empty rather than showing zero', () => {
    state.usage = usage([], { report: null, loading: true })
    const { unmount } = view()
    expect(screen.getByTestId('quota-meter').textContent).toBe('…')
    unmount()
    state.usage = usage([], { report: null, loading: false, failed: true })
    view()
    expect(screen.getByTestId('quota-meter')).toHaveAttribute(
      'aria-label',
      'Quota: couldn’t be read',
    )
  })
})
