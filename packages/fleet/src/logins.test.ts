import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Login,
  type LoginCaller,
  LoginStore,
  labChildProgram,
  labIdentity,
  loginMachine,
  loginPolicy,
} from './logins'
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
/** The shared login adapter as deployed under the test home: `current` links to a release. */
let adapter: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aico-logins-'))
  env = { HOME: home }
  store = new LoginStore(env)
  store.list()
  const shared = (loginPolicy.labPrograms[0] as string).slice(2).split('/current/')
  const release = join(home, shared[0] as string, 'releases/r1')
  adapter = join(release, shared[1] as string)
  mkdirSync(join(adapter, '..'), { recursive: true })
  writeFileSync(adapter, '')
  symlinkSync(release, join(home, shared[0] as string, 'current'))
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
          name: 'sample-agent-token',
          file: 'host-tool-st',
          authFile: '.config/agent-tokens/sample',
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
      adapter,
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
      adapter,
    ),
  ).toThrow('required')
  expect(() =>
    store.resolveLab(
      'another-local',
      [{ reference: one.identity.reference, fields: ['password'] }],
      hunter,
      adapter,
    ),
  ).toThrow('outside')
  store.assign(hunter.session as string, [], owner)
  expect(() =>
    store.resolveLab(
      'example-local',
      [{ reference: one.identity.reference, fields: ['password'] }],
      hunter,
      adapter,
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
it('CLI answers questions without acting: help for one command, no match in words, the valid kinds, recent activity', async () => {
  const out = vi.fn(),
    err = vi.fn()
  const io = {
    out,
    err,
    caller: owner,
    execute: vi.fn(async () => 0),
    input: vi.fn(async () => 'fixture-private-value'),
    outputSafe: () => false,
  }
  const printed = () => out.mock.calls.flat().join('')

  for (const command of ['edit', 'set', 'remove']) {
    out.mockClear()
    expect(await runLogins([command, '--help'], env, io)).toBe(0)
    expect(printed()).toContain(`  ${command} NAME`)
    expect(printed()).not.toContain('assign SESSION')
  }
  expect(io.input).not.toHaveBeenCalled()
  // What follows run's -- belongs to the command.
  expect(await runLogins(['run', '--with', 'absent', '--', '/bin/true', '--help'], env, io)).toBe(1)

  err.mockClear()
  expect(await runLogins(['set', 'bad-kind', '--kind', 'token'], env, io)).toBe(1)
  expect(err.mock.calls.flat().join('')).toContain('use one of: tool login, API key')

  out.mockClear()
  err.mockClear()
  expect(await runLogins(['list', 'nothing-like-this'], env, io)).toBe(0)
  expect(err.mock.calls.flat().join('')).toContain('No login has "nothing-like-this" in its name')
  expect(printed().trim()).toBe('[]')

  expect(await runLogins(['set', 'sample', '--notes', 'first'], env, io)).toBe(0)
  out.mockClear()
  expect(
    await runLogins(['edit', 'sample', '--notes', 'second', '--kind', 'backup key'], env, io),
  ).toBe(0)
  expect(JSON.parse(printed())).toMatchObject({
    kind: 'backup key',
    state: 'Unused',
    usable: true,
    activity: expect.any(Array),
  })
  await expect(runLogins(['edit', 'sample', '--kind', 'lab login'], env, io)).resolves.not.toBe(0)
  out.mockClear()
  expect(await runLogins(['show', 'sample'], env, io)).toBe(0)
  const shown = JSON.parse(printed())
  expect(shown.notes).toBe('second')
  expect(shown.state).toBe('Unused')
  expect(shown.usable).toBe(true)
  expect(shown.activity.at(-1).action).toBeTruthy()
  expect(printed()).not.toContain('fixture-private-value')
})
it('CLI set --account saves an account login, shows only length, and the summary has no password', async () => {
  const out = vi.fn(),
    err = vi.fn()
  const io = {
    caller: owner,
    out,
    err,
    execute: vi.fn<LoginsIo['execute']>(async () => 0),
    input: async () => 'fixture-private-value',
    outputSafe: () => false,
    probe: async () => ({ warning: 'No password field at https://school.example.test/.' }),
  }
  expect(
    await runLogins(
      [
        'set',
        'school',
        '--account',
        '--username',
        'me@example.test',
        '--login-url',
        'https://school.example.test/',
      ],
      env,
      io,
    ),
  ).toBe(0)
  expect(err.mock.calls.map((c) => c[0])).toContain('Saved, 21 characters\n')
  expect(JSON.stringify([...out.mock.calls, ...err.mock.calls])).not.toContain(
    'fixture-private-value',
  )
  expect(store.list().find((e) => e.lab?.target === 'school')?.lab).toMatchObject({
    kind: 'account',
    username: 'me@example.test',
    login_url: 'https://school.example.test/',
    fields: ['username', 'login_url', 'password'],
  })
  expect(JSON.stringify(store.list())).not.toContain('fixture-private-value')
  expect(await runLogins(['set', 'again', '--account', '--username', 'u'], env, io)).toBe(1)
})
it('sends each command to the store, and says so for one it does not know', async () => {
  const out = vi.fn(),
    err = vi.fn()
  // Only the test home: the owner's XDG_STATE_HOME or AICO_DATA_DIR would send the store to real state.
  const env = { PATH: process.env.PATH, HOME: home }
  let input = ''
  const io = { out, err, caller: owner, input: async () => input }
  const reply = () => out.mock.calls.at(-1)?.[0]
  const run = (...args: string[]) => runLogins(args, env, io)
  expect(await run('nothing')).toBe(1)
  expect(err.mock.calls.at(-1)?.[0]).toBe('Unknown login command; see aico logins --help\n')
  expect(await run('constructor')).toBe(1)
  expect(err.mock.calls.at(-1)?.[0]).toBe('Unknown login command; see aico logins --help\n')
  expect(await run('lab', 'nothing')).toBe(1)
  expect(err.mock.calls.at(-1)?.[0]).toBe('A lab target is required\n')
  expect(await run('lab', 'nothing', '--target', 'site')).toBe(1)
  expect(err.mock.calls.at(-1)?.[0]).toBe('Unknown login command; see aico logins --help\n')
  input = JSON.stringify({ username: 'u', password: 'fixture-private-value' })
  expect(await run('lab', 'enroll', '--target', 'site', '--kind', 'synthetic')).toBe(0)
  const { name, reference } = labIdentity('site', 'default')
  expect(JSON.parse(reply())).toEqual({ reference })
  expect(await run('lab', 'refs', '--target', 'site')).toBe(0)
  expect(JSON.parse(reply())).toEqual({ references: [reference] })
  input = JSON.stringify({ username: 'u', password: 'fixture-private-other' })
  expect(await run('lab', 'refresh', '--target', 'site')).toBe(0)
  expect(JSON.parse(store.value(name, owner).toString()).values.password).toBe(
    'fixture-private-other',
  )
  input = JSON.stringify({ set: { password: 'fixture-private-third' } })
  expect(await run('lab', 'patch', '--target', 'site')).toBe(0)
  expect(JSON.parse(store.value(name, owner).toString()).values.password).toBe(
    'fixture-private-third',
  )
  input = 'fixture-private-value'
  expect(await run('set', 'key', '--kind', 'API key')).toBe(0)
  input = 'fixture-private-other'
  expect(await run('rotate', 'key')).toBe(0)
  expect(store.value('key', owner).toString()).toBe('fixture-private-other')
  expect(await run('grant', 'key', '--role', 'review')).toBe(0)
  expect(JSON.parse(reply()).roles).toContain('review')
  expect(await run('revoke', 'key', '--role', 'review')).toBe(0)
  expect(JSON.parse(reply()).roles).not.toContain('review')
  expect(await run('grant', 'key')).toBe(1)
  expect(err.mock.calls.at(-1)?.[0]).toBe('Choose one machine or role\n')
  expect(await run('assign', 'a1b2c3d4', '--target', 'site')).toBe(0)
  expect(JSON.parse(reply())).toEqual({ session: 'a1b2c3d4', targets: ['site'] })
  expect(await run('assignments')).toBe(0)
  expect(JSON.parse(reply())).toEqual({ a1b2c3d4: ['site'] })
  expect(await run('unassign', 'a1b2c3d4')).toBe(0)
  expect(JSON.parse(reply())).toEqual({ session: 'a1b2c3d4', targets: [] })
  input = 'key'
  expect(await run('remove', 'key')).toBe(0)
  expect(JSON.parse(reply())).toEqual({ removed: 'key' })
  expect(store.list().find((e) => e.name === 'key')).toBeUndefined()
})
it('a lab login opens for an explicitly named role without a session, never for the default all-roles grant', () => {
  const one = lab('school', 'default', {
    username: 'me@example.test',
    password: 'fixture-password',
  })
  store.set(one.identity.name, one.value, one.metadata, owner)
  const job = { role: 'agent', machine: loginMachine() }
  expect(() => store.show(one.identity.name, job)).toThrow('unavailable')
  store.grant(one.identity.name, 'role', 'agent', true, owner)
  expect(store.show(one.identity.name, job).lab?.target).toBe('school')
  const request = [{ reference: one.identity.reference, fields: ['username'] }]
  expect(store.resolveLab('school', request, job, adapter).credentials[0].values).toEqual({
    username: 'me@example.test',
  })
  // A different role stays out, and so does a session with no assignment.
  expect(() => store.show(one.identity.name, { ...job, role: 'review' })).toThrow('unavailable')
})
it('a lab login goes only to the shared adapters and the programs it declares; agents add one, logged', () => {
  const one = lab('school', 'default')
  store.set(one.identity.name, one.value, one.metadata, owner)
  store.grant(one.identity.name, 'role', 'agent', true, owner)
  const job = { role: 'agent', machine: loginMachine(), session: 'job-one' }
  const request = [{ reference: one.identity.reference, fields: ['username'] }]
  const script = join(home, 'tool.py')
  writeFileSync(script, '')
  expect(() => store.resolveLab('school', request, job, script)).toThrow(
    `aico logins edit school --program ${script}`,
  )
  expect(() => store.resolveLab('school', request, job)).toThrow('program')
  expect(() => store.edit('school', { program: script }, hunter)).toThrow('coordinator')
  expect(() => store.edit('school', { program: 'tool.py' }, job)).toThrow('absolute')
  expect(() => store.edit('school', { program: join(home, 'none') }, job)).toThrow('No program')
  // An interpreter or shell runs anything, so it is never a program a login goes to.
  expect(() => store.edit('school', { program: '/usr/bin/python3' }, job)).toThrow('interpreter')
  expect(() => store.edit('school', { program: '/bin/sh' }, job)).toThrow('interpreter')
  expect(() => store.edit('school', { dropProgram: script }, job)).toThrow('not one of')
  // Declared through a link (a release's `current`), it follows the link when used.
  const release = join(home, 'release-1')
  mkdirSync(release)
  writeFileSync(join(release, 'tool.py'), '')
  symlinkSync(release, join(home, 'current'))
  store.edit('school', { program: '~/current/tool.py' }, job)
  expect(store.show('school', job).lab?.programs).toEqual([join(home, 'current/tool.py')])
  expect(
    store.resolveLab('school', request, job, join(release, 'tool.py')).credentials,
  ).toHaveLength(1)
  store.edit('school', { dropProgram: join(release, 'tool.py') }, job)
  expect(store.show('school', job).lab?.programs).toBeUndefined()
  store.edit('school', { program: join(release, 'tool.py') }, job)
  store.edit('school', { dropProgram: '~/current/tool.py' }, job)
  expect(store.show('school', job).lab?.programs).toBeUndefined()
  store.edit('school', { program: script }, job)
  expect(store.resolveLab('school', request, job, script).credentials[0].values).toEqual({
    username: 'fixture-user',
  })
  expect(store.audit(owner).map((e) => [e.action, e.detail])).toEqual(
    expect.arrayContaining([
      ['edit', `program ${script}`],
      ['lab use', `program ${script}`],
    ]),
  )
  // Replacing the values keeps the declared programs; dropping one takes it back.
  store.set(one.identity.name, one.value, {}, owner, true)
  expect(store.show('school', job).lab?.programs).toEqual([script])
  store.edit('school', { dropProgram: script }, job)
  expect(store.show('school', job).lab?.programs).toBeUndefined()
  expect(() => store.resolveLab('school', request, job, script)).toThrow('--program')
})
it('says which target to assign when a session enrolls a lab login it was not given', () => {
  const one = lab('school')
  expect(() => store.set(one.identity.name, one.value, one.metadata, hunter)).toThrow(
    'aico logins assign hunt-one --target school',
  )
  store.assign('hunt-one', ['school'], owner)
  store.set(one.identity.name, one.value, one.metadata, hunter)
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
  const script = join(home, 'adapter.py')
  writeFileSync(script, '')
  store.edit(one.identity.name, { program: script }, owner)
  const run = (...child: string[]) =>
    runLogins(
      ['lab', 'run', '--target', 'example-local', '--request', request, '--', ...child],
      env,
      {
        caller: hunter,
        out,
        err,
        execute,
      },
    )
  // Values go only to declared programs: any other child is refused before a value is read.
  expect(await run('/bin/true')).toBe(1)
  expect(err.mock.calls.join('')).toContain(`--program ${labChildProgram(['/bin/true'])}`)
  expect(execute).not.toHaveBeenCalled()
  for (const child of [
    ['/usr/bin/python3', '-c', 'print(1)'],
    ['/usr/bin/python3', '-I', '-c', 'print(1)'],
    ['/usr/bin/python3', '-I', '-m', 'json.tool'],
    ['/usr/bin/python3', script],
    ['/bin/sh', '-c', 'true'],
  ])
    expect(await run(...child)).toBe(1)
  expect(err.mock.calls.join('')).toContain('-I /absolute/script.py')
  expect(execute).not.toHaveBeenCalled()
  expect(await run('/usr/bin/python3', '-I', script, '--flag')).toBe(0)
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
it('collapses repeated machine reads, keeps explicit reveals, and caps activity by count and age', () => {
  let now = Date.parse('2026-11-06T00:00:00Z')
  const clocked = new LoginStore(
    { ...env, AICO_LOGINS_AUDIT_MAX_ENTRIES: '50', AICO_LOGINS_AUDIT_MAX_DAYS: '2' },
    () => new Date(now).toISOString(),
  )
  clocked.set('sample', 'fixture-private-value', {}, owner)
  const machine: LoginCaller = { role: 'coordinator', machine: loginMachine() }
  const before = readFileSync(clocked.path, 'utf8')
  for (let i = 0; i < 20; i++) clocked.value('sample', machine, 'VM operation')
  const reads = () => clocked.audit(owner).filter((e) => e.action === 'VM operation')
  expect(reads()).toHaveLength(1)
  const once = readFileSync(clocked.path, 'utf8')
  expect(once).not.toBe(before)
  now += 60_000
  clocked.value('sample', machine, 'VM operation')
  expect(readFileSync(clocked.path, 'utf8')).toBe(once) // collapsed reads leave the index alone
  clocked.value('sample', owner, 'reveal')
  clocked.value('sample', owner, 'reveal')
  expect(clocked.audit(owner).filter((e) => e.action === 'reveal')).toHaveLength(2)
  now += 3_601_000
  clocked.value('sample', machine, 'VM operation')
  expect(reads()).toHaveLength(2)
  for (let i = 0; i < 80; i++) {
    now += 3_601_000
    clocked.value('sample', machine, 'VM operation')
  }
  const kept: { at: string; action: string }[] = JSON.parse(
    readFileSync(clocked.path, 'utf8'),
  ).audit
  const machineReads = kept.filter((e) => e.action === 'VM operation')
  expect(machineReads.length).toBeLessThanOrEqual(50)
  expect(machineReads.every((e) => Date.parse(e.at) >= now - 2 * 86_400_000)).toBe(true)
  // Changes and explicit reveals are never pushed out by machine reads.
  expect(kept.filter((e) => e.action !== 'VM operation').map((e) => e.action)).toEqual([
    'set',
    'reveal',
    'reveal',
  ])
  expect(clocked.snapshot(loginMachine(), true).audit.length).toBeLessThanOrEqual(53)
})
it('trims an oversized existing activity log on the next write', () => {
  store.set('sample', 'fixture-private-value', {}, owner)
  const index = JSON.parse(readFileSync(store.path, 'utf8'))
  const at = new Date().toISOString()
  index.audit = [
    ...index.audit,
    ...Array.from({ length: 5000 }, (_, i) => ({
      id: `old-${i}`,
      at,
      action: 'VM operation',
      name: 'sample',
      actor: `caller-${i}`,
    })),
  ]
  writeFileSync(store.path, JSON.stringify(index))
  store.grant('sample', 'role', 'coordinator', true, owner)
  const audit: { action: string }[] = JSON.parse(readFileSync(store.path, 'utf8')).audit
  expect(audit.filter((e) => e.action === 'VM operation')).toHaveLength(2000)
  expect(audit.filter((e) => e.action !== 'VM operation').map((e) => e.action)).toEqual([
    'set',
    'grant',
  ])
})
it('merges only activity that survives the cap, so trimmed history is not news', () => {
  const now = () => '2026-11-06T00:00:00.000Z'
  const a = new LoginStore(env, now)
  a.set('sample', 'fixture-private-value', {}, owner)
  const snapshot = a.snapshot(loginMachine(), true)
  const old = {
    id: 'ancient',
    at: '2020-01-01T00:00:00.000Z',
    action: 'use',
    name: 'sample',
    actor: 'x',
  }
  expect(a.mergeSnapshot({ ...snapshot, audit: [...snapshot.audit, old] })).toBe(false)
  expect(a.audit(owner).some((e) => e.id === 'ancient')).toBe(false)
})
it('takes a kernel lock that a crashed holder cannot leave behind', () => {
  mkdirSync(join(store.folder, '.index-lock'), { recursive: true })
  // -o: only the flock process holds the lock; SIGKILL it mid-hold like a crashed writer.
  const held = spawnSync('flock', ['-o', '-x', join(store.folder, '.index.flock'), 'sleep', '2'], {
    timeout: 200,
    killSignal: 'SIGKILL',
  })
  expect(held.signal).toBe('SIGKILL')
  store.set('after-crash', 'fixture-private-value', {}, owner)
  expect(store.show('after-crash', owner).name).toBe('after-crash')
})
function account(target = 'canvas-pcsb', url = 'https://canvas.example.test/') {
  const identity = labIdentity(target, 'default')
  const values = { username: 'me@example.test', password: 'fixture-password', login_url: url }
  store.set(
    identity.name,
    JSON.stringify({
      schema_version: 1,
      reference: identity.reference,
      kind: 'account',
      expires_at: null,
      values,
    }),
    {
      kind: 'lab login',
      lab: {
        target,
        actor: 'default',
        kind: 'account',
        expires_at: null,
        fields: Object.keys(values),
      },
    },
    owner,
  )
  return identity
}
it('lists every login to an agent: unusable ones with what is missing and the command that fixes it', () => {
  const identity = account()
  store.grant(identity.name, 'role', '*', false, owner)
  store.set('sample', 'fixture-private-value', { kind: 'API key' }, owner)
  const agent = { role: 'school-check', machine: 'elsewhere', session: 'a1b2c3d4' }
  const listed = store.catalog(agent)
  expect(listed.map((e) => e.name).sort()).toEqual([identity.name, 'sample'])
  expect(listed.find((e) => e.name === identity.name)).toMatchObject({
    available: false,
    missing: [
      { kind: 'machine', value: 'elsewhere' },
      { kind: 'session', value: 'a1b2c3d4' },
      { kind: 'role', value: 'school-check' },
    ],
    fix: 'aico logins allow canvas-pcsb',
    lab: { target: 'canvas-pcsb', login_url: 'https://canvas.example.test/' },
  })
  expect(JSON.stringify(listed)).not.toContain('fixture-')
  expect(JSON.stringify(listed)).not.toContain('me@example.test')
  // A restricted role is not shown the owner's own logins it can't use.
  expect(store.catalog(hunter).map((e) => e.name)).toEqual([])
})
it('names what is missing in the refusal, with the one self-service command', () => {
  const identity = account()
  store.grant(identity.name, 'role', '*', false, owner)
  const agent = { role: 'school-check', machine: loginMachine(), session: 'a1b2c3d4' }
  expect(() => store.show('canvas-pcsb', agent)).toThrow(
    'Login canvas-pcsb unavailable to session a1b2c3d4: session a1b2c3d4 is not assigned target canvas-pcsb; role school-check is not allowed. Fix it yourself (logged, no owner step): aico logins allow canvas-pcsb',
  )
  expect(() => store.show('nothing-here', agent)).toThrow('No login named nothing-here')
  store.set('sample', 'fixture-private-value', {}, owner)
  store.grant('sample', 'machine', loginMachine(), false, owner)
  expect(() => store.value('sample', agent)).toThrow(`machine ${loginMachine()} is not allowed`)
})
it('an account login opens through All roles for unrestricted roles; restricted roles stay out unless marked', () => {
  account()
  const agent = { role: 'school-check', machine: loginMachine() }
  expect(store.show('canvas-pcsb', agent).lab?.target).toBe('canvas-pcsb')
  expect(() => store.show('canvas-pcsb', hunter)).toThrow("does not use the owner's real accounts")
  expect(() => store.show('canvas-pcsb', hunter)).toThrow('Ask your coordinator, never the owner')
})
describe('the owner real accounts and restricted roles', () => {
  const agent: LoginCaller = { role: 'school-check', machine: loginMachine(), session: 'a1b2c3d4' }
  const coordinator: LoginCaller = {
    role: 'coordinator',
    machine: loginMachine(),
    session: 'coord-one',
  }
  // Tether's coordinator flag, with whatever work role the session started under.
  const huntCoordinator: LoginCaller = {
    role: 'implementation',
    machine: loginMachine(),
    session: 'coord-two',
    coordinator: true,
  }
  const testLogin = (target: string) => {
    const identity = labIdentity(target, 'default')
    store.set(
      identity.name,
      JSON.stringify({
        schema_version: 1,
        reference: identity.reference,
        kind: 'synthetic',
        expires_at: null,
        values: { username: 'fixture-user', password: 'fixture-password' },
      }),
      {
        kind: 'lab login',
        lab: { target, actor: 'default', kind: 'synthetic', expires_at: null, fields: [] },
      },
      owner,
    )
    return identity
  }
  it('refuses an assigned hunter on an unmarked account, at the moment of use', () => {
    const identity = account()
    store.assign('hunt-one', ['canvas-pcsb'], owner)
    expect(() => store.show('canvas-pcsb', hunter)).toThrow(
      "does not use the owner's real accounts",
    )
    expect(() =>
      store.resolveLab(
        'canvas-pcsb',
        [{ reference: identity.reference, fields: ['username'] }],
        hunter,
        adapter,
      ),
    ).toThrow("does not use the owner's real accounts")
    expect(store.catalog(hunter).map((e) => e.name)).not.toContain(identity.name)
    // Naming the role on the login opens nothing either.
    store.grant(identity.name, 'role', 'hunting', true, owner)
    expect(() => store.show('canvas-pcsb', hunter)).toThrow(
      "does not use the owner's real accounts",
    )
  })
  it('lets an agent rename an account onto a hunter site; the hunter stays out', () => {
    account()
    store.assign('hunt-one', ['shop-local'], coordinator)
    const renamed = store.edit('canvas-pcsb', { target: 'shop-local' }, agent)
    expect(renamed.lab?.target).toBe('shop-local')
    expect(store.assignments(owner)['hunt-one']).toEqual(['shop-local'])
    expect(() => store.show('shop-local', hunter)).toThrow("does not use the owner's real accounts")
  })
  it('opens a marked account only to a hunter who is assigned it, and closes it again', () => {
    const identity = account()
    expect(store.huntersOk('canvas-pcsb', true, owner).lab?.huntersOk).toBe(true)
    expect(() => store.show('canvas-pcsb', hunter)).toThrow('not assigned target canvas-pcsb')
    expect(() => store.show('canvas-pcsb', hunter)).toThrow('Ask your coordinator, never the owner')
    store.assign('hunt-one', ['canvas-pcsb'], coordinator)
    expect(store.show('canvas-pcsb', hunter).name).toBe(identity.name)
    expect(
      store.resolveLab(
        'canvas-pcsb',
        [{ reference: identity.reference, fields: ['username'] }],
        hunter,
        adapter,
      ),
    ).toMatchObject({ schema_version: 1 })
    expect(store.audit(owner).at(-3)).toMatchObject({
      action: 'hunters OK',
      name: identity.name,
      actor: 'owner',
      detail: 'on',
    })
    store.huntersOk('canvas-pcsb', false, owner)
    expect(store.audit(owner).at(-1)).toMatchObject({ action: 'hunters OK', detail: 'off' })
    expect(store.show('canvas-pcsb', agent).lab?.huntersOk).toBeUndefined()
    expect(() => store.show('canvas-pcsb', hunter)).toThrow(
      "does not use the owner's real accounts",
    )
  })
  it('keeps the mark across a rename and a change of notes, page or programs', () => {
    account()
    store.huntersOk('canvas-pcsb', true, owner)
    store.edit('canvas-pcsb', { notes: 'x', login_url: 'https://other.example.test/' }, agent)
    store.edit('canvas-pcsb', { program: adapter }, agent)
    expect(store.edit('canvas-pcsb', { target: 'renamed' }, agent).lab?.huntersOk).toBe(true)
    const identity = labIdentity('renamed', 'default')
    // The owner replacing or patching it keeps the mark too.
    store.set(identity.name, store.value(identity.name, owner).toString(), {}, owner, true)
    expect(store.show('renamed', agent).lab?.huntersOk).toBe(true)
    store.patchLab('renamed', 'default', { set: { totp_secret: 'fixture-totp' } }, owner)
    expect(store.show('renamed', agent).lab?.huntersOk).toBe(true)
  })
  it('the mark opens an account to use, never to change', () => {
    const identity = account()
    store.huntersOk('canvas-pcsb', true, owner)
    store.assign('hunt-one', ['canvas-pcsb'], coordinator)
    const before = store.value(identity.name, owner).toString()
    expect(() =>
      store.patchLab('canvas-pcsb', 'default', { set: { totp_secret: 'x' } }, hunter),
    ).toThrow("hunters use it and don't change it")
    expect(() => store.set(identity.name, before, {}, hunter, true)).toThrow(
      "hunters use it and don't change it",
    )
    expect(store.value(identity.name, owner).toString()).toBe(before)
  })
  it('a refusal names the step that fixes it, not an assignment that changes nothing', () => {
    const identity = testLogin('shop-local')
    store.assign('hunt-one', ['shop-local'], coordinator)
    store.grant(identity.name, 'role', '*', false, owner)
    expect(() => store.show('shop-local', hunter)).toThrow(
      'A coordinator runs: aico logins grant shop-local --role hunting',
    )
    store.grant(identity.name, 'role', '*', true, owner)
    store.grant(identity.name, 'machine', loginMachine(), false, owner)
    expect(() => store.show('shop-local', hunter)).toThrow(
      `A coordinator runs: aico logins grant shop-local --machine ${loginMachine()}`,
    )
    store.grant(identity.name, 'machine', loginMachine(), true, coordinator)
    store.assign('hunt-one', [], coordinator)
    expect(() => store.show('shop-local', hunter)).toThrow(
      'A coordinator runs: aico logins assign hunt-one --target shop-local',
    )
    expect(() => store.show('nothing-here', hunter)).toThrow(
      'No login named nothing-here. Ask your coordinator, never the owner',
    )
    expect(() => store.set('other', 'x', {}, hunter)).toThrow('Ask your coordinator')
    expect(() => store.set('other', 'x', {}, hunter)).not.toThrow('tether ask')
  })
  it('the mark reaches other machines, on and off', () => {
    const identity = account()
    store.grant(identity.name, 'machine', 'worker-one', true, owner)
    store.assign('hunt-one', ['canvas-pcsb'], owner)
    const peerHome = mkdtempSync(join(tmpdir(), 'aico-logins-peer-'))
    try {
      const peer = new LoginStore({ HOME: peerHome }, undefined, 'worker-one')
      const there = { ...hunter, machine: 'worker-one' }
      peer.mergeSnapshot(store.snapshot('worker-one', false), 'worker-one')
      expect(() => peer.show('canvas-pcsb', there)).toThrow(
        "does not use the owner's real accounts",
      )
      store.huntersOk('canvas-pcsb', true, owner)
      peer.mergeSnapshot(store.snapshot('worker-one', false), 'worker-one')
      expect(peer.show('canvas-pcsb', there).name).toBe(identity.name)
      store.huntersOk('canvas-pcsb', false, owner)
      peer.mergeSnapshot(store.snapshot('worker-one', false), 'worker-one')
      expect(() => peer.show('canvas-pcsb', there)).toThrow(
        "does not use the owner's real accounts",
      )
    } finally {
      rmSync(peerHome, { recursive: true, force: true })
    }
  })
  it('only the owner sets or clears the mark, and only on an account', () => {
    const identity = account()
    for (const caller of [agent, coordinator, huntCoordinator, hunter])
      expect(() => store.huntersOk('canvas-pcsb', true, caller)).toThrow('Only the owner')
    store.huntersOk('canvas-pcsb', true, owner)
    expect(() => store.huntersOk('canvas-pcsb', false, coordinator)).toThrow('Only the owner')
    testLogin('shop-local')
    expect(() => store.huntersOk('shop-local', true, owner)).toThrow('account login')
    store.set('sample', 'fixture-private-value', {}, owner)
    expect(() => store.huntersOk('sample', true, owner)).toThrow('account login')
    // The mark comes through this one door: not through a save, and not through a replacement.
    store.huntersOk('canvas-pcsb', false, owner)
    const entry = store.show('canvas-pcsb', agent)
    const value = store.value(identity.name, owner).toString()
    store.set(
      identity.name,
      value,
      { lab: { ...entry.lab, huntersOk: true } as Login['lab'] },
      owner,
      true,
    )
    expect(store.show('canvas-pcsb', agent).lab?.huntersOk).toBeUndefined()
  })
  it('refuses a peer snapshot whose mark is not plainly on', () => {
    const identity = account()
    store.huntersOk('canvas-pcsb', true, owner)
    const snapshot = store.snapshot(loginMachine(), true)
    const item = snapshot.entries.find((e) => e.entry.name === identity.name)
    if (!item?.entry.lab) throw new Error('no entry')
    expect(item.entry.lab.huntersOk).toBe(true)
    ;(item.entry.lab as { huntersOk?: unknown }).huntersOk = 'yes'
    expect(() => store.mergeSnapshot(snapshot)).toThrow('Invalid login snapshot')
  })
  it('coordinators and hunter coordinators give a hunter a test login, no owner step', () => {
    for (const [caller, session] of [
      [coordinator, 'hunt-one'],
      [huntCoordinator, 'hunt-one'],
    ] as const) {
      const target = `shop-${caller.session}`
      const identity = testLogin(target)
      store.assign(session, [target], caller)
      expect(store.show(target, { ...hunter, session }).name).toBe(identity.name)
      store.assign(session, [], caller)
      expect(store.allow(target, { session }, caller).changed).toEqual([`session ${session}`])
      expect(store.show(target, { ...hunter, session }).name).toBe(identity.name)
      // A test login that names its roles: the coordinator can name the hunter's too.
      store.grant(identity.name, 'role', '*', false, owner)
      expect(() => store.show(target, { ...hunter, session })).toThrow('role hunting')
      store.grant(identity.name, 'role', 'hunting', true, caller)
      expect(store.show(target, { ...hunter, session }).name).toBe(identity.name)
    }
  })
  it('a coordinator cannot hand a hunter role an unmarked account', () => {
    const named = account()
    expect(() => store.grant(named.name, 'role', 'hunting', true, coordinator)).toThrow(
      "does not use the owner's real accounts",
    )
    expect(() => store.allow('canvas-pcsb', { role: 'hunting' }, coordinator)).toThrow(
      "does not use the owner's real accounts",
    )
    expect(() => store.allow('canvas-pcsb', { role: 'hunting' }, coordinator)).toThrow('test login')
  })
  it('a restricted role never counts as a coordinator, flag or no flag', () => {
    testLogin('shop-local')
    const flagged = { ...hunter, coordinator: true }
    expect(() => store.assign('hunt-one', ['shop-local'], flagged)).toThrow('Only a coordinator')
    expect(() => store.assignments(flagged)).toThrow('Only a coordinator')
    expect(() => store.allow('shop-local', { session: 'other' }, flagged)).toThrow('coordinator')
    const plain = { ...agent, coordinator: false }
    expect(() => store.assign('hunt-one', ['shop-local'], plain)).toThrow('Only a coordinator')
  })
  it('the command line refuses an agent the mark, and asks Tether who coordinates', async () => {
    account()
    const lines: string[] = []
    const io = (caller: LoginCaller, coordinates: LoginsIo['coordinates'] = () => false) => ({
      out: () => {},
      err: (text: string) => void lines.push(text),
      caller,
      coordinates,
    })
    expect(await runLogins(['hunters-ok', 'canvas-pcsb', 'on'], env, io(agent))).toBe(1)
    expect(lines.at(-1)).toContain('Only the owner')
    expect(store.show('canvas-pcsb', owner).lab?.huntersOk).toBeUndefined()
    expect(await runLogins(['hunters-ok', 'canvas-pcsb', 'maybe'], env, io(owner))).toBe(1)
    expect(await runLogins(['hunters-ok', 'canvas-pcsb', 'on'], env, io(owner))).toBe(0)
    expect(store.show('canvas-pcsb', owner).lab?.huntersOk).toBe(true)
    testLogin('shop-local')
    const assign = ['assign', 'hunt-one', '--target', 'shop-local']
    expect(await runLogins(assign, env, io(agent))).toBe(1)
    expect(lines.at(-1)).toContain('Only a coordinator')
    const asked = vi.fn<LoginsIo['coordinates']>(() => true)
    expect(await runLogins(assign, env, io(agent, asked))).toBe(0)
    expect(asked).toHaveBeenCalledWith('a1b2c3d4', env)
    expect(store.assignments(owner)['hunt-one']).toEqual(['shop-local'])
    // Tether's flag does nothing for a restricted role.
    expect(
      await runLogins(
        ['unassign', 'hunt-one'],
        env,
        io(hunter, () => true),
      ),
    ).toBe(1)
    // Plain self-service doesn't ask Tether at all.
    const unasked = vi.fn<LoginsIo['coordinates']>(() => true)
    expect(await runLogins(['allow', 'canvas-pcsb'], env, io(agent, unasked))).toBe(0)
    expect(unasked).not.toHaveBeenCalled()
  })
  it('regular agent fixes stay unblocked', () => {
    const identity = account()
    store.grant(identity.name, 'role', '*', false, owner)
    store.grant(identity.name, 'machine', loginMachine(), false, owner)
    expect(store.allow('canvas-pcsb', {}, agent).changed.length).toBe(3)
    expect(store.edit('canvas-pcsb', { notes: 'fixed' }, agent).notes).toBe('fixed')
    expect(
      store.edit('canvas-pcsb', { login_url: 'https://other.example.test/' }, agent).lab?.login_url,
    ).toBe('https://other.example.test/')
    store.grant(identity.name, 'role', 'review', true, agent)
    expect(store.show('canvas-pcsb', agent).name).toBe(identity.name)
  })
  it('hunters are told to ask their coordinator; only a missing key or a bad secret goes to the owner', () => {
    const identity = account()
    store.huntersOk('canvas-pcsb', true, owner)
    expect(() => store.allow('canvas-pcsb', {}, hunter)).toThrow(
      'Ask your coordinator, never the owner',
    )
    expect(() => store.edit('canvas-pcsb', { notes: 'x' }, hunter)).toThrow(
      'Ask your coordinator, never the owner',
    )
    store.set('sample', 'fixture-private-value', {}, owner)
    expect(() => store.grant('sample', 'role', 'review', true, agent)).toThrow(
      "Ask the owner only if a key you need doesn't exist yet",
    )
    expect(store.show('canvas-pcsb', agent).name).toBe(identity.name)
  })
})
it('lets any agent give itself what is missing, logged on the login with who and what', () => {
  const identity = account()
  store.grant(identity.name, 'role', '*', false, owner)
  store.grant(identity.name, 'machine', loginMachine(), false, owner)
  const agent = { role: 'school-check', machine: loginMachine(), session: 'a1b2c3d4' }
  expect(store.allow('canvas-pcsb', {}, agent)).toEqual({
    name: 'canvas-pcsb',
    changed: [`machine ${loginMachine()}`, 'session a1b2c3d4', 'role school-check'],
  })
  expect(store.show('canvas-pcsb', agent).name).toBe(identity.name)
  expect(store.allow('canvas-pcsb', {}, agent).changed).toEqual([])
  // A job without a session gets its role named; a role subject works the same for another role.
  expect(store.allow('canvas-pcsb', { role: 'nightly' }, agent).changed).toEqual(['role nightly'])
  expect(store.audit(owner)).toContainEqual(
    expect.objectContaining({
      action: 'allow',
      name: identity.name,
      actor: 'a1b2c3d4',
      detail: `machine ${loginMachine()}, session a1b2c3d4, role school-check`,
    }),
  )
  // Restricted roles keep coordinator-given access only; no one but the owner removes a login.
  expect(() => store.allow('canvas-pcsb', {}, hunter)).toThrow('coordinator')
  expect(() => store.grant(identity.name, 'role', 'hunting', true, hunter)).toThrow('coordinator')
  expect(() => store.remove(identity.name, agent, true)).toThrow('owner')
  store.grant(identity.name, 'role', 'review', true, agent)
  expect(store.audit(owner).at(-1)).toMatchObject({ action: 'grant', detail: 'role review' })
})
it('lets any agent fix notes, the login page and the site name, never the password', () => {
  const identity = account()
  const agent = { role: 'school-check', machine: loginMachine(), session: 'a1b2c3d4' }
  store.assign('a1b2c3d4', ['canvas-pcsb', 'other'], owner)
  const edited = store.edit(
    'canvas-pcsb',
    { notes: 'Dadbot school check', login_url: 'https://canvas.example.test/login/canvas' },
    agent,
  )
  expect(edited.notes).toBe('Dadbot school check')
  expect(edited.lab?.login_url).toBe('https://canvas.example.test/login/canvas')
  expect(JSON.parse(store.value(identity.name, owner).toString()).values).toEqual({
    username: 'me@example.test',
    password: 'fixture-password',
    login_url: 'https://canvas.example.test/login/canvas',
  })
  // Another site too, shown in its activity with the old and new page.
  expect(
    store.edit('canvas-pcsb', { login_url: 'https://lms.example.test/login' }, agent).lab
      ?.login_url,
  ).toBe('https://lms.example.test/login')
  expect(store.audit(owner).at(-1)?.detail).toContain(
    'login page https://canvas.example.test/login/canvas to https://lms.example.test/login',
  )
  store.edit('canvas-pcsb', { login_url: 'https://canvas.example.test/login/canvas' }, agent)
  expect(() =>
    store.edit('canvas-pcsb', { login_url: 'http://canvas.example.test/' }, agent),
  ).toThrow('https')
  const renamed = store.edit('canvas-pcsb', { target: 'canvas' }, agent)
  expect(renamed.name).toBe(labIdentity('canvas', 'default').name)
  expect(existsSync(join(store.folder, identity.name))).toBe(false)
  expect(store.assignments(owner).a1b2c3d4).toEqual(['canvas', 'other'])
  expect(JSON.parse(store.value(renamed.name, owner).toString()).reference).toBe(
    'secret://lab/canvas/default',
  )
  expect(
    store
      .audit(owner)
      .filter((e) => e.action === 'edit')
      .map((e) => e.detail),
  ).toEqual([
    'notes, login page https://canvas.example.test/ to https://canvas.example.test/login/canvas',
    'login page https://canvas.example.test/login/canvas to https://lms.example.test/login',
    'login page https://lms.example.test/login to https://canvas.example.test/login/canvas',
    'site name canvas-pcsb to canvas',
  ])
  expect(JSON.stringify(store.audit(owner))).not.toContain('fixture-password')
  expect(() => store.edit('canvas', { notes: 'x' }, hunter)).toThrow('coordinator')
})
it('keeps hunters and other sessions a coordinator call, and the saved site the owner one', () => {
  const identity = account()
  const agent = { role: 'school-check', machine: loginMachine(), session: 'a1b2c3d4' }
  const coordinator = { role: 'coordinator', machine: loginMachine(), session: 'coord-one' }
  expect(() => store.allow('canvas-pcsb', { role: 'hunting' }, agent)).toThrow('coordinator')
  expect(() => store.grant(identity.name, 'role', 'recon', true, agent)).toThrow('coordinator')
  expect(() => store.allow('canvas-pcsb', { session: 'hunt-one' }, agent)).toThrow(
    'another session',
  )
  expect(() => store.assign('hunt-one', ['canvas-pcsb'], agent)).toThrow('coordinator')
  expect(store.allow('canvas-pcsb', { session: 'hunt-one' }, coordinator).changed).toEqual([
    'session hunt-one',
  ])
  // A hunter is pointed at its coordinator, not at a command that refuses it.
  store.assign('hunt-one', [], owner)
  store.huntersOk('canvas-pcsb', true, owner)
  expect(() => store.show('canvas-pcsb', hunter)).toThrow(
    'Ask your coordinator, never the owner. A coordinator runs: aico logins assign hunt-one --target canvas-pcsb',
  )
  // An agent never changes an account login's username, password or site through the lab patch.
  expect(() =>
    store.patchLab('canvas-pcsb', 'default', { set: { password: 'other-password' } }, agent),
  ).toThrow("owner's")
  expect(() => store.patchLab('canvas-pcsb', 'default', { remove: ['login_url'] }, agent)).toThrow(
    "owner's",
  )
})
it("shows the new login page however long the old one, and an account's first one", () => {
  account()
  const agent = { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' }
  store.allow('canvas-pcsb', {}, agent)
  store.edit(
    'canvas-pcsb',
    { login_url: `https://canvas.example.test/?x=${'y'.repeat(700)}` },
    agent,
  )
  store.edit('canvas-pcsb', { login_url: 'https://lms.example.test/login' }, agent)
  expect(store.audit(owner).at(-1)?.detail).toContain('to https://lms.example.test/login')
  store.patchLab('canvas-pcsb', 'default', { remove: ['login_url'] }, owner)
  expect(
    store.edit('canvas-pcsb', { login_url: 'https://lms.example.test/login' }, agent).lab
      ?.login_url,
  ).toBe('https://lms.example.test/login')
  expect(store.audit(owner).at(-1)?.detail).toBe(
    'login page none to https://lms.example.test/login',
  )
})
it('a rename keeps the old site for sessions while another login uses it; long details are cut', () => {
  account('school')
  const teacher = lab('school', 'teacher')
  store.set(teacher.identity.name, teacher.value, teacher.metadata, owner)
  store.assign('a1b2c3d4', ['school'], owner)
  const agent = { role: 'school-check', machine: loginMachine(), session: 'a1b2c3d4' }
  store.edit(teacher.identity.name, { target: 'school2' }, agent)
  expect(store.assignments(owner).a1b2c3d4).toEqual(['school', 'school2'])
  store.edit('school', { login_url: `https://canvas.example.test/${'a'.repeat(700)}` }, agent)
  expect(store.audit(owner).at(-1)?.detail?.length).toBeLessThanOrEqual(600)
  const peer = new LoginStore({ HOME: join(home, 'peer') })
  peer.list()
  expect(peer.mergeSnapshot(store.snapshot(loginMachine(), true))).toBe(true)
  // Removing by site name removes that login, not a name that is not there.
  store.remove('school', owner, true)
  expect(store.list(owner).map((e) => e.name)).toEqual([labIdentity('school2', 'teacher').name])
})
it('an unrestricted session that saves a new lab login gets its target, logged', () => {
  const one = lab('school')
  const agent = { role: 'implementation', machine: loginMachine(), session: 'a1b2c3d4' }
  store.set(one.identity.name, one.value, one.metadata, agent)
  expect(store.assignments(owner).a1b2c3d4).toEqual(['school'])
  expect(store.audit(owner)).toContainEqual(
    expect.objectContaining({ action: 'allow', detail: 'session a1b2c3d4' }),
  )
})
it('CLI allow and edit print what changed; list shows unusable logins to agents', async () => {
  const identity = account()
  store.grant(identity.name, 'role', '*', false, owner)
  const out = vi.fn(),
    err = vi.fn(),
    probe = vi.fn(async () => ({ warning: 'No password field at https://canvas.example.test/.' }))
  const io = {
    caller: { role: 'school-check', machine: loginMachine(), session: 'a1b2c3d4' },
    out,
    err,
    execute: vi.fn<LoginsIo['execute']>(async () => 0),
    input: async () => '',
    outputSafe: () => false,
    probe,
  }
  expect(await runLogins(['list'], env, io)).toBe(0)
  expect(out.mock.calls[0][0]).toContain('  lab login  aico logins allow canvas-pcsb\n')
  out.mockClear()
  for (const args of [
    ['list', '--json'],
    ['list', 'CANVAS'],
  ]) {
    expect(await runLogins(args, env, io)).toBe(0)
    expect(JSON.parse(out.mock.calls.at(-1)?.[0])[0]).toMatchObject({
      fix: 'aico logins allow canvas-pcsb',
    })
  }
  expect(await runLogins(['list', 'nothing-like-it'], env, io)).toBe(0)
  expect(JSON.parse(out.mock.calls.at(-1)?.[0])).toEqual([])
  out.mockClear()
  expect(await runLogins(['allow', 'canvas-pcsb'], env, io)).toBe(0)
  expect(err.mock.calls.at(-1)?.[0]).toBe(
    'Allowed session a1b2c3d4, role school-check for canvas-pcsb; logged in its activity. Say so in your report.\n',
  )
  expect(
    await runLogins(
      ['edit', 'canvas-pcsb', '--login-url', 'https://canvas.example.test/'],
      env,
      io,
    ),
  ).toBe(0)
  expect(probe).toHaveBeenCalledWith('https://canvas.example.test/')
  expect(err.mock.calls.at(-1)?.[0]).toBe('No password field at https://canvas.example.test/.\n')
  expect(JSON.stringify([...out.mock.calls, ...err.mock.calls])).not.toContain('fixture-password')
})

it('guesses a public key as a backup key, and list and show agree a login with no value is not usable', async () => {
  writeFileSync(join(store.folder, 'backup-append.ed25519.pub'), 'public', { mode: 0o600 })
  store.discover()
  expect(store.list(owner).find((entry) => entry.name === 'backup-append.ed25519.pub')?.kind).toBe(
    'backup key',
  )
  rmSync(join(store.folder, 'backup-append.ed25519.pub'))
  const out = vi.fn()
  const io = {
    caller: owner,
    out,
    err: vi.fn(),
    execute: vi.fn<LoginsIo['execute']>(async () => 0),
    input: async () => '',
    outputSafe: () => false,
  }
  expect(await runLogins(['list'], env, io)).toBe(0)
  expect(out.mock.calls.flat().join('')).toContain(
    'backup-append.ed25519.pub  backup key  Unavailable',
  )
  out.mockClear()
  expect(await runLogins(['show', 'backup-append.ed25519.pub'], env, io)).toBe(0)
  expect(JSON.parse(out.mock.calls.flat().join(''))).toMatchObject({
    state: 'Unavailable',
    usable: false,
  })
})

it('leaves backup keys, API keys, passwords and tool logins to the owner', () => {
  store.set('key', 'value', { kind: 'backup key', machines: ['elsewhere'], roles: ['job'] }, owner)
  const agent = { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' }
  for (const change of [
    () => store.allow('key', {}, agent),
    () => store.allow('key', { machine: 'other' }, agent),
    () => store.grant('key', 'machine', 'other', true, agent),
    () => store.grant('key', 'machine', 'elsewhere', false, agent),
    () => store.grant('key', 'role', 'job', false, agent),
    () => store.edit('key', { notes: 'x' }, agent),
    () => store.edit('key', { kind: 'password' }, agent),
  ])
    expect(change).toThrow(/only the owner changes it, on the Logins page/)
  expect(store.list().find((entry) => entry.name === 'key')).toMatchObject({
    machines: ['elsewhere'],
    roles: ['job'],
    kind: 'backup key',
  })
  // The list says who fixes it, and so does a refusal to use it.
  expect(store.catalog(agent).find((entry) => entry.name === 'key')).toMatchObject({
    available: false,
    fix: expect.stringContaining('only the owner changes it'),
  })
  expect(() => store.value('key', agent)).toThrow(/only the owner changes it/)
  // The owner still can.
  expect(store.grant('key', 'machine', 'other', true, owner).machines).toContain('other')
  expect(store.edit('key', { notes: 'y' }, owner).notes).toBe('y')
})

it('leaves saving and replacing anything but a site login to the owner', () => {
  store.set('key', 'value', { kind: 'API key', roles: ['job'] }, owner)
  const agent = { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' }
  for (const save of [
    () => store.set('key', 'other', { notes: 'x' }, agent, true),
    () => store.set('new-key', 'value', {}, agent),
    () => store.set('key', 'other', { lab: lab('x', 'y').metadata.lab }, agent, true),
  ])
    expect(save).toThrow(/only the owner changes it/)
  expect(store.list().find((entry) => entry.name === 'new-key')).toBeUndefined()
})

it("keeps an account login's username, password and login page out of an agent's replace", () => {
  const { name } = labIdentity('site-a', 'default')
  const bundle = (values: Record<string, string>) =>
    JSON.stringify({
      schema_version: 1,
      reference: labIdentity('site-a', 'default').reference,
      kind: 'account',
      expires_at: null,
      values,
    })
  const saved = { username: 'u', password: 'p', login_url: 'https://site-a.test/login' }
  const metadata = {
    kind: 'lab login' as const,
    lab: { target: 'site-a', actor: 'default', kind: 'account', expires_at: null, fields: [] },
    roles: ['*'],
  }
  const agent = { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' }
  // Saving one is the owner's too.
  expect(() => store.set(name, bundle(saved), metadata, agent)).toThrow(/are the owner's/)
  store.set(name, bundle(saved), metadata, owner)
  for (const changed of [
    { ...saved, username: 'other' },
    { ...saved, password: 'other' },
    { ...saved, login_url: 'https://elsewhere.test/login' },
  ])
    expect(() => store.set(name, bundle(changed), {}, agent, true)).toThrow(/are the owner's/)
  // Its other fields stay an agent's to fix.
  expect(store.set(name, bundle({ ...saved, totp_secret: 'x' }), {}, agent, true).name).toBe(name)
})

it("lets a tool save and refresh its own grant, and no other tool's", () => {
  const agent = { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' }
  const saved = store.set('cloudflare-mcp-oauth', '{"a":1}', { kind: 'tool login' }, agent)
  expect(saved.name).toBe('cloudflare-mcp-oauth')
  store.grant('cloudflare-mcp-oauth', 'role', 'job', true, owner)
  expect(store.set('cloudflare-mcp-oauth', '{"a":2}', {}, agent, true).name).toBe(
    'cloudflare-mcp-oauth',
  )
  expect(() =>
    store.set('cloudflare-mcp-oauth', '{"a":3}', { provider: 'claude-code' }, agent, true),
  ).toThrow(/not a site login/)
  expect(() =>
    store.set('cloudflare-mcp-oauth', '{"a":3}', {}, { ...agent, role: 'hunting' }, true),
  ).toThrow()
})

it('a key named like a site does not hide the site login from an agent', () => {
  const { identity, value, metadata } = lab('canvas', 'default')
  store.set(identity.name, value, { ...metadata, roles: ['someone-else'] }, owner)
  store.set('canvas', 'value', { kind: 'API key' }, owner)
  const agent = { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' }
  expect(store.edit('canvas', { notes: 'fixed' }, agent)).toMatchObject({
    name: identity.name,
    notes: 'fixed',
  })
  expect(store.details('canvas', { ...agent, role: 'someone-else' }).name).toBe(identity.name)
})

it('an agent does not shut a restricted role out of a login', () => {
  const { identity, value, metadata } = lab('site-b', 'default')
  store.set(identity.name, value, metadata, owner)
  const agent = { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' }
  expect(() => store.grant(identity.name, 'role', 'hunting', false, agent)).toThrow(/coordinator/)
})

it('edit by a caller the login is not open to still prints the fix', async () => {
  const { identity, value, metadata } = lab('shut', 'default')
  store.set(identity.name, value, { ...metadata, roles: ['someone-else'] }, owner)
  const out = vi.fn()
  const code = await runLogins(['edit', 'shut', '--notes', 'fixed'], env, {
    caller: { role: 'job', machine: loginMachine(), session: 'a1b2c3d4' },
    out,
    err: vi.fn(),
    execute: vi.fn<LoginsIo['execute']>(async () => 0),
    input: async () => '',
    outputSafe: () => false,
  })
  expect(code).toBe(0)
  expect(JSON.parse(out.mock.calls.flat().join(''))).toMatchObject({
    name: identity.name,
    notes: 'fixed',
  })
})
