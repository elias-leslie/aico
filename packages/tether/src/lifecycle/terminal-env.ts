/** Environment Aico exposes to the outer PTY client (`tmux attach`). */
export function terminalClientEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') env[key] = value
  }

  delete env.NO_COLOR
  // Every Aico client names its private socket explicitly. Inheriting a parent
  // pane's nesting markers can make tmux reject attach/create operations and
  // obscures which server owns a process when Aico is launched from a terminal.
  delete env.TMUX
  delete env.TMUX_PANE
  delete env.TMUX_TMPDIR
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.CLICOLOR = env.CLICOLOR || '1'
  if (!env.LANG || env.LANG === 'C') env.LANG = 'en_US.UTF-8'
  if (!env.LC_CTYPE || env.LC_CTYPE === 'C') env.LC_CTYPE = 'C.UTF-8'

  return env
}
