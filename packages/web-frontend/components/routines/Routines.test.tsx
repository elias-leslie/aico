import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
    expect(rows[0]?.textContent).toContain('Every 5 minutes · next')
    expect(rows[0]?.textContent).toContain('Exited 1: T7 is writable')
    expect(rows[2]?.textContent).toContain('Paused')
    expect(rows[2]?.textContent).toContain('Daily at 19:00 · paused')
    expect(rows[1]?.textContent).toContain('OK')
    // A healthy row is closed until opened.
    expect(rows[1]?.textContent).not.toContain('Nothing new.')
    fireEvent.click(rows[1]?.querySelector('button') as HTMLElement)
    expect(rows[1]?.textContent).toContain('Nothing new.')
    expect(rows[1]?.textContent).toContain(
      'runs on either davion-sidarli or aico',
    )
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
      url: '/api/status/log',
      body: { id: 'jobs/school-check' },
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
