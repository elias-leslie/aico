// What an End does to the coordinator's lanes: running coordinator-role lanes are promoted,
// unless a kept wake will relaunch the coordinator and rejoin them itself.

import { Store } from '@aico/session-engine/store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindCatalog, getWidget, insertWidget, recordLauncher } from './catalog'
import { holdPromotion, publishPromotedLanes, releasePromotion } from './engine'

const store = new Store(':memory:')

beforeAll(() => bindCatalog(store.db))
afterAll(() => store.close())

function lanes(old: string, lane: string, plain: string): void {
  for (const id of [old, lane, plain]) insertWidget(id, 'codex')
  recordLauncher(lane, old)
  recordLauncher(plain, old)
  store.db
    .prepare(
      `INSERT INTO root_requests (request_id, digest, widget_id, logical_session_id, role, created_at, origin, work_role)
       VALUES (?, ?, ?, ?, 'lead', 0, 'aico', 'coordinator')`,
    )
    .run(`req-${lane}`, 'd', lane, `logical-${lane}`)
}

describe('publishPromotedLanes', () => {
  it('promotes a lane that is running and leaves one that is not', async () => {
    lanes('f2000001', 'f2000002', 'f2000003')
    const statusOf = async (row: { id: string }) =>
      row.id === 'f2000002' ? 'running' : 'uncertain'
    expect(await publishPromotedLanes('f2000001', statusOf as never)).toEqual(['f2000002'])
    expect(getWidget('f2000002')?.coordinator).toBe(true)
    lanes('f2000011', 'f2000012', 'f2000013')
    expect(await publishPromotedLanes('f2000011', (async () => 'pending') as never)).toEqual([])
    expect(getWidget('f2000012')?.coordinatorId).toBe('f2000011')
  })

  it('leaves the lanes of a coordinator a kept wake will relaunch', async () => {
    lanes('f2000021', 'f2000022', 'f2000023')
    holdPromotion('f2000021')
    expect(await publishPromotedLanes('f2000021', (async () => 'running') as never)).toEqual([])
    // The relaunch rejoins the lanes still on it.
    expect(getWidget('f2000022')?.coordinatorId).toBe('f2000021')
    expect(getWidget('f2000022')?.coordinator).toBe(false)
  })

  it('promotes again once an End that did not happen takes its hold back', async () => {
    lanes('f2000031', 'f2000032', 'f2000033')
    holdPromotion('f2000031')
    releasePromotion('f2000031')
    expect(await publishPromotedLanes('f2000031', (async () => 'running') as never)).toEqual([
      'f2000032',
    ])
  })
})
