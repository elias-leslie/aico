import { beforeEach, describe, expect, it } from 'vitest'
import { forgetSizeHolder, recordSizeHolder, resetSizeHolders, sizeHolderOf } from './size-holder'

const claim = { clientPid: 4242, cols: 100, rows: 30, generation: 'g1' }

describe('size holder', () => {
  beforeEach(resetSizeHolders)

  it('is unknown until a claim, then names the last claimer', () => {
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toBeNull()
    recordSizeHolder('aaaaaaaa', claim, () => new Date('2026-10-23T10:00:00Z'))
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toEqual({
      ...claim,
      claimedAt: '2026-10-23T10:00:00.000Z',
    })
    recordSizeHolder('aaaaaaaa', { ...claim, clientPid: 7, cols: 40, rows: 20 })
    expect(sizeHolderOf('aaaaaaaa', 'g1')?.clientPid).toBe(7)
  })

  it('drops a holder from another generation or a forgotten session', () => {
    recordSizeHolder('aaaaaaaa', claim)
    expect(sizeHolderOf('aaaaaaaa', 'g2')).toBeNull()
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toBeNull()
    recordSizeHolder('bbbbbbbb', claim)
    forgetSizeHolder('bbbbbbbb')
    expect(sizeHolderOf('bbbbbbbb', 'g1')).toBeNull()
  })
})
