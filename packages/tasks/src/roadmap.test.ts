import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openTasksDb } from './db'
import { ProjectError, parseRuntime, Registry } from './projects'
import { parseRoadmap, readRoadmap } from './roadmap'

const SAMPLE = `# Aico
Aico is the owner's workspace. It runs on the workstation.

## Now
- Remove the task system (plan: docs/plans/projects-page/plan.md)
- Fix the Drive backup (blocked: waiting on the new token)
- Both (blocked: the token) (plan: docs/x.md)
## Next
- Projects page
## Later
- Phone widgets
`

describe('parseRoadmap', () => {
  it('reads the name, overview and the three sections', () => {
    const r = parseRoadmap(SAMPLE)
    expect(r.name).toBe('Aico')
    expect(r.overview).toBe("Aico is the owner's workspace. It runs on the workstation.")
    expect(r.now).toEqual([
      { text: 'Remove the task system', plan: 'docs/plans/projects-page/plan.md' },
      { text: 'Fix the Drive backup', blocked: 'waiting on the new token' },
      { text: 'Both', blocked: 'the token', plan: 'docs/x.md' },
    ])
    expect(r.next).toEqual([{ text: 'Projects page' }])
    expect(r.later).toEqual([{ text: 'Phone widgets' }])
    expect(r.problems).toEqual([])
  })

  it('passes odd lines through raw and names them', () => {
    const r = parseRoadmap(
      '# P\nWhat it is.\n## Now\nplain words, no bullet\n- ok\n## Done\n- old thing\n## Next\n',
    )
    expect(r.now).toEqual([{ text: 'plain words, no bullet', raw: true }, { text: 'ok' }])
    expect(r.other).toEqual(['## Done', '- old thing'])
    expect(r.problems.map((p) => [p.line, p.why])).toEqual([
      [4, 'not a "- " item'],
      [6, 'only Now, Next and Later sections'],
    ])
  })

  it('joins an indented continuation to its item and keeps suffixes', () => {
    const r = parseRoadmap('# P\n## Now\n- Long item\n  that wraps (plan: a.md)\n')
    expect(r.now).toEqual([{ text: 'Long item that wraps', plan: 'a.md' }])
  })

  it('takes text before the title as a problem, and empty input as empty', () => {
    expect(parseRoadmap('stray\n# P\n').problems).toHaveLength(1)
    const empty = parseRoadmap('')
    expect(empty).toMatchObject({ name: null, overview: null, now: [], next: [], later: [] })
  })
})

describe('readRoadmap', () => {
  it('is null when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-'))
    expect(readRoadmap(dir)).toBeNull()
    writeFileSync(join(dir, 'ROADMAP.md'), SAMPLE)
    expect(readRoadmap(dir)?.name).toBe('Aico')
  })
})

describe('project runtime', () => {
  it('checks places and stores them with the project', () => {
    const registry = new Registry(openTasksDb(':memory:'))
    registry.register({ id: 'ominull', root: '/srv/ominull' })
    expect(registry.get('ominull')?.runtime).toEqual([])
    registry.setRuntime('ominull', [
      {
        kind: 'ct',
        id: 150,
        label: 'CT 150',
        power: true,
        intent: 'always',
        machine: 'ominull-hub',
      },
    ])
    expect(registry.get('ominull')?.runtime).toEqual([
      {
        kind: 'ct',
        id: 150,
        label: 'CT 150',
        power: true,
        intent: 'always',
        machine: 'ominull-hub',
      },
    ])
    registry.setRuntime('ominull', [])
    expect(registry.get('ominull')?.runtime).toEqual([])
  })

  it('refuses a bad place', () => {
    expect(() => parseRuntime({})).toThrow(ProjectError)
    expect(() => parseRuntime([{ kind: 'vm', label: 'x', power: true, intent: 'always' }])).toThrow(
      /Proxmox id/,
    )
    expect(() =>
      parseRuntime([{ kind: 'host', label: 'x', power: true, intent: 'always' }]),
    ).toThrow(/power hosts/)
    expect(() => parseRuntime([{ kind: 'ct', id: 150, label: 'x', power: true }])).toThrow(/intent/)
    expect(() =>
      parseRuntime([{ kind: 'ct', id: 150, label: 'x', power: true, intent: 'always', junk: 1 }]),
    ).toThrow(/unknown field/)
  })
})
