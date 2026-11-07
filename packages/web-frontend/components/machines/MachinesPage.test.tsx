import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostChoice } from '@/lib/hooks/use-hosts'
import type { StatusRow, StatusView } from '@/lib/status'
import { MachinesPage } from './MachinesPage'

const data = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  hosts: {} as Record<string, unknown>,
  power: vi.fn(async () => ({})),
}))
vi.mock('@/lib/hooks/use-status', () => ({ useStatus: () => data.status }))
vi.mock('@/lib/hooks/use-hosts', () => ({ useHosts: () => data.hosts }))
vi.mock('@/lib/hooks/use-host-admin', () => ({
  HostCallError: class extends Error {
    status = 409
  },
  powerHost: (...args: unknown[]) =>
    (data.power as (...a: unknown[]) => unknown)(...args),
  trustHost: vi.fn(),
}))

const row = (over: Partial<StatusRow>): StatusRow => ({
  id: 'x/machine',
  what: 'x',
  kind: 'machine',
  machine: 'x',
  state: 'ok',
  meaning: 'Up.',
  updated_at: new Date().toISOString(),
  shown: 'ok',
  shown_since: null,
  ...over,
})
const view = (rows: StatusRow[]) =>
  ({
    rows,
    machine: 'davion-sidarli',
    summary: {},
    generated_at: '',
  }) as unknown as StatusView
const ROWS = [
  row({ id: 'davion-sidarli/machine', machine: 'davion-sidarli' }),
  row({ id: 'ominull.machine', machine: 'ominull-hub' }),
  row({
    id: 'fleet/davion-sidarli/agent-work',
    machine: 'agent-work',
    shown: 'off',
  }),
]
const host = (over: Partial<HostChoice> = {}): HostChoice => ({
  name: 'agent-work',
  state: 'connected',
  canSleep: true,
  sessions: 0,
  ...over,
})

function renderPage() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <MachinesPage />
    </QueryClientProvider>,
  )
}
const ok = (v: StatusView) => ({
  view: v,
  loading: false,
  failed: false,
  stale: false,
  readAt: Date.now(),
  refetch: vi.fn(),
  refreshing: false,
})

describe('MachinesPage', () => {
  beforeEach(() => {
    data.power.mockClear()
    data.status = ok(view(ROWS))
    data.hosts = {
      hosts: [host()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }
  })

  it('says what the list is and tags the session hosts', () => {
    renderPage()
    expect(screen.getByRole('status')).toHaveTextContent(
      '3 machines; 2 can run sessions.',
    )
    const work = screen.getByTestId('machine-agent-work')
    expect(within(work).getByText('Session host')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('machine-ominull-hub')).queryByText(
        'Session host',
      ),
    ).toBeNull()
  })

  it('asks before powering off, then powers off', async () => {
    renderPage()
    fireEvent.click(
      within(screen.getByTestId('machine-agent-work')).getByRole('button', {
        name: 'Power off',
      }),
    )
    expect(data.power).not.toHaveBeenCalled()
    expect(screen.getByText('Power off agent-work?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(data.power).not.toHaveBeenCalled()
  })

  it('offers Power on for a host that is off', () => {
    data.hosts = {
      hosts: [host({ state: 'powered_off' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }
    renderPage()
    expect(screen.getByRole('button', { name: 'Power on' })).toBeInTheDocument()
  })

  it('is partial, not empty, when Status cannot be read', () => {
    data.status = { ...ok(view([])), view: null, failed: true }
    renderPage()
    expect(
      screen.getByText(/Couldn’t read the other machines/),
    ).toBeInTheDocument()
    expect(screen.getByTestId('machine-agent-work')).toBeInTheDocument()
  })

  it('says it could not load when nothing answers', () => {
    data.status = { ...ok(view([])), view: null, failed: true }
    data.hosts = {
      hosts: [],
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    }
    renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Couldn’t load machines.',
    )
    expect(screen.queryByTestId('machine-davion-sidarli')).toBeNull()
  })
})
