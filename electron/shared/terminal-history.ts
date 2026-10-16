/** History lines a control-mode window holds: main seeds this many lines of
 * the pane's tmux history on attach, and the renderer's terminal keeps the
 * same number as scrollback, so nothing seeded falls off the top. */
export const TERMINAL_HISTORY_LINES = 20_000
