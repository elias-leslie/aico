'use client'

import { clsx } from 'clsx'
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { type ReactNode, useRef, useState } from 'react'
import { useServerReach } from '@/lib/frame/server-reach'
import {
  HANDLE_HELP,
  nearestTier,
  TIER_LABEL,
  TIERS,
  type Tier,
  tierWidth,
} from '@/lib/frame/tiers'
import { useClock } from '@/lib/hooks/use-clock'
import { PRODUCT_NAME } from '@/lib/project-branding'
import { at } from '@/lib/status'
import styles from './Frame.module.css'
import { type Frame, useFrame } from './FrameContext'
import { SideList } from './SideList'

/** What fills the side at each width. Part 2 replaces `panel` (the triage
 * view) and `wideExtra` (the second column at home); `rail` keeps its marks. */
interface SideSlots {
  /** Rail: icons, counts and one mark per session. */
  rail: ReactNode
  /** Panel: the session list today (the triage view next). */
  panel: ReactNode
  /** Wide at home: the second column beside the panel. */
  wideExtra: ReactNode
}

interface LeftSideProps extends SideSlots {
  onNewSession?: () => void
  /** The session list is still loading (first read). */
  loading?: boolean
}

/** The left side: one frame for the session list and every other page. It
 * sits beside the session at Rail, Panel and Wide and covers it at Full; on
 * a narrow window it slides over the session from the top bar's menu. */
export function LeftSide(props: LeftSideProps) {
  const frame = useFrame()
  if (!frame) return null
  return frame.docked ? (
    <DockedSide frame={frame} {...props} />
  ) : (
    <SheetSide frame={frame} {...props} />
  )
}

/** The server can't be reached: say since when, and whether what is shown is
 * its last answer or nothing yet. Retry is in the top bar, once. */
function DownNote() {
  const reach = useServerReach()
  const now = useClock(30_000)
  if (!reach.down) return null
  return (
    <div className={styles.downNote} role="status" data-testid="side-down-note">
      <span>
        {reach.answered
          ? `Showing what ${PRODUCT_NAME} last knew, as of ${at(reach.since, now)}.`
          : `Can’t reach ${PRODUCT_NAME} since ${at(reach.since, now)}. Nothing to show yet; sessions come back once it answers.`}
      </span>
    </div>
  )
}

/** The first read of the session list; while the server is down the note above says why nothing is here. */
function Loading() {
  if (useServerReach().down) return null
  return (
    <p className={styles.loading} role="status">
      Loading sessions…
    </p>
  )
}

function NewSessionButton({ onClick }: { onClick?: () => void }) {
  if (!onClick) return null
  return (
    <button
      type="button"
      className="lantern-btn primary small"
      onClick={onClick}
      data-testid="new-session-btn"
      title="New session"
    >
      <Plus className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      New session
    </button>
  )
}

function Body({
  frame,
  rail,
  panel,
  wideExtra,
  loading,
}: LeftSideProps & { frame: Frame }) {
  const query = useSearchParams()
  const down = useServerReach().down
  const panelColumn = (
    <div className={styles.col} data-stale={down ? 'true' : undefined}>
      <DownNote />
      {loading ? <Loading /> : panel}
    </div>
  )
  if (frame.tier === 'rail')
    return (
      <div className={styles.railBody} data-stale={down ? 'true' : undefined}>
        {rail}
      </div>
    )
  if (frame.tier === 'panel') return panelColumn
  if (frame.tier === 'wide')
    return (
      <div className={styles.wideCols}>
        {panelColumn}
        <div className={styles.pageCol} data-testid="frame-page">
          {frame.page ?? wideExtra}
        </div>
      </div>
    )
  return (
    <div className={styles.fullCols}>
      <SideList pathname={frame.pathname} query={query} />
      <div className={styles.pageCol} data-testid="frame-page">
        {frame.page}
      </div>
    </div>
  )
}

function DockedSide({
  frame,
  onNewSession,
  ...slots
}: LeftSideProps & { frame: Frame }) {
  const root = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{
    width: number
    frameWidth: number
  } | null>(null)
  const tier = frame.tier
  const full = tier === 'full'
  // The last tier beside the session: Full covers the session without
  // resizing it, so the session keeps that width underneath.
  const besideRef = useRef<Tier>('panel')
  if (!full) besideRef.current = tier
  const spacer = drag ? drag.width : besideRef.current
  const width = (t: Tier | number) =>
    typeof t === 'number'
      ? `${t}px`
      : t === 'wide'
        ? '58%'
        : t === 'full'
          ? '100%'
          : `${tierWidth(t, Number.POSITIVE_INFINITY)}px`
  const near = drag ? nearestTier(drag.width, drag.frameWidth) : null

  return (
    <div
      ref={root}
      className={styles.sideSpacer}
      style={{ width: width(spacer) }}
      data-tier={tier}
    >
      <aside
        className={clsx(styles.side, drag && styles.dragging)}
        style={{ width: drag ? width(drag.width) : width(tier) }}
        data-frame-side=""
        data-tier={tier}
        data-testid="frame-side"
        aria-label="Sessions and everything else"
      >
        {tier !== 'rail' && (
          <div className={styles.sideHead}>
            <NewSessionButton onClick={onNewSession} />
            <span className={styles.spacer} />
            <button
              type="button"
              className="lantern-icon-btn compact"
              aria-label="Narrower"
              title="Narrower · Alt+["
              onClick={() => frame.step(-1)}
              data-testid="frame-narrower"
            >
              <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </button>
            {!full && (
              <button
                type="button"
                className="lantern-icon-btn compact"
                aria-label="Wider"
                title="Wider · Alt+]"
                onClick={() => frame.step(1)}
                data-testid="frame-wider"
              >
                <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.7} />
              </button>
            )}
            {full && (
              <button
                type="button"
                className="lantern-icon-btn compact"
                aria-label="Back to the session"
                title="Back to the session · Esc"
                onClick={frame.close}
                data-testid="frame-close"
              >
                <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
              </button>
            )}
          </div>
        )}
        <Body frame={frame} {...slots} />
        {!full && (
          <Handle
            tier={tier}
            frameWidth={() =>
              root.current?.parentElement?.getBoundingClientRect().width ||
              window.innerWidth
            }
            onDrag={setDrag}
            onSnap={frame.setTier}
          />
        )}
      </aside>
      {drag && (
        <div className={styles.snaps} aria-hidden="true">
          {TIERS.map((t) => (
            <span
              key={t}
              className={clsx(styles.snap, near === t && styles.snapNear)}
              style={{ left: tierWidth(t, drag.frameWidth) }}
            >
              {TIER_LABEL[t]}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** The edge: drag and it snaps to the nearest width when let go; arrow keys
 * step; double-click for Panel. The session refits as it goes (its resize is
 * debounced) and stays the same session. */
function Handle({
  tier,
  frameWidth,
  onDrag,
  onSnap,
}: {
  tier: Tier
  frameWidth: () => number
  onDrag: (drag: { width: number; frameWidth: number } | null) => void
  onSnap: (tier: Tier) => void
}) {
  const state = useRef<{ x: number; start: number; frame: number } | null>(null)
  const last = useRef(0)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter, as WAI-ARIA's window splitter
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side"
      aria-valuetext={TIER_LABEL[tier]}
      aria-valuenow={TIERS.indexOf(tier) + 1}
      aria-valuemin={1}
      aria-valuemax={TIERS.length}
      tabIndex={0}
      title={HANDLE_HELP}
      className={styles.handle}
      data-testid="frame-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        const shown =
          event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
        state.current = { x: event.clientX, start: shown, frame: frameWidth() }
        last.current = shown
      }}
      onPointerMove={(event) => {
        const drag = state.current
        if (!drag) return
        const width = Math.max(
          48,
          Math.min(drag.frame, drag.start + event.clientX - drag.x),
        )
        last.current = width
        onDrag({ width, frameWidth: drag.frame })
      }}
      onPointerUp={() => {
        const drag = state.current
        state.current = null
        onDrag(null)
        if (drag && last.current !== drag.start)
          onSnap(nearestTier(last.current, drag.frame))
      }}
      onPointerCancel={() => {
        state.current = null
        onDrag(null)
      }}
      onDoubleClick={() => onSnap('panel')}
      onKeyDown={(event) => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
        const index = TIERS.indexOf(tier)
        if (event.key === 'Home') onSnap('rail')
        else if (event.key === 'End') onSnap('full')
        else if (step)
          onSnap(
            TIERS[
              Math.min(TIERS.length - 1, Math.max(0, index + step))
            ] as Tier,
          )
        else return
        event.preventDefault()
      }}
    >
      <span className={styles.grip} aria-hidden="true" />
    </div>
  )
}

/** Narrow windows: the side slides over the session, full width, from the
 * top bar's menu. A page opens in it with Back to the list. */
function SheetSide({
  frame,
  onNewSession,
  ...slots
}: LeftSideProps & { frame: Frame }) {
  const down = useServerReach().down
  const onPage = frame.page !== null
  return (
    <aside
      className={styles.sheet}
      data-open={frame.sheetOpen ? 'true' : undefined}
      data-frame-side=""
      data-testid="frame-sheet"
      aria-label="Sessions and everything else"
      aria-hidden={frame.sheetOpen ? undefined : true}
      inert={!frame.sheetOpen}
    >
      <div className={styles.sideHead}>
        {onPage && (
          <button
            type="button"
            className="lantern-icon-btn"
            aria-label="Back"
            title="Back"
            onClick={frame.home}
            data-testid="frame-back"
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={1.7} />
          </button>
        )}
        {!onPage && <span className={styles.sheetTitle}>{PRODUCT_NAME}</span>}
        {!onPage && (
          <NewSessionButton
            onClick={
              onNewSession
                ? () => {
                    frame.setSheetOpen(false)
                    onNewSession()
                  }
                : undefined
            }
          />
        )}
        <span className={styles.spacer} />
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label="Back to the session"
          title="Back to the session"
          onClick={frame.close}
          data-testid="frame-close"
        >
          <X className="h-5 w-5" strokeWidth={1.7} />
        </button>
      </div>
      {onPage ? (
        <div className={styles.pageCol} data-testid="frame-page">
          {frame.page}
        </div>
      ) : (
        // Mounted only while open: a closed sheet must not hold Needs you,
        // which then opens over the session as before.
        frame.sheetOpen && (
          <div className={styles.col} data-stale={down ? 'true' : undefined}>
            <DownNote />
            {slots.loading ? <Loading /> : slots.panel}
          </div>
        )
      )}
    </aside>
  )
}
