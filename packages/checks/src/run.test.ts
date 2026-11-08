import { describe, expect, it } from 'vitest'
import { failureLines, resultLine } from './run'

describe('a failed check says what failed', () => {
  it('lists the failing lines past the hint, cleaned and without the command', () => {
    const output = [
      '$ biome check --no-errors-on-unmatched src/a.ts',
      'src/a.ts:3:1 lint/style/useConst FIXABLE ━━━━━━',
      '   some context',
      'src/a.ts format ━━━',
      'Found 2 errors.',
    ].join('\n')
    expect(failureLines(output, 'Found 2 errors.')).toEqual([
      'src/a.ts:3:1 lint/style/useConst FIXABLE',
      'src/a.ts format',
      'Biome and ruff can fix your own files: st check --fix',
    ])
  })

  it('takes both lines of a test failure, and caps a long list with how many more', () => {
    const failing = Array.from({ length: 12 }, (_, n) => `FAIL src/t.test.ts > case ${n}`)
    const lines = failureLines(
      `\u001b[31m${failing[0]}\u001b[0m\n${failing.slice(1).join('\n')}`,
      '',
    )
    expect(lines.slice(0, 2)).toEqual([
      'FAIL src/t.test.ts > case 0',
      'FAIL src/t.test.ts > case 1',
    ])
    expect(lines).toHaveLength(9)
    expect(lines.at(-1)).toBe('4 more in the details')
  })

  it("falls back to the output's end when nothing looks like a failure", () => {
    const output = Array.from({ length: 20 }, (_, n) => `line ${n}`).join('\n')
    expect(failureLines(output, '')).toEqual(Array.from({ length: 8 }, (_, n) => `line ${n + 12}`))
  })

  it('prints them under the result line, and a pass stays one line', () => {
    const base = { id: 'x', ms: 1000, required: true, hint: 'first' }
    expect(resultLine({ ...base, state: 'fail', failures: ['a', 'b'] })).toBe(
      'CHECK:FAIL:x|1.0s|hint:first\n  a\n  b',
    )
    expect(resultLine({ ...base, state: 'pass' })).toBe('CHECK:OK:x|1.0s|hint:first')
  })
})
