import { describe, expect, it } from 'vitest'
import { type Routine, scheduleText, soonIn } from './routines'

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

describe('scheduleText', () => {
  // Kiritimati is +14 and no viewer's test zone: 05:15 there is 15:15 UTC the day before.
  const schedule = {
    schedule: 'sundays at 05:15',
    tz: 'Pacific/Kiritimati',
  } as Routine
  const here = (utc: string) =>
    new Date(utc).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })

  it('gives the scheduled time here, not the next run a random delay moved', () => {
    const delayed = Date.parse('2026-11-14T15:38:00Z')
    expect(scheduleText({ ...schedule, nextRun: delayed })).toContain(
      `(${here('2026-11-14T15:15:00Z')} here)`,
    )
  })

  it('counts a delay across midnight the short way', () => {
    const delayed = Date.parse('2026-11-14T10:10:00Z') // 00:10 there
    expect(
      scheduleText({
        ...schedule,
        schedule: 'daily at 23:50',
        nextRun: delayed,
      }),
    ).toContain(`(${here('2026-11-14T09:50:00Z')} here)`)
  })
})
