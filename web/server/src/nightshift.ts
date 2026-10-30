// The Health panel's source: Nightshift's owner view (its GET /api/view, built
// by Nightshift's own view logic), read server-side on loopback and passed
// through. Read-only: decisions and approvals stay in Nightshift. When
// Nightshift does not answer, the panel is told so and shows unknown, never OK.
//
//   GET /api/nightshift/view -> {available: true, view} | {available: false, reason}

import type { Router } from './http'

export interface NightshiftConfig {
  /** Nightshift's own web server, loopback; null turns the panel off. */
  nightshiftUrl: string | null
}

/** The view contract this panel reads (Nightshift web/apiview.py VERSION). */
export const NIGHTSHIFT_VIEW_VERSION = 1
const TIMEOUT_MS = 5_000

export type NightshiftView =
  | { available: true; view: Record<string, unknown> }
  | { available: false; reason: 'not_configured' | 'not_answering' | 'unexpected' }

export async function readNightshiftView(
  config: NightshiftConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<NightshiftView> {
  if (!config.nightshiftUrl) return { available: false, reason: 'not_configured' }
  let response: Response
  try {
    response = await fetchImpl(`${config.nightshiftUrl.replace(/\/+$/, '')}/api/view`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    console.error('[aico-web] Nightshift unreachable:', (error as Error).message)
    return { available: false, reason: 'not_answering' }
  }
  if (!response.ok) {
    console.error(`[aico-web] Nightshift /api/view answered ${response.status}`)
    return { available: false, reason: 'not_answering' }
  }
  try {
    const view = (await response.json()) as unknown
    if (
      view &&
      typeof view === 'object' &&
      (view as { version?: unknown }).version === NIGHTSHIFT_VIEW_VERSION &&
      Array.isArray((view as { tiles?: unknown }).tiles)
    )
      return { available: true, view: view as Record<string, unknown> }
  } catch {
    // Reported below.
  }
  console.error('[aico-web] Nightshift /api/view: not a view this version reads')
  return { available: false, reason: 'unexpected' }
}

export function registerNightshiftRoutes(
  router: Router,
  config: NightshiftConfig,
  fetchImpl: typeof fetch = fetch,
): void {
  router.on('GET', '/api/nightshift/view', () => readNightshiftView(config, fetchImpl))
}
