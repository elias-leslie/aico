import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostChoice } from '@/lib/hooks/use-hosts'
import type { StatusRow, StatusView } from '@/lib/status'
import { MachinesPage } from './MachinesPage'

const data = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  hosts: {} as Record<string, unknown>,
  power: vi.fn(async () => ({})),
  guests: {} as Record<string, unknown>,
  machinePower: vi.fn(async () => ({})),
  autostart: vi.fn(async () => ({})),
  away: vi.fn(async () => {}),
  awayStatus: { enabled: true } as { enabled: boolean; reason?: string } | null,
  services: null as unknown,
  restartService: vi.fn(async () => {}),
  shutDown: vi.fn(async () => {}),
}))
vi.mock('@/lib/hooks/use-status', () => ({ useStatus: () => data.status }))
vi.mock('@/lib/hooks/use-hosts', () => ({
  useHosts: () => data.hosts,
  isStarting: (h: { wake?: { state?: string } | null }) =>
    h.wake?.state === 'starting',
}))
vi.mock('@/lib/hooks/use-host-admin', () => ({
  HostCallError: class extends Error {
    status = 409
  },
  powerHost: (...args: unknown[]) =>
    (data.power as (...a: unknown[]) => unknown)(...args),
  trustHost: vi.fn(),
}))

vi.mock('@/lib/hooks/use-machine-guests', () => ({
  useMachineServices: () => ({ machines: data.services, refetch: vi.fn() }),
  useSessionCopies: () => ({ machines: null, failed: false }),
  restartService: (...args: unknown[]) =>
    (data.restartService as (...a: unknown[]) => unknown)(...args),
  shutDownMachine: (...args: unknown[]) =>
    (data.shutDown as (...a: unknown[]) => unknown)(...args),
  useMachineGuests: () => data.guests,
  powerMachine: (...args: unknown[]) =>
    (data.machinePower as (...a: unknown[]) => unknown)(...args),
  setAutostart: (...args: unknown[]) =>
    (data.autostart as (...a: unknown[]) => unknown)(...args),
  awayAll: () => data.away(),
  useAwayStatus: () => data.awayStatus,
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
    data.machinePower.mockClear()
    data.autostart.mockClear()
    data.away.mockClear()
    data.awayStatus = { enabled: true }
    data.guests = {
      guests: null,
      failure: null,
      isLoading: false,
      refetch: vi.fn(),
    }
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
      '3 machines, 3 on. Sessions can run on 2 of them; all of those are on.',
    )
    const work = screen.getByTestId('machine-agent-work')
    expect(within(work).getByText('Runs sessions')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('machine-ominull-hub')).queryByText(
        'Runs sessions',
      ),
    ).toBeNull()
  })

  it('asks before powering off, then powers off', async () => {
    renderPage()
    fireEvent.click(
      within(screen.getByTestId('machine-agent-work')).getByRole('button', {
        name: 'Shut down',
      }),
    )
    expect(data.power).not.toHaveBeenCalled()
    expect(screen.getByText('Shut down agent-work?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(data.power).not.toHaveBeenCalled()
  })

  it('asks plainly before shutting everything down for leaving, then says how to start again', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Shut down all' }))
    expect(data.away).not.toHaveBeenCalled()
    expect(screen.getByText('Shut down all machines?')).toBeInTheDocument()
    expect(screen.getByText(/Kasa app/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(data.away).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Shut down all' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Shut down all',
      }),
    )
    expect(await screen.findByText('Shutting down.')).toBeInTheDocument()
    expect(data.away).toHaveBeenCalledTimes(1)
  })

  it('shows Shut down all disabled, with the reason, until remote power is set up', () => {
    data.awayStatus = {
      enabled: false,
      reason: 'Remote power isn’t set up yet.',
    }
    renderPage()
    const button = screen.getByRole('button', { name: 'Shut down all' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Remote power isn’t set up yet.')
    data.awayStatus = null
    renderPage()
    expect(
      screen.getAllByRole('button', { name: 'Shut down all' })[1],
    ).toBeDisabled()
  })

  it('keeps the dialog open with the reason when the shutdown is refused', async () => {
    data.away.mockRejectedValueOnce(
      new Error('The power plug at 192.168.87.217 didn’t answer'),
    )
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Shut down all' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Shut down all',
      }),
    )
    expect(
      await screen.findByText('The power plug at 192.168.87.217 didn’t answer'),
    ).toBeInTheDocument()
    expect(screen.getByText('Shut down all machines?')).toBeInTheDocument()
  })

  it('shuts the Workstation down from its row, saying how it comes back', async () => {
    data.status = ok(view(ROWS))
    data.hosts = { hosts: [], isError: false, refetch: vi.fn() }
    data.shutDown.mockClear()
    renderPage()
    const workstation = screen.getByTestId('machine-davion-sidarli')
    fireEvent.click(
      within(workstation).getByRole('button', { name: 'Shut down' }),
    )
    expect(screen.getByText('Shut down Workstation?')).toBeInTheDocument()
    expect(screen.getByText(/Sessions save their place/)).toBeInTheDocument()
    expect(screen.getByText(/hasn’t been tried yet yet/)).toBeInTheDocument()
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'Shut down' })
        .at(-1) as HTMLElement,
    )
    await vi.waitFor(() =>
      expect(data.shutDown).toHaveBeenCalledWith('davion-sidarli'),
    )
  })

  it('lists a machine’s services and restarts one after asking once', async () => {
    data.status = ok(view(ROWS))
    data.hosts = { hosts: [], isError: false, refetch: vi.fn() }
    data.services = [
      {
        machine: 'davion-sidarli',
        units: [
          {
            unit: 'aico-jobs.service',
            label: 'Routines',
            state: 'failed',
            reloadsPage: false,
          },
        ],
      },
    ]
    data.restartService.mockClear()
    renderPage()
    const workstation = screen.getByTestId('machine-davion-sidarli')
    expect(within(workstation).getByText('Failed')).toBeTruthy()
    fireEvent.click(
      within(workstation).getByRole('button', { name: 'Restart' }),
    )
    expect(
      screen.getByText('Restart Routines on Workstation?'),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Restart' }).at(-1) as HTMLElement,
    )
    await vi.waitFor(() =>
      expect(data.restartService).toHaveBeenCalledWith(
        'davion-sidarli',
        'aico-jobs.service',
      ),
    )
    data.services = null
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

  describe('with Proxmox read', () => {
    const guest = (over: Record<string, unknown>) => ({
      machine: 'ominull-hub',
      vmid: 150,
      kind: 'ct',
      state: 'running',
      since: null,
      busy: null,
      failed: null,
      autostart: true,
      intent: 'always',
      powerable: true,
      cpus: 2,
      memoryMb: 1024,
      projects: [],
      ...over,
    })
    const withGuests = (...list: Record<string, unknown>[]) => {
      data.guests = {
        guests: list,
        failure: null,
        isLoading: false,
        refetch: vi.fn(),
      }
    }

    it('offers Restart and Shut down on a machine that is on, and asks first', async () => {
      withGuests(guest({}))
      renderPage()
      const hub = within(screen.getByTestId('machine-ominull-hub'))
      expect(hub.queryByRole('button', { name: 'Power on' })).toBeNull()
      fireEvent.click(hub.getByRole('button', { name: 'Restart' }))
      expect(screen.getByText('Restart ominull-hub?')).toBeInTheDocument()
      expect(data.machinePower).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
      await vi.waitFor(() =>
        expect(data.machinePower).toHaveBeenCalledWith(
          'ominull-hub',
          'restart',
          true,
        ),
      )
    })

    it('shows a failed shutdown as a badge, lets the owner retry, and offers Force off only then', async () => {
      withGuests(guest({}))
      renderPage()
      expect(
        within(screen.getByTestId('machine-ominull-hub')).queryByRole(
          'button',
          {
            name: 'Force off',
          },
        ),
      ).toBeNull()
      cleanup()
      withGuests(
        guest({
          failed: {
            action: 'shutdown',
            reason: 'VM quit/powerdown failed - got timeout',
            at: '2026-11-08T10:00:00Z',
          },
        }),
      )
      renderPage()
      const hub = within(screen.getByTestId('machine-ominull-hub'))
      expect(hub.getByText('Didn’t shut down')).toHaveAttribute(
        'title',
        expect.stringContaining('got timeout'),
      )
      // Not stuck: the row is no longer shutting down and Shut down is available again.
      expect(hub.queryByText('Shutting down')).toBeNull()
      expect(hub.getByRole('button', { name: 'Shut down' })).toBeEnabled()
      fireEvent.click(hub.getByRole('button', { name: 'Force off' }))
      expect(screen.getByText('Force off ominull-hub?')).toBeInTheDocument()
      expect(data.machinePower).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Force off' }))
      await vi.waitFor(() =>
        expect(data.machinePower).toHaveBeenCalledWith(
          'ominull-hub',
          'stop',
          true,
        ),
      )
    })

    it('warns an always-on machine that Status will not flag it while off', () => {
      withGuests(guest({}))
      renderPage()
      fireEvent.click(
        within(screen.getByTestId('machine-ominull-hub')).getByRole('button', {
          name: 'Shut down',
        }),
      )
      expect(screen.getByText(/Status won’t flag it/)).toBeInTheDocument()
    })

    it('offers Power on for a stopped machine and shows a start in progress', () => {
      withGuests(
        guest({
          machine: 'ominull-hub',
          state: 'stopped',
          intent: 'on-demand',
        }),
      )
      renderPage()
      expect(
        screen.getByRole('button', { name: 'Power on' }),
      ).toBeInTheDocument()
      withGuests(
        guest({ machine: 'ominull-hub', state: 'stopped', busy: 'start' }),
      )
      renderPage()
      expect(
        screen.getAllByRole('button', { name: 'Starting…' })[0],
      ).toBeDisabled()
    })

    it('shows the real autostart value and writes the toggle', async () => {
      withGuests(guest({ autostart: false, intent: 'on-demand' }))
      renderPage()
      const toggle = within(
        screen.getByTestId('machine-ominull-hub'),
      ).getByRole('switch', { name: 'Autostart' })
      expect(toggle).not.toBeChecked()
      fireEvent.click(toggle)
      await vi.waitFor(() =>
        expect(data.autostart).toHaveBeenCalledWith('ominull-hub', true),
      )
    })

    it('says so when Proxmox did not give the autostart value', () => {
      withGuests(guest({ autostart: null }))
      renderPage()
      expect(
        screen.getByText(/Autostart: Proxmox didn’t say/),
      ).toBeInTheDocument()
      expect(screen.queryByRole('switch')).toBeNull()
    })

    it('says Proxmox could not be read and keeps session-host power', () => {
      data.guests = {
        guests: null,
        failure: 'Proxmox did not answer.',
        isLoading: false,
        refetch: vi.fn(),
      }
      renderPage()
      expect(screen.getByText(/Couldn’t read Proxmox/)).toBeInTheDocument()
      expect(screen.queryByRole('switch')).toBeNull()
      expect(
        within(screen.getByTestId('machine-agent-work')).getByRole('button', {
          name: 'Shut down',
        }),
      ).toBeInTheDocument()
    })

    it('does not offer power on a machine the registry says is not powered here', () => {
      withGuests(guest({ powerable: false }))
      renderPage()
      const hub = within(screen.getByTestId('machine-ominull-hub'))
      expect(hub.queryByRole('button', { name: 'Shut down' })).toBeNull()
      expect(hub.getByRole('switch')).toBeInTheDocument()
    })
  })
})
