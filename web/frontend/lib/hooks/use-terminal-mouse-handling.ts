import type { Terminal } from '@xterm/xterm'

/** Typed subset of xterm's internal core API used for mouse reporting detection. */
interface XtermCoreInternal {
  _core?: {
    coreMouseService?: {
      areMouseEventsActive: boolean
    }
  }
}

/**
 * Sets up mouse event handling for a terminal to enable local text selection
 * when mouse reporting is active in programs like tmux.
 *
 * When mouse reporting is enabled (detected via xterm's internal coreMouseService),
 * this intercepts mouse events and re-dispatches them with shiftKey=true to force
 * local selection instead of sending to the application.
 *
 * @param terminal - The xterm Terminal instance
 * @param container - The DOM element containing the terminal
 * @returns Cleanup function to remove event listeners
 */
export function setupTerminalMouseHandling(
  terminal: Terminal,
  container: HTMLElement,
): () => void {
  const forceLocalMouseHandling = (e: MouseEvent) => {
    if (e.shiftKey) return // Already has shift (including our synthetic events), let it through
    if (!e.isTrusted) return // Skip synthetic events to prevent loops

    // Check if mouse reporting is enabled via xterm internal API
    const core = (terminal as unknown as XtermCoreInternal)._core
    const mouseService = core?.coreMouseService
    const mouseActive = mouseService?.areMouseEventsActive

    if (!mouseActive) {
      // Mouse reporting not enabled, let event pass through normally
      return
    }

    // Mouse reporting is enabled - intercept and force local handling
    e.stopPropagation()
    e.preventDefault()

    // Create new event with shiftKey=true
    const newEvent = new MouseEvent(e.type, {
      bubbles: e.bubbles,
      cancelable: e.cancelable,
      view: e.view,
      detail: e.detail,
      screenX: e.screenX,
      screenY: e.screenY,
      clientX: e.clientX,
      clientY: e.clientY,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: true, // Force shiftKey for local selection
      metaKey: e.metaKey,
      button: e.button,
      buttons: e.buttons,
      relatedTarget: e.relatedTarget,
    })

    e.target?.dispatchEvent(newEvent)
  }

  // Attach listeners in capture phase to intercept before xterm processes them
  container.addEventListener('mousedown', forceLocalMouseHandling, {
    capture: true,
  })
  container.addEventListener('mouseup', forceLocalMouseHandling, {
    capture: true,
  })
  container.addEventListener('mousemove', forceLocalMouseHandling, {
    capture: true,
  })

  // Return cleanup function
  return () => {
    container.removeEventListener('mousedown', forceLocalMouseHandling, {
      capture: true,
    })
    container.removeEventListener('mouseup', forceLocalMouseHandling, {
      capture: true,
    })
    container.removeEventListener('mousemove', forceLocalMouseHandling, {
      capture: true,
    })
  }
}
