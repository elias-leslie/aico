const SHELL_MODE = 'shell'

export function isShellSessionMode(sessionMode?: string): boolean {
  return sessionMode === SHELL_MODE
}

export function isTuiSessionMode(sessionMode?: string): boolean {
  return !!sessionMode && !isShellSessionMode(sessionMode)
}

export function prefersLocalViewportScrollForMode(
  sessionMode?: string,
): boolean {
  return isTuiSessionMode(sessionMode)
}
