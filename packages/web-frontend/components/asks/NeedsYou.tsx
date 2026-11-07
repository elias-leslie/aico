'use client'

import { Inbox } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type ReactNode, useRef, useState } from 'react'
import {
  openNeedsYou,
  useNeedsYouRequests,
} from '@/lib/frame/needs-you-request'
import { useServerReach } from '@/lib/frame/server-reach'
import {
  type AttachedFile,
  answeredAsks,
  askCounts,
  askCountsParts,
  type OwnerAsk,
  openAsks,
  useApprovals,
  useOwnerAsks,
} from '@/lib/hooks/use-asks'
import { useClock } from '@/lib/hooks/use-clock'
import { useNeedsYouCounts } from '@/lib/hooks/use-needs-you'
import { PRODUCT_NAME } from '@/lib/project-branding'
import { at, plural } from '@/lib/status'
import { useFrame } from '../frame/FrameContext'
import { AnsweredCard } from './AnsweredCard'
import { ApprovalCard } from './ApprovalCard'
import { AttachedFileView } from './AskAttached'
import { AskCard } from './AskCard'
import { AsksState, askTitle, Note, useSentNote } from './ask-shared'

type Tab = 'asks' | 'approvals' | 'answered'

/** The push link (`?ask=<id>`): read once on load, then dropped from the URL
 * so a reload does not reopen it. */
export function takeAskFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const id = url.searchParams.get('ask')
  if (id === null) return null
  url.searchParams.delete('ask')
  window.history.replaceState(window.history.state, '', url)
  return /^[0-9a-f]{12}$/.test(id) ? id : null
}

/** Where the launcher sits: the session bar on a desktop (`pill`), its
 * folded rail (`icon`), the phone's session bar (`compact`: the count alone,
 * nothing when nothing waits), the session sheet (`row`: labelled) or no
 * button at all (`none`). */
type Variant = 'pill' | 'icon' | 'compact' | 'row' | 'none'

/** The "N need you" button: it shows Needs you in the side. */
export function NeedsYouLauncher({ variant = 'pill' }: { variant?: Variant }) {
  const { count, summary } = useNeedsYouCounts()
  const show = () => openNeedsYou()

  if (variant === 'none') return null
  if (variant === 'row')
    return (
      <button
        type="button"
        className="lantern-btn ghost small"
        onClick={show}
        aria-label={summary}
        title={summary}
        data-testid="needs-you-pill"
        data-count={count}
      >
        <Inbox className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
        Needs you
        {count > 0 && (
          <span aria-hidden="true" style={{ color: 'var(--lantern)' }}>
            {count}
          </span>
        )}
      </button>
    )
  if (variant === 'icon' || (variant !== 'compact' && count === 0))
    return (
      <button
        type="button"
        className="lantern-icon-btn compact relative"
        onClick={show}
        aria-label={summary}
        title={summary}
        data-testid="needs-you-pill"
        data-count={count}
      >
        <Inbox className="h-[18px] w-[18px]" strokeWidth={1.7} />
        {count > 0 && (
          <span aria-hidden="true" className="lantern-rail-count">
            {count}
          </span>
        )}
      </button>
    )
  if (count === 0) return null
  return (
    <button
      type="button"
      className="lantern-need-pill"
      onClick={show}
      aria-label={summary}
      title={summary}
      data-testid="needs-you-pill"
      data-count={count}
    >
      <span aria-hidden="true" className="dot" />
      {variant === 'pill' ? `${count} need you` : count}
    </button>
  )
}

/** Needs you as a page in the main area (Wide, Full or the phone's sheet):
 * every question, the grant requests, and what was answered. The side's own
 * Needs you section shows the same cards on top of the list. */
export function NeedsYouPage({ focus = null }: { focus?: string | null }) {
  const frame = useFrame()
  return (
    <section
      aria-labelledby="needs-you-page-title"
      data-testid="needs-you-panel"
      className="flex h-full min-h-0 flex-col"
    >
      <NeedsYouBody
        focus={focus}
        onOpenSession={() => {
          if (frame && !frame.docked) frame.close()
        }}
        header={(summary) => (
          <>
            <h1
              id="needs-you-page-title"
              className="min-w-0 flex-1 truncate"
              style={{ font: '500 18px/1.2 var(--font-display)' }}
            >
              Needs you
            </h1>
            <span
              className="truncate text-[12px]"
              style={{ color: 'var(--mist)' }}
            >
              {summary}
            </span>
          </>
        )}
      />
    </section>
  )
}

/** The header row, tabs and cards every Needs you shares. */
function NeedsYouBody({
  focus,
  header,
  onOpenSession,
}: {
  focus: string | null
  /** The title row, given the "2 agent questions · 1 notice" line. */
  header: (summary: string) => ReactNode
  /** Called after a card opens its session (the phone closes the sheet). */
  onOpenSession?: () => void
}) {
  const { asks, known, isLoading, isError, refetch } = useOwnerAsks()
  const { approvals, isLoading: approvalsLoading } = useApprovals()
  const unreachable = useServerReach().down && !known
  const now = Date.now()
  const waiting = openAsks(asks)
  const answered = answeredAsks(asks, now)
  const focused = focus ? asks.find((ask) => ask.id === focus) : undefined
  const [tab, setTab] = useState<Tab>(
    focused && focused.state !== 'open' ? 'answered' : 'asks',
  )
  const taps = approvals?.taps ?? []
  /** What the last Send said, until the owner moves on. */
  const [sent, setSent] = useSentNote()
  /** An attached file open in the list's place; the list stays mounted
   * (hidden) so a half-typed reply and the scroll survive the visit. */
  const [viewing, setViewing] = useState<{
    file: AttachedFile
    question: string
  } | null>(null)
  const openAttached = (ask: OwnerAsk) => (file: AttachedFile) =>
    setViewing({ file, question: askTitle(ask) })
  const backFromFile = () => {
    const path = viewing?.file.path
    setViewing(null)
    window.requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          `[data-testid="ask-attached"][title="${CSS.escape(path ?? '')}"]`,
        )
        ?.focus(),
    )
  }
  const blockedSessions = new Set(
    waiting.filter((ask) => ask.blocking && ask.session).map((a) => a.session),
  ).size
  const summary = known
    ? [
        ...askCountsParts(askCounts(asks)),
        blockedSessions ? plural(blockedSessions, 'waiting session') : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'Nothing waiting'
    : 'Not loaded yet'

  return (
    <>
      <div className="flex items-center gap-2 pt-3 pr-2 pb-1 pl-4">
        {header(summary)}
      </div>
      {viewing && (
        <AttachedFileView
          file={viewing.file}
          question={viewing.question}
          onBack={backFromFile}
        />
      )}
      <div
        role="tablist"
        aria-label="Needs you"
        hidden={viewing !== null}
        className="flex flex-none gap-1 px-3 pb-2"
        style={{ borderBottom: '1px solid var(--paper-veil)' }}
      >
        <TabButton id="asks" tab={tab} onSelect={setTab}>
          Asks{waiting.length ? ` ${waiting.length}` : ''}
        </TabButton>
        <TabButton id="approvals" tab={tab} onSelect={setTab}>
          Grants{taps.length ? ` ${taps.length}` : ''}
        </TabButton>
        <TabButton id="answered" tab={tab} onSelect={setTab}>
          Answered
        </TabButton>
      </div>
      <div
        role="tabpanel"
        hidden={viewing !== null}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-4"
      >
        <div className="mb-2.5 empty:hidden">
          <AsOfNote />
        </div>
        {tab === 'approvals' ? (
          approvalsLoading ? (
            <Note>Checking grant requests…</Note>
          ) : approvals?.state !== 'ok' ? (
            <Note>
              Can’t read grant requests right now. Open the Aico tray on your
              computer to see them.
            </Note>
          ) : taps.length === 0 ? (
            <Note>Nothing waiting for your security key.</Note>
          ) : (
            <ul className="flex flex-col gap-2.5" aria-label="Grants">
              {taps.map((tap) => (
                <ApprovalCard key={tap.id} tap={tap} />
              ))}
            </ul>
          )
        ) : (
          <AsksState
            unreachable={unreachable}
            isLoading={isLoading}
            isError={isError}
            refetch={refetch}
          >
            {tab === 'asks' ? (
              <>
                {sent && (
                  <p
                    role="status"
                    className="mb-2.5 rounded-md px-2.5 py-2 text-[13px]"
                    style={{
                      backgroundColor: 'rgb(var(--lantern-rgb) / 0.12)',
                    }}
                  >
                    {sent}{' '}
                    <button
                      type="button"
                      className="underline"
                      style={{ color: 'var(--lantern)' }}
                      onClick={() => setTab('answered')}
                    >
                      See Answered
                    </button>
                  </p>
                )}
                {waiting.length === 0 ? (
                  <Note>
                    {sent
                      ? 'Nothing else waiting.'
                      : 'Nothing waiting for you. Check results are under Status.'}
                  </Note>
                ) : (
                  <ul className="flex flex-col gap-2.5" aria-label="Questions">
                    {orderFocused(waiting, focus).map((ask) => (
                      <AskCard
                        key={ask.id}
                        ask={ask}
                        now={now}
                        onSent={setSent}
                        onOpenSession={onOpenSession}
                        onOpenFile={openAttached(ask)}
                      />
                    ))}
                  </ul>
                )}
              </>
            ) : answered.length === 0 ? (
              <Note>Nothing answered in the last day.</Note>
            ) : (
              <ul className="flex flex-col gap-2.5" aria-label="Answered">
                {orderFocused(answered, focus).map((ask) => (
                  <AnsweredCard key={ask.id} ask={ask} now={now} />
                ))}
              </ul>
            )}
          </AsksState>
        )}
      </div>
    </>
  )
}

function orderFocused(asks: OwnerAsk[], focus: string | null): OwnerAsk[] {
  const first = asks.find((ask) => ask.id === focus)
  return first ? [first, ...asks.filter((ask) => ask !== first)] : asks
}

function TabButton({
  id,
  tab,
  onSelect,
  children,
}: {
  id: Tab
  tab: Tab
  onSelect: (tab: Tab) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className="lantern-btn ghost small"
      aria-pressed={tab === id}
      onClick={() => onSelect(id)}
    >
      {children}
    </button>
  )
}

/** While the server can't be reached the cards are its last copy: say as of
 * when, and that answers wait (their buttons are off). */
function AsOfNote() {
  const reach = useServerReach()
  const now = useClock(30_000)
  if (!reach.down) return null
  return (
    <p
      role="status"
      data-testid="needs-you-as-of"
      className="rounded-md px-2.5 py-2 text-[13px]"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--ember) 15%, transparent)',
      }}
    >
      {reach.answered
        ? `As of ${at(reach.since, now)}. Can’t reach ${PRODUCT_NAME}, so answers wait until it is back.`
        : `Can’t reach ${PRODUCT_NAME} since ${at(reach.since, now)}.`}
    </p>
  )
}

/** Needs you at the top of the side's list: the first few questions as full
 * cards (a push link or a session's own question puts one first), the rest
 * and the answered ones on the Needs you page. */
export function NeedsYouSection() {
  const { asks, known, isLoading, isError, refetch } = useOwnerAsks()
  const { approvals } = useApprovals()
  const unreachable = useServerReach().down && !known
  const router = useRouter()
  const frame = useFrame()
  const ref = useRef<HTMLElement>(null)
  const [focus, setFocus] = useState<string | null>(null)
  /** The section was asked for (the top bar's count): it flashes once, so a tap
   * when it is already showing still answers. */
  const [called, setCalled] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [sent, setSent] = useSentNote()
  const now = Date.now()
  const waiting = orderFocused(openAsks(asks), focus)
  const taps = approvals?.taps ?? []
  useNeedsYouRequests((request) => {
    setFocus(request.focus)
    setCalled(true)
    window.setTimeout(() => setCalled(false), 1400)
    window.requestAnimationFrame(() =>
      ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    )
  })
  const shown = showAll ? waiting : waiting.slice(0, 3)
  const total = waiting.length + taps.length
  const openPage = () => {
    router.push('/needs-you')
    if (frame && !frame.docked) frame.close()
  }
  return (
    <section
      ref={ref}
      aria-label="Needs you"
      data-testid="needs-you-section"
      data-called={called ? 'true' : undefined}
      className="lantern-called flex flex-col gap-2"
    >
      <div className="lantern-sec">
        <h2>Needs you</h2>
        {total > 0 && <span className="n">{total}</span>}
        <button
          type="button"
          className="ml-auto text-[11px] normal-case tracking-normal max-lg:min-h-11"
          style={{ color: 'var(--lantern)' }}
          onClick={openPage}
        >
          All and answered
        </button>
      </div>
      {sent && (
        <p
          role="status"
          className="rounded-md px-2.5 py-2 text-[13px]"
          style={{ backgroundColor: 'rgb(var(--lantern-rgb) / 0.12)' }}
        >
          {sent}
        </p>
      )}
      <AsOfNote />
      <AsksState
        unreachable={unreachable}
        isLoading={isLoading}
        isError={isError}
        refetch={refetch}
      >
        {total === 0 ? (
          <Note>
            {sent ? 'Nothing else waiting.' : 'Nothing is waiting for you.'}
          </Note>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Questions">
            {taps.map((tap) => (
              <ApprovalCard key={tap.id} tap={tap} />
            ))}
            {shown.map((ask) => (
              <AskCard
                key={ask.id}
                ask={ask}
                now={now}
                compact
                onSent={setSent}
                onOpenSession={() => {
                  if (frame && !frame.docked) frame.close()
                }}
              />
            ))}
          </ul>
        )}
      </AsksState>
      {!showAll && waiting.length > shown.length && (
        <button
          type="button"
          className="lantern-btn ghost small self-start"
          onClick={() => setShowAll(true)}
        >
          Show {waiting.length - shown.length} more
        </button>
      )}
    </section>
  )
}
