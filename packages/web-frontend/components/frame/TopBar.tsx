'use client'

import { useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { Menu, RefreshCw, StickyNote } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { quotaGlances, quotaLine, quotaTitle } from '@/lib/frame/quota'
import { useServerReach } from '@/lib/frame/server-reach'
import { shownSessionLine, useShownSession } from '@/lib/frame/shown-session'
import { openAsks, useApprovals, useOwnerAsks } from '@/lib/hooks/use-asks'
import { useClock } from '@/lib/hooks/use-clock'
import { useStatus } from '@/lib/hooks/use-status'
import { popOutNotes } from '@/lib/notes-window'
import { PRODUCT_NAME } from '@/lib/project-branding'
import { at, plural, summaryLine } from '@/lib/status'
import { AgentIcon, getAgentColor } from '../AgentIcon'
import { openNeedsYou } from '../asks/NeedsYou'
import styles from './Frame.module.css'
import { useFrame } from './FrameContext'

/** Notes opens on a new note, ready to type; nothing is saved until something is typed. */
const NEW_NOTE_HREF = '/notes?new=note'
const QUOTA_HREF = '/status?q=usage'

/** Bring the open session's row into view once the list is on screen. */
function revealCurrentRow() {
  requestAnimationFrame(() =>
    document
      .querySelector('[data-frame-side] [aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest' }),
  )
}

/** Needs you: agents' open questions and access requests waiting on the owner. */
function useNeedsYouCount(): { count: number; title: string } {
  const { asks } = useOwnerAsks()
  const { approvals } = useApprovals()
  const questions = openAsks(asks).length
  const taps = approvals?.taps.length ?? 0
  const count = questions + taps
  const title =
    count === 0
      ? 'Needs you: nothing waiting'
      : `Needs you: ${[
          questions ? plural(questions, 'question') : null,
          taps ? plural(taps, 'approval') : null,
        ]
          .filter(Boolean)
          .join(', ')}`
  return { count, title }
}

/** The top bar: global state only. The session on screen and its state, Needs
 * you, health, quota and Notes; each opens the right place in one click. */
export function TopBar() {
  const frame = useFrame()
  const router = useRouter()
  const queryClient = useQueryClient()
  const now = useClock(30_000)
  const session = useShownSession()
  const reach = useServerReach()
  const needs = useNeedsYouCount()
  const { view, failed, stale } = useStatus()
  const docked = frame?.docked ?? true
  const summary = view?.summary
  const glances = quotaGlances(view?.rows ?? [])
  const down = reach.down
  const since = at(reach.since, now)

  const showList = () => {
    if (!frame) return
    if (frame.docked) {
      if (frame.tier === 'rail' || frame.tier === 'full') frame.setTier('panel')
    } else frame.setSheetOpen(true)
    revealCurrentRow()
  }
  const showNeedsYou = () => {
    if (frame) {
      if (frame.docked) {
        if (frame.tier === 'rail' || frame.tier === 'full')
          frame.setTier('panel')
      } else frame.setSheetOpen(true)
    }
    openNeedsYou()
  }
  const retry = () => {
    void queryClient.refetchQueries({ type: 'active' })
  }
  const openNotes = () => {
    if (!popOutNotes(NEW_NOTE_HREF)) router.push(NEW_NOTE_HREF)
  }

  // Health: the worst state's dot and the problem count; unknown when it couldn't be read.
  const worst = summary?.worst
  const healthTone =
    !summary || stale || failed
      ? 'unknown'
      : worst === 'failed'
        ? 'bad'
        : worst === 'late' || worst === 'warn'
          ? 'warn'
          : worst === 'unknown'
            ? 'unknown'
            : 'ok'
  const problems = summary?.problems ?? 0
  const healthLabel = !summary
    ? failed
      ? 'Status not loaded'
      : 'Status'
    : problems === 0
      ? 'All healthy'
      : plural(problems, 'problem')
  const healthTitle = !summary
    ? failed
      ? 'Status couldn’t be read'
      : 'Status'
    : stale
      ? `Status as of ${at(view ? Date.parse(view.generated_at) : null, now)}: ${summaryLine(summary)}`
      : `Status: ${summaryLine(summary)}`

  const sessionLine = session ? shownSessionLine(session) : ''

  return (
    <header
      className={styles.topbar}
      data-docked={docked ? 'true' : undefined}
      data-down={down ? 'true' : undefined}
      data-testid="top-bar"
    >
      {!docked && (
        <button
          type="button"
          className={clsx(styles.tbIcon, styles.menu)}
          aria-label={`Sessions and everything else${needs.count ? ` · ${needs.count} need you` : ''}`}
          title="Sessions and everything else"
          onClick={() => frame?.setSheetOpen(true)}
          data-testid="frame-menu"
        >
          <Menu className="h-5 w-5" strokeWidth={1.7} />
          {needs.count > 0 && (
            <span className={styles.menuCount} aria-hidden="true">
              {needs.count}
            </span>
          )}
        </button>
      )}
      {docked && <span className={styles.brand}>{PRODUCT_NAME}</span>}

      <button
        type="button"
        className={styles.current}
        onClick={showList}
        title={
          session
            ? `${session.name}${sessionLine ? ` · ${sessionLine}` : ''}: show it in the list`
            : 'Show the session list'
        }
        data-testid="top-bar-session"
      >
        {session && docked && (
          <span className={styles.currentMark} aria-hidden="true">
            <AgentIcon
              slug={session.agent}
              size={16}
              color={getAgentColor(session.agent)}
            />
          </span>
        )}
        <span className={styles.currentText}>
          <span className={styles.currentName}>
            {session ? session.name : 'No session open'}
          </span>
          {session && sessionLine && (
            <span
              className={styles.currentSub}
              data-state={
                session.status === 'connected'
                  ? 'live'
                  : session.status === 'connecting'
                    ? 'connecting'
                    : 'off'
              }
            >
              {down && session.status !== 'connected'
                ? 'Disconnected'
                : sessionLine}
            </span>
          )}
        </span>
      </button>

      <span className={styles.spacer} />

      <button
        type="button"
        className={clsx(styles.tbBtn, needs.count > 0 && styles.tbNeed)}
        onClick={showNeedsYou}
        aria-label={needs.title}
        title={needs.title}
        data-testid="top-bar-needs-you"
        data-count={needs.count}
      >
        <span
          className={styles.dot}
          data-tone={needs.count > 0 ? 'need' : 'quiet'}
          aria-hidden="true"
        />
        <span className={styles.count}>{needs.count}</span>
        <span className={styles.wideOnly}>need you</span>
      </button>

      {down ? (
        <span className={styles.downGroup} role="status">
          <span className={styles.dot} data-tone="bad" aria-hidden="true" />
          <span className={styles.downText}>
            <b>Offline</b>
            <span className={styles.wideOnly}>
              {' '}
              · can’t reach {PRODUCT_NAME} since {since}
            </span>
          </span>
          <button
            type="button"
            className={styles.tbBtn}
            onClick={retry}
            data-testid="top-bar-retry"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.7} />
            Retry
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={styles.tbBtn}
          onClick={() => frame?.open('/status', 'wide')}
          aria-label={healthTitle}
          title={healthTitle}
          data-testid="top-bar-health"
        >
          <span
            className={styles.dot}
            data-tone={healthTone}
            aria-hidden="true"
          />
          {summary && problems > 0 ? (
            <>
              <span className={styles.count}>{problems}</span>
              <span className={styles.wideOnly}>
                {problems === 1 ? 'problem' : 'problems'}
              </span>
            </>
          ) : (
            <span className={styles.wideOnly}>{healthLabel}</span>
          )}
        </button>
      )}

      {docked && glances.length > 0 && (
        <button
          type="button"
          className={clsx(styles.tbBtn, down && styles.stale)}
          onClick={() => frame?.open(QUOTA_HREF, 'wide')}
          aria-label={`Quota: ${quotaLine(glances)}`}
          title={quotaTitle(glances)}
          data-testid="top-bar-quota"
        >
          <span className={styles.qglance} aria-hidden="true">
            {glances.map((glance) => (
              <i
                key={glance.id}
                data-out={glance.state === 'left' ? undefined : 'true'}
                style={{ '--h': `${glance.left ?? 0}%` } as React.CSSProperties}
              />
            ))}
          </span>
          <span className={styles.quotaLine}>{quotaLine(glances)}</span>
        </button>
      )}

      {docked && (
        <button
          type="button"
          className={styles.tbBtn}
          onClick={openNotes}
          title="Notes: opens in its own window, ready to type"
          data-testid="top-bar-notes"
        >
          <StickyNote
            className="h-4 w-4"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          Notes
        </button>
      )}
    </header>
  )
}
