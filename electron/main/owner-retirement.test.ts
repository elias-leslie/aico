import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { retireOwnedSession } from './owner-retirement'
import { getWidget, initStore, insertWidget } from './store'

describe('native retirement generation guards', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-retirement-test-'))
  const dbPath = join(root, 'aico.db')

  beforeAll(() => initStore(dbPath))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function managedRow(id: string): void {
    insertWidget(id, false, 'shell')
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare(
        `UPDATE widgets SET lifecycle_version = 1, tmux_allocation_state = 'bound',
         tmux_server_id = 'abcdef12', tmux_session_id = '$5', pane_id = '%8'
         WHERE id = ?`,
      ).run(id)
    } finally {
      db.close()
    }
  }

  function replacePane(id: string): void {
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare("UPDATE widgets SET tmux_session_id = '$6', pane_id = '%9' WHERE id = ?").run(id)
    } finally {
      db.close()
    }
  }

  it('does not stop tmux when the persisted generation changes during verification', async () => {
    const id = 'deadbeef'
    managedRow(id)
    const stopTmuxSession = vi.fn(async () => {})
    const result = await retireOwnedSession(id, {
      sessionState: async () => 'present',
      verifiedCurrentPane: async () => {
        replacePane(id)
        return true
      },
      stopTmuxSession,
      settleServer: async () => {},
    })
    expect(result).toEqual({ status: 'stale' })
    expect(stopTmuxSession).not.toHaveBeenCalled()
    expect(getWidget(id)?.tmuxSessionId).toBe('$6')
  })

  it('does not adopt a newer row after the old tmux session stops', async () => {
    const id = 'feedface'
    managedRow(id)
    let checks = 0
    const result = await retireOwnedSession(id, {
      sessionState: async () => {
        checks += 1
        return checks === 1 ? 'present' : 'absent'
      },
      verifiedCurrentPane: async () => true,
      stopTmuxSession: async () => replacePane(id),
      settleServer: async () => {},
    })
    expect(result).toEqual({ status: 'stale' })
    expect(getWidget(id)?.tmuxSessionId).toBe('$6')
  })
})
