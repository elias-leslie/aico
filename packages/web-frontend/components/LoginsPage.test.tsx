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
  fireEvent.click(screen.getByRole('button', { name: /scratch/ }))
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
it.each(['add', 'replace'])(
  'clears the %s form after a saved value even when a machine is offline',
  async (mode) => {
    const warning =
      'Saved here. An offline machine will sync when it reconnects.'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, options?: RequestInit) =>
        Response.json(
          options?.method === 'POST'
            ? { warning }
            : _path.endsWith('/sessions')
              ? { sessions: [] }
              : { entries: [entry], assignments: {}, revealSeconds: 30 },
        ),
      ),
    )
    render(<LoginsPage />)
    await screen.findByText('scratch')
    if (mode === 'replace')
      fireEvent.click(screen.getByRole('button', { name: /scratch/ }))
    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'add' ? 'Add login' : 'Replace',
      }),
    )
    if (mode === 'add')
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'new-scratch' },
      })
    fireEvent.change(
      screen.getByLabelText(
        mode === 'add' ? 'Value (hidden)' : 'New value (hidden)',
      ),
      { target: { value: 'fixture-only' } },
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'add' ? 'Save login' : 'Replace login',
      }),
    )
    await screen.findByText(new RegExp(`Saved, 12 characters.*${warning}`))
    expect(
      screen.queryByLabelText(
        mode === 'add' ? 'Value (hidden)' : 'New value (hidden)',
      ),
    ).toBeNull()
  },
)
it('says when a login was last used once, on the row, not again in its detail', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(
        path.endsWith('/sessions')
          ? { sessions: [] }
          : path.endsWith('/audit')
            ? { events: [] }
            : {
                entries: [{ ...entry, lastUsed: '2026-11-05T11:15:00Z' }],
                assignments: {},
                revealSeconds: 30,
              },
      ),
    ),
  )
  render(<LoginsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /scratch/ }))
  expect(screen.getAllByText(/Last used:/)).toHaveLength(1)
  expect(screen.getByText('Scratch entry')).toBeInTheDocument()
})
it('keeps every action a button with a border, not bare text', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(
        path.endsWith('/sessions')
          ? { sessions: [] }
          : path.endsWith('/audit')
            ? { events: [] }
            : { entries: [entry], assignments: {}, revealSeconds: 30 },
      ),
    ),
  )
  const { container } = render(<LoginsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /scratch/ }))
  expect(container.querySelector('.lantern-btn.ghost')).toBeNull()
  expect(screen.getByRole('button', { name: 'Refresh' })).toHaveClass(
    'lantern-btn',
  )
  expect(screen.getByRole('button', { name: 'Copy' })).toHaveClass(
    'lantern-btn',
  )
})
const lists = (entries: unknown[]) =>
  vi.fn(async (path: string, options?: RequestInit) =>
    Response.json(
      options?.method
        ? {}
        : path.endsWith('/sessions')
          ? { sessions: [] }
          : path.endsWith('/audit')
            ? { events: [] }
            : { entries, assignments: {}, revealSeconds: 30 },
    ),
  )
it('shows masked dots and a count as a value is pasted, then Saved, N characters', async () => {
  const fetcher = lists([entry])
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await screen.findByText('scratch')
  fireEvent.click(screen.getByRole('button', { name: 'Add login' }))
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'site' },
  })
  fireEvent.change(screen.getByLabelText('Value (hidden)'), {
    target: { value: 'fixture-only' },
  })
  expect(screen.getByText(/12 characters/)).toBeInTheDocument()
  expect(screen.getByText('••••••••••••')).toBeInTheDocument()
  expect(screen.queryByText('fixture-only')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save login' }))
  expect(await screen.findByText('Saved, 12 characters')).toBeInTheDocument()
  const post = fetcher.mock.calls.find(([, o]) => o?.method === 'POST')
  expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ name: 'site' })
})
it('adds an account login with a username and login page, and lists it under Account logins', async () => {
  const account = {
    ...entry,
    name: '_lab_focus-pcsb--default',
    kind: 'lab login',
    notes: '',
    lab: {
      target: 'focus-pcsb',
      actor: 'default',
      kind: 'account',
      fields: ['username', 'password', 'login_url'],
      expires_at: null,
      username: 'me@example.test',
      login_url: 'https://focus.example.test/login',
    },
  }
  const fetcher = lists([account])
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await screen.findByRole('list', { name: 'Account logins' })
  fireEvent.click(screen.getByRole('button', { name: /focus-pcsb/ }))
  expect(screen.getByText('Username: me@example.test')).toBeInTheDocument()
  expect(
    screen.getByText('Login page: https://focus.example.test/login'),
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Add login' }))
  fireEvent.change(screen.getByLabelText('Kind'), {
    target: { value: 'account login' },
  })
  fireEvent.change(screen.getByLabelText('Site name'), {
    target: { value: 'school' },
  })
  fireEvent.change(screen.getByLabelText('Username or email'), {
    target: { value: 'me@example.test' },
  })
  fireEvent.change(screen.getByLabelText('Login page'), {
    target: { value: 'https://school.example.test/' },
  })
  fireEvent.change(screen.getByLabelText('Password (hidden)'), {
    target: { value: 'fixture-only' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save login' }))
  expect(await screen.findByText('Saved, 12 characters')).toBeInTheDocument()
  const post = fetcher.mock.calls.find(([, o]) => o?.method === 'POST')
  expect(post?.[0]).toBe('/api/logins/lab')
  expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
    target: 'school',
    kind: 'account',
    values: {
      username: 'me@example.test',
      password: 'fixture-only',
      login_url: 'https://school.example.test/',
    },
  })
})
