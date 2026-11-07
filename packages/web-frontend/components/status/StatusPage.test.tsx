import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusRow, StatusView } from '@/lib/status'
import { StatusPage } from './StatusPage'

const api = vi.hoisted(() => ({
  view: null as StatusView | null,
  sessions: [] as { id: string; name: string }[],
  recovery: { items: [] } as unknown,
  resume: { results: [{ ok: true, reason: null }] } as unknown,
  push: vi.fn(),
  narrow: false,
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
      if (url === '/api/recovery') return api.recovery
      if (url === '/api/recovery/resume') return api.resume
      throw new Error(`unexpected ${url}`)
    }),
  }
})
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => false }))
vi.mock('@/lib/hooks/use-terminal-sessions', () => ({
  useTerminalSessions: () => ({
    sessions: api.sessions,
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: api.push }) }))
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
  api.sessions = []
  api.recovery = { items: [] }
  api.resume = { results: [{ ok: true, reason: null }] }
  api.push.mockClear()
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

  it('keeps rows of a machine that is off apart from the healthy ones', async () => {
    api.view = view([
      row({
        id: 'backups',
        what: 'Nightly backup',
        state: 'failed',
        shown: 'failed',
      }),
      row({ id: 'disk', what: 'Disk space' }),
      row({
        id: 'scan',
        what: 'Job scan',
        machine: 'jobinator',
        state: 'off',
        shown: 'off',
        machine_off: true,
      }),
      row({ id: 'hub', what: 'Hub', machine: 'aico' }),
      row({ id: 'gem', what: 'Gem', machine: 'davion-gem' }),
    ])
    show()
    await screen.findByText('Nightly backup')
    expect(screen.getByText(/5 rows from 3 machines/)).toBeVisible()
    expect(screen.getByRole('button', { name: /3 healthy/ })).toBeVisible()
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Off' })).getByRole('button'),
    )
    expect(screen.getByText('Job scan')).toBeVisible()
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

  describe('a memory row', () => {
    const memoryText =
      '6 memory kills in the last 24 hours: Session fa41c0c8: jobs killed again and again; chrome (18 MiB) killed in Session fa41c0c8; chrome (73 MiB) killed in Session 0badc0de. A session or its work was lost or cut short. Resume the session if it was not resumed, and see what held the memory.'
    beforeEach(() => {
      api.view = view([
        row({
          id: 'davion-sidarli/check-perf',
          what: 'Workstation performance',
          state: 'warn',
          shown: 'warn',
          meaning: 'Swap is 96% full while 23 GiB of memory is free.',
        }),
        row({
          id: 'davion-sidarli/check-memory',
          what: 'Memory',
          state: 'warn',
          shown: 'warn',
          meaning: memoryText,
          actions: [
            {
              kind: 'run',
              ref: 'sudo -n systemctl start host-steward-check.service',
            },
            { kind: 'session', ref: 'fa41c0c8' },
            { kind: 'session', ref: '0badc0de' },
          ],
        }),
        row({
          id: 'davion-sidarli/check-sudo',
          what: 'Sudo use',
          state: 'warn',
          shown: 'warn',
          meaning:
            '2 new sudo commands: userdel (Agent in session fa41c0c8), ominull-release-signer.',
        }),
      ])
      api.sessions = [{ id: 'fa41c0c8', name: 'Restore drill' }]
      api.recovery = { items: [{ id: 'fa41c0c8', resumable: true }] }
    })

    it('lists lost work and security before swap, and says what each costs', async () => {
      show()
      const problems = await screen.findByRole('region', { name: 'Problems' })
      const names = within(problems)
        .getAllByRole('button', {
          name: /^(Memory|Sudo use|Workstation performance)$/,
        })
        .map((button) => button.textContent)
      expect(names).toEqual(['Memory', 'Sudo use', 'Workstation performance'])
      expect(within(problems).getByText('Lost work')).toBeVisible()
      expect(within(problems).getByText('Security')).toBeVisible()
      expect(within(problems).getByText('Speed and space')).toBeVisible()
    })

    it('shows the whole text with session names, not ids', async () => {
      show()
      await screen.findByText('Memory')
      expect(
        await screen.findByText(
          /Session “Restore drill”: jobs killed again and again; chrome \(18 MiB\) killed in Session “Restore drill”; chrome \(73 MiB\) killed in A session that has ended\. .*see what held the memory\./,
        ),
      ).toBeVisible()
      expect(
        screen.getByText(
          /userdel \(Agent in session “Restore drill”\), ominull/,
        ),
      ).toBeVisible()
      expect(screen.queryByText(/fa41c0c8/)).toBeNull()
    })

    it('resumes a stopped session from the row', async () => {
      show()
      await screen.findByText('Memory')
      const button = await screen.findByRole('button', { name: /Resume/ })
      expect(button).toHaveAttribute(
        'title',
        'Resume “Restore drill”, which stopped',
      )
      fireEvent.click(button)
      expect(await screen.findByText(/Resuming “Restore drill”/)).toBeVisible()
      expect(
        api.calls.find((call) => call.url === '/api/recovery/resume'),
      ).toEqual({
        url: '/api/recovery/resume',
        method: 'POST',
        body: JSON.stringify({ id: 'fa41c0c8' }),
      })
    })

    it('says why a session did not resume', async () => {
      api.resume = {
        results: [{ ok: false, reason: 'not enough memory right now' }],
      }
      show()
      await screen.findByText('Memory')
      fireEvent.click(await screen.findByRole('button', { name: /Resume/ }))
      expect(
        await screen.findByText(/didn’t resume: not enough memory right now/),
      ).toBeVisible()
    })

    it('offers Open for a live session that is not waiting to be resumed', async () => {
      api.recovery = { items: [] }
      show()
      await screen.findByText('Memory')
      fireEvent.click(await screen.findByRole('button', { name: /Open/ }))
      expect(api.push).toHaveBeenCalledWith('/?session=fa41c0c8')
    })
  })
})
