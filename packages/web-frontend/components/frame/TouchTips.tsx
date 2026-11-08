'use client'

import { useEffect, useState } from 'react'
import styles from './TouchTips.module.css'

/** How long a finger stays down before a held control shows its tip. */
const HOLD_MS = 450
/** A finger that moves this far is scrolling, not holding. */
const MOVE_PX = 10
const ACTS_ON_TAP =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[tabindex]'

interface Tip {
  text: string
  x: number
  y: number
  from: Element
}

/**
 * Tooltips for a finger: the app's `title` text has no hover on a touch screen. A badge or label
 * shows it on a tap; anything a tap acts on shows it on a hold, and that hold doesn't also act.
 * The next touch or a scroll closes it.
 */
export function TouchTips() {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let hold: number | undefined
    let down: Tip | null = null
    let shown: Element | null = null
    let held = false
    const show = (next: Tip) => {
      shown = next.from
      setTip(next)
    }
    const close = () => {
      shown = null
      setTip(null)
    }
    const cancel = () => {
      window.clearTimeout(hold)
      down = null
    }
    const onDown = (event: PointerEvent) => {
      const open = shown
      close()
      cancel()
      held = false
      if (event.pointerType !== 'touch' || !(event.target instanceof Element))
        return
      const from = event.target.closest('[title]')
      const text = from?.getAttribute('title')?.trim()
      if (!from || !text) return
      const next = { text, x: event.clientX, y: event.clientY, from }
      hold = window.setTimeout(() => {
        down = null
        held = true
        show(next)
      }, HOLD_MS)
      // A second tap on the one showing just closes it.
      down = open === from ? null : next
    }
    const onMove = (event: PointerEvent) => {
      if (!down) return
      const far = Math.hypot(event.clientX - down.x, event.clientY - down.y)
      if (far > MOVE_PX) cancel()
    }
    const onUp = (event: PointerEvent) => {
      const tapped = down
      cancel()
      if (tapped && !(event.target as Element).closest?.(ACTS_ON_TAP))
        show(tapped)
    }
    // The hold was for the tip: it doesn't press the button or open the browser's menu too.
    const onClick = (event: MouseEvent) => {
      if (!held) return
      held = false
      event.preventDefault()
      event.stopPropagation()
    }
    const onMenu = (event: Event) => {
      if (held) event.preventDefault()
    }
    const onScroll = () => {
      cancel()
      close()
    }
    const listen: [string, EventListener][] = [
      ['pointerdown', onDown as EventListener],
      ['pointermove', onMove as EventListener],
      ['pointerup', onUp as EventListener],
      ['pointercancel', cancel],
      ['click', onClick as EventListener],
      ['contextmenu', onMenu],
      ['scroll', onScroll],
    ]
    for (const [type, handler] of listen)
      window.addEventListener(type, handler, { capture: true, passive: false })
    return () => {
      cancel()
      for (const [type, handler] of listen)
        window.removeEventListener(type, handler, { capture: true })
    }
  }, [])

  if (!tip) return null
  // Above the finger, unless that would run off the top; kept inside the screen's edges.
  const above = tip.y > 140
  return (
    <div
      role="tooltip"
      className={styles.tip}
      style={{
        left: `clamp(12px, ${tip.x - 140}px, calc(100vw - 292px))`,
        ...(above
          ? { bottom: window.innerHeight - tip.y + 18 }
          : { top: tip.y + 28 }),
      }}
    >
      {tip.text}
    </div>
  )
}
