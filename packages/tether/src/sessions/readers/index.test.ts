import { describe, expect, it, vi } from 'vitest'
import type { Reader } from '../types'
import { readLine } from './index'

const reading = { fold: {}, events: [] }

function fakeReader(): Reader {
  return {
    tool: 'pi',
    discover: () => [],
    nativeIdOf: (path) => path,
    initialState: () => ({}),
    skip: (line) => line.includes('"skip"'),
    read: vi.fn(() => reading),
  }
}

describe('readLine', () => {
  it('hands a JSON object line to the reader', () => {
    const reader = fakeReader()
    const state = { seen: 1 }
    expect(readLine(reader, '{"type":"message"}', state, true)).toBe(reading)
    expect(reader.read).toHaveBeenCalledWith({ type: 'message' }, state, true, undefined)
  })

  it.each([
    ['an empty line', ''],
    ['a line the reader skips', '{"type":"skip"}'],
    ['a cut line', '{"type":"mess'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"text"'],
  ])('passes over %s', (_name, line) => {
    const reader = fakeReader()
    expect(readLine(reader, line, {}, false)).toBeNull()
    expect(reader.read).not.toHaveBeenCalled()
  })
})
