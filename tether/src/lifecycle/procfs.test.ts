import { describe, expect, it } from 'vitest'
import {
  processControlGroup,
  processEnvironment,
  processInControlGroup,
  processStartTime,
  processStartTimeFromStat,
} from './procfs'

describe('procfs readers', () => {
  it('reads starttime past a command name with spaces and parens', () => {
    // Fields after "(comm) ": state is field 3, starttime is field 22.
    const after = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), '987654', '23']
    expect(processStartTimeFromStat(`42 (evil) name) ${after.join(' ')}`)).toBe('987654')
    expect(processStartTimeFromStat('42 (short) S 1')).toBeNull()
  })

  it.runIf(process.platform === 'linux')('reads this process', () => {
    expect(processEnvironment(process.pid)?.get('PATH')).toBe(process.env.PATH)
    expect(processStartTime(process.pid)).toMatch(/^\d+$/)
    const group = processControlGroup(process.pid)
    expect(group).toMatch(/^\//)
    expect(processInControlGroup(process.pid, group as string)).toBe(true)
    expect(processInControlGroup(process.pid, '/not/this/group')).toBe(false)
  })

  it('answers null or false for a process that does not exist', () => {
    expect(processEnvironment(-1)).toBeNull()
    expect(processStartTime(-1)).toBeNull()
    expect(processInControlGroup(-1, '/')).toBe(false)
  })
})
