import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
  env = { HOME: home }
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
    tool: 'codex',
    name: 'login',
    file: 'host-tool-codex-login',
    authFile: '.codex/auth.json',
    value: 'fixture-auth',
  }
  receiveLogins(JSON.stringify({ entries: [file], tools: ['codex'] }), env)
  expect(lstatSync(join(home, '.codex/auth.json')).mode & 0o777).toBe(0o600)
  receiveLogins(JSON.stringify({ entries: [], tools: [] }), env)
  expect(existsSync(join(home, '.codex/auth.json'))).toBe(false)
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
