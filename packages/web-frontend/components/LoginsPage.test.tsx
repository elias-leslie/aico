import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    const warning = "agent-work is offline and gets this change when it's back"
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
    // The notice goes with the next thing the owner does.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.queryByText(new RegExp(warning))).toBeNull()
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
  expect(screen.getByLabelText('Standby')).toBeChecked()
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
  expect(screen.getByLabelText('Standby')).toBeChecked()
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
const labEntry = (target: string, roles: string[]) => ({
  ...entry,
  name: `_lab_${target}--default`,
  kind: 'lab login',
  machines: ['aico'],
  roles,
  lab: {
    target,
    actor: 'default',
    kind: 'account',
    fields: ['username', 'password', 'login_url'],
    expires_at: null,
  },
})
it('copies a lab login named roles and session assignments, and saves both', async () => {
  machines.list = [{ name: 'aico', state: 'connected' }]
  const fetcher = vi.fn(
    async (path: string, options?: { method?: string; body?: string }) =>
      Response.json(
        path.endsWith('/roles')
          ? { roles: ['coordinator', 'review'] }
          : options?.method
            ? {}
            : path.endsWith('/sessions')
              ? { sessions: [{ id: 's1', label: 'School session' }] }
              : path.endsWith('/audit')
                ? { events: [] }
                : {
                    entries: [
                      labEntry('focus-pcsb', ['*', 'school-check']),
                      labEntry('canvas-pcsb', ['*']),
                    ],
                    machine: 'aico',
                    assignments: { s1: ['focus-pcsb'] },
                    revealSeconds: 30,
                  },
      ),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await screen.findAllByText('canvas-pcsb')
  fireEvent.click(screen.getByRole('button', { name: /canvas-pcsb/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Access' }))
  expect(screen.getByLabelText('School session')).not.toBeChecked()
  fireEvent.change(screen.getByLabelText('Same access as'), {
    target: { value: '_lab_focus-pcsb--default' },
  })
  expect(screen.getByLabelText('All roles')).toBeChecked()
  expect(screen.getByLabelText('school-check')).toBeChecked()
  expect(screen.getByRole('img', { name: 'Named' })).toBeInTheDocument()
  expect(screen.getByLabelText('School session')).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Save access' }))
  await screen.findByText('Access saved.')
  const sent = fetcher.mock.calls
    .filter(([, o]) => o?.method === 'POST')
    .map(([path, o]) => [path, JSON.parse(String(o?.body))])
  expect(sent).toEqual([
    [
      '/api/logins/_lab_canvas-pcsb--default/grants',
      { type: 'role', value: 'school-check', granted: true },
    ],
    [
      '/api/logins/assign',
      { session: 's1', targets: ['focus-pcsb', 'canvas-pcsb'] },
    ],
  ])
})

const school = {
  ...entry,
  name: '_lab_school--default',
  kind: 'lab login',
  notes: '',
  machines: ['aico'],
  roles: ['*'],
  lab: {
    target: 'school',
    actor: 'default',
    kind: 'account',
    fields: ['username', 'password', 'login_url'],
    expires_at: null,
    username: 'me@example.test',
    login_url: 'https://school.example.test/',
  },
}
const schoolApi = (
  answers: Record<string, unknown> = {},
  events: unknown[] = [],
) =>
  vi.fn(async (path: string, options?: { method?: string; body?: string }) =>
    Response.json(
      path in answers
        ? answers[path]
        : path.endsWith('/roles')
          ? { roles: ['review'] }
          : options?.method
            ? { entry: school }
            : path.endsWith('/sessions')
              ? { sessions: [{ id: 'a1b2c3d4', label: 'Dadbot' }] }
              : path.endsWith('/audit')
                ? { events }
                : {
                    entries: [school],
                    machine: 'aico',
                    assignments: {},
                    revealSeconds: 30,
                  },
    ),
  )
const openSchool = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /school/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Access' }))
}
it('lists roles and sessions together under Used by, with All roles for an account login', async () => {
  vi.stubGlobal(
    'fetch',
    schoolApi({}, [
      {
        at: '2026-11-07T11:00:00Z',
        action: 'rotate',
        name: '_lab_school--default',
        actor: 'a1b2c3d4',
      },
      {
        at: '2026-11-07T12:00:00Z',
        action: 'allow',
        name: '_lab_school--default',
        actor: 'a1b2c3d4',
        detail: 'session a1b2c3d4',
      },
    ]),
  )
  render(<LoginsPage />)
  await openSchool()
  const usedBy = screen.getByRole('group', { name: 'Used by' })
  expect(usedBy).toHaveTextContent('All roles')
  expect(usedBy).toHaveTextContent('review')
  expect(usedBy).toHaveTextContent('Dadbot')
  expect(screen.queryByRole('group', { name: 'Sessions' })).toBeNull()
  // Who changed what, on the login itself.
  // The session is named once the session list has loaded.
  await waitFor(() =>
    expect(
      screen.getByRole('list', { name: "This login's activity" }),
    ).toHaveTextContent('allow · Dadbot · session a1b2c3d4'),
  )
  expect(
    screen.getByRole('list', { name: "This login's activity" }),
  ).toHaveTextContent('replaced · Dadbot')
})
it('recent activity names a login as its row does, and an account beside its site', async () => {
  vi.stubGlobal(
    'fetch',
    schoolApi({}, [
      {
        at: '2026-11-07T11:00:00Z',
        action: 'set',
        name: '_lab_school--default',
        actor: 'owner',
      },
      {
        at: '2026-11-07T12:00:00Z',
        action: 'rotate',
        name: '_lab_school--dadbot',
        actor: 'owner',
      },
    ]),
  )
  render(<LoginsPage />)
  fireEvent.click(
    await screen.findByRole('button', { name: /Recent activity/ }),
  )
  await screen.findByText(/added · school · owner/)
  expect(screen.getByText(/replaced · school · dadbot · owner/)).toBeTruthy()
})
it('a lab login that is not an account shows no All roles and ticks only named roles', async () => {
  const lab = {
    ...school,
    roles: ['*', 'review'],
    lab: { ...school.lab, kind: 'synthetic' },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(
        path.endsWith('/roles')
          ? { roles: ['review', 'implementation'] }
          : path.endsWith('/sessions')
            ? { sessions: [] }
            : path.endsWith('/audit')
              ? { events: [] }
              : {
                  entries: [lab],
                  machine: 'aico',
                  assignments: {},
                  revealSeconds: 30,
                },
      ),
    ),
  )
  render(<LoginsPage />)
  await openSchool()
  const usedBy = screen.getByRole('group', { name: 'Used by' })
  expect(usedBy).not.toHaveTextContent('All roles')
  expect(screen.getByRole('checkbox', { name: 'review' })).toBeChecked()
  expect(
    screen.getByRole('checkbox', { name: 'implementation' }),
  ).not.toBeChecked()
})
it('edits notes and the login page, then offers the page that has a password field', async () => {
  const fetcher = schoolApi({
    '/api/logins/_lab_school--default/edit': {
      entry: school,
      probe: {
        password: false,
        suggestion: 'https://school.example.test/login/canvas',
        warning: 'No password field at https://school.example.test/.',
      },
    },
  })
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await screen.findByRole('button', { name: /school/ })
  fireEvent.click(screen.getByRole('button', { name: /school/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByLabelText('Notes'), {
    target: { value: 'School check' },
  })
  fireEvent.change(screen.getByLabelText('Login page'), {
    target: { value: 'https://school.example.test/home' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const notice = await screen.findByText(
    'No password field at https://school.example.test/.',
  )
  // Shown in the edited login's own row, next to its Edit button, not at the top of a long page.
  expect(
    notice.compareDocumentPosition(
      screen.getByRole('button', { name: 'Edit' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(
    notice.compareDocumentPosition(
      screen.getByRole('button', { name: /school/ }),
    ) & Node.DOCUMENT_POSITION_PRECEDING,
  ).toBeTruthy()
  const edit = fetcher.mock.calls.find(([p]) => p.endsWith('/edit'))
  expect(JSON.parse(String(edit?.[1]?.body))).toEqual({
    notes: 'School check',
    login_url: 'https://school.example.test/home',
  })
  fireEvent.click(screen.getByRole('button', { name: 'Use this page' }))
  expect(await screen.findByText('Login page saved.')).toBeInTheDocument()
  expect(
    fetcher.mock.calls.some(
      ([p, o]) =>
        p.endsWith('/edit') &&
        JSON.parse(String(o?.body)).login_url ===
          'https://school.example.test/login/canvas',
    ),
  ).toBe(true)
})
it('replaces an account login with a username and password, not a JSON bundle', async () => {
  const fetcher = schoolApi()
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await screen.findByRole('button', { name: /school/ })
  fireEvent.click(screen.getByRole('button', { name: /school/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
  expect(screen.getByLabelText('Username or email')).toHaveValue(
    'me@example.test',
  )
  fireEvent.change(screen.getByLabelText('Password (hidden)'), {
    target: { value: 'fixture-only' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Replace login' }))
  expect(await screen.findByText(/Saved, 12 characters/)).toBeInTheDocument()
  const patch = fetcher.mock.calls.find(([, o]) => o?.method === 'PATCH')
  expect(patch?.[0]).toBe('/api/logins/lab/school/default')
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
    set: { username: 'me@example.test', password: 'fixture-only' },
  })
})
it('removes a lab login by the site name its row shows, not its stored name', async () => {
  const fetcher = schoolApi({
    '/api/logins/_lab_school--default/remove': { removed: true },
  })
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  await screen.findByRole('button', { name: /school/ })
  fireEvent.click(screen.getByRole('button', { name: /school/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  const confirm = screen.getByLabelText(
    `Type ${school.lab.target} to remove it`,
  )
  fireEvent.change(confirm, { target: { value: 'not it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove login' }))
  expect(
    await screen.findByText(`Type ${school.lab.target} exactly to remove it.`),
  ).toBeInTheDocument()
  expect(fetcher.mock.calls.some(([p]) => p.endsWith('/remove'))).toBe(false)
  fireEvent.change(confirm, { target: { value: school.lab.target } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove login' }))
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([p]) => p.endsWith('/remove'))).toBe(true),
  )
  const remove = fetcher.mock.calls.find(([p]) => p.endsWith('/remove'))
  expect(JSON.parse(String(remove?.[1]?.body))).toEqual({
    confirm: '_lab_school--default',
  })
})
