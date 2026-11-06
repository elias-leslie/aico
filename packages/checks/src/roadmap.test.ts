import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { roadmapProblems, roadmapStep } from './roadmap'

const GOOD = `# Demo
What it is.

## Now
- Do the thing (plan: docs/plans/x/plan.md)
## Next
- Another (blocked: waiting on the owner)
## Later
`

const has = (path: string) => path === 'docs/plans/x/plan.md'
const first = (text: string) => roadmapProblems(text, has)[0]?.message

describe('ROADMAP.md format check', () => {
  it('accepts a well-formed file', () => {
    expect(roadmapProblems(GOOD, has)).toEqual([])
  })

  it('names the first problem for each kind of mistake', () => {
    expect(first(GOOD.replace('## Later', '## Done'))).toContain('only Now, Next and Later')
    expect(first(GOOD.replace('- Another', 'Another'))).toContain('not a "- " item')
    expect(first(GOOD.replace('# Demo\n', ''))).toBeTruthy()
    expect(first(GOOD.replace('What it is.\n', ''))).toContain('missing the overview')
    expect(first(GOOD.replace('(blocked: waiting on the owner)', '(blocked: )'))).toContain(
      'malformed',
    )
    expect(
      first(GOOD.replace('(plan: docs/plans/x/plan.md)', '(plan docs/plans/x/plan.md)')),
    ).toContain('malformed')
    expect(first(GOOD.replace('docs/plans/x/plan.md', 'docs/plans/gone.md'))).toContain(
      'plan path docs/plans/gone.md does not exist',
    )
  })

  it('is one line with the file line and the count of the rest', () => {
    const step = (() => {
      const root = mkdtempSync(join(tmpdir(), 'roadmap-check-'))
      mkdirSync(join(root, 'docs/plans/x'), { recursive: true })
      writeFileSync(join(root, 'docs/plans/x/plan.md'), '')
      writeFileSync(
        join(root, 'ROADMAP.md'),
        GOOD.replace('## Later', '## Done').replace('- Another', 'oops\n- Another'),
      )
      return { root, step: roadmapStep(root, null) }
    })()
    expect(step.step?.state).toBe('fail')
    expect(step.step?.hint).toBe('ROADMAP.md:7: not a "- " item: oops (+1 more)')
    expect(roadmapStep(step.root, ['src/a.ts'])).toBeNull()
    expect(roadmapStep(step.root, ['ROADMAP.md'])?.state).toBe('fail')
    writeFileSync(join(step.root, 'ROADMAP.md'), GOOD)
    expect(roadmapStep(step.root, ['ROADMAP.md'])).toBeNull()
    expect(roadmapStep(mkdtempSync(join(tmpdir(), 'no-roadmap-')), null)).toBeNull()
  })
})
