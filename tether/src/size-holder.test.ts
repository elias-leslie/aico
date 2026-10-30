import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetSizeHolder,
  parseViewerLabel,
  persistSizeHolders,
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

describe('saved size holders', () => {
  beforeEach(resetSizeHolders)

  function memory(initial: string | null = null) {
    let value = initial
    return {
      read: () => value,
      write: (next: string) => {
        value = next
      },
      get: () => value,
    }
  }

  it('survive a restart, so the real holder keeps the window', () => {
    const saved = memory()
    persistSizeHolders(saved, () => true)
    const viewer = { app: 'web', device: 'Pixel 9' }
    recordSizeHolder('aaaaaaaa', { ...claim, viewer }, () => new Date('2026-10-30T10:00:00Z'))

    resetSizeHolders() // Tether restarts: memory is empty
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toBeNull()
    persistSizeHolders(saved, () => true)
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toEqual({
      ...claim,
      viewer,
      claimedAt: '2026-10-30T10:00:00.000Z',
    })
  })

  it('drop a holder whose session is gone, replaced or unreadable', () => {
    const holder = { ...claim, claimedAt: '2026-10-30T10:00:00.000Z', viewer: null }
    const saved = memory(
      JSON.stringify({
        aaaaaaaa: holder,
        bbbbbbbb: holder,
        cccccccc: { ...holder, clientPid: 'x' },
        dddddddd: { ...holder, viewer: { app: 'Desktop', device: 'x' } },
      }),
    )
    persistSizeHolders(saved, (id) => id !== 'bbbbbbbb')
    expect(Object.keys(JSON.parse(saved.get() ?? '{}'))).toEqual(['aaaaaaaa'])
    expect(sizeHolderOf('aaaaaaaa', 'g2')).toBeNull()
    expect(JSON.parse(saved.get() ?? '')).toEqual({})
  })

  it('start empty from a value that does not parse', () => {
    persistSizeHolders(memory('{nope'), () => true)
    expect(sizeHolderOf('aaaaaaaa', 'g1')).toBeNull()
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
