import { useEffect, useRef, useState } from 'react'
import { setupATermMouseHandling } from './use-aterm-mouse-handling'
import {
  type ATermInstanceOptions,
  type ATermInstanceRefs,
  type FocusPasteCleanup,
  installBootstrapWheelBlocker,
  replaceScrollingHandlers,
  setupScrollbarAutoHide,
  setupMobileATerm,
  setupMobileContextMenuPaste,
  setupFocusAndPasteTracking,
  loadXtermModules,
  createATermWithAddons,
} from './aterm-instance-utils'

// Re-export public API used by tests and other consumers
export {
  installBootstrapWheelBlocker,
  replaceScrollingHandlers,
} from './aterm-instance-utils'
export type {
  ATermInstanceOptions,
  ATermInstanceRefs,
} from './aterm-instance-utils'

/**
 * Hook to manage xterm.js aterm instance initialization and lifecycle.
 *
 * Architecture: Two separate effects handle init vs. settings updates:
 * - Init effect: Runs once to create the aterm, load addons, set up event
 *   listeners. Reads current settings from a ref to avoid re-running when
 *   settings change (which would destroy and recreate the entire aterm).
 * - Settings effect: Applies incremental settings changes (font, theme, etc.)
 *   directly to the existing aterm instance via xterm.js options API.
 */
export function useATermInstance(
  options: ATermInstanceOptions,
  refs: ATermInstanceRefs,
) {
  const { atermRef, fitAddonRef, containerRef, isFocusedRef } = refs
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
  // depending on them (prevents aterm destruction on settings change)
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const setupScrollingRef = useRef(options.setupScrolling)
  useEffect(() => {
    setupScrollingRef.current = options.setupScrolling
  }, [options.setupScrolling])

  // Initialize aterm -- runs once when container is available.
  useEffect(() => {
    let mounted = true
    setIsReady(false)

    async function initATerm() {
      if (!containerRef.current) return

      bootstrapWheelCleanupRef.current =
        installBootstrapWheelBlocker(containerRef.current)

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
      atermRef.current = term
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
      if (atermRef.current) {
        atermRef.current.dispose()
        atermRef.current = null
      }
      fitAddonRef.current = null
      isFocusedRef.current = false
    }
  }, [containerRef, atermRef, fitAddonRef, isFocusedRef])

  useEffect(() => {
    if (!containerRef.current || !atermRef.current) return
    scrollCleanupRef.current = replaceScrollingHandlers(
      containerRef.current,
      options.setupScrolling,
      scrollCleanupRef.current,
    )
  }, [containerRef, options.setupScrolling, atermRef])

  // Apply incremental settings changes to existing aterm
  useEffect(() => {
    if (!atermRef.current) return
    atermRef.current.options.fontFamily = options.fontFamily
    atermRef.current.options.fontSize = options.fontSize
    atermRef.current.options.scrollback = options.scrollback
    atermRef.current.options.cursorStyle = options.cursorStyle
    atermRef.current.options.cursorBlink = options.cursorBlink
    atermRef.current.options.theme = options.theme
    fitAddonRef.current?.fit()
  }, [
    options.fontFamily,
    options.fontSize,
    options.scrollback,
    options.cursorStyle,
    options.cursorBlink,
    options.theme,
    atermRef,
    fitAddonRef,
  ])

  return { isReady }
}
