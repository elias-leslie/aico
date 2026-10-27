import { describe, expect, it } from 'vitest'
import { findPaths } from './terminal-path-links'

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
