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
})
