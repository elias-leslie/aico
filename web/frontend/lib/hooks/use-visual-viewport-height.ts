'use client'

import { useEffect } from 'react'

const VIEWPORT_HEIGHT_VAR = '--a-term-viewport-height'

function getViewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

export function useVisualViewportHeight() {
  useEffect(() => {
    let frame: number | null = null

    const syncViewportHeight = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        frame = null
        document.documentElement.style.setProperty(
          VIEWPORT_HEIGHT_VAR,
          `${Math.round(getViewportHeight())}px`,
        )
      })
    }

    syncViewportHeight()
    window.addEventListener('resize', syncViewportHeight, { passive: true })
    window.addEventListener('orientationchange', syncViewportHeight, {
      passive: true,
    })
    window.visualViewport?.addEventListener('resize', syncViewportHeight, {
      passive: true,
    })
    window.visualViewport?.addEventListener('scroll', syncViewportHeight, {
      passive: true,
    })

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      window.removeEventListener('resize', syncViewportHeight)
      window.removeEventListener('orientationchange', syncViewportHeight)
      window.visualViewport?.removeEventListener('resize', syncViewportHeight)
      window.visualViewport?.removeEventListener('scroll', syncViewportHeight)
      document.documentElement.style.removeProperty(VIEWPORT_HEIGHT_VAR)
    }
  }, [])
}
