'use client'

import { clsx } from 'clsx'
import { ArrowLeft, Plus, X } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { type ReactNode, useRef, useState } from 'react'
import { useServerReach } from '@/lib/frame/server-reach'
import {
  HANDLE_HELP,
  nearestTier,
  PANEL_MAX_SHARE,
  PANEL_PX,
  panelWidthAt,
  RAIL_PX,
  type Tier,
  WIDEN_PX,
  WIDEN_SHARE,
} from '@/lib/frame/tiers'
import styles from './Frame.module.css'
import { type Frame, useFrame } from './FrameContext'
import { SideList } from './SideList'
import { SideToggle } from './SideToggle'

/** What fills the side at each width. */
interface SideSlots {
  /** Rail: icons, counts and one mark per session. */
  rail: ReactNode
  /** Panel: the session list today (the triage view next). */
  panel: ReactNode
}

interface LeftSideProps extends SideSlots {
  onNewSession?: () => void
  /** The session list is still loading (first read). */
  loading?: boolean
}

/** The left side: one frame for the session list and every other page. It
 * sits beside the session at Rail and Panel and covers it at Full; on
 * a narrow window it slides over the session from the session header's menu. */
export function LeftSide(props: LeftSideProps) {
  const frame = useFrame()
  if (!frame) return null
  return frame.docked ? (
    <DockedSide frame={frame} {...props} />
  ) : (
    <SheetSide frame={frame} {...props} />
  )
}

/** The first read of the session list; while the server is down the offline strip says why nothing is here. */
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
  loading,
}: LeftSideProps & { frame: Frame }) {
  const query = useSearchParams()
  const down = useServerReach().down
  const panelColumn = (
    <div className={styles.col} data-stale={down ? 'true' : undefined}>
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
  // An expanded item that needs room widens the panel and pushes the session over;
  // a panel dragged wider covers part of the session instead.
  const widen = `min(${WIDEN_PX}px, ${WIDEN_SHARE * 100}%)`
  const panel = frame.widened
    ? `max(${frame.panelWidth}px, ${widen})`
    : `${frame.panelWidth}px`
  const beside =
    besideRef.current === 'rail'
      ? `${RAIL_PX}px`
      : frame.widened
        ? `max(${PANEL_PX}px, ${widen})`
        : `${PANEL_PX}px`
  const spacer = drag ? `${Math.min(drag.width, PANEL_PX)}px` : beside
  const shown = drag
    ? `${drag.width}px`
    : tier === 'rail'
      ? `${RAIL_PX}px`
      : full
        ? '100%'
        : panel
  const near = drag ? nearestTier(drag.width) : null
  const frameWidth = () =>
    root.current?.parentElement?.getBoundingClientRect().width ||
    window.innerWidth

  return (
    <div
      ref={root}
      className={styles.sideSpacer}
      style={{ width: spacer }}
      data-tier={tier}
    >
      <aside
        className={clsx(styles.side, drag && styles.dragging)}
        style={{ width: shown }}
        data-frame-side=""
        data-tier={tier}
        data-testid="frame-side"
        aria-label="Sessions and everything else"
      >
        <div className={clsx(styles.sideHead, styles.dockedHead)}>
          <SideToggle />
          {tier === 'panel' && <NewSessionButton onClick={onNewSession} />}
          {full && <NewSessionButton onClick={onNewSession} />}
          <span className={styles.spacer} />
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
        <Body frame={frame} {...slots} />
        {!full && (
          <Handle
            tier={tier}
            width={frame.panelWidth}
            frameWidth={frameWidth}
            onDrag={setDrag}
            onTier={frame.setTier}
            onWidth={frame.setPanelWidth}
          />
        )}
      </aside>
      {drag && (
        <div className={styles.snaps} aria-hidden="true">
          {[RAIL_PX, PANEL_PX].map((x) => (
            <span
              key={x}
              className={clsx(
                styles.snapLine,
                near === (x === RAIL_PX ? 'rail' : 'panel') && styles.snapNear,
              )}
              style={{ left: x }}
            />
          ))}
          {near && (
            <span
              className={styles.snapTarget}
              style={{
                left: Math.max(70, Math.min(drag.width, drag.frameWidth - 70)),
              }}
              data-testid="snap-target"
            >
              {near === 'rail'
                ? 'Release for the rail'
                : `Release for a ${Math.round(panelWidthAt(drag.width, drag.frameWidth))}px panel`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Wider by arrow key, in px. */
const KEY_STEP = 40

/** The edge: drag it in to the rail or out to set the panel's width (it keeps
 * the default width when let go close to it); arrow keys step; double-click for
 * the default width. The session refits as it goes (its resize is debounced)
 * and stays the same session. */
function Handle({
  tier,
  width,
  frameWidth,
  onDrag,
  onTier,
  onWidth,
}: {
  tier: Tier
  /** The panel's kept width. */
  width: number
  frameWidth: () => number
  onDrag: (drag: { width: number; frameWidth: number } | null) => void
  onTier: (tier: Tier) => void
  onWidth: (width: number, frameWidth: number) => void
}) {
  const state = useRef<{ x: number; start: number; frame: number } | null>(null)
  const last = useRef(0)
  const panel = tier === 'panel'
  const max = Math.floor(frameWidth() * PANEL_MAX_SHARE)
  const settle = (next: number) => {
    const total = frameWidth()
    if (nearestTier(next) === 'rail') onTier('rail')
    else {
      onTier('panel')
      onWidth(next, total)
    }
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter, as WAI-ARIA's window splitter
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side"
      aria-valuetext={panel ? `Panel, ${width}px` : 'Rail'}
      aria-valuenow={panel ? width : RAIL_PX}
      aria-valuemin={RAIL_PX}
      aria-valuemax={Math.max(PANEL_PX, max)}
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
        const next = Math.max(
          0,
          Math.min(drag.frame, drag.start + event.clientX - drag.x),
        )
        last.current = next
        onDrag({ width: next, frameWidth: drag.frame })
      }}
      onPointerUp={() => {
        const drag = state.current
        state.current = null
        onDrag(null)
        if (drag && last.current !== drag.start) settle(last.current)
      }}
      onPointerCancel={() => {
        state.current = null
        onDrag(null)
      }}
      onDoubleClick={() => {
        onTier('panel')
        onWidth(PANEL_PX, frameWidth())
      }}
      onKeyDown={(event) => {
        if (event.key === 'Home') onTier('rail')
        else if (event.key === 'End') {
          onTier('panel')
          onWidth(max, frameWidth())
        } else if (event.key === 'ArrowLeft') {
          if (panel && width > PANEL_PX) onWidth(width - KEY_STEP, frameWidth())
          else onTier('rail')
        } else if (event.key === 'ArrowRight') {
          if (panel) onWidth(width + KEY_STEP, frameWidth())
          else onTier('panel')
        } else return
        event.preventDefault()
      }}
    >
      <span className={styles.grip} aria-hidden="true" />
    </div>
  )
}

/** Narrow windows: the side slides over the session, full width, from the
 * session header's menu. A page opens in it with Back to the list. */
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
        {!onPage && <span className={styles.sheetTitle}>Sessions</span>}
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
            {slots.loading ? <Loading /> : slots.panel}
          </div>
        )
      )}
    </aside>
  )
}
