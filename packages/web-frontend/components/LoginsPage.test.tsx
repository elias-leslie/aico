import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LoginsPage } from './LoginsPage'

const machines = vi.hoisted(() => ({
  list: [] as { name: string; state: string }[],
}))
vi.mock('@/lib/hooks/use-hosts', () => ({
  useHosts: () => ({
    hosts: machines.list,
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

const focus = {
  ...entry,
  name: 'focus-pcsb',
  machines: ['aico', 'neri'],
  roles: ['review', 'implementation'],
}
const canvas = {
  ...entry,
  name: 'canvas-pcsb',
  machines: ['aico'],
  roles: ['*'],
  deniedRoles: ['review'],
}
const accessApi = () =>
  vi.fn(async (path: string, options?: { method?: string; body?: string }) =>
    Response.json(
      path.endsWith('/roles')
        ? { roles: ['coordinator', 'review', 'implementation'] }
        : options?.method
          ? {}
          : path.endsWith('/sessions')
            ? { sessions: [] }
            : path.endsWith('/audit')
              ? { events: [] }
              : {
                  entries: [focus, canvas],
                  machine: 'aico',
                  assignments: {},
                  revealSeconds: 30,
                },
    ),
  )
const openAccess = async (name: string) => {
  await screen.findByText(name)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
  fireEvent.click(screen.getByRole('button', { name: 'Access' }))
}
it('copies another login access with one choice and saves only the difference', async () => {
  machines.list = [
    { name: 'aico', state: 'connected' },
    { name: 'neri', state: 'connected' },
  ]
  const fetcher = accessApi()
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await openAccess('canvas-pcsb')
  expect(screen.getByLabelText('aico')).toBeChecked()
  expect(screen.getByLabelText('neri')).not.toBeChecked()
  expect(screen.getByLabelText('All roles')).toBeChecked()
  expect(screen.getByLabelText('review')).not.toBeChecked()
  expect(screen.getByLabelText('coordinator')).toBeChecked()
  expect(screen.getByRole('button', { name: 'Save access' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Same access as'), {
    target: { value: 'focus-pcsb' },
  })
  expect(screen.getByLabelText('neri')).toBeChecked()
  expect(screen.getByLabelText('All roles')).not.toBeChecked()
  expect(screen.getByLabelText('review')).toBeChecked()
  expect(screen.getByLabelText('coordinator')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Save access' }))
  await screen.findByText('Access saved.')
  const sent = fetcher.mock.calls
    .filter(([, o]) => o?.method === 'POST')
    .map(([path, o]) => [path, JSON.parse(String(o?.body))])
  expect(sent).toEqual([
    [
      '/api/logins/canvas-pcsb/grants',
      { type: 'machine', value: 'neri', granted: true },
    ],
    [
      '/api/logins/canvas-pcsb/grants',
      { type: 'role', value: '*', granted: false },
    ],
    [
      '/api/logins/canvas-pcsb/grants',
      { type: 'role', value: 'review', granted: true },
    ],
    [
      '/api/logins/canvas-pcsb/grants',
      { type: 'role', value: 'implementation', granted: true },
    ],
  ])
})
it('names each grant that failed and keeps going', async () => {
  machines.list = [
    { name: 'aico', state: 'connected' },
    { name: 'neri', state: 'connected' },
  ]
  const fetcher = accessApi()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: { method?: string; body?: string }) =>
      options?.method && JSON.parse(String(options.body)).value === 'neri'
        ? Response.json({ detail: 'Invalid grant' }, { status: 400 })
        : fetcher(path, options),
    ),
  )
  render(<LoginsPage />)
  await openAccess('canvas-pcsb')
  fireEvent.click(screen.getByLabelText('neri'))
  fireEvent.click(screen.getByLabelText('coordinator'))
  fireEvent.click(screen.getByRole('button', { name: 'Save access' }))
  expect(
    await screen.findByText('Could not allow neri (machine): Invalid grant'),
  ).toBeInTheDocument()
  expect(screen.getByText('Access partly saved.')).toBeInTheDocument()
  expect(
    fetcher.mock.calls.some(([, o]) => o?.body?.includes('coordinator')),
  ).toBe(true)
})
it('sets access in the Add login form and saves it with the login', async () => {
  machines.list = [{ name: 'aico', state: 'connected' }]
  const fetcher = vi.fn(
    async (path: string, options?: { method?: string; body?: string }) =>
      path === '/api/logins' && options?.method
        ? Response.json({
            entry: { ...entry, name: 'site', machines: ['aico'], roles: ['*'] },
          })
        : accessApi()(path, options),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await screen.findByText('focus-pcsb')
  fireEvent.click(screen.getByRole('button', { name: 'Add login' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'site' } })
  fireEvent.change(screen.getByLabelText('Value (hidden)'), {
    target: { value: 'fixture-only' },
  })
  expect(screen.getByLabelText('aico')).toBeChecked()
  expect(screen.getByLabelText('All roles')).toBeChecked()
  fireEvent.click(screen.getByLabelText('implementation'))
  fireEvent.click(screen.getByRole('button', { name: 'Save login' }))
  await screen.findByText('Saved, 12 characters')
  const grants = fetcher.mock.calls.filter(([p]) => p.endsWith('/grants'))
  expect(grants.map(([p, o]) => [p, JSON.parse(String(o?.body))])).toEqual([
    [
      '/api/logins/site/grants',
      { type: 'role', value: 'implementation', granted: false },
    ],
  ])
})
