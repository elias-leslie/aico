import type { SizeHolder } from 'tether/client'
import { describe, expect, it } from 'vitest'
import { createOwnerSurface } from './owner-surface'

const web = { app: 'web', device: 'Firefox on Linux' }
const desktop = { app: 'desktop', device: 'box' }

function holder(claimedAt: string, viewer: SizeHolder['viewer']): SizeHolder {
  return { clientPid: 1, cols: 80, rows: 24, generation: 'g', claimedAt, viewer }
}

describe('owner surface', () => {
  it('is the desktop until the web app claims a size, and again once an Aico window has focus', () => {
    const surface = createOwnerSurface()
    expect(surface.onDesktop()).toBe(true)
    surface.sizeHeld(web)
    expect(surface.onDesktop()).toBe(false)
    // The desktop claims for windows it arranges too: not the owner coming back.
    surface.sizeHeld(desktop)
    surface.sizeHeld(null)
    expect(surface.onDesktop()).toBe(false)
    surface.focused()
    expect(surface.onDesktop()).toBe(true)
  })

  it('seeds from the latest claim Tether remembers', async () => {
    const surface = createOwnerSurface()
    await surface.seed(async () => [
      holder('2026-10-29T12:00:00.000Z', desktop),
      null,
      holder('2026-10-29T12:30:00.000Z', web),
    ])
    expect(surface.onDesktop()).toBe(false)
    await surface.seed(async () => [holder('2026-10-29T12:40:00.000Z', desktop)])
    expect(surface.onDesktop()).toBe(true)
  })

  it('keeps what it knows when Tether knows no holder or fails', async () => {
    const surface = createOwnerSurface()
    surface.sizeHeld(web)
    await surface.seed(async () => [null])
    await surface.seed(async () => {
      throw new Error('tether down')
    })
    expect(surface.onDesktop()).toBe(false)
  })

  it('never lets a slower seed override a live signal', async () => {
    const surface = createOwnerSurface()
    let answer: (holders: SizeHolder[]) => void = () => {}
    const seeding = surface.seed(() => new Promise((resolve) => (answer = resolve)))
    surface.focused()
    answer([holder('2026-10-29T12:30:00.000Z', web)])
    await seeding
    expect(surface.onDesktop()).toBe(true)
  })
})
