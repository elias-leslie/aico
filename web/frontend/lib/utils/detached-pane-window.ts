const DETACHED_PANE_WINDOW_WIDTH = 1280
const DETACHED_PANE_WINDOW_HEIGHT = 900
const DETACHED_PANE_WINDOW_LEFT = 80
const DETACHED_PANE_WINDOW_TOP = 80
export const DETACHED_PANE_PARAM = 'detachedPane'
export const DETACHED_WINDOW_SCOPE_PARAM = 'windowScope'
export const DETACHED_WINDOW_PANES_PARAM = 'windowPanes'

function normalizePaneIds(paneIds: Iterable<string>): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const paneId of paneIds) {
    const trimmed = paneId.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

export function parseDetachedWindowPaneIds(
  value: string | null | undefined,
  fallbackPaneId?: string | null,
): string[] {
  const parsed = normalizePaneIds((value ?? '').split(','))
  if (parsed.length > 0) {
    return parsed
  }
  return fallbackPaneId ? [fallbackPaneId] : []
}

export function makeDetachedWindowScopeId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `detached-${Math.random().toString(36).slice(2, 10)}`
}

export function getScopedATermStorageKey(
  baseKey: string,
  storageScopeId?: string | null,
): string {
  return storageScopeId ? `${baseKey}:${storageScopeId}` : baseKey
}

export function buildDetachedPaneWindowUrl(
  currentHref: string,
  paneId: string,
  sessionId?: string | null,
  options?: {
    paneIds?: string[]
    windowScopeId?: string | null
  },
): string {
  const url = new URL(currentHref)
  url.searchParams.delete('project')
  url.searchParams.delete('dir')
  url.searchParams.delete('modal')
  const paneIds = parseDetachedWindowPaneIds(
    options?.paneIds?.join(','),
    paneId,
  )
  const windowScopeId = options?.windowScopeId ?? makeDetachedWindowScopeId()

  url.searchParams.set(DETACHED_PANE_PARAM, paneIds[0] ?? paneId)
  url.searchParams.set(DETACHED_WINDOW_SCOPE_PARAM, windowScopeId)
  if (paneIds.length > 0) {
    url.searchParams.set(DETACHED_WINDOW_PANES_PARAM, paneIds.join(','))
  } else {
    url.searchParams.delete(DETACHED_WINDOW_PANES_PARAM)
  }
  if (sessionId) {
    url.searchParams.set('session', sessionId)
  } else {
    url.searchParams.delete('session')
  }
  return url.toString()
}

export function getDetachedPaneWindowName(paneId: string): string {
  return `a-term-detached-pane-${paneId}`
}

export function getDetachedPaneWindowFeatures(): string {
  return [
    'popup=yes',
    `width=${DETACHED_PANE_WINDOW_WIDTH}`,
    `height=${DETACHED_PANE_WINDOW_HEIGHT}`,
    `left=${DETACHED_PANE_WINDOW_LEFT}`,
    `top=${DETACHED_PANE_WINDOW_TOP}`,
    'resizable=yes',
    'scrollbars=yes',
  ].join(',')
}
