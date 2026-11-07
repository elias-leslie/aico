import { afterEach, expect, it } from 'vitest'
import { localClock, localTime } from './time'

const zone = process.env.TZ
afterEach(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

it('writes local time with its zone, following TZ', () => {
  process.env.TZ = 'America/New_York'
  expect(localTime('2026-11-07T03:28:50.155Z')).toBe('Nov 6, 10:28 PM EST')
  expect(localClock(Date.parse('2026-11-07T03:28:50Z'))).toBe('10:28 PM EST')
  process.env.TZ = 'UTC'
  expect(localTime('2026-11-07T03:28:50.155Z')).toBe('Nov 7, 3:28 AM UTC')
})
