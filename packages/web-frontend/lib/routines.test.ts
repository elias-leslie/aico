import { describe, expect, it } from 'vitest'
import { type Routine, soonIn } from './routines'

const routine = {} as Routine
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime()

describe('soonIn', () => {
  const now = at(8, 4, 50) // Sunday

  it('gives a run due later today as just its time', () => {
    expect(soonIn(routine, at(8, 23, 15), now)).toMatch(/^11:15\sPM$/)
  })

  it('names the day for every run due tomorrow, even one more than 24 hours off', () => {
    expect(soonIn(routine, at(9, 3, 30), now)).toMatch(/^Mon 3:30\sAM$/)
    expect(soonIn(routine, at(9, 6, 30), now)).toMatch(/^Mon 6:30\sAM$/)
  })

  it('gives a later run its date', () => {
    expect(soonIn(routine, at(10, 1, 0), now)).toMatch(/^Nov 10/)
  })
})
