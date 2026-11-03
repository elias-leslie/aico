import { describe, expect, it } from 'vitest'
import { thumbSize } from './capture-thumb'

describe('thumbSize', () => {
  it('fits the long edge to 480 and keeps the ratio', () => {
    expect(thumbSize(4000, 3000)).toEqual({ width: 480, height: 360 })
    expect(thumbSize(3000, 4000)).toEqual({ width: 360, height: 480 })
  })
  it('never enlarges a small picture', () => {
    expect(thumbSize(200, 100)).toEqual({ width: 200, height: 100 })
  })
})
