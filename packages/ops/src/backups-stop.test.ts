import { expect, it, vi } from 'vitest'
import { stopReadsFailed } from './backups'

it('a backup run that gets stopped exits non-zero instead of reading as finished', () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  stopReadsFailed()
  process.emit('SIGINT')
  expect(exit).toHaveBeenCalledWith(130)
  exit.mockRestore()
})
