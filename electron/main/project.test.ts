import { describe, expect, it, vi } from 'vitest'
import {
  PERSONAL_WORKSPACE_ID,
  PERSONAL_WORKSPACE_NAME,
  ProjectCatalog,
  personalWorkspaceRoot,
} from './project'

describe('workspace catalog from Tether', () => {
  it('puts the Personal Workspace first and keeps the last good list on failure', async () => {
    let now = 0
    const load = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'aico', name: 'Aico', root: '/srv/aico' }])
      .mockRejectedValueOnce(new Error('tether down'))
    const repaint = vi.fn()
    const catalog = new ProjectCatalog(load, repaint, () => now)

    expect((await catalog.listFresh()).map((p) => p.id)).toEqual([PERSONAL_WORKSPACE_ID, 'aico'])
    expect(repaint).toHaveBeenCalledOnce()
    now = 60_000
    expect((await catalog.listFresh()).map((p) => p.id)).toEqual([PERSONAL_WORKSPACE_ID, 'aico'])
    expect(load).toHaveBeenCalledTimes(2)
    expect(catalog.nameFor('aico', null)).toBe('Aico')
    expect(catalog.nameFor(null, personalWorkspaceRoot())).toBe(PERSONAL_WORKSPACE_NAME)
    expect(catalog.nameFor(null, '/elsewhere')).toBeNull()
  })

  it('serves the cache without blocking and refreshes once in the background', async () => {
    const load = vi.fn(async () => [{ id: 'aico', name: '', root: '/srv/aico' }])
    const catalog = new ProjectCatalog(load)
    expect(catalog.list().map((p) => p.id)).toEqual([PERSONAL_WORKSPACE_ID])
    catalog.list()
    await catalog.refresh()
    expect(load).toHaveBeenCalledOnce()
    expect(catalog.list()[1]).toEqual({
      id: 'aico',
      name: 'aico',
      root: '/srv/aico',
      current: false,
    })
  })
})
