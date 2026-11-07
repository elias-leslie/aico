import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoveryItem, RecoveryView } from '@/lib/recovery'
import { RecoveryPage } from './RecoveryPage'

const api = vi.hoisted(() => ({
  status: null as unknown,
  view: null as unknown,
  fail: false,
  resume: { resumed: 1, results: [] } as unknown,
  calls: [] as { url: string; method: string }[],
}))
vi.mock('@/lib/api-fetch', async () => {
  const { ApiError } =
    await vi.importActual<typeof import('@/lib/api-fetch')>('@/lib/api-fetch')
  return {
    ApiError,
    apiFetch: vi.fn(async (url: string, options?: RequestInit) => {
      api.calls.push({ url, method: options?.method ?? 'GET' })
      if (url === '/api/recovery') {
        if (api.fail || !api.view) throw new Error('Couldn’t check')
        return api.view
      }
      if (url === '/api/recovery/resume') return api.resume
      throw new Error(`unexpected ${url}`)
    }),
  }
})
vi.mock('@/lib/hooks/use-status', () => ({
  useStatus: () => ({ view: api.status }),
}))
vi.mock('@/lib/hooks/use-status-sessions', () => ({
  useStatusSessions: () => ({
    names: new Map([['fa41c0c8', 'Aico']]),
    resumable: new Set(),
  }),
}))
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

const item = (over: Partial<RecoveryItem>): RecoveryItem => ({
  id: 'aaaaaaaa',
  name: 'Restore drill',
  agent: 'Claude',
  project: null,
  machine: 'davion-sidarli',
  cause: 'crash',
  what: 'Ran out of memory',
  at: Date.now() - 3_600_000,
  atApprox: false,
  outcome: 'gave_up',
  resumedAt: null,
  note: 'It crashed again within 10 minutes of being recovered.',
  attemptsLeft: 0,
  resumable: true,
  canOpen: false,
  ...over,
})
const view = (
  items: RecoveryItem[],
  over: Partial<RecoveryView> = {},
): RecoveryView => ({
  checkedAt: Date.now(),
  partial: null,
  restartAt: null,
  maxAttempts: 2,
  windowHours: 6,
  resumable: items.filter((i) => i.resumable).length,
  items,
  ...over,
})

const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RecoveryPage />
    </QueryClientProvider>,
  )

beforeEach(() => {
  api.fail = false
  api.calls = []
  api.resume = { resumed: 1, results: [] }
  api.view = view([])
  api.status = null
})

describe('Recovery page', () => {
  it('names the memory kills Status reports, so the two pages agree', async () => {
    api.status = {
      rows: [
        {
          id: 'host/check-memory',
          shown: 'warn',
          meaning:
            '6 memory kills in the last 24 hours: Session fa41c0c8: jobs killed.',
        },
      ],
    }
    show()
    expect(
      await screen.findByText(/Status reports lost work this page can’t list/),
    ).toHaveTextContent('Session “Aico”: jobs killed.')
    expect(screen.getByRole('link', { name: 'Open Status' })).toHaveAttribute(
      'href',
      '/status',
    )
  })

  it('says nothing needs recovering, with no Resume button beside it', async () => {
    show()
    expect(
      await screen.findByText('No stopped sessions to bring back.'),
    ).toBeTruthy()
    expect(screen.getByText(/Last checked/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Resume/ })).toBeNull()
    expect(screen.queryByText('Nothing has stopped.')).toBeNull()
  })

  it('says it is checking, and never shows a failed check as nothing stopped', async () => {
    api.fail = true
    show()
    expect(screen.getByText('Checking for stopped sessions…')).toBeTruthy()
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.queryByText('No stopped sessions to bring back.')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Resume/ })).toBeNull()
  })

  it('leads with the restart and what came back, with a row for each session', async () => {
    api.view = view(
      [
        item({
          id: 'aaaaaaaa',
          name: 'Restore drill',
          cause: 'restart',
          what: 'Stopped when the workstation restarted',
          outcome: 'gave_up',
          resumable: false,
          note: 'No live agent appeared.',
        }),
        item({
          id: 'bbbbbbbb',
          name: 'Security hunt',
          cause: 'restart',
          what: 'Stopped when the workstation restarted',
          outcome: 'resumed',
          resumable: false,
          canOpen: true,
          note: 'Resumed where it left off.',
          attemptsLeft: null,
        }),
        item({
          id: 'cccccccc',
          name: 'Third',
          cause: 'restart',
          what: 'Stopped when the workstation restarted',
          outcome: 'resumed',
          resumable: false,
          note: 'Resumed where it left off.',
          attemptsLeft: null,
        }),
      ],
      { restartAt: Date.now() - 7_200_000 },
    )
    show()
    expect(
      await screen.findByText(
        /3 sessions stopped when the workstation restarted at .*; 2 came back, 1 didn’t come back\./,
      ),
    ).toBeTruthy()
    const rows = within(
      screen.getByRole('list', { name: 'Stopped sessions' }),
    ).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('Gave up')).toBeTruthy()
    // Open only where the session is alive again; a session that came back starts closed.
    fireEvent.click(within(rows[1]).getByRole('button'))
    fireEvent.click(within(rows[2]).getByRole('button'))
    expect(
      within(rows[1])
        .getByRole('link', { name: 'Open Security hunt' })
        .getAttribute('href'),
    ).toBe('/?session=bbbbbbbb')
    expect(within(rows[2]).queryByRole('link')).toBeNull()
    expect(
      screen.getByText('Nothing here can be resumed from Aico.'),
    ).toBeTruthy()
  })

  it('resumes what is waiting with one button and reports each refusal', async () => {
    api.view = view([
      item({ id: 'aaaaaaaa', name: 'First' }),
      item({ id: 'bbbbbbbb', name: 'Second' }),
    ])
    api.resume = {
      resumed: 1,
      results: [
        { id: 'aaaaaaaa', name: 'First', ok: true, reason: null },
        {
          id: 'bbbbbbbb',
          name: 'Second',
          ok: false,
          reason: 'There isn’t room to start it now.',
        },
      ],
    }
    show()
    const button = await screen.findByRole('button', {
      name: 'Resume 2 sessions',
    })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        url: '/api/recovery/resume',
        method: 'POST',
      }),
    )
    expect(
      await screen.findByText(
        /Resuming 1 session\. Couldn’t resume 1\. Second: There isn’t room to start it now\./,
      ),
    ).toBeTruthy()
  })

  it('says a waiting session comes back by itself, and how many tries are left', async () => {
    api.view = view([
      item({
        outcome: 'waiting',
        resumable: false,
        attemptsLeft: 1,
        note: 'Waiting to resume by itself.',
      }),
    ])
    show()
    expect(
      await screen.findByText('1 automatic try left in 6 hours.'),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /1 session stopped on its own; 1 is coming back by itself\./,
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Nothing to resume: the waiting ones come back by themselves.',
      ),
    ).toBeTruthy()
  })

  it('says when part of the answer could not be read', async () => {
    api.view = view([], {
      partial:
        'The list of sessions restored after a restart could not be read.',
    })
    show()
    expect(
      await screen.findByText(
        /could not be read\. Sessions stopped by a restart may be missing here\./,
      ),
    ).toBeTruthy()
  })
})
