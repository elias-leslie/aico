import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UsageReport } from '@/lib/quota-usage'
import { QuotaPage } from './QuotaPage'

const usage = vi.hoisted(() => ({ report: null as unknown }))
vi.mock('@/lib/hooks/use-usage', () => ({
  useUsage: () => ({
    query: { isPending: false, isError: false, isFetching: false },
    report: usage.report,
  }),
}))

const provider = (over: object) => ({
  id: 'p',
  name: 'OpenCode Go',
  status: 'used_up',
  summary: null,
  plan: null,
  windows: [],
  credits: null,
  problem: null,
  spend: { unit: null, recorded_since: null, days: [] },
  by_project: {
    tracked: false,
    unit: null,
    from: '',
    to: '',
    total: 0,
    items: [],
  },
  ...over,
})

const show = (providers: object[]) => {
  usage.report = {
    as_of: new Date().toISOString(),
    collected_at: new Date().toISOString(),
    providers,
  } satisfies UsageReport | object
  return render(<QuotaPage />)
}

describe('Quota page copy', () => {
  it('says a used-up window once, not as a summary and again as the window', () => {
    show([
      provider({
        summary: 'Weekly used up until Nov 8, 7:00 PM EST',
        windows: [
          {
            label: 'weekly',
            state: 'used_up',
            left_percent: 0,
            resets_at: null,
            length_seconds: 604800,
            resets_in_seconds: null,
            text: 'weekly used up until Nov 8, 7:00 PM EST',
          },
        ],
      }),
    ])
    expect(screen.getAllByText(/used up until Nov 8/i)).toHaveLength(1)
  })

  it('keeps a summary that says something the windows do not', () => {
    show([
      provider({
        name: 'Codex',
        status: 'on_credits',
        summary: 'Running on credits',
        windows: [],
      }),
    ])
    expect(screen.getByText('Running on credits.')).toBeInTheDocument()
  })

  it('splits Claude and Codex use by project and says the others are not tracked', () => {
    const split = (over: object) => ({
      by_project: {
        tracked: true,
        unit: 'tokens',
        from: '2026-11-01',
        to: '2026-11-07',
        total: 4000,
        items: [
          {
            id: 'aico',
            name: 'Aico',
            kind: 'project',
            amount: 3000,
            share: 0.75,
          },
          {
            id: null,
            name: 'Other folders',
            kind: 'other',
            amount: 1000,
            share: 0.25,
          },
        ],
        ...over,
      },
    })
    show([
      provider({ id: 'claude', name: 'Claude', ...split({}) }),
      provider({ id: 'codex', name: 'Codex', ...split({ unit: 'credits' }) }),
      provider({ id: 'opencode-go', name: 'OpenCode Go' }),
    ])
    expect(
      screen.getByText('Tokens by project, last 7 days'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Spent by project, last 7 days'),
    ).toBeInTheDocument()
    expect(screen.getAllByText('75% · 3.0K')).toHaveLength(2)
    expect(screen.getByText('Not tracked by project.')).toBeInTheDocument()
  })

  it('does not call an empty split zero', () => {
    show([
      provider({
        name: 'Claude',
        by_project: {
          tracked: true,
          unit: null,
          from: '2026-11-01',
          to: '2026-11-07',
          total: 0,
          items: [],
        },
      }),
    ])
    expect(
      screen.getByText(/Nothing recorded for Claude in the last 7 days/),
    ).toBeInTheDocument()
  })
})
