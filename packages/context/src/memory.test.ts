import { transaction } from '@aico/store'
import { describe, expect, it } from 'vitest'
import { openContext } from './db'
import {
  addMemory,
  deleteMemory,
  getMemories,
  listMemories,
  putMemory,
  searchMemories,
} from './memory'

const NOW = '2026-11-03T12:00:00.000Z'

function seeded() {
  const db = openContext(':memory:')
  const tmux = addMemory(
    db,
    {
      content: 'tmux -S PATH chmods PATH as its socket; point it only at a resolved socket file.',
      summary: 'tmux socket paths',
      tier: 'guardrail',
      tags: ['tmux', 'safety'],
    },
    NOW,
  )
  const wayland = addMemory(
    db,
    {
      content: 'The workstation runs GNOME on Wayland; do not steer back to Xorg.',
      summary: 'Wayland desktop',
    },
    NOW,
  )
  const project = addMemory(
    db,
    {
      content: 'Aico sessions mention tmux only in the attach path.',
      summary: 'attach path',
      scope: 'project',
      scopeId: 'aico',
    },
    NOW,
  )
  for (let index = 0; index < 20; index++)
    addMemory(db, { content: `Filler memory number ${index} about backups and snapshots.` }, NOW)
  return { db, tmux, wayland, project }
}

describe('memories', () => {
  it('finds by words, best match first, summary and tags weighing most', () => {
    const { db, tmux } = seeded()
    const found = searchMemories(db, 'tmux socket')
    expect(found[0]?.id).toBe(tmux.id)
    expect(found[0]?.score).toBeGreaterThan(0)
    expect(found.every((item) => item.scope === 'global')).toBe(true)
    expect(searchMemories(db, 'wayland')[0]?.summary).toBe('Wayland desktop')
    expect(searchMemories(db, '   ')).toEqual([])
    db.close()
  })

  it('searches a project with the global memories, and filters by tier', () => {
    const { db, tmux, project } = seeded()
    const ids = searchMemories(db, 'tmux', { scope: 'project', scopeId: 'aico' }).map(
      (item) => item.id,
    )
    expect(ids.sort()).toEqual([tmux.id, project.id].sort())
    expect(searchMemories(db, 'tmux', { tier: 'reference' })).toEqual([])
    expect(searchMemories(db, 'tmux', {}, { minScore: 0.99 })).toEqual([])
    db.close()
  })

  it('keeps the search index and revisions in step with every write', () => {
    const { db, wayland } = seeded()
    const changed = {
      ...wayland,
      content: 'Desktop sessions use Xwayland for legacy apps.',
      version: 2,
    }
    transaction(db, () => putMemory(db, changed, 'edited', NOW))
    expect(searchMemories(db, 'gnome')).toEqual([])
    expect(searchMemories(db, 'xwayland')[0]?.id).toBe(wayland.id)
    transaction(db, () => putMemory(db, changed, 'edited again', NOW))
    const revisions = db
      .prepare('SELECT version, reason FROM memory_revisions WHERE memory_id = ? ORDER BY version')
      .all(wayland.id)
    expect(revisions).toEqual([
      { version: 1, reason: 'created' },
      { version: 2, reason: 'edited' },
    ])
    db.prepare('DELETE FROM memories WHERE id = ?').run(wayland.id)
    expect(searchMemories(db, 'xwayland')).toEqual([])
    db.close()
  })

  it('gets by id prefix and lists a scope page by page, mandates first', () => {
    const { db, tmux, project } = seeded()
    const got = getMemories(db, [tmux.id.slice(0, 8), 'ffffffff'])
    expect(got.found.map((item) => item.id)).toEqual([tmux.id])
    expect(got.missing).toEqual(['ffffffff'])
    const first = listMemories(db, {}, { limit: 5 })
    expect(first.memories[0]?.id).toBe(tmux.id)
    expect(first.next).toBe(5)
    const last = listMemories(db, {}, { limit: 50, offset: 20 })
    expect(last.memories).toHaveLength(2)
    expect(last.next).toBeNull()
    expect(
      listMemories(db, { scope: 'project', scopeId: 'aico' }).memories.map((m) => m.id),
    ).toEqual([project.id])
    expect(listMemories(db, { tag: 'safety' }).memories.map((m) => m.id)).toEqual([tmux.id])
    expect(() => addMemory(db, { content: 'x', scope: 'project' }, NOW)).toThrow('--scope-id')
    db.close()
  })
})

describe('deleteMemory', () => {
  it('removes the memory and its search entry, keeps revisions, lists every scope on request', () => {
    const db = openContext(':memory:')
    const keep = addMemory(db, { content: 'Keep this one.' }, NOW)
    const gone = addMemory(
      db,
      { content: 'Throwaway zebra note.', scope: 'project', scopeId: 'aico' },
      NOW,
    )
    expect(listMemories(db, { scope: 'all' }).memories).toHaveLength(2)
    expect(searchMemories(db, 'zebra', { scope: 'all' })).toHaveLength(1)
    expect(deleteMemory(db, gone.id)).toBe(true)
    expect(deleteMemory(db, gone.id)).toBe(false)
    expect(listMemories(db, { scope: 'all' }).memories.map((m) => m.id)).toEqual([keep.id])
    expect(searchMemories(db, 'zebra', { scope: 'all' })).toHaveLength(0)
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM memory_revisions WHERE memory_id = ?').get(gone.id),
    ).toEqual({ n: 1 })
    db.close()
  })
})
