'use client'

import { createContext, useContext, useEffect } from 'react'
import { useFrame, type Widen } from './FrameContext'

export type { Widen }

/** A host that widens itself (a rail pop-out); without one the side panel widens. */
export const WidenContext = createContext<Widen | null>(null)

/** While `active`, the place this sits in (the side panel, or the rail pop-out around it) is wider; it
 * goes back when `active` ends or the content leaves. For an expanded item that needs room after pruning. */
export function useWiden(active: boolean): void {
  const host = useContext(WidenContext)
  const frame = useFrame()
  const widen = host ?? frame?.widen ?? null
  useEffect(() => {
    if (!active || !widen) return
    return widen()
  }, [active, widen])
}
