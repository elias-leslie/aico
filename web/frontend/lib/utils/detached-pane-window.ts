'use client'

const DETACHED_PANE_WINDOW_WIDTH = 1280
const DETACHED_PANE_WINDOW_HEIGHT = 900
const DETACHED_PANE_WINDOW_LEFT = 80
const DETACHED_PANE_WINDOW_TOP = 80

export function buildDetachedPaneWindowUrl(
  currentHref: string,
  paneId: string,
  sessionId?: string | null,
): string {
  const url = new URL(currentHref)
  url.searchParams.delete('project')
  url.searchParams.delete('dir')
  url.searchParams.delete('modal')
  url.searchParams.set('detachedPane', paneId)
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
