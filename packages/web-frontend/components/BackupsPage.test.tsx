// Backups: the summary leads, sources group their copies, archived ones fold
// away, and a failed load says so.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackupEntry } from '@/lib/backups'
import { markFailed, resetServerReachForTest } from '@/lib/frame/server-reach'
import { BackupsPage } from './BackupsPage'

const copy = (over: Partial<BackupEntry>): BackupEntry => ({
  id: `${over.target ?? 'native'}/${over.source ?? 'home'}`,
  source: 'home',
  name: 'Home',
  target: 'native',
  dataAt: '2026-11-06T20:30:00.000Z',
  nextRun: '2026-11-07T00:30:00.000Z',
  state: 'ok',
  meaning: 'Restorable data is 41 min old.',
  snapshot: null,
  path: null,
  machine: 'workstation',
  ...over,
})

function answer(entries: BackupEntry[] | 'down') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      entries === 'down'
        ? Response.json({ detail: 'Backups could not start.' }, { status: 503 })
        : Response.json({ machine: 'workstation', entries, runs: {} }),
    ),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('BackupsPage', () => {
  it('opens with the summary, one block per source and the archived ones folded', async () => {
    answer([
      copy({}),
      copy({ target: 'drive' }),
      copy({
        source: 'old',
        name: 'Old tool',
        state: 'off',
        dataAt: null,
        gone: true,
      }),
      copy({
        source: 'old',
        name: 'Old tool',
        target: 'drive',
        state: 'off',
        dataAt: null,
        gone: true,
      }),
      copy({
        source: 'jobs',
        name: 'Jobs database',
        target: 'external',
        state: 'off',
        meaning: 'Machine is off; its last good backup date is shown.',
      }),
    ])
    render(<BackupsPage />)
    expect(await screen.findByTestId('backups-summary')).toHaveTextContent(
      'All 1 source current (2 copies), 1 on a machine that is off, 1 archived.',
    )
    // Sources are counted once, whatever number of places hold a copy: the summary and the
    // folded list agree.
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3)
    expect(screen.getByText(/^On a machine that is off \(1\)/)).toBeVisible()
    const archived = screen
      .getByText(/^Archived \(1\)/)
      .closest('details') as HTMLDetailsElement
    expect(archived.open).toBe(false)
    expect(screen.getAllByText('T7')).toHaveLength(2)
    expect(screen.getAllByText('Drive')).toHaveLength(2)
  })

  it('draws the oldest copy at each destination against its limit', async () => {
    const hoursAgo = (h: number) =>
      new Date(Date.now() - h * 3_600_000).toISOString()
    answer([
      copy({ dataAt: hoursAgo(2), limitHours: 6 }),
      copy({ target: 'drive', dataAt: hoursAgo(30), limitHours: 26 }),
    ])
    render(<BackupsPage />)
    await screen.findByTestId('backups-summary')
    expect(
      screen.getByRole('img', { name: 'T7: 2 h old, late after 6 h' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Drive: 30 h old, late after 26 h' }),
    ).toBeInTheDocument()
  })

  it('shows a failed copy first with its reason', async () => {
    answer([
      copy({ source: 'a', name: 'Alpha' }),
      copy({
        source: 'z',
        name: 'Zulu',
        state: 'failed',
        meaning: 'Drive refused the upload.',
      }),
    ])
    render(<BackupsPage />)
    await screen.findByTestId('backups-summary')
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(names).toEqual(['Zulu', 'Alpha'])
    expect(screen.getByText('Drive refused the upload.')).toBeInTheDocument()
    expect(screen.getByTestId('backups-summary')).toHaveTextContent(
      '1 failed, 1 source current (1 copy).',
    )
  })

  it('filters by name and says when nothing matches', async () => {
    answer([copy({})])
    render(<BackupsPage />)
    await screen.findByTestId('backups-summary')
    fireEvent.change(screen.getByLabelText('Find a backup'), {
      target: { value: 'zzz' },
    })
    expect(
      screen.getByText('No backups match your search.'),
    ).toBeInTheDocument()
  })

  it('says it cannot read backups instead of showing an empty list', async () => {
    answer('down')
    render(<BackupsPage />)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        "Can't read backups. Backups could not start.",
      ),
    )
    expect(screen.queryByTestId('backups-summary')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  it('leaves Retry to the top bar while the whole server is down', async () => {
    answer('down')
    markFailed()
    try {
      render(<BackupsPage />)
      await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    } finally {
      resetServerReachForTest()
    }
  })
})
