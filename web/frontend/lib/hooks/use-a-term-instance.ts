import { useEffect, useRef, useState } from 'react'
import {
  type ATermInstanceOptions,
  type ATermInstanceRefs,
  createATermWithAddons,
  type FocusPasteCleanup,
  installBootstrapWheelBlocker,
  loadXtermModules,
  replaceScrollingHandlers,
  setupFocusAndPasteTracking,
  setupMobileATerm,
  setupMobileContextMenuPaste,
  setupScrollbarAutoHide,
} from './a-term-instance-utils'
import { setupATermMouseHandling } from './use-a-term-mouse-handling'

export type {
  ATermInstanceOptions,
  ATermInstanceRefs,
} from './a-term-instance-utils'
// Re-export public API used by tests and other consumers
export {
  installBootstrapWheelBlocker,
  replaceScrollingHandlers,
} from './a-term-instance-utils'

/**
 * Hook to manage xterm.js aTerm instance initialization and lifecycle.
 *
 * Architecture: Two separate effects handle init vs. settings updates:
 * - Init effect: Runs once to create the aTerm, load addons, set up event
 *   listeners. Reads current settings from a ref to avoid re-running when
 *   settings change (which would destroy and recreate the entire aTerm).
 * - Settings effect: Applies incremental settings changes (font, theme, etc.)
 *   directly to the existing aTerm instance via xterm.js options API.
 */
export function useATermInstance(
  options: ATermInstanceOptions,
  refs: ATermInstanceRefs,
) {
  const { aTermRef, fitAddonRef, containerRef, isFocusedRef } = refs
  const [isReady, setIsReady] = useState(false)
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const mouseCleanupRef = useRef<(() => void) | null>(null)
  const scrollCleanupRef = useRef<{
    wheelCleanup: () => void
    touchCleanup: () => void
  } | null>(null)
  const focusPasteCleanupRef = useRef<FocusPasteCleanup | null>(null)
  const contextMenuPasteCleanupRef = useRef<(() => void) | null>(null)
  const scrollbarCleanupRef = useRef<(() => void) | null>(null)
  const bootstrapWheelCleanupRef = useRef<(() => void) | null>(null)

  // Store options in ref so init effect reads current values without
  // depending on them (prevents aTerm destruction on settings change)
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const setupScrollingRef = useRef(options.setupScrolling)
  useEffect(() => {
    setupScrollingRef.current = options.setupScrolling
  }, [options.setupScrolling])

  // Initialize aTerm -- runs once when container is available.
  useEffect(() => {
    let mounted = true
    setIsReady(false)

    async function initATerm() {
      if (!containerRef.current) return

      bootstrapWheelCleanupRef.current = installBootstrapWheelBlocker(
        containerRef.current,
      )

      const modules = await loadXtermModules()
      if (!mounted) return

      const opts = optionsRef.current
      const { term, fitAddon } = createATermWithAddons(modules, opts)
      if (!mounted) return

      if (!containerRef.current) return
      term.open(containerRef.current)
      if (!mounted) return

      mouseCleanupRef.current = setupATermMouseHandling(
        term,
        containerRef.current,
      )
      aTermRef.current = term
      fitAddonRef.current = fitAddon

      scrollCleanupRef.current = replaceScrollingHandlers(
        containerRef.current,
        setupScrollingRef.current,
        scrollCleanupRef.current,
      )
      if (bootstrapWheelCleanupRef.current) {
        bootstrapWheelCleanupRef.current()
        bootstrapWheelCleanupRef.current = null
      }

      scrollbarCleanupRef.current = setupScrollbarAutoHide(containerRef.current)
      setupMobileATerm(containerRef.current)
      contextMenuPasteCleanupRef.current = setupMobileContextMenuPaste(
        containerRef.current,
        opts.onPaste,
      )
      fitAddon.fit()
      setIsReady(true)

      if (term.textarea) {
        focusPasteCleanupRef.current = setupFocusAndPasteTracking(
          term.textarea,
          isFocusedRef,
          opts.onPaste,
        )
      }

      onDataDisposableRef.current = term.onData(opts.onData)
    }

    initATerm()

    return () => {
      mounted = false
      onDataDisposableRef.current?.dispose()
      onDataDisposableRef.current = null
      focusPasteCleanupRef.current?.focusCleanup()
      focusPasteCleanupRef.current?.pasteCleanup()
      focusPasteCleanupRef.current = null
      contextMenuPasteCleanupRef.current?.()
      contextMenuPasteCleanupRef.current = null
      mouseCleanupRef.current?.()
      mouseCleanupRef.current = null
      scrollbarCleanupRef.current?.()
      scrollbarCleanupRef.current = null
      if (scrollCleanupRef.current) {
        scrollCleanupRef.current.wheelCleanup()
        scrollCleanupRef.current.touchCleanup()
        scrollCleanupRef.current = null
      }
      bootstrapWheelCleanupRef.current?.()
      bootstrapWheelCleanupRef.current = null
      if (aTermRef.current) {
        aTermRef.current.dispose()
        aTermRef.current = null
      }
      fitAddonRef.current = null
      isFocusedRef.current = false
    }
  }, [containerRef, aTermRef, fitAddonRef, isFocusedRef])

  useEffect(() => {
    if (!containerRef.current || !aTermRef.current) return
    scrollCleanupRef.current = replaceScrollingHandlers(
      containerRef.current,
      options.setupScrolling,
      scrollCleanupRef.current,
    )
  }, [containerRef, options.setupScrolling, aTermRef])

  // Apply incremental settings changes to existing aTerm
  useEffect(() => {
    if (!aTermRef.current) return
    aTermRef.current.options.fontFamily = options.fontFamily
    aTermRef.current.options.fontSize = options.fontSize
    aTermRef.current.options.scrollback = options.scrollback
    aTermRef.current.options.cursorStyle = options.cursorStyle
    aTermRef.current.options.cursorBlink = options.cursorBlink
    aTermRef.current.options.theme = options.theme
    fitAddonRef.current?.fit()
  }, [
    options.fontFamily,
    options.fontSize,
    options.scrollback,
    options.cursorStyle,
    options.cursorBlink,
    options.theme,
    aTermRef,
    fitAddonRef,
  ])

  return { isReady }
}
