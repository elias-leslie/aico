'use client'

import { useEffect, useMemo, useState } from 'react'
import type {
  DiagnosticEntry,
  DiagnosticCounters,
} from '@/lib/hooks/use-aterm-diagnostics'
import type { AnsiColorProfile } from '@/lib/utils/ansi-color-profile'
import { formatAnsiColorProfile } from '@/lib/utils/ansi-color-profile'

interface DiagnosticsSnapshot {
  frontend: DiagnosticCounters
  log: DiagnosticEntry[]
  backend: {
    counters: Record<string, number>
  } | null
}

interface ATermDiagnosticsOverlayProps {
  enabled: boolean
  themeId: string
  sessionMode?: string
  getDiagnostics: () => DiagnosticsSnapshot
}

function findLatest(
  log: DiagnosticEntry[],
  event: string,
): DiagnosticEntry | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i]?.event === event) {
      return log[i] ?? null
    }
  }
  return null
}

function findLatestAny(
  log: DiagnosticEntry[],
  events: string[],
): DiagnosticEntry | null {
  let latest: DiagnosticEntry | null = null
  for (const event of events) {
    const candidate = findLatest(log, event)
    if (!candidate) continue
    if (!latest || candidate.ts > latest.ts) {
      latest = candidate
    }
  }
  return latest
}

function formatProfileFromEntry(entry: DiagnosticEntry | null): string {
  const profile = entry?.details?.profile as AnsiColorProfile | undefined
  return profile ? formatAnsiColorProfile(profile) : 'none'
}

function formatEventAge(entry: DiagnosticEntry | null): string {
  if (!entry) return 'never'
  const deltaMs = Math.max(performance.now() - entry.ts, 0)
  if (deltaMs < 1000) return `${Math.round(deltaMs)}ms ago`
  return `${(deltaMs / 1000).toFixed(1)}s ago`
}

export function ATermDiagnosticsOverlay({
  enabled,
  themeId,
  sessionMode,
  getDiagnostics,
}: ATermDiagnosticsOverlayProps) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(() =>
    getDiagnostics(),
  )

  useEffect(() => {
    if (!enabled) return
    const interval = window.setInterval(() => {
      setSnapshot(getDiagnostics())
    }, 250)
    return () => window.clearInterval(interval)
  }, [enabled, getDiagnostics])

  const details = useMemo(() => {
    const lastLive = findLatest(snapshot.log, 'live_write_color_profile')
    const lastSnapshot = findLatest(snapshot.log, 'scrollback_sync_color_profile')
    const lastApply = findLatestAny(snapshot.log, [
      'snapshot_full_reset_applied',
      'snapshot_tail_patch_applied',
      'write_flushed',
    ])

    return {
      lastLive,
      lastSnapshot,
      lastApply,
    }
  }, [snapshot.log])

  if (!enabled) return null

  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-20 max-w-[360px] rounded border px-2 py-1.5 text-[10px] leading-4 shadow-lg"
      style={{
        background: 'var(--term-surface-glass)',
        borderColor: 'var(--term-border-active)',
        color: 'var(--term-text-primary)',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div>diag theme={themeId} mode={sessionMode ?? 'shell'}</div>
      <div>
        writes={snapshot.frontend.writesFlushed}/
        {snapshot.frontend.writesEnqueued} snapshots=
        {snapshot.frontend.snapshotReceived}/
        {snapshot.frontend.snapshotApplied}
      </div>
      <div>
        reset={snapshot.frontend.fullResetApplied}
      </div>
      <div>
        skip(prompt)={snapshot.frontend.snapshotSkippedPromptInput}
      </div>
      <div>live {formatProfileFromEntry(details.lastLive)}</div>
      <div>snap {formatProfileFromEntry(details.lastSnapshot)}</div>
      <div>
        last={details.lastApply?.event ?? 'none'} {formatEventAge(details.lastApply)}
      </div>
    </div>
  )
}
