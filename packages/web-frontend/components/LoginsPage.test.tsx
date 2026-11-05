import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LoginsPage } from './LoginsPage'

vi.mock('@/lib/hooks/use-hosts', () => ({
  useHosts: () => ({
    hosts: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))
vi.mock('./HostsSheet', () => ({ HostSignIn: () => null }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const entry = {
  name: 'scratch',
  kind: 'password',
  notes: 'Scratch entry',
  state: 'Unused',
  machines: ['local'],
  roles: ['*'],
  created: '2026-11-04T12:00:00Z',
  rotated: null,
  lastUsed: null,
}
it('reveals only after a recorded API request and hides again after thirty seconds', async () => {
  const fetcher = vi.fn(async (path: string) =>
    Response.json(
      path.endsWith('/reveal')
        ? { value: 'fixture-private-value' }
        : path.endsWith('/sessions')
          ? { sessions: [] }
          : path.endsWith('/audit')
            ? { events: [] }
            : { entries: [entry], assignments: {}, revealSeconds: 30 },
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  expect(await screen.findByText('scratch')).toBeInTheDocument()
  expect(screen.queryByText('fixture-private-value')).toBeNull()
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
  })
  expect(screen.getByText('fixture-private-value')).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledWith(
    '/api/logins/scratch/reveal',
    expect.objectContaining({ method: 'POST' }),
  )
  await act(async () => {
    vi.advanceTimersByTime(30000)
  })
  expect(screen.queryByText('fixture-private-value')).toBeNull()
  expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument()
})
it('shows a failed list separately from an empty store', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ detail: 'Logins could not load.' }, { status: 503 }),
    ),
  )
  render(<LoginsPage />)
  expect(await screen.findByText('Logins could not load.')).toBeInTheDocument()
  expect(
    screen.queryByText('No logins saved yet. Add one to get started.'),
  ).toBeNull()
})
