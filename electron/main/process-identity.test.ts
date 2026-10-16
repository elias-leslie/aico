import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ownStartTime, parseStartTime } from './process-identity'

describe('parseStartTime', () => {
  it('reads field 22 past a command name holding spaces and parentheses', () => {
    const rest = Array.from({ length: 50 }, (_, i) => String(i + 3))
    rest[19] = '987654'
    expect(parseStartTime(`1234 (we ird) (x)) ${rest.join(' ')}\n`)).toBe('987654')
  })

  it('refuses a line without the field', () => {
    expect(parseStartTime('1234 (short) S 1 2')).toBeNull()
    expect(parseStartTime('garbage')).toBeNull()
  })
})

describe('ownStartTime', () => {
  it('matches what another reader sees in /proc/<pid>/stat', () => {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    const expected = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    expect(ownStartTime()).toBe(expected)
  })
})
