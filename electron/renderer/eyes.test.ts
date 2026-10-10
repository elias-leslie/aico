import { describe, expect, it } from 'vitest'
import {
  ASLEEP_AFTER_MS,
  aimOffset,
  GAZE_MAX,
  nextReadingGaze,
  restingMood,
  SLEEPY_AFTER_MS,
} from './eyes'

describe('restingMood', () => {
  it('reads while output flows, however long it has been quiet before', () => {
    expect(restingMood(true, ASLEEP_AFTER_MS * 2)).toBe('busy')
  })

  it('gets sleepy, then falls asleep, as the quiet stretches', () => {
    expect(restingMood(false, 0)).toBe('idle')
    expect(restingMood(false, SLEEPY_AFTER_MS - 1)).toBe('idle')
    expect(restingMood(false, SLEEPY_AFTER_MS)).toBe('sleepy')
    expect(restingMood(false, ASLEEP_AFTER_MS)).toBe('asleep')
  })
})

describe('aimOffset', () => {
  it('keeps a near target as is', () => {
    expect(aimOffset(1, -1)).toEqual({ x: 1, y: -1 })
  })

  it('clamps a far target to the socket edge in the same direction', () => {
    const o = aimOffset(300, 400)
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(GAZE_MAX)
    expect(o.y / o.x).toBeCloseTo(400 / 300)
  })

  it('looks straight ahead at a target on the face', () => {
    expect(aimOffset(0, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('nextReadingGaze', () => {
  it('hops right along the line', () => {
    expect(nextReadingGaze({ x: -GAZE_MAX, line: 0 }, 1)).toEqual({ x: -GAZE_MAX + 1, line: 0 })
  })

  it('sweeps back to the start of the next line at the edge, wrapping after three', () => {
    expect(nextReadingGaze({ x: GAZE_MAX - 0.5, line: 0 }, 1)).toEqual({ x: -GAZE_MAX, line: 1 })
    expect(nextReadingGaze({ x: GAZE_MAX, line: 2 }, 1)).toEqual({ x: -GAZE_MAX, line: 0 })
  })
})
