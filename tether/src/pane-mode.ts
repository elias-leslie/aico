// Read-only pane mode query (`GET /v1/sessions/:id/pane-mode`). Clients use it
// to decide whether wheel and keys go to the pane or to tmux's copy mode, so
// they never have to run tmux against Tether's private sockets themselves.

export interface PaneMode {
  /** The pane shows its alternate screen (a full-screen TUI). */
  alternateScreen: boolean
  /** The program asked for mouse reporting. */
  mouseReporting: boolean
  /** Lines of history above the visible screen. */
  historySize: number
  /** tmux shows a mode over the pane (copy mode, view mode, ...). */
  inMode: boolean
  /** That mode's name (`copy-mode`, `view-mode`, ...), else null. */
  mode: string | null
}

const FORMAT = [
  '#{?alternate_on,1,0}',
  '#{?mouse_any_flag,1,0}',
  '#{history_size}',
  '#{?pane_in_mode,1,0}',
  '#{pane_mode}',
].join('\t')

/** `display-message -p` arguments for one exact pane target. */
export function paneModeArgs(socket: string, target: string): string[] {
  return ['-S', socket, 'display-message', '-p', '-t', target, FORMAT]
}

export function parsePaneMode(stdout: string): PaneMode {
  const [alternate, mouse, history, inMode, mode] = stdout.replace(/\n$/, '').split('\t')
  const historySize = Number(history)
  const name = mode?.trim() ?? ''
  return {
    alternateScreen: alternate === '1',
    mouseReporting: mouse === '1',
    historySize: Number.isSafeInteger(historySize) && historySize > 0 ? historySize : 0,
    inMode: inMode === '1',
    mode: inMode === '1' && /^[a-z][a-z-]{0,31}$/.test(name) ? name : null,
  }
}
