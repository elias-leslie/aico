import { expect, it, vi } from 'vitest'
import { holdsBackupLock, stopReadsFailed } from './backups'

it('a backup run that gets stopped exits non-zero instead of reading as finished', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  stopReadsFailed()
  process.emit('SIGINT')
  expect(exit).toHaveBeenCalledWith(130)
  exit.mockRestore()
})

it('a restore does not wait on a running backup: only a backup run holds the lock', () => {
  expect(holdsBackupLock('run')).toBe(true)
  for (const verb of ['restore', 'browse', 'snapshots', 'list']) {
    expect(holdsBackupLock(verb)).toBe(false)
  }
})
