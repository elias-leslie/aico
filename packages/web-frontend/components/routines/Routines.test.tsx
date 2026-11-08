import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine } from '@/lib/routines'
import { RoutinesBody, useRoutinesHead } from './Routines'

const routine = (over: Partial<Routine> = {}): Routine => ({
  kind: 'school-check',
  what: 'Nightly school check',
  project: 'school-check',
  source: 'registered',
  home: 'davion-sidarli',
  hosts: ['davion-sidarli', 'aico'],
  schedule: 'daily at 19:00',
  scope: 'user',
  command: ['/srv/workspaces/projects/school-check/run.sh'],
  paused: false,
  running: false,
  started: true,
  nextRun: Date.now() + 3_600_000,
  lastRun: Date.now() - 3_600_000,
  lastState: 'ok',
  lastMeaning: 'Nothing new.',
  lastMachine: 'davion-sidarli',
  ...over,
})

let list: Routine[] | 'down'
let logLines: string[] = []
const posts: { url: string; body: unknown }[] = []

beforeEach(() => {
  list = [
    routine(),
    routine({
      kind: 'backups-guard',
      what: 'Backup storage read-only guard',
      project: 'aico',
      source: 'built-in',
      schedule: 'every 5 minutes',
      command: undefined,
      lastState: 'failed',
      lastMeaning: 'Exited 1: T7 is writable',
    }),
    routine({ kind: 'old', what: 'Old thing', paused: true, nextRun: null }),
  ]
  posts.length = 0
  logLines = ['line one', 'line two']
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        return new Response(
          JSON.stringify(
            url.endsWith('/log')
              ? { ok: true, truncated: false, lines: logLines }
              : { message: 'done' },
          ),
        )
      }
      if (list === 'down') return new Response('{}', { status: 502 })
      return new Response(JSON.stringify({ routines: list }))
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const view = (ui = <RoutinesBody />) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, retryDelay: 0 } },
        })
      }
    >
      {ui}
    </QueryClientProvider>,
  )

describe('Routines', () => {
  it('lists failed first with chips, schedule and next run, and opens the failed one', async () => {
    view()
    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'routine-backups-guard',
      'routine-school-check',
      'routine-old',
    ])
    expect(rows[0]?.textContent).toContain('Failed')
    expect(rows[0]?.textContent).toContain('next')
    // A failed row opens by itself: the schedule sentence and the failure are in its detail.
    expect(rows[0]?.textContent).toContain('Every 5 minutes')
    expect(rows[0]?.textContent).toContain('Exited 1: T7 is writable')
    expect(rows[2]?.textContent).toContain('Paused')
    expect(rows[2]?.textContent).toContain('paused')
    expect(rows[1]?.textContent).toContain('OK')
    // A healthy row is closed until opened.
    expect(rows[1]?.textContent).not.toContain('Nothing new.')
    expect(rows[1]?.textContent).not.toContain('Daily at 19:00')
    fireEvent.click(rows[1]?.querySelector('button') as HTMLElement)
    expect(rows[1]?.textContent).toContain('Nothing new.')
    expect(rows[1]?.textContent).toContain(
      'runs on either davion-sidarli or aico',
    )
    expect(rows[1]?.textContent).toContain('Daily at 19:00')
    expect(rows[1]?.textContent).toContain('Last run')
    expect(rows[1]?.textContent).toContain(
      '/srv/workspaces/projects/school-check/run.sh',
    )
  })

  it('runs now, pauses and resumes by kind, and shows the log', async () => {
    view()
    const school = (await screen.findByTestId(
      'routine-school-check',
    )) as HTMLElement
    fireEvent.click(school.querySelector('button') as HTMLElement)
    const button = (name: string) =>
      Array.from(school.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(name),
      ) as HTMLElement
    fireEvent.click(button('Run now'))
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/routines/run',
        body: { kind: 'school-check' },
      }),
    )
    fireEvent.click(button('Pause'))
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/routines/pause',
        body: { kind: 'school-check' },
      }),
    )
    fireEvent.click(button('Show log'))
    expect(await screen.findByText(/line one/)).toBeTruthy()
    expect(posts.at(-1)).toEqual({
      url: '/api/routines/log',
      body: { kind: 'school-check' },
    })
    const old = screen.getByTestId('routine-old')
    fireEvent.click(old.querySelector('button') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }))
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/routines/resume',
        body: { kind: 'old' },
      }),
    )
  })

  it('lists a weekly routine in words and a systemd timer read only, with no log to show', async () => {
    list = [
      routine({
        kind: 'proveout',
        what: 'Weekly prove-out',
        schedule: 'every Monday at 06:30',
        at: '06:30',
        on: 'mon',
      }),
      routine({
        kind: 'host-steward-heartbeat@aico',
        what: 'Host heartbeat to Proxmox',
        project: 'aico',
        source: 'systemd',
        home: 'aico',
        hosts: ['aico'],
        schedule: 'every 5 minutes',
        scope: 'system',
        command: ['host-steward-heartbeat.timer'],
        lastState: 'failed',
        lastMeaning: 'Failed (exit-code, exit 3).',
      }),
    ]
    view()
    const weekly = await screen.findByTestId('routine-proveout')
    fireEvent.click(weekly.querySelector('button') as HTMLElement)
    expect(weekly.textContent).toContain('Every Monday at 06:30 · next')
    const timer = screen.getByTestId('routine-host-steward-heartbeat@aico')
    // A failed row opens by itself and wears the failed chip, like any routine.
    expect(timer.textContent).toContain('Failed')
    expect(timer.textContent).toContain(
      'Systemd timer, read only · runs on aico',
    )
    expect(timer.textContent).toContain('host-steward-heartbeat.timer')
    const names = Array.from(timer.querySelectorAll('button')).map(
      (b) => b.textContent,
    )
    expect(names).toContain('Run now')
    expect(names).toContain('Pause')
    expect(names).toContain('Show log')
    fireEvent.click(
      Array.from(timer.querySelectorAll('button')).find(
        (b) => b.textContent === 'Run now',
      ) as HTMLElement,
    )
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/routines/run',
        body: { kind: 'host-steward-heartbeat@aico' },
      }),
    )
    // Its log is the service's journal, asked of the routines route.
    logLines = ['Nov 07 20:21:11 aico systemd[1]: Finished.']
    fireEvent.click(
      Array.from(timer.querySelectorAll('button')).find(
        (b) => b.textContent === 'Show log',
      ) as HTMLElement,
    )
    expect(await screen.findByText(/20:21:11 aico/)).toBeTruthy()
    expect(posts.at(-1)).toEqual({
      url: '/api/routines/log',
      body: { kind: 'host-steward-heartbeat@aico' },
    })
  })

  it('shows a run due later today as its time of day alone, in the viewer’s time with no zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 8, 9, 0))
    list = [
      routine({
        kind: 'soon',
        what: 'Soon one',
        schedule: 'daily at 03:30',
        at: '03:30',
        tz: 'Pacific/Kiritimati',
        nextRun: Date.now() + 3_600_000,
      }),
    ]
    view()
    const row = await screen.findByTestId('routine-soon')
    const when = row.querySelector('button')?.textContent ?? ''
    expect(when).toMatch(/\d:\d\d (AM|PM)/)
    expect(when).not.toMatch(/GMT|UTC|[A-Z][a-z]{2} \d/)
    vi.useRealTimers()
  })

  it('names the day of a run due tomorrow, so it can’t read as a time already gone by', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 8, 9, 0))
    list = [
      routine({
        kind: 'soon',
        what: 'Soon one',
        nextRun: new Date(2026, 10, 9, 3, 5).getTime(),
      }),
    ]
    view()
    const row = await screen.findByTestId('routine-soon')
    expect(row.querySelector('button')?.textContent).toContain('Mon 3:05 AM')
    vi.useRealTimers()
  })

  it('always shows the next run in the row, marked with the clock; next and last in full on hover', async () => {
    list = [
      routine({
        kind: 'late',
        what: 'Late one',
        nextRun: Date.now() - 60_000,
        lastRun: Date.parse('2026-11-07T22:11:00'),
        lastMachine: 'aico',
      }),
    ]
    view()
    const row = await screen.findByTestId('routine-late')
    expect(row.querySelector('button')).toHaveTextContent('due now')
    expect(within(row).getByLabelText('Next run')).toBeInTheDocument()
    expect(
      row.querySelector('[title^="Next run"]')?.getAttribute('title'),
    ).toMatch(/^Next run .+\. Last run Nov 7, 10:11 PM on aico\.$/)
  })

  it('groups by machine, groups with a problem first (by name), with the failed count in the head', async () => {
    list = [
      routine({ kind: 'a1', what: 'Alpha', home: 'aico', hosts: ['aico'] }),
      routine({ kind: 'w1', what: 'Wolf', home: 'davion-sidarli' }),
      routine({
        kind: 'w2',
        what: 'Wasp',
        home: 'davion-sidarli',
        lastState: 'failed',
        lastMeaning: 'Exited 1',
      }),
      routine({
        kind: 'g1',
        what: 'Gem job',
        home: 'davion-gem',
        hosts: ['davion-gem'],
        unreadable: 'ssh timed out',
        lastState: null,
      }),
    ]
    view()
    await screen.findByTestId('routine-w1')
    const heads = screen
      .getAllByRole('button', { expanded: true })
      .filter((b) => b.className.includes('groupHead'))
    expect(heads.map((b) => b.textContent)).toEqual([
      'davion-gem1 routine1 not known',
      'davion-sidarli2 routines1 failed',
      'aico1 routine',
    ])
    const rows = screen.getAllByRole('listitem')
    // Failed first inside its machine.
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'routine-g1',
      'routine-w2',
      'routine-w1',
      'routine-a1',
    ])
  })

  it('folds a big machine with nothing to look at, and opens it on a click', async () => {
    list = Array.from({ length: 10 }, (_, i) =>
      routine({ kind: `r${i}`, what: `Routine ${i}` }),
    )
    view()
    const head = await screen.findByRole('button', { name: /davion-sidarli/ })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    fireEvent.click(head)
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
  })

  it('tells a run in the viewer’s time, and names the routine’s own zone only on its schedule with the viewer’s time beside it', async () => {
    // 03:30 in Kiritimati (UTC+14) is 13:30 UTC the day before.
    const next = Date.UTC(2030, 5, 14, 13, 30)
    const local = new Date(next).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    const localTime = new Date(next).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
    list = [
      routine({
        kind: 'gem',
        what: 'Notes export (gem)',
        schedule: 'daily at 03:30',
        at: '03:30',
        tz: 'Pacific/Kiritimati',
        nextRun: next,
      }),
      routine({
        kind: 'here',
        what: 'Local export',
        schedule: 'daily at 03:30',
        at: '03:30',
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        nextRun: next,
      }),
    ]
    view()
    const gem = await screen.findByTestId('routine-gem')
    expect(gem.querySelector('button')?.textContent).toContain(local)
    expect(gem.querySelector('button')?.textContent).not.toContain('GMT')
    fireEvent.click(gem.querySelector('button') as HTMLElement)
    expect(gem.textContent).toContain(
      `Daily at 03:30 GMT+14 (${localTime} here) · next ${local}`,
    )
    const here = screen.getByTestId('routine-here')
    fireEvent.click(here.querySelector('button') as HTMLElement)
    expect(here.textContent).toContain(`Daily at 03:30 · next ${local}`)
    expect(here.textContent).not.toContain('GMT')
    expect(here.textContent).not.toContain('here)')
  })

  it('says so when the last run printed nothing', async () => {
    logLines = ['']
    view()
    const school = (await screen.findByTestId(
      'routine-school-check',
    )) as HTMLElement
    fireEvent.click(school.querySelector('button') as HTMLElement)
    fireEvent.click(
      Array.from(school.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Show log'),
      ) as HTMLElement,
    )
    expect(
      await screen.findByText('Its last run printed nothing.'),
    ).toBeTruthy()
  })

  it('says it could not load, not that there are none', async () => {
    list = 'down'
    view()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Couldn’t load routines',
    )
    expect(screen.queryByText(/No routines yet/)).toBeNull()
  })

  it('says none are registered when the list is empty', async () => {
    list = []
    view()
    expect(await screen.findByText(/No routines yet/)).toBeTruthy()
  })

  it('gives the collapsed row its value', async () => {
    const Head = () => <p data-testid="head">{useRoutinesHead().value}</p>
    view(<Head />)
    expect(screen.getByTestId('head').textContent).toBe('Checking…')
    await waitFor(() =>
      expect(screen.getByTestId('head').textContent).toBe(
        '3 routines · 1 failed · 1 paused',
      ),
    )
  })
})
