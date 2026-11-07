import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GlanceQuota, useQuotaGlance } from './GlanceQuota'

const state = vi.hoisted(() => ({ usage: {} as Record<string, unknown> }))
vi.mock('@/lib/hooks/use-usage', () => ({ useUsage: () => state.usage }))

const window = (left: number, label = 'weekly') => ({
  label,
  state: 'ok',
  left_percent: left,
  resets_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  length_seconds: 1000,
  resets_in_seconds: 400,
  text: `${label} ${left}% left`,
})
const provider = (id: string, name: string, over: object = {}) => ({
  id,
  name,
  status: 'ok',
  answer: 'Available',
  plan: 'Max',
  windows: [window(73)],
  credits: null,
  problem: null,
  spend: { unit: null, recorded_since: null, days: [] },
  by_project: { tracked: false, unit: null, total: 0, items: [] },
  ...over,
})
const ok = (providers: unknown[], over: object = {}) => ({
  report: { as_of: '', collected_at: new Date().toISOString(), providers },
  query: { isError: false, isFetching: false, refetch: vi.fn() },
  loading: false,
  failed: false,
  stale: false,
  ...over,
})
const view = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GlanceQuota />
    </QueryClientProvider>,
  )
const Head = () => {
  const head = useQuotaGlance()
  return (
    <p data-testid="head" data-tone={head.tone ?? ''}>
      {head.value}
    </p>
  )
}

beforeEach(() => {
  state.usage = ok([provider('claude', 'Claude')])
})

describe('GlanceQuota', () => {
  it('shows a row per subscription, each opening to its windows in place', () => {
    state.usage = ok([
      provider('claude', 'Claude'),
      provider('codex', 'Codex', { windows: [window(40, 'daily')] }),
    ])
    view()
    expect(screen.getByRole('img', { name: /Claude: 73% left/ })).toBeVisible()
    expect(screen.getByRole('img', { name: /Codex: 40% left/ })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Windows' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Claude:/ }))
    expect(screen.getByRole('list', { name: 'Windows' })).toBeVisible()
    expect(screen.getByText('Max plan')).toBeVisible()
    expect(screen.getByText('Spend isn’t recorded for Claude.')).toBeVisible()
    expect(screen.getByRole('button', { name: /^Claude:/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('says loading, failed (with Retry) and empty in different words', () => {
    state.usage = { report: null, loading: true, failed: false, stale: false }
    const { unmount } = view()
    expect(screen.getByText('Checking quota…')).toBeVisible()
    unmount()
    const refetch = vi.fn()
    state.usage = {
      report: null,
      query: { isError: true, isFetching: false, refetch, error: null },
      loading: false,
      failed: true,
      stale: false,
    }
    const second = view()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Quota couldn’t be read.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalled()
    second.unmount()
    state.usage = ok([])
    view()
    expect(screen.getByText('No quota reports yet.')).toBeVisible()
  })

  it('keeps the last numbers and says it could not refresh', () => {
    state.usage = ok([provider('claude', 'Claude')], { stale: true })
    view()
    expect(screen.getByText(/Can’t refresh usage/)).toBeVisible()
    expect(screen.getByRole('img', { name: /Claude: 73% left/ })).toBeVisible()
  })

  it('warns when the collection is old', () => {
    state.usage = ok([provider('claude', 'Claude')])
    ;(state.usage.report as { collected_at: string }).collected_at = new Date(
      Date.now() - 3 * 3_600_000,
    ).toISOString()
    view()
    expect(screen.getByText(/may be out of date/)).toBeVisible()
  })
})

describe('useQuotaGlance', () => {
  it('leads with the lowest amount left; amber when low', () => {
    state.usage = ok([
      provider('a', 'A'),
      provider('b', 'B', { windows: [window(12)] }),
    ])
    render(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('12% left')
    expect(screen.getByTestId('head')).toHaveAttribute('data-tone', 'warn')
  })

  it('is quiet when there is plenty left, and counts those used up', () => {
    const { rerender } = render(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('73% left')
    expect(screen.getByTestId('head')).toHaveAttribute('data-tone', '')
    state.usage = ok([
      provider('a', 'A'),
      provider('b', 'B', {
        status: 'used_up',
        windows: [{ ...window(0), state: 'used_up', left_percent: 0 }],
      }),
    ])
    rerender(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('1 used up')
    expect(screen.getByTestId('head')).toHaveAttribute('data-tone', 'warn')
  })

  it('says why there is no number', () => {
    state.usage = { report: null, loading: true, failed: false, stale: false }
    const { rerender } = render(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('Checking…')
    state.usage = { report: null, loading: false, failed: true, stale: false }
    rerender(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('Couldn’t read')
    expect(screen.getByTestId('head')).toHaveAttribute('data-tone', 'failed')
  })
})
