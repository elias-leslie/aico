import {
  mouseReportingActive,
  programOwnsSelection,
  setupMouseShim,
} from '../../../../shared/mouse-shim'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

/**
 * Mouse selection and copy, as on the desktop.
 *
 * Claude Code and a shell's full-screen program get the drag when they track
 * the mouse: Claude Code selects across its whole transcript, copies on
 * release (OSC 52, which the clipboard addon writes) and says so itself.
 * Every other drag is xterm's local selection, which a mouse-reporting
 * program would otherwise eat, and is copied on release. Right-click never
 * reaches the program (Claude Code would paste the host's clipboard); the
 * browser's own menu pastes here. Phones keep the local selection: their taps
 * reach the program from the touch handlers, and copy is the native layer's.
 */
export function setupTerminalMouseHandling(
  terminal: XtermTerminal,
  container: HTMLElement,
  options: { sessionMode: () => string | undefined; isMobile: boolean },
): () => void {
  let forceDrag = true
  const stopShim = setupMouseShim(terminal, container, (e) => {
    if (e.type === 'mousedown') {
      forceDrag =
        options.isMobile ||
        !programOwnsSelection({
          tuiSlug: options.sessionMode() ?? '',
          alternateScreen: terminal.buffer.active.type === 'alternate',
          mouseReporting: mouseReportingActive(terminal),
        })
    }
    return forceDrag
  })
  if (options.isMobile) return stopShim

  // On release, not per selection change: that fires per cell mid-drag. The
  // shim re-dispatches a shifted mouseup, so this fires inside TUIs too.
  const copySelection = (e: MouseEvent) => {
    if (e.button !== 0) return
    const selection = terminal.getSelection()
    if (selection)
      void navigator.clipboard?.writeText(selection).catch(() => {})
  }
  container.addEventListener('mouseup', copySelection)
  return () => {
    stopShim()
    container.removeEventListener('mouseup', copySelection)
  }
}
