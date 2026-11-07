import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { LoginStore } from './logins'
import { loginCaller } from './logins-cli'
import {
  forgetLogin,
  loadToolSecrets,
  parseToolSecrets,
  privateFile,
  receiveLogins,
  secretsDir,
  toolEnvironment,
  writePrivate,
} from './secrets'

// A file-based tool login for the auth-file tests; no built-in login uses one today.
vi.mock('./static-logins.json', () => ({
  default: [
    { tool: 'claude-code', name: 'oauth-token', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
    { tool: 'pi', name: 'opencode-go', envVar: 'OPENCODE_API_KEY' },
    { tool: 'st', name: 'sample-agent-token', authFile: '.config/agent-tokens/sample' },
  ],
}))

let home: string
let env: NodeJS.ProcessEnv
const entry = {
  tool: 'claude-code',
  name: 'oauth-token',
  file: 'host-tool-claude-code-oauth-token',
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aico-secrets-'))
  // This fixture owns its caller; do not inherit the harness's verification or hunting role.
  env = { HOME: home, AICO_WIDGET_ID: 'fixture-session', ST_WORK_ROLE: 'agent' }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
it('stores pushed logins privately and supplies them to the tool environment without changing the parent', () => {
  expect(
    receiveLogins(
      JSON.stringify({ entries: [{ ...entry, value: 'fixture-login' }], tools: ['claude-code'] }),
      env,
    ),
  ).toEqual([entry.file])
  const path = join(secretsDir(env), entry.file)
  expect(lstatSync(path).mode & 0o777).toBe(0o600)
  expect(lstatSync(secretsDir(env)).mode & 0o777).toBe(0o700)
  expect(toolEnvironment('claude-code', env).CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-login')
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  expect(loadToolSecrets(env)).toEqual([entry])
  expect(JSON.stringify(loadToolSecrets(env))).not.toContain('fixture-login')
})
it('writes an auth file as 0600 and removes a revoked login on the next push', () => {
  const file = {
    tool: 'st',
    name: 'sample-agent-token',
    file: 'host-tool-st-sample-agent-token',
    authFile: '.config/agent-tokens/sample',
    value: 'fixture-auth',
  }
  mkdirSync(join(home, '.config/agent-tokens'), { recursive: true, mode: 0o755 })
  chmodSync(join(home, '.config/agent-tokens'), 0o755)
  receiveLogins(JSON.stringify({ entries: [file], tools: ['st'] }), env)
  expect(lstatSync(join(home, '.config/agent-tokens/sample')).mode & 0o777).toBe(0o600)
  receiveLogins(JSON.stringify({ entries: [], tools: [] }), env)
  expect(existsSync(join(home, '.config/agent-tokens/sample'))).toBe(false)
  expect(loadToolSecrets(env)).toEqual([])
})
it('rejects traversal, malformed or ungranted deliveries without echoing secret input', () => {
  expect(() => parseToolSecrets([{ ...entry, file: '../outside' }])).toThrow()
  expect(() => receiveLogins('{fixture-secret', env)).toThrow('Invalid tool login delivery')
  expect(() =>
    receiveLogins(
      JSON.stringify({ entries: [{ ...entry, value: 'fixture-secret' }], tools: [] }),
      env,
    ),
  ).toThrow('Invalid tool login delivery')
  expect(existsSync(secretsDir(env))).toBe(false)
})
it('refuses readable or symlinked source secrets', () => {
  const path = join(home, 'private')
  writePrivate(path, 'fixture-login')
  chmodSync(path, 0o644)
  expect(() => privateFile(path)).toThrow('0600')
  chmodSync(path, 0o600)
  symlinkSync(path, join(home, 'link'))
  expect(() => privateFile(join(home, 'link'))).toThrow('0600')
  forgetLogin('unknown', env)
})
it('keeps permitted Pi tool sign-in available to hunters while raw login retrieval stays scoped', () => {
  receiveLogins(
    JSON.stringify({
      tools: ['pi'],
      entries: [
        {
          tool: 'pi',
          name: 'opencode-go',
          file: 'opencode-go',
          envVar: 'OPENCODE_API_KEY',
          value: 'fixture-private-value',
        },
      ],
    }),
    env,
  )
  for (const role of ['hunting', 'recon', 'verification']) {
    const roleEnv = { ...env, ST_WORK_ROLE: role }
    expect(toolEnvironment('pi', roleEnv).OPENCODE_API_KEY).toBe('fixture-private-value')
    expect(new LoginStore(env).list(loginCaller(roleEnv))).toEqual([])
    expect(() => new LoginStore(env).value('opencode-go', loginCaller(roleEnv))).toThrow(
      'unavailable',
    )
  }
  receiveLogins(
    JSON.stringify({
      tools: ['pi', 'claude-code'],
      entries: [{ ...entry, value: 'fixture-claude' }],
    }),
    env,
  )
  expect(() => toolEnvironment('claude-code', { ...env, ST_WORK_ROLE: 'hunting' })).toThrow(
    'unavailable',
  )
})

it('gives a tool variable the key from an imported wrapper, not the wrapper JSON', () => {
  const wrapped = JSON.stringify({ schema_version: 1, value: 'fixture-key', expires_at: null })
  receiveLogins(
    JSON.stringify({
      tools: ['pi'],
      entries: [
        {
          tool: 'pi',
          name: 'opencode-go',
          file: 'opencode-go',
          envVar: 'OPENCODE_API_KEY',
          value: wrapped,
        },
      ],
    }),
    env,
  )
  expect(toolEnvironment('pi', env).OPENCODE_API_KEY).toBe('fixture-key')
})
it('refuses rotating logins and a static entry pointing at an arbitrary auth file', () => {
  for (const entry of [
    { tool: 'codex', name: 'login', file: 'codex', authFile: '.codex/auth.json' },
    { tool: 'pi', name: 'oauth', file: 'pi', authFile: '.pi/agent/auth.json' },
    { tool: 'st', name: 'sample-agent-token', file: 'st', authFile: '.ssh/authorized_keys' },
  ]) {
    expect(() => parseToolSecrets([entry])).toThrow('Invalid tool login map')
    expect(() =>
      receiveLogins(
        JSON.stringify({ entries: [{ ...entry, value: 'fixture' }], tools: [entry.tool] }),
        env,
      ),
    ).toThrow('Invalid tool login map')
  }
})
it.skipIf(process.getuid?.() === 0)(
  'records destinations before a partial delivery, so revocation removes written files',
  () => {
    const folder = join(home, '.config/agent-tokens')
    mkdirSync(folder, { recursive: true, mode: 0o755 })
    chmodSync(folder, 0o555)
    const entry = {
      tool: 'st',
      name: 'sample-agent-token',
      file: 'host-tool-st',
      authFile: '.config/agent-tokens/sample',
      value: 'fixture',
    }
    try {
      expect(() =>
        receiveLogins(JSON.stringify({ entries: [entry], tools: ['st'] }), env),
      ).toThrow()
      expect(loadToolSecrets(env)).toMatchObject([{ tool: 'st', file: entry.file }])
      expect(existsSync(join(secretsDir(env), entry.file))).toBe(true)
    } finally {
      chmodSync(folder, 0o755)
    }
    forgetLogin('st', env)
    expect(existsSync(join(secretsDir(env), entry.file))).toBe(false)
  },
)
