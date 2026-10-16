// The eyes and the titlebar arcade, main's half: the cursor pump that feeds
// both, the gaze scenes where windows look at each other (gaze.ts), the urgent
// looks at a window waiting too long, and which window shows which game
// (arcade.ts). They share the cursor pump, so they live together.

import type { BrowserWindow, IpcMain, Screen } from 'electron'
import { cursorNearTitlebar, nextArcade, parseArcadeKeys, pickArcade } from './arcade'
import {
  allLookAt,
  DEFAULT_EYE_ANCHOR,
  type Face,
  type Point,
  pickScene,
  SCENE_EVERY_MS,
} from './gaze'
import type { WindowRegistry } from './window-registry'

/** Every ~20 s, the other windows' eyes turn to each window waiting 2+ minutes. */
const URGENT_LOOK_EVERY_MS = 20_000

interface AmbientDeps {
  registry: Pick<WindowRegistry, 'sessionOf' | 'forSession' | 'sessionWindows' | 'senderWindow'>
  windowById(id: number): BrowserWindow | null
  allWindows(): BrowserWindow[]
  focusedWindow(): BrowserWindow | null
  screen: Pick<Screen, 'getCursorScreenPoint'>
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  /** Sessions blocked two minutes unseen (attention.ts `urgent`). */
  urgent(): string[]
  isQuitting(): boolean
  random?: () => number
}

export function createAmbient(deps: AmbientDeps) {
  const { registry, screen } = deps
  const random = deps.random ?? Math.random

  // Eyes-follow-cursor: while any widget is unfocused, broadcast the global cursor
  // position so those widgets' eyes can track it. One shared interval feeds every
  // window; the focused window ignores it and stares ahead. Windows running the
  // titlebar arcade also get the cursor (window coordinates, focused or not) while
  // it is near their titlebar: the titlebar is the OS drag region, so the page
  // itself never sees the pointer there. Runs only while someone needs it.
  const blurredWins = new Set<number>()
  // Window id -> titlebar arcade game, kept for the window's lifetime (or until
  // the user cycles it), and the games that window has shown this cycle.
  const arcadeOf = new Map<number, string>()
  const arcadeShown = new Map<number, Set<string>>()
  const arcadeNear = new Set<number>()
  let cursorTimer: NodeJS.Timeout | undefined
  let cursorPeriod = 0
  let lastCursorPt: { x: number; y: number } | null = null
  function pumpCursor(): void {
    const pt = screen.getCursorScreenPoint()
    if (lastCursorPt && pt.x === lastCursorPt.x && pt.y === lastCursorPt.y) return
    lastCursorPt = pt
    for (const id of blurredWins) {
      const win = deps.windowById(id)
      if (win && !win.isDestroyed()) win.webContents.send('win:cursor', pt)
    }
    for (const id of arcadeOf.keys()) {
      const win = deps.windowById(id)
      if (!win || win.isDestroyed() || !win.isVisible()) continue
      const near = cursorNearTitlebar(pt, win.getContentBounds())
      if (near) arcadeNear.add(id)
      else if (!arcadeNear.delete(id)) continue // already told it the cursor left
      win.webContents.send('arcade:cursor', near)
    }
  }
  function syncCursorPump(): void {
    lastCursorPt = null // a focus change always gets one fresh send
    const period = arcadeOf.size > 0 ? 100 : blurredWins.size > 0 ? 250 : 0
    if (period === cursorPeriod) return
    if (cursorTimer) clearInterval(cursorTimer)
    cursorTimer = period ? setInterval(pumpCursor, period) : undefined
    cursorPeriod = period
  }

  // -------------------------------------------------------------------------
  // Gaze (see gaze.ts): eyes that look at the other windows.

  const eyeAnchors = new Map<number, Point>()
  let gazeTimer: ReturnType<typeof setTimeout> | undefined

  function faces(): Face[] {
    const focused = deps.focusedWindow()
    return registry
      .sessionWindows()
      .filter((w) => w.isVisible() && !w.isMinimized())
      .map((w) => {
        const b = w.getContentBounds()
        const a = eyeAnchors.get(w.id) ?? DEFAULT_EYE_ANCHOR
        return { winId: w.id, eye: { x: b.x + a.x, y: b.y + a.y }, focused: w === focused }
      })
  }

  let gazeScenesLogged = 0
  function playGazeScene(): void {
    const scene = pickScene(faces(), random)
    // The first few scenes after start go to the log, proof the director runs.
    if (scene.length && gazeScenesLogged < 3) {
      gazeScenesLogged++
      const who = (winId: number) => registry.sessionOf(winId) ?? String(winId)
      console.log(`[aico:gaze] scene ${scene.map((g) => who(g.winId)).join(' ')}`)
    }
    for (const g of scene) {
      const win = deps.windowById(g.winId)
      if (!win || win.isDestroyed()) continue
      win.webContents.send('eyes:look', {
        x: g.target.x,
        y: g.target.y,
        delay: g.delay,
        hold: g.hold,
      })
    }
  }

  function scheduleGaze(): void {
    const [lo, hi] = SCENE_EVERY_MS
    gazeTimer = setTimeout(
      () => {
        if (deps.isQuitting()) return
        playGazeScene()
        scheduleGaze()
      },
      lo + random() * (hi - lo),
    )
  }

  function lookAtUrgent(): void {
    const all = faces()
    for (const id of deps.urgent()) {
      const win = registry.forSession(id)
      const star = win && all.find((f) => f.winId === win.id)
      if (!star) continue
      for (const g of allLookAt(star, all, random, false)) {
        deps.windowById(g.winId)?.webContents.send('eyes:look', {
          x: g.target.x,
          y: g.target.y,
          delay: g.delay,
          hold: g.hold,
        })
      }
    }
  }

  // Titlebar arcade on or off, for every window (one row in aico.db). Off, no
  // window runs a game and the cursor pump stops for them.
  const arcadeOn = (): boolean => deps.getSetting('arcade') !== 'off'

  return {
    /** The first gaze scene in 20-45 s, then one every 20-45 s until quit. */
    start: scheduleGaze,
    /** Urgent looks every 20 s, unref'd; started at module evaluation, as before the split. */
    startUrgentLooks: (): void => {
      setInterval(lookAtUrgent, URGENT_LOOK_EVERY_MS).unref()
    },
    /** Quit: the gaze timer only (the cursor pump and urgent looks are left, as before). */
    stop: (): void => {
      if (gazeTimer) clearTimeout(gazeTimer)
    },
    focused: (winId: number): void => {
      blurredWins.delete(winId)
      syncCursorPump()
    },
    blurred: (winId: number): void => {
      blurredWins.add(winId)
      syncCursorPump()
    },
    /** The window is gone: its eyes, game and cursor feed. */
    forget: (winId: number): void => {
      blurredWins.delete(winId)
      arcadeOf.delete(winId)
      arcadeShown.delete(winId)
      arcadeNear.delete(winId)
      eyeAnchors.delete(winId)
      syncCursorPump()
    },
    registerIpc: (ipcMain: Pick<IpcMain, 'on' | 'handle'>): void => {
      ipcMain.on('eyes:anchor', (event, pt: unknown) => {
        const win = registry.senderWindow(event.sender)
        const p = pt as Partial<Point> | null
        if (!win || typeof p?.x !== 'number' || typeof p.y !== 'number') return
        if (
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          Math.abs(p.x) > 4000 ||
          Math.abs(p.y) > 4000
        )
          return
        eyeAnchors.set(win.id, { x: Math.round(p.x), y: Math.round(p.y) })
      })
      ipcMain.handle('arcade:enabled', () => arcadeOn())
      ipcMain.on('arcade:toggle', () => {
        const on = !arcadeOn()
        deps.setSetting('arcade', on ? 'on' : 'off')
        if (!on) {
          arcadeOf.clear()
          arcadeShown.clear()
          arcadeNear.clear()
          syncCursorPump()
        }
        for (const win of deps.allWindows()) win.webContents.send('arcade:enabled', on)
      })
      // Titlebar arcade: the renderer lists the games it ships; main picks one this
      // window keeps (reloads included) until it closes.
      ipcMain.handle('arcade:assign', (event, keys: unknown) => {
        const win = registry.senderWindow(event.sender)
        const known = parseArcadeKeys(keys)
        if (!win || !known || !arcadeOn()) return null
        const current = arcadeOf.get(win.id)
        if (current && known.includes(current)) return current
        arcadeOf.delete(win.id)
        const key = pickArcade(known, arcadeOf.values())
        if (key) {
          arcadeOf.set(win.id, key)
          arcadeShown.set(win.id, new Set([key]))
        }
        syncCursorPump()
        return key
      })
      // "Choose game" from the lantern menu: this game, in this window. Picking one
      // while the games are off turns them back on.
      ipcMain.handle('arcade:pick', (event, pick: unknown, keys: unknown) => {
        const win = registry.senderWindow(event.sender)
        const known = parseArcadeKeys(keys)
        if (!win || !known || typeof pick !== 'string' || !known.includes(pick)) return null
        arcadeOf.set(win.id, pick)
        arcadeShown.set(win.id, new Set([...(arcadeShown.get(win.id) ?? []), pick]))
        syncCursorPump()
        if (!arcadeOn()) {
          deps.setSetting('arcade', 'on')
          for (const w of deps.allWindows()) w.webContents.send('arcade:enabled', true)
        }
        return pick
      })
      // "Next game" from the lantern menu: another game this window hasn't shown
      // yet and no other window is showing (while one is free).
      ipcMain.handle('arcade:next', (event, keys: unknown) => {
        const win = registry.senderWindow(event.sender)
        const known = parseArcadeKeys(keys)
        if (!win || !known || !arcadeOn()) return null
        const current = arcadeOf.get(win.id)
        const others = [...arcadeOf].filter(([id]) => id !== win.id).map(([, k]) => k)
        const shown = arcadeShown.get(win.id) ?? new Set(current ? [current] : [])
        const next = nextArcade(known, current, others, shown)
        if (!next.key) return null
        arcadeOf.set(win.id, next.key)
        arcadeShown.set(win.id, next.shown)
        syncCursorPump()
        return next.key
      })
    },
  }
}
