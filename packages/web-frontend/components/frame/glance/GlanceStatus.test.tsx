import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusRow, StatusView } from '@/lib/status'
import { GlanceStatus, useStatusGlance } from './GlanceStatus'

const api = vi.hoisted(() => ({
  view: null as StatusView | null,
  fail: false,
  calls: [] as { url: string; method: string; body?: string }[],
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
      if (url === '/api/status/run') return { state: 'done', lines: [] }
      if (url === '/api/recovery') return { items: [] }
      throw new Error(`unexpected ${url}`)
    }),
  }
})
vi.mock('@/lib/hooks/use-terminal-sessions', () => ({
  useTerminalSessions: () => ({
    sessions: [],
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
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
  kind: 'job',
  machine: 'davion-sidarli',
  state: 'ok',
  meaning: 'Fine.',
  updated_at: new Date().toISOString(),
  shown: 'ok',
  shown_since: null,
  ...over,
})
const failing = (id: string) =>
  row({
    id,
    what: `Job ${id}`,
    shown: 'failed',
    state: 'failed',
    meaning: `Job ${id} broke`,
    actions: [{ kind: 'run', ref: id }],
  })
const view = (rows: StatusRow[]): StatusView => {
  const problems = rows.filter((r) => r.shown === 'failed')
  return {
    generated_at: new Date().toISOString(),
    machine: 'davion-sidarli',
    rows,
    summary: {
      problems: problems.length,
      worst: problems.length ? 'failed' : null,
      counts: { failed: problems.length, late: 0, unknown: 0, warn: 0 },
      quiet: 0,
      healthy: rows.length - problems.length,
      top: problems.slice(0, 3),
    },
  } as unknown as StatusView
}

const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, retryDelay: 0 } },
        })
      }
    >
      <GlanceStatus />
    </QueryClientProvider>,
  )

beforeEach(() => {
  api.fail = false
  api.view = null
  api.calls = []
})

describe('GlanceStatus', () => {
  it('lists every problem, not the top few, with no link out', async () => {
    api.view = view([
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => failing(`f${n}`)),
      row({ id: 'ok1', what: 'Fine job' }),
    ])
    show()
    for (let n = 1; n <= 7; n++)
      expect(
        await screen.findByRole('button', { name: new RegExp(`Job f${n}`) }),
      ).toBeVisible()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText(/more in Status/)).toBeNull()
    expect(screen.getByRole('button', { name: /1 healthy/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('opens a row in place with its meaning and its own action, which runs it', async () => {
    api.view = view([failing('a'), row({ id: 'ok1', what: 'Fine job' })])
    show()
    const line = await screen.findByRole('button', { name: /Job a/ })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Job a broke/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await screen.findByText(/Started “Job a”/)
    expect(api.calls).toContainEqual(
      expect.objectContaining({ url: '/api/status/run', method: 'POST' }),
    )
  })

  it('folds the healthy rows until asked, and a search opens them', async () => {
    api.view = view([failing('a'), row({ id: 'ok1', what: 'Fine job' })])
    show()
    await screen.findByRole('button', { name: /Job a/ })
    expect(screen.queryByText('Fine job')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /1 healthy/ }))
    expect(screen.getByText('Fine job')).toBeVisible()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search rows' }), {
      target: { value: 'nothing like it' },
    })
    expect(screen.getByText('Nothing matches.')).toBeVisible()
  })

  it('says loading, failed and empty in different words', async () => {
    api.fail = true
    const { unmount } = show()
    expect(screen.getByRole('status')).toHaveTextContent('Checking Status…')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Status couldn’t be read',
    )
    unmount()
    api.fail = false
    api.view = view([])
    show()
    expect(await screen.findByText(/No rows yet/)).toBeVisible()
  })
})

describe('useStatusGlance', () => {
  function Value() {
    const head = useStatusGlance()
    return (
      <p>
        {head.value}|{head.tone}
      </p>
    )
  }
  const mount = () =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
        }
      >
        <Value />
      </QueryClientProvider>,
    )

  it('calls warnings alone notes in a muted chip, and carries what needs the owner', async () => {
    const warn = (id: string) =>
      row({ id, what: id, shown: 'warn', state: 'warn' })
    const quiet = view([warn('a'), warn('b'), warn('c'), warn('d')])
    quiet.summary.counts = { failed: 0, late: 0, unknown: 0, warn: 4 }
    quiet.summary.problems = 4
    quiet.summary.worst = 'warn'
    api.view = quiet
    const first = mount()
    expect(await screen.findByText('4 notes|off')).toBeVisible()
    first.unmount()
    const loud = view([failing('a')])
    loud.summary.needs = 1
    api.view = loud
    mount()
    expect(await screen.findByText('1 problem|failed')).toBeVisible()
  })

  it('wears the worst state as a chip, healthy as ok, and never a zero for unread', async () => {
    api.view = view([failing('a'), failing('b')])
    const first = mount()
    expect(await screen.findByText('2 problems|failed')).toBeVisible()
    first.unmount()
    api.view = view([row({ id: 'ok1' })])
    const second = mount()
    expect(await screen.findByText('All healthy|ok')).toBeVisible()
    second.unmount()
    api.view = null
    api.fail = true
    mount()
    expect(screen.getByText('Checking…|')).toBeVisible()
    expect(await screen.findByText('Couldn’t read|failed')).toBeVisible()
  })
})
