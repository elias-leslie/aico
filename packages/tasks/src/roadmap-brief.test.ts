import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openTasksDb } from './db'
import { Registry } from './projects'
import { runPulse } from './pulse-cli'
import { roadmapBrief } from './roadmap-brief'

const ROADMAP = `# Demo
A small demo project that does one thing well.

## Now
- Ship the thing (plan: docs/plans/x/plan.md)
## Next
- Second
- Third
- Fourth
- Fifth (blocked: waiting on the owner)
## Later
- Someday
`

describe('startup roadmap brief', () => {
  it('shows the overview, Now and a bounded Next; nothing without a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadmap-brief-'))
    expect(roadmapBrief(root)).toEqual([])
    expect(roadmapBrief(null)).toEqual([])
    writeFileSync(join(root, 'ROADMAP.md'), ROADMAP)
    expect(roadmapBrief(root)).toEqual([
      'Project roadmap (ROADMAP.md, Demo):',
      'A small demo project that does one thing well.',
      'Now:',
      '- Ship the thing (plan: docs/plans/x/plan.md)',
      'Next:',
      '- Second',
      '- Third',
      '- Fourth',
      '- +1 more in ROADMAP.md',
    ])
  })

  it('aico pulse --start prints it for the project holding the session cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roadmap-start-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'ROADMAP.md'), ROADMAP)
    const db = openTasksDb(':memory:')
    new Registry(db).register({ id: 'demo', root, name: 'Demo' })
    const out: string[] = []
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) }
    const env = { AICO_DATA_DIR: mkdtempSync(join(tmpdir(), 'pulse-data-')) } as NodeJS.ProcessEnv
    const sources = {
      now: () => Date.now(),
      sessions: async () => [],
      docNames: async () => [],
      doc: async () => null,
      findings: () => [],
    }
    const stdin = () => JSON.stringify({ cwd: join(root, 'src'), hook_event_name: 'SessionStart' })
    expect(await runPulse(['--start'], { db, cwd: '/', env, sources, stdin }, io)).toBe(0)
    expect(out[0]).toBe('Project roadmap (ROADMAP.md, Demo):')
    expect(out).toContain('- Ship the thing (plan: docs/plans/x/plan.md)')
    out.length = 0
    expect(
      await runPulse(
        ['--start'],
        { db, cwd: '/', env, sources, stdin: () => '{"cwd":"/nowhere"}' },
        io,
      ),
    ).toBe(0)
    expect(out).toEqual([])
  })
})
