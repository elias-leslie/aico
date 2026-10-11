import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ProjectProvider,
  parseSummitFlowProjects,
  readLocalProjects,
  summitflowUrlFromEnv,
} from './projects'

const rows = [
  { id: 'aico', name: 'Aico', root_path: '/srv/workspaces/projects/aico', lifecycle: 'active' },
  { id: 'old', name: 'Old', root_path: '/srv/old', lifecycle: 'archived' },
  { id: 'bad', name: 'Bad', root_path: 'relative' },
  {
    id: 'a-term',
    name: 'A-Term',
    root_path: '/srv/workspaces/projects/a-term/',
    lifecycle: 'active',
  },
]

describe('parseSummitFlowProjects', () => {
  it('keeps valid, non-archived projects sorted by id', () => {
    expect(parseSummitFlowProjects(rows)).toEqual([
      {
        id: 'a-term',
        name: 'A-Term',
        root: '/srv/workspaces/projects/a-term/',
        lifecycle: 'active',
      },
      { id: 'aico', name: 'Aico', root: '/srv/workspaces/projects/aico', lifecycle: 'active' },
    ])
    expect(() => parseSummitFlowProjects({ items: [] })).toThrow()
  })
})

describe('ProjectProvider', () => {
  it('caches SummitFlow, serves the cache while it is down, then falls back to local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-projects-'))
    const localFile = join(dir, 'projects.json')
    writeFileSync(
      localFile,
      JSON.stringify([
        { id: 'home', root: dir },
        { id: 'gone', root: '/nonexistent/x' },
      ]),
    )
    let now = 0
    let calls = 0
    let up = true
    const provider = new ProjectProvider({
      summitflowUrl: 'http://127.0.0.1:8001/api/projects',
      localFile,
      ttlMs: 100,
      now: () => now,
      fetchJson: async () => {
        calls += 1
        if (!up) throw new Error('down')
        return rows
      },
    })
    expect((await provider.list()).source).toBe('summitflow')
    expect((await provider.list()).source).toBe('summitflow')
    expect(calls).toBe(1)
    now = 200
    up = false
    const cached = await provider.list()
    expect(cached.source).toBe('summitflow-cache')
    expect(cached.projects).toHaveLength(2)

    const local = new ProjectProvider({
      summitflowUrl: 'http://x',
      localFile,
      fetchJson: async () => {
        throw new Error('down')
      },
    })
    expect(await local.list()).toMatchObject({
      source: 'local',
      projects: [{ id: 'home', root: dir }],
    })
  })

  it('reads nothing from a missing local file and honours TETHER_SUMMITFLOW_URL=off', () => {
    expect(readLocalProjects('/nonexistent/projects.json')).toEqual([])
    expect(summitflowUrlFromEnv({ TETHER_SUMMITFLOW_URL: 'off' })).toBeNull()
    expect(summitflowUrlFromEnv({})).toBe('http://127.0.0.1:8001/api/projects')
  })
})
