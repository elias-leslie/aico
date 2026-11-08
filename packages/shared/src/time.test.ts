import { afterEach, expect, it } from 'vitest'
import { ago, agoOrDate, localClock, localTime, shortAgo } from './time'

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

it('says how long ago one way: minutes, rounded hours under two days, then days', () => {
  const now = Date.parse('2026-11-08T12:00:00Z'),
    min = 60_000
  expect(ago(now - 20_000, now)).toBe('just now')
  expect(ago(now + 5 * min, now)).toBe('just now')
  expect(ago(now - 48 * min, now)).toBe('48 min ago')
  expect(ago(now - 90 * min, now)).toBe('2 h ago')
  expect(ago(now - 47 * 60 * min, now)).toBe('47 h ago')
  expect(ago(now - 3 * 1440 * min, now)).toBe('3 days ago')
  expect(shortAgo(now - 90 * min, now)).toBe('2 h')
  expect(shortAgo(now - 3 * 1440 * min, now)).toBe('3 d')
  expect(agoOrDate(now - 90 * min, now)).toBe('2 h ago')
  expect(agoOrDate(Date.parse('2026-11-05T12:00:00Z'), now)).toBe('Nov 5')
  expect(agoOrDate(Date.parse('2025-02-03T12:00:00Z'), now)).toBe('Feb 3, 2025')
})
