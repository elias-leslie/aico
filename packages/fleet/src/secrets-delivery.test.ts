import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { pushToolLogins, secretsDir, toolLoginsFile, writePrivate } from './secrets'
import type { FleetSettings } from './settings'

const mocks = vi.hoisted(() => ({ pins: vi.fn(), exec: vi.fn() }))
vi.mock('./trust', () => ({ readPins: mocks.pins }))
vi.mock('./exec', () => ({ requestExec: mocks.exec }))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})
it('refuses unpinned machines and worker senders without reading or sending values', async () => {
  const settings = {
    machine: 'source',
    allowlist: '/pins',
    peerRoot: '/peers',
    peers: [{ name: 'worker', tools: ['pi'] }],
  } as FleetSettings
  mocks.pins.mockReturnValue([
    { name: 'source', role: 'worker' },
    { name: 'worker', role: 'worker' },
  ])
  await expect(pushToolLogins(settings, 'worker')).rejects.toThrow('full peer')
  mocks.pins.mockReturnValue([{ name: 'source', role: 'full' }])
  await expect(pushToolLogins(settings, 'worker')).rejects.toThrow('approved')
  expect(mocks.exec).not.toHaveBeenCalled()
})
it('refuses a rotating source entry before any request, while a static login is sent only through stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-login-send-'))
  dirs.push(dir)
  const env = { HOME: dir }
  const settings = {
    machine: 'source',
    allowlist: '/pins',
    peerRoot: '/peers',
    peers: [{ name: 'worker', tools: ['pi'] }],
  } as FleetSettings
  mocks.pins.mockReturnValue([
    { name: 'source', role: 'full' },
    { name: 'worker', role: 'worker' },
  ])
  mocks.exec.mockResolvedValue({ code: 0, stdout: 'written', output: '' })
  writePrivate(
    toolLoginsFile(env),
    JSON.stringify([{ tool: 'pi', name: 'oauth', file: 'oauth', authFile: '.pi/agent/auth.json' }]),
  )
  await expect(pushToolLogins(settings, 'worker', undefined, env)).rejects.toThrow('tool login map')
  expect(mocks.exec).not.toHaveBeenCalled()
  const entry = { tool: 'pi', name: 'opencode-go', file: 'opencode-go', envVar: 'OPENCODE_API_KEY' }
  writePrivate(toolLoginsFile(env), JSON.stringify([entry]))
  writePrivate(join(secretsDir(env), entry.file), 'fixture-static-login')
  await pushToolLogins(settings, 'worker', undefined, env)
  const [socket, argv, body] = mocks.exec.mock.calls[0] as [string, string[], Buffer]
  expect(socket).toBe('/peers/worker/exec.sock')
  expect(JSON.stringify(argv)).not.toContain('fixture-static-login')
  expect(JSON.parse(body.toString())).toMatchObject({
    entries: [{ ...entry, value: 'fixture-static-login' }],
    tools: ['pi'],
  })
})
