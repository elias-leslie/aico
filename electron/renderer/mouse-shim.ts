import type { Terminal } from '@xterm/xterm'

/** xterm's internal mouse-reporting flag — true while a TUI grabs the mouse. */
interface XtermCoreInternal {
  _core?: { coreMouseService?: { areMouseEventsActive: boolean } }
}

let warnedMissingCore = false

/**
 * True when the program in the terminal (e.g. Claude Code) has mouse reporting on.
 *
 * Reads xterm's private `_core.coreMouseService`, which is not in the public
 * typings and can be renamed by an xterm upgrade. A bare `?? false` would then
 * silently return false forever — disabling the drag-copy shim and the scrollback
 * wheel-gate with no error. So distinguish "reporting off" from "internal gone"
 * and shout once, so an upgrade that moves it is caught instead of silently
 * breaking copy/scrollback.
 */
export function mouseReportingActive(term: Terminal): boolean {
  const svc = (term as unknown as XtermCoreInternal)._core?.coreMouseService
  if (!svc) {
    if (!warnedMissingCore) {
      warnedMissingCore = true
      console.error(
        '[aico] xterm internal _core.coreMouseService is missing — drag-copy shim ' +
          'and scrollback gating are disabled. An xterm upgrade likely moved it; ' +
          'fix mouse-shim.ts.',
      )
    }
    return false
  }
  return svc.areMouseEventsActive
}

/**
 * When a TUI enables mouse reporting, xterm sends mouse events to the program
 * instead of doing local text selection — so you can't drag-select to copy.
 * This re-dispatches plain (unshifted) mouse events with `shiftKey=true`, which
 * xterm always treats as "select locally," restoring copy inside TUIs without
 * affecting the program's own clicks. Returns a cleanup function.
 */
export function setupMouseShim(term: Terminal, container: HTMLElement): () => void {
  const forceLocalSelection = (e: MouseEvent) => {
    if (e.shiftKey || !e.isTrusted) return // already shifted, or our own synthetic event
    if (!mouseReportingActive(term)) return // no TUI grabbing the mouse — let it through

    e.stopPropagation()
    e.preventDefault()
    e.target?.dispatchEvent(
      new MouseEvent(e.type, {
        bubbles: e.bubbles,
        cancelable: e.cancelable,
        view: e.view,
        detail: e.detail,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: true,
        metaKey: e.metaKey,
        button: e.button,
        buttons: e.buttons,
        relatedTarget: e.relatedTarget,
      }),
    )
  }

  const opts = { capture: true } as const
  for (const type of ['mousedown', 'mouseup', 'mousemove'] as const) {
    container.addEventListener(type, forceLocalSelection, opts)
  }
  return () => {
    for (const type of ['mousedown', 'mouseup', 'mousemove'] as const) {
      container.removeEventListener(type, forceLocalSelection, opts)
    }
  }
}
