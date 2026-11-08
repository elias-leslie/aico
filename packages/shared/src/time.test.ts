import { afterEach, expect, it } from 'vitest'
import { ago, agoOrDate, localClock, localTime, shortAgo, spanText } from './time'

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

it('rounds at the edges: half a minute is a minute, two days switch to days or the date', () => {
  const now = Date.parse('2026-11-08T12:00:00Z'),
    min = 60_000
  expect(ago(now - 29_000, now)).toBe('just now')
  expect(ago(now - 30_000, now)).toBe('1 min ago')
  expect(ago(now - 59 * min, now)).toBe('59 min ago')
  expect(ago(now - 60 * min, now)).toBe('1 h ago')
  expect(ago(now - (48 * 60 - 1) * min, now)).toBe('48 h ago')
  expect(ago(now - 48 * 60 * min, now)).toBe('2 days ago')
  expect(agoOrDate(now - (48 * 60 - 1) * min, now)).toBe('48 h ago')
  expect(agoOrDate(now - 48 * 60 * min, now)).toBe('Nov 6')
})

it('says an age or a limit in the fewest words, and an age rounds like the rest', () => {
  expect(spanText(30_000)).toBe('1 min')
  expect(spanText(55 * 60_000)).toBe('55 min')
  expect(spanText(2.5 * 3_600_000)).toBe('3 h')
  expect(spanText(38 * 3_600_000)).toBe('38 h')
  expect(spanText(72 * 3_600_000)).toBe('3 days')
})
