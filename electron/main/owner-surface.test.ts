import type { SizeHolder } from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { createOwnerSurface, DESKTOP_SINCE } from './owner-surface'

const web = { app: 'web', device: 'Chrome on Linux' }
const desktop = { app: 'desktop', device: 'box' }

function holder(claimedAt: string, viewer: SizeHolder['viewer']): SizeHolder {
  return { clientPid: 1, cols: 80, rows: 24, generation: 'g', claimedAt, viewer }
}

function setup(since?: string) {
  const settings = new Map<string, string>(since ? [[DESKTOP_SINCE, since]] : [])
  const setSetting = vi.fn((key: string, value: string) => void settings.set(key, value))
  const surface = createOwnerSurface({
    getSetting: (key) => settings.get(key),
    setSetting,
    now: () => new Date('2026-10-29T13:00:00.000Z'),
  })
  return { surface, settings, setSetting }
}

describe('owner surface', () => {
  it('is the desktop until the web app claims a size, and again once the owner uses an Aico window', () => {
    const { surface } = setup()
    expect(surface.onDesktop()).toBe(true)
    surface.sizeHeld(web)
    expect(surface.onDesktop()).toBe(false)
    // The desktop claims for windows it shows or arranges too: not the owner coming back.
    surface.sizeHeld(desktop)
    surface.sizeHeld(null)
    expect(surface.onDesktop()).toBe(false)
    surface.used()
    expect(surface.onDesktop()).toBe(true)
  })

  it('records when the owner came back to the desktop once per stretch, not per key', () => {
    const { surface, settings, setSetting } = setup()
    surface.used()
    surface.used()
    expect(setSetting).toHaveBeenCalledTimes(1)
    expect(settings.get(DESKTOP_SINCE)).toBe('2026-10-29T13:00:00.000Z')
    surface.sizeHeld(web)
    surface.used()
    expect(setSetting).toHaveBeenCalledTimes(2)
  })

  it('at launch, a web claim after the owner last used the desktop means the web app', async () => {
    const { surface } = setup('2026-10-29T12:00:00.000Z')
    // The desktop's own claims, even the latest, say nothing.
    await surface.seed(async () => [
      holder('2026-10-29T12:30:00.000Z', web),
      null,
      holder('2026-10-29T12:40:00.000Z', desktop),
    ])
    expect(surface.onDesktop()).toBe(false)
  })

  it('at launch, stays on the desktop when every web claim is older, or none is known', async () => {
    const older = setup('2026-10-29T12:45:00.000Z')
    await older.surface.seed(async () => [holder('2026-10-29T12:30:00.000Z', web)])
    expect(older.surface.onDesktop()).toBe(true)
    const failed = setup()
    await failed.surface.seed(async () => {
      throw new Error('tether down')
    })
    expect(failed.surface.onDesktop()).toBe(true)
  })

  it('never lets a slower seed override a live signal', async () => {
    const { surface } = setup()
    let answer: (holders: SizeHolder[]) => void = () => {}
    const seeding = surface.seed(() => new Promise((resolve) => (answer = resolve)))
    surface.used()
    answer([holder('2026-10-29T12:30:00.000Z', web)])
    await seeding
    expect(surface.onDesktop()).toBe(true)
  })
})
