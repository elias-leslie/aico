import { describe, expect, it } from 'vitest'
import {
  clip,
  joinDays,
  orderProjects,
  type Place,
  type ProjectSummary,
  placeLine,
  placeName,
  planBlocks,
  powerActions,
  powerButtonText,
  powerLabel,
  powerSummary,
  problemText,
  shortAge,
  splitProjects,
  timelineDay,
} from './projects'

const project = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'p',
  name: 'P',
  archived: false,
  top: null,
  waiting: null,
  runState: null,
  problems: [],
  agents: 0,
  lastActivity: '2026-11-06T10:00:00Z',
  ...over,
})
const NOW = Date.parse('2026-11-06T12:00:00')

describe('orderProjects', () => {
  it('sorts by name, whatever is waiting, broken or recent', () => {
    const ordered = orderProjects([
      project({ id: 'z', name: 'Zed', lastActivity: '2026-11-06T11:00:00Z' }),
      project({
        id: 'b',
        name: 'beta',
        problems: [{ kind: 'fail', count: 1 }],
      }),
      project({
        id: 'd',
        name: 'Dadbot',
        lastActivity: '2026-11-01T00:00:00Z',
      }),
      project({ id: 'n', name: 'Neri', waiting: { askId: 'a', title: 'x' } }),
    ])
    expect(ordered.map((p) => p.id)).toEqual(['b', 'd', 'n', 'z'])
  })

  it('keeps a project in place when it gains a waiting session', () => {
    const list = [
      project({ id: 'a', name: 'Aico' }),
      project({ id: 'n', name: 'Neri' }),
    ]
    const after = list.map((p) =>
      p.id === 'n' ? { ...p, waiting: { askId: 'a', title: 'x' } } : p,
    )
    expect(orderProjects(after).map((p) => p.id)).toEqual(['a', 'n'])
  })

  it('keeps archived apart and searches name and top line', () => {
    const { active, archived } = splitProjects(
      [
        project({ id: 'a', name: 'Aico', top: 'Cleanup' }),
        project({ id: 'b', name: 'Old thing', archived: true }),
        project({ id: 'c', name: 'Other', top: 'aico notes' }),
      ],
      'aico',
    )
    expect(active.map((p) => p.id).sort()).toEqual(['a', 'c'])
    expect(archived).toEqual([])
    expect(
      splitProjects([project({ archived: true })], '').archived,
    ).toHaveLength(1)
  })
})

describe('words', () => {
  it('names problems with their count', () => {
    expect(problemText('quiet', 21)).toBe('21 checks quiet')
    expect(problemText('fail', 2)).toBe('2 failed')
    expect(problemText('warn', 1)).toBe('1 warning')
    expect(problemText('warn', 3)).toBe('3 warnings')
    expect(problemText('backup', 1, 'warn')).toBe('1 backup warning')
    expect(problemText('publish', 1)).toBe('Publish to GitHub failed')
    expect(problemText('backup', 2)).toBe('2 backups failed')
  })

  it('gives short ages and day labels', () => {
    expect(shortAge('2026-11-06T11:51:00', NOW)).toBe('9 min')
    expect(shortAge('2026-11-04T12:00:00', NOW)).toBe('2 d')
    expect(timelineDay('2026-11-06', NOW)).toBe('Today · Nov 6')
    expect(timelineDay('2026-11-05', NOW)).toBe('Yesterday · Nov 5')
    expect(timelineDay('2026-11-04', NOW)).toBe('Wed · Nov 4')
  })

  it('clips long subjects to one line', () => {
    const long = `${'word '.repeat(60)}end`
    const clipped = clip(long)
    expect(clipped.length).toBeLessThanOrEqual(100)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clip('Short\nbody')).toBe('Short')
  })
})

describe('places', () => {
  const vm: Place = {
    kind: 'vm',
    id: 180,
    label: 'Portfolio AI',
    power: true,
    state: 'stopped',
    since: '2026-11-06T10:40:00',
    asOf: '2026-11-06T11:59:00',
  }

  it('names the target and the sheet buttons', () => {
    expect(placeName(vm)).toBe('VM 180')
    expect(
      placeName({ ...vm, kind: 'host', id: undefined, label: 'Workstation' }),
    ).toBe('Workstation')
    expect(powerLabel('start', 'VM 180')).toBe('Start VM 180')
    expect(powerLabel('shutdown', 'VM 180')).toBe('Shut down VM 180')
    expect(powerLabel('restart', 'CT 150')).toBe('Restart CT 150')
  })

  it('offers actions by state and nothing for indicators', () => {
    expect(powerActions(vm)).toEqual(['start'])
    expect(powerActions({ ...vm, state: 'running' })).toEqual([
      'shutdown',
      'restart',
    ])
    expect(powerActions({ ...vm, state: 'unknown' })).toBeNull()
    expect(powerActions({ ...vm, state: 'starting' })).toBeNull()
    expect(powerActions({ ...vm, power: false, state: 'running' })).toBeNull()
  })

  it('names why a place is unknown', () => {
    expect(
      placeLine(
        { ...vm, state: 'unknown', note: 'Proxmox did not answer (timeout).' },
        NOW,
      ),
    ).toContain('can’t reach the Proxmox host')
    expect(
      placeLine(
        { ...vm, state: 'unknown', note: 'Proxmox does not list this guest.' },
        NOW,
      ),
    ).toContain('Proxmox does not list this guest · as of')
    expect(shortAge(null, NOW)).toBe('')
  })

  it('says the state in one line', () => {
    expect(placeLine(vm, NOW)).toBe('stopped at 10:40')
    expect(placeLine({ ...vm, state: 'unknown' }, NOW)).toBe(
      'can’t reach the Proxmox host · as of 11:59',
    )
    expect(
      powerSummary(
        { ...vm, state: 'running', since: '2026-11-06T09:12:00' },
        0,
        NOW,
      ),
    ).toBe('Running since 09:12 · No agent is working on it')
    expect(
      powerSummary(
        { ...vm, state: 'running', since: '2026-11-06T09:12:00' },
        2,
        NOW,
      ),
    ).toContain('2 agents are working on it')
    expect(powerSummary(vm, 0, NOW)).toBe(
      'Stopped at 10:40 · checked 1 min ago',
    )
    // A check time that can't be read says nothing rather than "NaN ago".
    expect(powerSummary({ ...vm, asOf: 'not a time' }, 0, NOW)).toBe(
      'Stopped at 10:40',
    )
  })
})

describe('joinDays', () => {
  it('joins a day that a page boundary split, keeping the order', () => {
    const commit = (sha: string) => ({ sha, subject: sha, at: '' })
    const days = joinDays([
      {
        end: false,
        days: [
          { date: '2026-10-29', commits: [commit('a')] },
          { date: '2026-10-27', commits: [commit('b')] },
        ],
      },
      {
        end: true,
        days: [
          { date: '2026-10-27', commits: [commit('c')] },
          { date: '2026-10-26', commits: [commit('d')] },
        ],
      },
    ])
    expect(
      days.map((day) => [day.date, day.commits.map((c) => c.sha)]),
    ).toEqual([
      ['2026-10-29', ['a']],
      ['2026-10-27', ['b', 'c']],
      ['2026-10-26', ['d']],
    ])
  })
})

describe('planBlocks', () => {
  it('keeps code fences and tables as written and the rest as text', () => {
    const blocks = planBlocks(
      '# Plan\nWords.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\nAfter.',
    )
    expect(blocks.map((block) => block.kind)).toEqual([
      'text',
      'code',
      'code',
      'text',
    ])
    expect(blocks[1]?.text).toContain('| 1 | 2 |')
    expect(blocks[2]?.text).toBe('const x = 1')
  })
})

describe('powerButtonText', () => {
  const base: Place = {
    kind: 'vm',
    id: 180,
    label: 'X',
    power: true,
    state: 'stopped',
  }
  it('names the action and the target', () => {
    expect(powerButtonText(base)).toEqual({
      short: 'Start',
      full: 'Start VM 180 (it is stopped)',
    })
    expect(powerButtonText({ ...base, state: 'running' }).full).toBe(
      'Shut down or restart VM 180 (it is running)',
    )
  })
})
