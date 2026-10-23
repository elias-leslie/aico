import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetSizeHolder,
  parseViewerLabel,
  recordSizeHolder,
  resetSizeHolders,
  sizeHolderOf,
} from './size-holder'

const claim = { clientPid: 4242, cols: 100, rows: 30, generation: 'g1' }

describe('size holder', () => {
  beforeEach(resetSizeHolders)

  it('is unknown until a claim, then names the last claimer', () => {
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toBeNull()
    recordSizeHolder('aaaaaaaa', claim, () => new Date('2026-10-23T10:00:00Z'))
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toEqual({
      ...claim,
      claimedAt: '2026-10-23T10:00:00.000Z',
      viewer: null,
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

  it("keeps the claimer's viewer label", () => {
    const viewer = { app: 'desktop', device: 'davion-sidarli' }
    recordSizeHolder('aaaaaaaa', { ...claim, viewer })
    expect(sizeHolderOf('aaaaaaaa', 'g1')?.viewer).toEqual(viewer)
  })
})

describe('viewer label', () => {
  it('accepts an app and a device name, or no label at all', () => {
    expect(parseViewerLabel(undefined)).toBeUndefined()
    expect(parseViewerLabel({ app: 'desktop', device: 'davion-sidarli' })).toEqual({
      app: 'desktop',
      device: 'davion-sidarli',
    })
    expect(parseViewerLabel({ app: 'web', device: 'Pixel 9 · Chrome' })).toEqual({
      app: 'web',
      device: 'Pixel 9 · Chrome',
    })
  })

  it.each([
    null,
    'desktop',
    [],
    { app: 'desktop' },
    { app: 'desktop', device: 'x', extra: 1 },
    { app: 'Desktop', device: 'x' },
    { app: 'desktop', device: '' },
    { app: 'desktop', device: ' padded ' },
    { app: 'desktop', device: 'a\nb' },
    { app: 'desktop', device: 'x'.repeat(65) },
    { app: 'desktop', device: 7 },
  ])('refuses %j', (value) => {
    expect(parseViewerLabel(value)).toBeNull()
  })
})
