import { describe, expect, it } from 'vitest'
import { trimTrailingBlankLines } from './scrollback-overlay'

describe('scrollback capture trimming', () => {
  it('removes padded screen rows without backtracking across earlier blank screens', () => {
    const capture = `start\n${'\n'.repeat(24)}end\n`
    const started = performance.now()

    expect(trimTrailingBlankLines(capture)).toBe(`start\n${'\n'.repeat(24)}end`)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('preserves trailing spaces when the capture has no trailing line break', () => {
    expect(trimTrailingBlankLines('prompt   ')).toBe('prompt   ')
  })
})
