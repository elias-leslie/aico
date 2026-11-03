import { describe, expect, it } from 'vitest'
import { findPaths, wrappedRows } from './terminal-path-links'

const paths = (text: string) => findPaths(text).map((found) => found.path)

describe('findPaths', () => {
  it('finds absolute and home paths where words start', () => {
    expect(
      paths('Wrote /srv/out/report.md and ~/notes/a b.txt, see (/tmp/x).'),
    ).toEqual(['/srv/out/report.md', '~/notes/a', '/tmp/x'])
  })

  it('drops trailing punctuation and line numbers', () => {
    expect(paths('at /srv/app/main.ts:12:3: error')).toEqual([
      '/srv/app/main.ts',
    ])
    expect(paths('saved to /srv/out/.')).toEqual(['/srv/out/'])
  })

  it('skips URLs, bare slashes and paths inside words', () => {
    expect(paths('https://example.com/a and a/b/c and / and ~/')).toEqual([])
  })

  it('reports where each path sits', () => {
    expect(findPaths('cat "/etc/hosts"')).toEqual([
      { path: '/etc/hosts', start: 5, end: 15 },
    ])
  })
})

describe('wrappedRows', () => {
  const rows = (wrapped: boolean[]) => ({
    length: wrapped.length,
    // Like xterm: rows wrap around, so asking past the end answers a row.
    getLine: (y: number) =>
      ({
        isWrapped:
          wrapped[((y % wrapped.length) + wrapped.length) % wrapped.length],
      }) as never,
  })

  it('reads the rows one line wraps over', () => {
    const buffer = rows([false, true, true, false, true])
    expect(wrappedRows(buffer, 2, 80).first).toBe(0)
    expect(wrappedRows(buffer, 2, 80).lines).toHaveLength(3)
    expect(wrappedRows(buffer, 4, 80).first).toBe(3)
  })

  it('stops when every row is wrapped instead of looping around the buffer', () => {
    // A screen painted wider than the pane marks every row wrapped; this
    // used to build rows until the page ran out of memory.
    const buffer = rows(Array.from({ length: 64 }, () => true))
    const { first, lines } = wrappedRows(buffer, 30, 129)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(lines.length).toBeLessThanOrEqual(64)
  })

  it('reads a bounded window of a very long wrapped line', () => {
    const buffer = rows(Array.from({ length: 20000 }, () => true))
    const { lines } = wrappedRows(buffer, 10000, 100, 4000)
    expect(lines.length).toBeLessThanOrEqual(81)
  })

  it('copes with a row outside the buffer', () => {
    const buffer = rows([false, true])
    expect(wrappedRows(buffer, 50, 80).lines).toEqual([])
    expect(wrappedRows(buffer, -3, 80).lines).toEqual([])
  })
})
