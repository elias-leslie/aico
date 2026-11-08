'use client'

import { createContext } from 'react'
import type { Widen } from './FrameContext'

export type { Widen }

/** A host that widens itself (a rail pop-out); without one the side panel widens. */
export const WidenContext = createContext<Widen | null>(null)
