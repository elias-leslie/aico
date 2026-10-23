import { useEffect, useRef, useState } from 'react'
import { LANTERN_MONO_FACE } from '../constants/lantern'
import { setupMobileNativeSelection } from './mobile-native-selection'
import {
  collectTerminalRendererStatus,
  createTerminalWithAddons,
  type FocusPasteCleanup,
  installBootstrapWheelBlocker,
  loadWebglRenderer,
  loadXtermModules,
  replaceScrollingHandlers,
  setupFocusAndPasteTracking,
  setupMobileTerminal,
  setupScrollbarAutoHide,
  type TerminalInstanceOptions,
  type TerminalInstanceRefs,
} from './terminal-instance-utils'
import { setupTerminalMouseHandling } from './use-terminal-mouse-handling'

export type {
  TerminalInstanceOptions,
  TerminalInstanceRefs,
} from './terminal-instance-utils'
// Re-export public API used by tests and other consumers
export {
  installBootstrapWheelBlocker,
  replaceScrollingHandlers,
} from './terminal-instance-utils'

/**
 * Hook to manage xterm.js terminal instance initialization and lifecycle.
 *
 * Architecture: Two separate effects handle init vs. settings updates:
 * - Init effect: Runs once to create the terminal, load addons, set up event
 *   listeners. Reads current settings from a ref to avoid re-running when
 *   settings change (which would destroy and recreate the entire terminal).
 * - Settings effect: Applies incremental settings changes (font, theme, etc.)
 *   directly to the existing terminal instance via xterm.js options API.
 */
export function useTerminalInstance(
  options: TerminalInstanceOptions,
  refs: TerminalInstanceRefs,
) {
  const { terminalRef, fitAddonRef, containerRef, isFocusedRef } = refs
  const [isReady, setIsReady] = useState(false)
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const mouseCleanupRef = useRef<(() => void) | null>(null)
  const scrollCleanupRef = useRef<{
    wheelCleanup: () => void
    touchCleanup: () => void
  } | null>(null)
  const focusPasteCleanupRef = useRef<FocusPasteCleanup | null>(null)
  const nativeSelectionCleanupRef = useRef<(() => void) | null>(null)
  const scrollbarCleanupRef = useRef<(() => void) | null>(null)
  const bootstrapWheelCleanupRef = useRef<(() => void) | null>(null)
  const webglDisposeRef = useRef<(() => void) | null>(null)

  // Store options in ref so init effect reads current values without
  // depending on them (prevents terminal destruction on settings change)
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const setupScrollingRef = useRef(options.setupScrolling)
  useEffect(() => {
    setupScrollingRef.current = options.setupScrolling
  }, [options.setupScrolling])

  // Initialize terminal -- runs once when container is available.
  useEffect(() => {
    let mounted = true
    setIsReady(false)

    async function initTerminal() {
      if (!containerRef.current) return

      bootstrapWheelCleanupRef.current = installBootstrapWheelBlocker(
        containerRef.current,
      )

      const modules = await loadXtermModules()
      if (!mounted) return

      const opts = optionsRef.current
      // The webfont must be loaded before xterm measures its glyph cell, or
      // the view renders at fallback metrics and misaligns once it swaps in.
      try {
        await Promise.all([
          document.fonts?.load(`${opts.fontSize}px '${LANTERN_MONO_FACE}'`),
          document.fonts?.load(
            `bold ${opts.fontSize}px '${LANTERN_MONO_FACE}'`,
          ),
        ])
      } catch {
        /* render with whatever font is available */
      }
      if (!mounted) return

      const { term, fitAddon } = createTerminalWithAddons(modules, opts)
      if (!mounted) return

      if (!containerRef.current) return
      term.open(containerRef.current)
      if (!mounted) return

      // WebGL must load after term.open() so the canvas exists. On failure or
      // context loss, xterm transparently falls back to the DOM renderer.
      webglDisposeRef.current = loadWebglRenderer(term, modules)

      mouseCleanupRef.current = setupTerminalMouseHandling(
        term,
        containerRef.current,
      )
      terminalRef.current = term
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
      setupMobileTerminal(containerRef.current)
      nativeSelectionCleanupRef.current = setupMobileNativeSelection(
        term,
        containerRef.current,
        { onPaste: opts.onPaste, onFilePaste: opts.onFilePaste },
      )
      fitAddon.fit()
      window.setTimeout(() => {
        if (!mounted || terminalRef.current !== term) return
        opts.onRendererStatus?.(
          collectTerminalRendererStatus(term, !!webglDisposeRef.current),
        )
      }, 0)
      setIsReady(true)

      if (term.textarea) {
        focusPasteCleanupRef.current = setupFocusAndPasteTracking(
          term.textarea,
          isFocusedRef,
          opts.onPaste,
          opts.onFilePaste,
        )
      }

      onDataDisposableRef.current = term.onData(opts.onData)
    }

    initTerminal()

    return () => {
      mounted = false
      onDataDisposableRef.current?.dispose()
      onDataDisposableRef.current = null
      focusPasteCleanupRef.current?.focusCleanup()
      focusPasteCleanupRef.current?.pasteCleanup()
      focusPasteCleanupRef.current = null
      nativeSelectionCleanupRef.current?.()
      nativeSelectionCleanupRef.current = null
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
      // Dispose the WebGL addon before the term so it can release the GL
      // context cleanly; term.dispose() would do it implicitly but explicit
      // ordering avoids edge-case warnings on some drivers.
      webglDisposeRef.current?.()
      webglDisposeRef.current = null
      if (terminalRef.current) {
        terminalRef.current.dispose()
        terminalRef.current = null
      }
      fitAddonRef.current = null
      isFocusedRef.current = false
    }
  }, [containerRef, terminalRef, fitAddonRef, isFocusedRef])

  useEffect(() => {
    if (!containerRef.current || !terminalRef.current) return
    scrollCleanupRef.current = replaceScrollingHandlers(
      containerRef.current,
      options.setupScrolling,
      scrollCleanupRef.current,
    )
  }, [containerRef, options.setupScrolling, terminalRef])

  // Apply incremental settings changes to existing terminal
  useEffect(() => {
    if (!terminalRef.current) return
    terminalRef.current.options.fontSize = options.fontSize
    terminalRef.current.options.scrollback = options.scrollback
    fitAddonRef.current?.fit()
  }, [options.fontSize, options.scrollback, terminalRef, fitAddonRef])

  return { isReady }
}
