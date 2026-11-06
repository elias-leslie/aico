import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectProvider, readLocalProjects } from './projects'

describe('ProjectProvider', () => {
  it('serves the registry once it has projects, and the local list while it has none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-projects-'))
    const localFile = join(dir, 'projects.json')
    writeFileSync(localFile, JSON.stringify([{ id: 'home', root: dir }]))
    let registry: { id: string; name: string; root: string }[] = []
    const provider = new ProjectProvider({ registry: () => registry, localFile })
    expect(await provider.list({ refresh: true })).toMatchObject({
      source: 'local',
      projects: [{ id: 'home', root: dir }],
    })
    registry = [
      { id: 'zeta', name: 'Zeta', root: '/srv/zeta' },
      { id: 'aico', name: 'Aico', root: '/srv/aico' },
      { id: 'bad', name: 'Bad', root: 'relative' },
    ]
    const list = await provider.list({ refresh: true })
    expect(list.source).toBe('registry')
    expect(list.projects.map((project) => project.id)).toEqual(['aico', 'zeta'])
  })

  it('caches the registry for its TTL', async () => {
    let now = 0
    let reads = 0
    const provider = new ProjectProvider({
      registry: () => {
        reads += 1
        return [{ id: 'aico', name: 'Aico', root: '/srv/aico' }]
      },
      localFile: '/nonexistent/projects.json',
      ttlMs: 100,
      now: () => now,
    })
    await provider.list()
    await provider.list()
    expect(reads).toBe(1)
    now = 200
    await provider.list()
    expect(reads).toBe(2)
  })

  it('falls back to the local list when the registry cannot be read, with no network fetch', async () => {
    const realFetch = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched += 1
      throw new Error('no network')
    }) as typeof fetch
    try {
      const provider = new ProjectProvider({
        registry: () => {
          throw new Error('locked')
        },
        localFile: '/nonexistent/projects.json',
      })
      expect(await provider.list()).toMatchObject({ source: 'local', projects: [] })
      expect(fetched).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('reads nothing from a missing local file and skips roots that are not directories', () => {
    expect(readLocalProjects('/nonexistent/projects.json')).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'tether-projects-'))
    const localFile = join(dir, 'projects.json')
    writeFileSync(
      localFile,
      JSON.stringify([
        { id: 'home', root: dir },
        { id: 'gone', root: '/nonexistent/x' },
      ]),
    )
    expect(readLocalProjects(localFile).map((project) => project.id)).toEqual(['home'])
  })
})
