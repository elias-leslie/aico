// Backups: the summary leads, sources group their copies, archived ones fold
// away, and a failed load says so.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackupEntry } from '@/lib/backups'
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
      copy({ source: 'old', name: 'Old tool', state: 'off', dataAt: null }),
    ])
    render(<BackupsPage />)
    expect(await screen.findByTestId('backups-summary')).toHaveTextContent(
      'All 2 current, 1 archived.',
    )
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2)
    const archived = screen
      .getByText(/^Archived \(1\)/)
      .closest('details') as HTMLDetailsElement
    expect(archived.open).toBe(false)
    expect(screen.getAllByText('T7')).toHaveLength(2)
    expect(screen.getByText('Drive')).toBeInTheDocument()
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
      '1 failed, 1 current.',
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
  })
})
