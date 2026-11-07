import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusRow, StatusView } from '@/lib/status'
import { StatusPage } from './StatusPage'

const api = vi.hoisted(() => ({
  view: null as StatusView | null,
  fail: false,
  calls: [] as { url: string; method: string; body?: string }[],
  /** The answer to POST /api/status/run: an object, or an HTTP status to refuse with. */
  run: { state: 'done', lines: [] } as unknown,
  log: null as unknown,
}))
vi.mock('@/lib/api-fetch', async () => {
  const { ApiError } =
    await vi.importActual<typeof import('@/lib/api-fetch')>('@/lib/api-fetch')
  return {
    ApiError,
    apiFetch: vi.fn(async (url: string, options?: RequestInit) => {
      api.calls.push({
        url,
        method: options?.method ?? 'GET',
        body: options?.body as string | undefined,
      })
      if (url === '/api/status') {
        if (api.fail || !api.view) throw new Error('Couldn’t load status')
        return api.view
      }
      if (url === '/api/status/run') {
        if (typeof api.run === 'number')
          throw new ApiError('Nightly backup is still running', api.run)
        return api.run
      }
      if (url === '/api/status/log') return api.log
      throw new Error(`unexpected ${url}`)
    }),
  }
})
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

const urls = () => api.calls.map((call) => call.url)

beforeEach(() => {
  api.fail = false
  api.calls = []
  api.run = { state: 'done', lines: [] }
  api.log = null
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
    expect(urls()).toContain('/api/status/run')
  })

  it('shows a run the server says is going, and a second run as still running', async () => {
    api.view = { ...(api.view as StatusView), running: ['backups'] }
    show()
    await screen.findByText('Nightly backup')
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled()
  })

  it('says a row is still running when the server refuses a second run', async () => {
    api.run = 409
    show()
    await screen.findByText('Nightly backup')
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(
      await screen.findByText(
        '“Nightly backup” is still running. The row updates when it reports.',
      ),
    ).toBeVisible()
  })

  it('reads the log by POST and says when it was cut off', async () => {
    api.view = view([
      row({
        id: 'backups',
        what: 'Nightly backup',
        kind: 'backup',
        state: 'failed',
        shown: 'failed',
        meaning: 'The copy to the T7 failed.',
        actions: [{ kind: 'log', ref: 'journalctl -f' }],
      }),
    ])
    api.log = {
      ref: 'journalctl -f',
      machine: 'davion-sidarli',
      ok: true,
      truncated: true,
      lines: ['old line'],
    }
    show()
    await screen.findByText('Nightly backup')
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    expect(
      await screen.findByText(
        /Cut off after 10 seconds: the command was still printing/,
      ),
    ).toBeVisible()
    expect(api.calls.find((call) => call.url === '/api/status/log')).toEqual({
      url: '/api/status/log',
      method: 'POST',
      body: JSON.stringify({ id: 'backups' }),
    })
  })

  it('names a project picked in the filters, counts its rows, and the arrow shows all again', async () => {
    show()
    await screen.findByText('Nightly backup')
    expect(screen.getByText(/^3 rows from 1 machine/)).toBeVisible()
    // The frame closes the page; Status has no way back of its own.
    expect(screen.queryByRole('link', { name: 'Back to sessions' })).toBeNull()
    fireEvent.change(screen.getByLabelText('All projects'), {
      target: { value: 'aico' },
    })
    expect(
      screen.getByRole('heading', { level: 1, name: 'aico' }),
    ).toBeVisible()
    expect(screen.getByText(/^1 row from 1 machine/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Status' }))
    expect(
      screen.getByRole('heading', { level: 1, name: 'Status' }),
    ).toBeVisible()
    expect(screen.getByText(/^3 rows from 1 machine/)).toBeVisible()
  })

  it('counts what a filter shows, and the arrow clears it', async () => {
    show()
    await screen.findByText('Nightly backup')
    fireEvent.click(screen.getByRole('button', { name: '1 failed' }))
    expect(screen.getByText(/^1 of 3 rows · updated/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Back to all rows' }))
    expect(screen.getByText(/^3 rows from 1 machine/)).toBeVisible()
    expect(screen.getByRole('button', { name: '1 failed' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
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
