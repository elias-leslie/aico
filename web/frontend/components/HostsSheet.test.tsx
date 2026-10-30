import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSignInWatch, watchSignIn } from '@/lib/hooks/use-host-admin'
import { HostsSheet } from './HostsSheet'

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => true }))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({
    enabledTools: [
      { slug: 'claude-code', name: 'Claude Code' },
      { slug: 'codex', name: 'Codex' },
    ],
  }),
}))

type Json = Record<string, unknown>
const state = vi.hoisted(() => ({
  hosts: [] as Json[],
  logins: {} as Record<string, { status: number; body: Json }>,
  posts: [] as Array<{ url: string; body: Json }>,
  answers: [] as Array<{ status: number; body: Json }>,
}))

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const reply = (status: number, body: Json) =>
        new Response(JSON.stringify(body), { status })
      if (init?.method === 'POST') {
        state.posts.push({ url, body: JSON.parse(String(init.body)) })
        const next = state.answers.shift() ?? { status: 200, body: {} }
        return reply(next.status, next.body)
      }
      if (url === '/api/hosts') return reply(200, { items: state.hosts })
      const match = url.match(/^\/api\/hosts\/([^/]+)\/logins$/)
      if (match) {
        const answer = state.logins[match[1]]
        return reply(answer.status, answer.body)
      }
      if (url.startsWith('/api/sessions') || url.startsWith('/api/panes'))
        return reply(200, { items: [], total: 0 })
      return reply(404, { detail: 'not found' })
    }),
  )
}

const host = (over: Json = {}): Json => ({
  name: 'agent-work',
  state: 'connected',
  since: 1,
  sessions: 0,
  error: null,
  wake: null,
  ...over,
})

const loginsFor = (over: Json = {}): { status: number; body: Json } => ({
  status: 200,
  body: {
    host: 'agent-work',
    agent_hub: 'reachable',
    checkedAt: 1,
    tools: [
      {
        tool: 'claude-code',
        state: 'signed_in',
        source: 'agent-hub',
        credentials: [],
      },
      {
        tool: 'codex',
        state: 'needs_sign_in',
        source: 'host:/home/agent/.codex/auth.json',
        credentials: [],
      },
    ],
    actions: {
      'claude-code': { signIn: true, signOut: 'revoke' },
      codex: { signIn: true, signOut: 'command' },
    },
    ...over,
  },
})

function renderSheet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <HostsSheet open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return { client, onOpenChange }
}

describe('HostsSheet', () => {
  beforeEach(() => {
    state.hosts = []
    state.logins = {}
    state.posts = []
    state.answers = []
    push.mockReset()
    stubFetch()
  })

  it('says it is loading, then that no other hosts exist', async () => {
    renderSheet()
    expect(screen.getByText('Loading hosts…')).toBeInTheDocument()
    expect(await screen.findByText(/No other hosts/)).toBeInTheDocument()
  })

  it('says when the hosts could not be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 502 })),
    )
    renderSheet()
    expect(await screen.findByText(/Couldn’t load hosts/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument()
  })

  it('leads an offline host with its state and offers Power on, not a sign-in check', async () => {
    state.hosts = [host({ state: 'offline', error: 'ssh: no route' })]
    renderSheet()
    expect(await screen.findByTestId('host-status')).toHaveTextContent(
      'Offline',
    )
    expect(screen.getByText('ssh: no route')).toBeInTheDocument()
    expect(
      screen.getByText('Sign-in can be checked once agent-work is connected.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Checking sign-in…')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Power on' }))
    await waitFor(() =>
      expect(state.posts).toEqual([
        { url: '/api/hosts/agent-work/power', body: { action: 'on' } },
      ]),
    )
  })

  it('says a powered-off host is off without the link error', async () => {
    state.hosts = [
      host({
        state: 'powered_off',
        error:
          'connect ECONNREFUSED /run/user/1000/tether/default/control.sock',
      }),
    ]
    renderSheet()
    expect(await screen.findByTestId('host-status')).toHaveTextContent(
      'Powered off',
    )
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Power on' })).toBeInTheDocument()
  })

  it('shows the start step while starting, with no Power on', async () => {
    state.hosts = [
      host({
        state: 'connecting',
        wake: { state: 'starting', step: 'checking_services' },
      }),
    ]
    renderSheet()
    expect(await screen.findByTestId('host-status')).toHaveTextContent(
      'Starting… checking services',
    )
    expect(screen.queryByRole('button', { name: 'Power on' })).toBeNull()
  })

  it('says why a start failed and offers Power on again', async () => {
    state.hosts = [
      host({
        state: 'powered_off',
        wake: { state: 'failed', error: 'no answer from the switch' },
      }),
    ]
    renderSheet()
    expect(await screen.findByTestId('host-status')).toHaveTextContent(
      'Didn’t start: no answer from the switch',
    )
    expect(screen.getByRole('button', { name: 'Power on' })).toBeInTheDocument()
  })

  it('asks before trusting a machine that changed', async () => {
    state.hosts = [host({ state: 'identity_changed' })]
    renderSheet()
    expect(await screen.findByTestId('host-status')).toHaveTextContent(
      'Not the same machine as before',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Trust' }))
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent(
      'Trust the machine now answering as agent-work?',
    )
    expect(state.posts).toEqual([])
    fireEvent.click(within(dialog).getByTestId('confirm-dialog-confirm'))
    await waitFor(() =>
      expect(state.posts).toEqual([
        { url: '/api/hosts/agent-work/trust', body: {} },
      ]),
    )
  })

  it('shows each tool with its state and source, never Unknown as signed out', async () => {
    state.hosts = [host({ sessions: 2 })]
    state.logins['agent-work'] = loginsFor({
      agent_hub: 'timed out',
      tools: [
        {
          tool: 'claude-code',
          state: 'unknown',
          source: 'agent-hub',
          credentials: [],
        },
        {
          tool: 'codex',
          state: 'expired',
          source: 'host:/home/agent/.codex/auth.json',
          credentials: [
            {
              name: 'auth',
              rotates: true,
              state: 'expired',
              source: 'host:/home/agent/.codex/auth.json',
              detail: 'token expired',
            },
          ],
        },
        {
          tool: 'st',
          state: 'needs_sign_in',
          source: 'agent-hub',
          credentials: [],
        },
      ],
      actions: {},
    })
    renderSheet()
    expect(await screen.findByTestId('host-status')).toHaveTextContent(
      'Connected · 2 sessions',
    )
    expect(await screen.findByTestId('agent-hub-away')).toHaveTextContent(
      'Agent Hub can’t be reached from agent-work',
    )
    expect(screen.getByTestId('login-claude-code')).toHaveTextContent(
      'Unknown · Agent Hub can’t be reached',
    )
    expect(screen.getByTestId('login-claude-code')).not.toHaveTextContent(
      'Needs sign-in',
    )
    const codex = screen.getByTestId('login-codex')
    expect(codex).toHaveTextContent('Expired · This host')
    // The file the login lives in is never shown, only where: This host.
    expect(codex).not.toHaveTextContent('/home/agent/.codex/auth.json')
    expect(codex).toHaveTextContent('token expired')
    expect(screen.getByTestId('login-st')).toHaveTextContent(
      'Needs sign-in · Agent Hub',
    )
  })

  it('offers Sign in only where it is needed; the rest and the paths sit in Details', async () => {
    state.hosts = [host()]
    state.logins['agent-work'] = loginsFor({
      tools: [
        {
          tool: 'codex',
          state: 'signed_in',
          source: 'host:/home/agent/.codex/auth.json',
          credentials: [
            {
              name: 'login',
              rotates: true,
              state: 'signed_in',
              source: 'host:/home/agent/.codex/auth.json',
            },
          ],
        },
        {
          tool: 'pi',
          state: 'signed_in',
          source: 'agent-hub',
          credentials: [
            {
              name: 'minimax',
              rotates: false,
              state: 'needs_sign_in',
              source: 'agent-hub',
            },
            {
              name: 'oauth',
              rotates: true,
              state: 'needs_sign_in',
              source: 'host:/home/agent/.pi/agent/auth.json',
            },
            {
              name: 'opencode-go',
              rotates: false,
              state: 'signed_in',
              source: 'agent-hub',
            },
          ],
        },
      ],
      actions: {
        codex: { signIn: true, signOut: 'command' },
        pi: { signIn: true, signOut: 'session' },
      },
    })
    renderSheet()
    const codex = await screen.findByTestId('login-codex')
    expect(codex).toHaveTextContent('Signed in · This host')
    // Signed in: no Sign in up front; the credentials fold into Details.
    expect(
      screen.queryByRole('button', { name: 'Sign in to Codex on agent-work' }),
    ).toBeNull()
    const codexDetails = codex.querySelector('details')
    expect(codexDetails).not.toHaveAttribute('open')
    expect(codexDetails).toHaveTextContent('Signed in · This host')
    expect(
      within(codex).getByRole('button', {
        name: 'Sign in to Codex on agent-work again',
      }),
    ).toHaveTextContent('Sign in again')
    // Pi: one provider of three, so it says so and offers Sign in.
    const pi = screen.getByTestId('login-pi')
    const chip = pi.querySelector('[data-tone]')
    expect(chip).toHaveTextContent(/^1 of 3 signed in$/)
    expect(chip).toHaveAttribute('data-tone', 'wait')
    expect(
      within(pi).getByRole('button', { name: 'Sign in to pi on agent-work' }),
    ).toBeInTheDocument()
    const piDetails = pi.querySelector('details')
    expect(piDetails).toHaveTextContent('minimax · Needs sign-in · Agent Hub')
    expect(piDetails).toHaveTextContent('opencode-go · Signed in · Agent Hub')
    expect(piDetails).toHaveTextContent('oauth · Needs sign-in · This host')
    expect(piDetails).not.toHaveTextContent('auth.json')
  })

  it('says sign-in could not be checked and retries', async () => {
    state.hosts = [host()]
    state.logins['agent-work'] = {
      status: 502,
      body: { detail: 'ssh timed out' },
    }
    renderSheet()
    expect(
      await screen.findByText(
        /Couldn’t check sign-in on agent-work: ssh timed out/,
      ),
    ).toBeInTheDocument()
    state.logins['agent-work'] = loginsFor()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('login-codex')).toBeInTheDocument()
    // Nothing to sign out of while it needs a sign-in.
    expect(
      screen.queryByRole('button', { name: 'Sign out of Codex on agent-work' }),
    ).toBeNull()
    expect(
      screen.getByRole('button', {
        name: 'Sign out of Claude Code on agent-work',
      }),
    ).toBeInTheDocument()
  })

  it('opens the sign-in session in the app and closes the sheet', async () => {
    state.hosts = [host()]
    state.logins['agent-work'] = loginsFor()
    state.answers = [
      {
        status: 200,
        body: { host: 'agent-work', session: { id: 'abcd1234' } },
      },
    ]
    const { onOpenChange } = renderSheet()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sign in to Codex on agent-work',
      }),
    )
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(state.posts).toEqual([
      {
        url: '/api/hosts/agent-work/logins/codex',
        body: { action: 'sign_in' },
      },
    ])
    expect(push.mock.calls[0][0]).toContain('session=abcd1234')
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('asks before signing out, then shows the note', async () => {
    state.hosts = [host()]
    state.logins['agent-work'] = loginsFor()
    state.answers = [
      {
        status: 200,
        body: {
          host: 'agent-work',
          signedOut: true,
          note: 'Shims update later.',
        },
      },
    ]
    renderSheet()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sign out of Claude Code on agent-work',
      }),
    )
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Sign out of Claude Code?')
    expect(state.posts).toEqual([])
    fireEvent.click(within(dialog).getByTestId('confirm-dialog-confirm'))
    expect(await screen.findByText('Shims update later.')).toBeInTheDocument()
    expect(state.posts[0].body).toEqual({ action: 'sign_out' })
  })

  it('asks before powering off a host with sessions, then forces', async () => {
    state.hosts = [host({ sessions: 2 })]
    state.logins['agent-work'] = loginsFor()
    renderSheet()
    fireEvent.click(await screen.findByRole('button', { name: 'Power off' }))
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent(
      '2 sessions running on agent-work will end.',
    )
    expect(state.posts).toEqual([])
    fireEvent.click(within(dialog).getByTestId('confirm-dialog-confirm'))
    await waitFor(() =>
      expect(state.posts).toEqual([
        {
          url: '/api/hosts/agent-work/power',
          body: { action: 'off', force: true },
        },
      ]),
    )
  })

  it('offers Power off anyway when the host answers 409', async () => {
    state.hosts = [host({ sessions: 0 })]
    state.logins['agent-work'] = loginsFor()
    state.answers = [
      { status: 409, body: { detail: '1 session is running on agent-work' } },
      { status: 200, body: { host: 'agent-work', state: 'powering_off' } },
    ]
    renderSheet()
    fireEvent.click(await screen.findByRole('button', { name: 'Power off' }))
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('1 session is running on agent-work')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Power off anyway' }),
    )
    await waitFor(() => expect(state.posts).toHaveLength(2))
    expect(state.posts[1].body).toEqual({ action: 'off', force: true })
  })
})

describe('useSignInWatch', () => {
  it('re-checks the host once its sign-in session ends', () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    watchSignIn('s1', 'agent-work', queryClient)
    const alive = [{ id: 's1', is_alive: true }]
    const { rerender } = renderHook(
      ({ sessions }) => useSignInWatch(sessions, true),
      { initialProps: { sessions: alive } },
    )
    expect(invalidate).not.toHaveBeenCalled()
    rerender({ sessions: [] })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['host-logins', 'agent-work'],
    })
  })
})
