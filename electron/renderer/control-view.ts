// Renderer side of the control-mode transport (main/tmux-control.ts).
//
// The terminal parses the pane's own output, so it holds real scrollback and
// knows the program's modes. tmux stays the terminal the program talks to: it
// already answers the program's queries, so xterm must not answer them a
// second time into the program's input.

import type { Terminal } from '@xterm/xterm'

export type ControlWheelAction = 'forward-sgr' | 'xterm-report' | 'consume' | 'scroll'

/**
 * What a wheel event does on a control-mode terminal.
 *
 * A program that tracks the mouse gets the wheel: as several SGR reports when
 * it reads SGR (Claude Code scrolls one row per report), else as xterm's own
 * single report in the program's encoding. A full-screen program without
 * mouse tracking gets nothing (xterm would type arrow keys into it). Otherwise
 * the wheel scrolls the terminal's own history.
 */
export function controlWheelAction(state: {
  mouseTracking: boolean
  sgrMouse: boolean
  alternateScreen: boolean
}): ControlWheelAction {
  if (state.mouseTracking) return state.sgrMouse ? 'forward-sgr' : 'xterm-report'
  if (state.alternateScreen) return 'consume'
  return 'scroll'
}

/** Follow SGR mouse encoding (DECSET 1006), which xterm does not expose. */
export function trackSgrMouse(term: Terminal): () => boolean {
  let sgr = false
  const watch = (on: boolean) => (params: (number | number[])[]) => {
    if (params.some((p) => p === 1006)) sgr = on
    return false // xterm applies the mode itself
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, watch(true))
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, watch(false))
  term.parser.registerEscHandler({ final: 'c' }, () => {
    sgr = false
    return false
  })
  return () => sgr
}

/**
 * Stop xterm replying to terminal queries in the stream. tmux answers them
 * for the program; a second answer from xterm would arrive as typed input.
 * Kitty keyboard requests are dropped too, so keys keep the encoding tmux told
 * the program it supports.
 */
export function swallowQueryReplies(term: Terminal): void {
  const drop = () => true
  const { parser } = term
  parser.registerCsiHandler({ final: 'c' }, drop) // DA1
  parser.registerCsiHandler({ prefix: '>', final: 'c' }, drop) // DA2
  parser.registerCsiHandler({ prefix: '=', final: 'c' }, drop) // DA3
  parser.registerCsiHandler({ final: 'n' }, drop) // DSR, cursor position report
  parser.registerCsiHandler({ prefix: '?', final: 'n' }, drop) // DEC DSR
  parser.registerCsiHandler({ intermediates: '$', final: 'p' }, drop) // DECRQM
  parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, drop)
  parser.registerCsiHandler({ prefix: '>', final: 'q' }, drop) // XTVERSION
  parser.registerCsiHandler({ final: 't' }, drop) // window reports
  for (const prefix of ['?', '>', '<', '=']) parser.registerCsiHandler({ prefix, final: 'u' }, drop)
  parser.registerDcsHandler({ intermediates: '$', final: 'q' }, drop) // DECRQSS
  parser.registerDcsHandler({ intermediates: '+', final: 'q' }, drop) // XTGETTCAP
  // Colour queries ("?") only; colour changes still apply.
  for (const code of [4, 10, 11, 12, 17, 19])
    parser.registerOscHandler(code, (data) => data.includes('?'))
}
