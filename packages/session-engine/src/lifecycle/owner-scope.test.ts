import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(mocks.execFile, { [promisify.custom]: mocks.execFile }) }
})
vi.mock('node:fs', () => ({
  readFileSync: mocks.readFileSync,
  statSync: mocks.statSync,
  writeFileSync: mocks.writeFileSync,
}))

import { stopOwnedPaneScope } from './owner-scope'

const unit = 'tmux-spawn-00000000-0000-4000-8000-000000000001.scope'
const invocation = 'a'.repeat(32)
const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`

beforeEach(() => {
  vi.resetAllMocks()
  mocks.execFile.mockResolvedValue({
    stdout: `LoadState=loaded\nActiveState=inactive\nControlGroup=${group}\nInvocationID=${invocation}\nJob=\n`,
  })
  mocks.statSync.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' })
  })
  mocks.readFileSync.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' })
  })
})

it('finishes retirement when systemd still reports an owned scope whose cgroup is already gone', async () => {
  expect(await stopOwnedPaneScope(unit, invocation, 'test retirement')).toBe(true)
  expect(mocks.execFile).toHaveBeenCalledTimes(1)
  expect(mocks.writeFileSync).not.toHaveBeenCalled()
})

it('keeps unverifiable cgroups and changed invocations blocked', async () => {
  mocks.readFileSync.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  })
  expect(await stopOwnedPaneScope(unit, invocation, 'test retirement')).toBe(false)
  expect(await stopOwnedPaneScope(unit, 'b'.repeat(32), 'test retirement')).toBe(false)
  expect(mocks.writeFileSync).not.toHaveBeenCalled()
})
