import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type LoginCaller, LoginStore, labIdentity, loginMachine } from './logins'
import { commandEnvironment, type LoginsIo, runLogins } from './logins-cli'
import { pushLoginGrants, receiveLoginGrants } from './logins-delivery'
import { receiveLogins, toolEnvironment } from './secrets'
import type { FleetSettings } from './settings'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), pins: vi.fn() }))
vi.mock('./logins-wire', () => ({ requestLoginWire: mocks.exec }))
vi.mock('./trust', () => ({ readPins: mocks.pins }))
let home: string, env: NodeJS.ProcessEnv, store: LoginStore
const owner: LoginCaller = { owner: true, role: 'owner', machine: loginMachine() }
const hunter: LoginCaller = { role: 'hunting', machine: loginMachine(), session: 'hunt-one' }
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aico-logins-'))
  env = { HOME: home }
  store = new LoginStore(env)
  store.list()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.clearAllMocks()
})
function lab(
  target = 'example-local',
  actor = 'viewer',
  values = { username: 'fixture-user', password: 'fixture-password' },
) {
  return {
    identity: labIdentity(target, actor),
    value: JSON.stringify({
      schema_version: 1,
      reference: labIdentity(target, actor).reference,
      kind: 'synthetic',
      expires_at: null,
      values,
    }),
    metadata: {
      kind: 'lab login' as const,
      lab: { target, actor, kind: 'synthetic', expires_at: null, fields: Object.keys(values) },
    },
  }
}
it('keeps values in 0600 files only; list, show, timestamps and audit contain no value', () => {
  expect(() => store.set('missing', 'fixture-private-value', {}, owner, true)).toThrow()
  store.set('sample', 'fixture-private-value', { kind: 'password' }, owner)
  expect(lstatSync(join(store.folder, 'sample')).mode & 0o777).toBe(0o600)
  expect(readFileSync(store.path, 'utf8')).not.toContain('fixture-private-value')
  expect(JSON.stringify(store.show('sample', owner))).not.toContain('fixture-private-value')
  expect(store.value('sample', owner, 'reveal').toString()).toBe('fixture-private-value')
  expect(store.audit(owner)).toContainEqual(
    expect.objectContaining({ name: 'sample', action: 'reveal', actor: 'owner' }),
  )
  expect(store.show('sample', owner).lastUsed).not.toBeNull()
  expect(() => store.remove('sample', hunter, true)).toThrow('owner')
  expect(() => store.remove('sample', owner, false)).toThrow('Confirm')
  store.remove('sample', owner, true)
  expect(existsSync(join(store.folder, 'sample'))).toBe(false)
  expect(store.list()).toEqual([])
})
it('refuses restricted roles before use, including Claude env injection', async () => {
  store.set('claude', 'fixture-secret', { provider: 'claude-code', kind: 'tool login' }, owner)
  for (const role of ['hunting', 'recon', 'verification']) {
    expect(store.list({ ...hunter, role })).toEqual([])
    await expect(
      commandEnvironment(store, ['claude=TOKEN'], { ...hunter, role }, {}),
    ).rejects.toThrow('unavailable')
  }
})
it('rejects reserved index names and applies explicit role revocation even when all roles were allowed', () => {
  expect(() => store.set('index.json', 'fixture-private-value', {}, owner)).toThrow()
  store.set('sample', 'fixture-private-value', {}, owner)
  const caller = { role: 'review', machine: loginMachine() }
  store.grant('sample', 'role', 'review', false, owner)
  expect(() => store.value('sample', caller)).toThrow('unavailable')
  store.grant('sample', 'role', 'review', true, owner)
  expect(store.value('sample', caller).toString()).toBe('fixture-private-value')
})
it('sanitizes child execution rejection without echoing environment values', async () => {
  store.set('sample', 'fixture-private-value\0', {}, owner)
  const out = vi.fn(),
    err = vi.fn()
  expect(
    await runLogins(['run', '--with', 'sample=LOGIN', '--', '/bin/true'], env, {
      caller: owner,
      out,
      err,
      execute: async () => {
        throw new Error('fixture-private-value')
      },
    }),
  ).toBe(1)
  expect(JSON.stringify([...out.mock.calls, ...err.mock.calls])).not.toContain(
    'fixture-private-value',
  )
  expect(
    await runLogins(
      ['run', '--with', 'sample=LOGIN', '--', process.execPath, '-e', 'process.exit(0)'],
      env,
      { caller: owner, out, err },
    ),
  ).toBe(1)
  expect(JSON.stringify([...out.mock.calls, ...err.mock.calls])).not.toContain(
    'fixture-private-value',
  )
})
it('the tool launcher applies role refusal and machine revocation', () => {
  receiveLogins(
    JSON.stringify({
      tools: ['claude-code'],
      entries: [
        {
          tool: 'claude-code',
          name: 'oauth-token',
          file: 'host-tool-claude-code-oauth-token',
          envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
          value: 'fixture-private-value',
        },
      ],
    }),
    env,
  )
  expect(() => toolEnvironment('claude-code', { ...env, ST_WORK_ROLE: 'hunting' })).toThrow(
    'unavailable',
  )
  expect(
    toolEnvironment('claude-code', { ...env, ST_WORK_ROLE: 'implementation' })
      .CLAUDE_CODE_OAUTH_TOKEN,
  ).toBe('fixture-private-value')
  store.grant('host-tool-claude-code-oauth-token', 'machine', loginMachine(), false, owner)
  expect(() => toolEnvironment('claude-code', { ...env, ST_WORK_ROLE: 'implementation' })).toThrow(
    'unavailable',
  )
})
it('delivers tool entries through the same index and removes them when machine access is revoked', async () => {
  receiveLogins(
    JSON.stringify({
      tools: ['pi'],
      entries: [
        {
          tool: 'pi',
          name: 'opencode-go',
          file: 'host-tool-pi-opencode-go',
          envVar: 'OPENCODE_API_KEY',
          value: 'fixture-private-value',
        },
      ],
    }),
    env,
  )
  store.grant('host-tool-pi-opencode-go', 'machine', 'receiver', true, owner)
  const settings = {
    machine: loginMachine(),
    allowlist: '/pins',
    peerRoot: '/peers',
    peers: [{ name: 'receiver' }],
  } as FleetSettings
  mocks.pins.mockReturnValue([
    { name: loginMachine(), role: 'full' },
    { name: 'receiver', role: 'worker' },
  ])
  mocks.exec.mockResolvedValue(JSON.stringify({ ok: true }))
  await pushLoginGrants(settings, 'receiver', env)
  expect(JSON.parse(mocks.exec.mock.calls[0][1]).snapshot.entries[0].entry.tool.tool).toBe('pi')
  store.grant('host-tool-pi-opencode-go', 'machine', 'receiver', false, owner)
  await pushLoginGrants(settings, 'receiver', env)
  expect(JSON.parse(mocks.exec.mock.calls[1][1]).snapshot.entries).toEqual([])
})
it('binds hunter list, enrollment, refresh and selected fields to owner-assigned targets; revocation takes effect', () => {
  const one = lab(),
    other = lab('another-local')
  store.set(one.identity.name, one.value, one.metadata, owner)
  store.set(other.identity.name, other.value, other.metadata, owner)
  expect(store.list(hunter)).toEqual([])
  store.assign(hunter.session as string, ['example-local'], owner)
  const injected = lab('example-local', 'injected')
  expect(() =>
    store.set(
      injected.identity.name,
      injected.value,
      {
        ...injected.metadata,
        tool: {
          tool: 'st',
          name: 'summitflow-agent-token',
          file: 'host-tool-st',
          authFile: '.config/agent-tokens/summitflow',
        },
      },
      hunter,
    ),
  ).toThrow()
  expect(store.list(hunter).map((e) => e.name)).toEqual([one.identity.name])
  expect(() => store.set(other.identity.name, other.value, other.metadata, hunter, true)).toThrow(
    'unavailable',
  )
  expect(() => store.value(one.identity.name, hunter)).toThrow('descriptor')
  expect(
    store.resolveLab(
      'example-local',
      [
        {
          reference: one.identity.reference,
          fields: ['password'],
          optional_fields: ['totp_secret'],
        },
      ],
      hunter,
    ),
  ).toEqual({
    schema_version: 1,
    target: 'example-local',
    credentials: [{ reference: one.identity.reference, values: { password: 'fixture-password' } }],
  })
  expect(() =>
    store.resolveLab(
      'example-local',
      [{ reference: one.identity.reference, fields: ['constructor'] }],
      hunter,
    ),
  ).toThrow('required')
  expect(() =>
    store.resolveLab(
      'another-local',
      [{ reference: one.identity.reference, fields: ['password'] }],
      hunter,
    ),
  ).toThrow('outside')
  store.assign(hunter.session as string, [], owner)
  expect(() =>
    store.resolveLab(
      'example-local',
      [{ reference: one.identity.reference, fields: ['password'] }],
      hunter,
    ),
  ).toThrow('unavailable')
})
it('lets a coordinator assign targets without an owner step and refuses hunter self-assignment', () => {
  const coordinator = { role: 'coordinator', machine: loginMachine(), session: 'coordinator-one' }
  expect(() => store.assign('hunt-one', ['example-local'], hunter)).toThrow()
  store.assign('hunt-one', ['example-local'], coordinator)
  expect(store.assignments(coordinator)['hunt-one']).toEqual(['example-local'])
})
it('patches selected lab fields, keeps account fields, and requires password when changing site', () => {
  const identity = labIdentity('example-local', 'account')
  store.set(
    identity.name,
    JSON.stringify({
      schema_version: 1,
      reference: identity.reference,
      kind: 'account',
      expires_at: null,
      values: {
        username: 'fixture-user',
        password: 'fixture-password',
        login_url: 'https://example.test/login',
        totp_secret: 'fixture-totp',
      },
    }),
    {
      kind: 'lab login',
      lab: {
        target: 'example-local',
        actor: 'account',
        kind: 'account',
        expires_at: null,
        fields: [],
      },
    },
    owner,
  )
  expect(() =>
    store.patchLab(
      'example-local',
      'account',
      { set: { login_url: 'https://other.test/login' } },
      owner,
    ),
  ).toThrow('password')
  expect(() => store.patchLab('example-local', 'account', { remove: ['password'] }, owner)).toThrow(
    'username and password',
  )
  store.patchLab(
    'example-local',
    'account',
    { set: { username: 'fixture-updated' }, remove: ['totp_secret'] },
    owner,
  )
  expect(JSON.parse(store.value(identity.name, owner).toString()).values).toEqual({
    username: 'fixture-updated',
    password: 'fixture-password',
    login_url: 'https://example.test/login',
  })
})
it('CLI values enter through input, stay out of metadata and argv; get refuses session output', async () => {
  const out = vi.fn(),
    err = vi.fn(),
    execute = vi.fn<LoginsIo['execute']>(async () => 0)
  const io = {
    caller: owner,
    out,
    err,
    execute,
    input: async () => 'fixture-private-value',
    outputSafe: () => false,
  }
  expect(await runLogins(['set', 'sample'], env, io)).toBe(0)
  expect(JSON.stringify(out.mock.calls)).not.toContain('fixture-private-value')
  expect(await runLogins(['set', 'bad', 'fixture-private-value'], env, io)).toBe(1)
  expect(JSON.stringify(err.mock.calls)).not.toContain('fixture-private-value')
  expect(await runLogins(['get', 'sample'], env, io)).toBe(1)
  expect(await runLogins(['run', '--with', 'sample=LOGIN', '--', '/bin/true'], env, io)).toBe(0)
  expect(execute.mock.calls[0]?.[0]).toEqual(['/bin/true'])
  expect(execute.mock.calls[0]?.[1]).toMatchObject({ LOGIN: 'fixture-private-value' })
  expect(JSON.stringify(out.mock.calls)).not.toContain('fixture-private-value')
})
it('lab CLI preserves descriptor wire format and silences the trusted child', async () => {
  const one = lab(),
    out = vi.fn(),
    err = vi.fn(),
    execute = vi.fn<LoginsIo['execute']>(async () => 0)
  store.set(one.identity.name, one.value, one.metadata, owner)
  store.assign(hunter.session as string, ['example-local'], owner)
  const { writeFileSync } = await import('node:fs')
  const request = join(home, 'request.json')
  writeFileSync(
    request,
    JSON.stringify([{ reference: one.identity.reference, fields: ['password'] }]),
  )
  expect(
    await runLogins(
      ['lab', 'run', '--target', 'example-local', '--request', request, '--', '/bin/true'],
      env,
      { caller: hunter, out, err, execute },
    ),
  ).toBe(0)
  expect(execute.mock.calls[0]?.[1]).toEqual({
    PATH: '/usr/bin:/bin',
    AGENT_HUB_LAB_CREDENTIAL_FD: '3',
  })
  expect(JSON.parse(execute.mock.calls[0]?.[2] as string).credentials[0].values).toEqual({
    password: 'fixture-password',
  })
  expect(out).not.toHaveBeenCalled()
})
it('delivers machine grants through the fleet stdin and removes revoked delivered files', async () => {
  store.set('sample', 'fixture-private-value', {}, owner)
  store.grant('sample', 'machine', 'receiver', true, owner)
  const settings = {
    machine: loginMachine(),
    allowlist: '/pins',
    peerRoot: '/peers',
    peers: [{ name: 'receiver' }],
  } as FleetSettings
  mocks.pins.mockReturnValue([
    { name: loginMachine(), role: 'full' },
    { name: 'receiver', role: 'worker' },
  ])
  mocks.exec.mockResolvedValue(JSON.stringify({ ok: true }))
  expect(await pushLoginGrants(settings, 'receiver', env)).toEqual(['sample'])
  const [socket, input] = mocks.exec.mock.calls[0] as [string, string]
  expect(socket).not.toContain('fixture-private-value')
  expect(JSON.parse(input).snapshot.entries[0].value).toBe('fixture-private-value')
  const receiverHome = join(home, 'receiver'),
    receiverEnv = { HOME: receiverHome },
    receiver = new LoginStore(receiverEnv)
  receiveLoginGrants(
    JSON.stringify({ ...store.snapshot(loginMachine(), false), source: 'sender' }),
    receiverEnv,
  )
  expect(receiver.list().map((e) => e.name)).toEqual(['sample'])
  store.grant('sample', 'role', '*', false, owner)
  store.grant('sample', 'role', 'review', true, owner)
  receiveLoginGrants(
    JSON.stringify({ ...store.snapshot(loginMachine(), false), source: 'sender' }),
    receiverEnv,
  )
  expect(receiver.list()[0].roles).toEqual(['review'])
  store.grant('sample', 'machine', loginMachine(), false, owner)
  receiveLoginGrants(
    JSON.stringify({ ...store.snapshot(loginMachine(), false), source: 'sender' }),
    receiverEnv,
  )
  expect(receiver.list()).toEqual([])
  expect(existsSync(join(receiver.folder, 'sample'))).toBe(false)
})
