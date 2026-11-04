import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusRow, StatusView } from '@/lib/status'
import { StatusPage } from './StatusPage'

const api = vi.hoisted(() => ({
  view: null as StatusView | null,
  fail: false,
  calls: [] as string[],
}))
vi.mock('@/lib/api-fetch', () => ({
  apiFetch: vi.fn(async (url: string) => {
    api.calls.push(url)
    if (url === '/api/status') {
      if (api.fail || !api.view) throw new Error('Couldn’t load status')
      return api.view
    }
    if (url === '/api/status/run') return { state: 'done', lines: [] }
    throw new Error(`unexpected ${url}`)
  }),
}))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => false }))
vi.mock('@/lib/hooks/use-hosts', () => ({ useHosts: () => ({ hosts: [] }) }))
vi.mock('@/lib/hooks/use-project-settings', () => ({
  useProjectSettings: () => ({ projects: [] }),
}))
vi.mock('@/components/HostsSheet', () => ({ HostsSheet: () => null }))
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

const row = (over: Partial<StatusRow>): StatusRow => ({
  id: 'x',
  what: 'x',
  kind: 'check',
  machine: 'davion-sidarli',
  state: 'ok',
  meaning: 'Fine.',
  updated_at: new Date().toISOString(),
  shown: 'ok',
  shown_since: null,
  ...over,
})
const view = (rows: StatusRow[]): StatusView => ({
  generated_at: new Date().toISOString(),
  machine: 'davion-sidarli',
  rows,
  summary: {
    problems: 1,
    worst: 'failed',
    counts: { failed: 1, late: 0, unknown: 0, warn: 0 },
    quiet: 0,
    healthy: rows.length - 1,
    top: [],
  },
})

const show = (project = '') =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <StatusPage project={project} />
    </QueryClientProvider>,
  )

beforeEach(() => {
  api.fail = false
  api.calls = []
  api.view = view([
    row({
      id: 'backups',
      what: 'Nightly backup',
      kind: 'backup',
      state: 'failed',
      shown: 'failed',
      meaning: 'The copy to the T7 failed.',
      project: 'aico',
      actions: [{ kind: 'run', ref: 'backup now' }],
    }),
    row({ id: 'disk', what: 'Disk space' }),
    row({ id: 'web', what: 'aico-web', kind: 'service' }),
  ])
})

describe('StatusPage', () => {
  it('shows problems first and folds the healthy rows into a count', async () => {
    show()
    const problems = await screen.findByRole('region', { name: 'Problems' })
    expect(within(problems).getByText('Nightly backup')).toBeVisible()
    expect(screen.queryByText('Disk space')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /2 healthy/ }))
    expect(screen.getByText('Disk space')).toBeVisible()
  })

  it('filters by a rollup chip and offers to clear when nothing matches', async () => {
    show()
    await screen.findByText('Nightly backup')
    fireEvent.change(screen.getByLabelText('Search rows'), {
      target: { value: 'nothing like it' },
    })
    expect(screen.getByText('Nothing matches')).toBeVisible()
    expect(screen.getByText(/3 rows hidden by these filters/)).toBeVisible()
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])
    fireEvent.click(screen.getByRole('button', { name: '2 OK' }))
    expect(screen.queryByText('Nightly backup')).toBeNull()
    expect(screen.getByText('Disk space')).toBeVisible()
  })

  it('runs a row and says it started', async () => {
    show()
    await screen.findByText('Nightly backup')
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(
      await screen.findByText(
        'Started “Nightly backup”. The row updates when it reports.',
      ),
    ).toBeVisible()
    expect(api.calls).toContain('/api/status/run')
  })

  it('says when the server doesn’t answer and treats nothing as healthy', async () => {
    api.fail = true
    show()
    // useStatus retries once before it gives up.
    expect(
      await screen.findByText('Couldn’t load status.', {}, { timeout: 4000 }),
    ).toBeVisible()
    expect(screen.getByText('No rows to show')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('says no rows yet when nothing has reported', async () => {
    api.view = view([])
    show()
    expect(
      await screen.findByRole('heading', { name: 'No rows yet' }),
    ).toBeVisible()
  })

  it('a project page keeps only that project’s rows', async () => {
    show('aico')
    await screen.findByText('Nightly backup')
    expect(
      screen.getByRole('heading', { level: 1, name: 'aico' }),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: /healthy/ })).toBeNull()
  })
})
