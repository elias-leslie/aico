'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import { Check, Copy, Inbox, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { formatAge } from '@/lib/attention'
import { openFiles } from '@/lib/files-opener'
import {
  type Approval,
  type AskReply,
  answeredAsks,
  type OwnerAsk,
  openAsks,
  useApprovals,
  useAskReply,
  useOwnerAsks,
} from '@/lib/hooks/use-asks'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useTerminalSessions } from '@/lib/hooks/use-terminal-sessions'

type Tab = 'asks' | 'approvals' | 'answered'

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? '' : 's'}`

/** The push link (`?ask=<id>`): read once on load, then dropped from the URL
 * so a reload does not reopen the drawer. */
function takeAskFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const id = url.searchParams.get('ask')
  if (id === null) return null
  url.searchParams.delete('ask')
  window.history.replaceState(window.history.state, '', url)
  return /^[0-9a-f]{12}$/.test(id) ? id : null
}

/** One drawer for the whole page: the launcher that opened it shows it, and
 * when that one leaves the screen (the session bar giving way to the list, the
 * session sheet closing) another launcher still on screen takes it over. */
interface DrawerState {
  open: boolean
  focus: string | null
  owner: string | null
}
let drawerState: DrawerState = { open: false, focus: null, owner: null }
const drawerListeners = new Set<() => void>()
function setDrawer(next: Partial<DrawerState>): void {
  drawerState = { ...drawerState, ...next }
  for (const listener of drawerListeners) listener()
}
function subscribeDrawer(listener: () => void): () => void {
  drawerListeners.add(listener)
  return () => drawerListeners.delete(listener)
}
const readDrawer = () => drawerState

/** Where the launcher sits: the session bar on a desktop (`pill`), the
 * session list header where Health and Hosts share the row (`count`: the pill
 * with the count alone), its folded rail (`icon`), the phone's session bar
 * (`compact`: the count alone, nothing when nothing waits) or the session
 * sheet (`row`, always there). */
type Variant = 'pill' | 'count' | 'icon' | 'compact' | 'row'

/** The "N need you" pill and its drawer: questions agents asked, Nightshift
 * approvals (links only) and what was answered. */
export function NeedsYouLauncher({ variant = 'pill' }: { variant?: Variant }) {
  const { asks } = useOwnerAsks()
  const { approvals } = useApprovals()
  const me = useId()
  const drawer = useSyncExternalStore(subscribeDrawer, readDrawer, readDrawer)
  const waiting = openAsks(asks).length
  const taps = approvals?.taps.length ?? 0
  const count = waiting + taps

  // The sheet row mounts only while the sheet is open; the bar or the list
  // that is always on screen takes the push link and an orphaned drawer.
  useEffect(() => {
    if (variant === 'row') return
    const id = takeAskFromUrl()
    if (id) setDrawer({ open: true, focus: id, owner: null })
  }, [variant])
  useEffect(() => {
    if (variant !== 'row' && drawer.open && drawer.owner === null)
      setDrawer({ owner: me })
  }, [variant, drawer.open, drawer.owner, me])
  useEffect(
    () => () => {
      if (drawerState.owner === me) setDrawer({ owner: null })
    },
    [me],
  )

  const summary =
    count === 0
      ? 'Needs you: nothing waiting'
      : `${[
          waiting ? plural(waiting, 'question') : null,
          taps ? plural(taps, 'approval') : null,
        ]
          .filter(Boolean)
          .join(' and ')} waiting for you`
  const show = () => setDrawer({ open: true, focus: null, owner: me })

  let button: ReactNode
  if (variant === 'row')
    button = (
      <button
        type="button"
        className="lantern-btn ghost small"
        onClick={show}
        aria-label={summary}
        title={summary}
        data-testid="needs-you-pill"
        data-count={count}
      >
        <Inbox className="h-4 w-4" strokeWidth={1.7} />
        {count > 0 ? `${count} need you` : 'Needs you'}
      </button>
    )
  else if (variant === 'icon' || (variant !== 'compact' && count === 0))
    button = (
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
  else if (count > 0)
    button = (
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

  return (
    <>
      {button}
      {drawer.open && drawer.owner === me && (
        <NeedsYouDrawer
          open
          onOpenChange={(next) => {
            if (!next) setDrawer({ open: false, focus: null, owner: null })
          }}
          focus={drawer.focus}
        />
      )}
    </>
  )
}

export function NeedsYouDrawer({
  open,
  onOpenChange,
  focus = null,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** An ask to show first (a push link). */
  focus?: string | null
}) {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const { asks, isLoading, isError, refetch } = useOwnerAsks()
  const { approvals, isLoading: approvalsLoading } = useApprovals()
  const now = Date.now()
  const waiting = openAsks(asks)
  const answered = answeredAsks(asks, now)
  const focused = focus ? asks.find((ask) => ask.id === focus) : undefined
  const [tab, setTab] = useState<Tab>(
    focused && focused.state !== 'open' ? 'answered' : 'asks',
  )
  const taps = approvals?.taps ?? []
  const blockedSessions = new Set(
    waiting.filter((ask) => ask.blocking && ask.session).map((a) => a.session),
  ).size

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={isMobile}>
      <Dialog.Portal>
        {isMobile && (
          <Dialog.Overlay
            className="fixed inset-0 z-[10000]"
            style={{ backgroundColor: 'var(--scrim)' }}
          />
        )}
        <Dialog.Content
          data-testid="needs-you-drawer"
          aria-describedby={undefined}
          // Beside the session on a desktop: clicking the session keeps it open.
          onInteractOutside={(event) => {
            if (!isMobile) event.preventDefault()
          }}
          className={clsx(
            'lantern-sheet fixed z-[10001] flex flex-col overflow-hidden outline-none',
            isMobile
              ? 'lantern-rise inset-x-0 bottom-0 h-[84dvh] rounded-t-[14px]'
              : 'lantern-enter top-0 right-0 bottom-0 w-[380px] max-w-[92vw]',
          )}
          style={{
            color: 'var(--bone)',
            borderLeft: isMobile ? undefined : '1px solid var(--paper-veil)',
          }}
        >
          {isMobile && (
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 rounded-full"
              style={{ backgroundColor: 'var(--paper-veil)' }}
            />
          )}
          <div className="flex items-center gap-2 pt-3 pr-2 pb-1 pl-4">
            <Dialog.Title
              className="min-w-0 flex-1"
              style={{ font: '500 18px/1.2 var(--font-display)' }}
            >
              Needs you
            </Dialog.Title>
            <span className="text-[11px]" style={{ color: 'var(--mist)' }}>
              {[
                plural(waiting.length, 'question'),
                blockedSessions
                  ? plural(blockedSessions, 'waiting session')
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <Dialog.Close aria-label="Close" className="lantern-icon-btn">
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </div>
          <div
            role="tablist"
            aria-label="Needs you"
            className="flex flex-none gap-1 px-3 pb-2"
            style={{ borderBottom: '1px solid var(--paper-veil)' }}
          >
            <TabButton id="asks" tab={tab} onSelect={setTab}>
              Asks{waiting.length ? ` ${waiting.length}` : ''}
            </TabButton>
            <TabButton id="approvals" tab={tab} onSelect={setTab}>
              Approvals{taps.length ? ` ${taps.length}` : ''}
            </TabButton>
            <TabButton id="answered" tab={tab} onSelect={setTab}>
              Answered
            </TabButton>
          </div>
          <div
            role="tabpanel"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-4"
          >
            {tab === 'approvals' ? (
              approvalsLoading ? (
                <Note>Checking Nightshift…</Note>
              ) : approvals?.state !== 'ok' ? (
                <Note>
                  Can’t read Nightshift’s approvals right now. Open Nightshift
                  to see them.
                </Note>
              ) : taps.length === 0 ? (
                <Note>Nothing waiting for your security key.</Note>
              ) : (
                <ul className="flex flex-col gap-2.5" aria-label="Approvals">
                  {taps.map((tap) => (
                    <ApprovalCard key={tap.id} tap={tap} />
                  ))}
                </ul>
              )
            ) : isLoading ? (
              <Note>Loading questions…</Note>
            ) : isError ? (
              <Note>
                Couldn’t load questions.{' '}
                <button
                  type="button"
                  className="underline"
                  style={{ color: 'var(--lantern)' }}
                  onClick={() => void refetch()}
                >
                  Try again
                </button>
              </Note>
            ) : tab === 'asks' ? (
              waiting.length === 0 ? (
                <Note>
                  No questions waiting. Agents’ questions show up here.
                </Note>
              ) : (
                <ul className="flex flex-col gap-2.5" aria-label="Questions">
                  {orderFocused(waiting, focus).map((ask) => (
                    <AskCard
                      key={ask.id}
                      ask={ask}
                      now={now}
                      onOpenSession={
                        isMobile ? () => onOpenChange(false) : undefined
                      }
                    />
                  ))}
                </ul>
              )
            ) : answered.length === 0 ? (
              <Note>Nothing answered in the last day.</Note>
            ) : (
              <ul className="flex flex-col gap-2.5" aria-label="Answered">
                {orderFocused(answered, focus).map((ask) => (
                  <AnsweredCard key={ask.id} ask={ask} now={now} />
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 py-2 text-[13px]" style={{ color: 'var(--mist)' }}>
      {children}
    </p>
  )
}

/** Who asked: the session's name, else the requester's label. */
function useAsker(ask: OwnerAsk): { name: string; sessionId: string | null } {
  const { sessions } = useTerminalSessions({ includeDetached: true })
  return useMemo(() => {
    const session = ask.session
      ? sessions?.find((item) => item.id === ask.session)
      : undefined
    if (session) return { name: session.name, sessionId: session.id }
    if (ask.session) return { name: 'An ended session', sessionId: null }
    return { name: ask.requester ?? 'An agent', sessionId: null }
  }, [ask.session, ask.requester, sessions])
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <div
      className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[11px]"
      style={{ color: 'var(--mist)' }}
    >
      {children}
    </div>
  )
}

function OpenSession({
  sessionId,
  onOpen,
}: {
  sessionId: string | null
  onOpen?: () => void
}) {
  const router = useRouter()
  if (!sessionId) return null
  return (
    <button
      type="button"
      className="lantern-btn ghost small ml-auto"
      onClick={() => {
        const params = new URLSearchParams(window.location.search)
        params.delete('ask')
        params.set('session', sessionId)
        router.push(`?${params.toString()}`, { scroll: false })
        onOpen?.()
      }}
    >
      Open session
    </button>
  )
}

function AskCard({
  ask,
  now,
  onOpenSession,
}: {
  ask: OwnerAsk
  now: number
  onOpenSession?: () => void
}) {
  const asker = useAsker(ask)
  const reply = useAskReply()
  const [choice, setChoice] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const hasOptions = ask.options.length > 0
  const send = (answer: AskReply) => reply.mutate({ id: ask.id, reply: answer })
  const noteText = note.trim()
  const canSend = !reply.isPending && (choice !== null || noteText.length > 0)

  return (
    <li
      data-testid="ask-card"
      className="lantern-ask"
      data-blocking={ask.blocking ? 'true' : undefined}
    >
      <Meta>
        <span className="min-w-0 truncate" style={{ color: 'var(--bone)' }}>
          {asker.name}
        </span>
        <span aria-hidden="true">·</span>
        <span className="whitespace-nowrap">
          {ask.blocking ? 'agent is waiting' : 'whenever'} ·{' '}
          {formatAge(now - ask.createdAt)}
        </span>
      </Meta>
      <p className="mb-1.5 font-semibold" style={{ overflowWrap: 'anywhere' }}>
        {ask.question}
      </p>
      {ask.body && (
        <p
          className="mb-2 text-[12.5px] whitespace-pre-wrap"
          style={{
            color: 'rgb(var(--bone-rgb) / 0.72)',
            overflowWrap: 'anywhere',
          }}
        >
          {ask.body}
        </p>
      )}
      {ask.command && <CommandBox command={ask.command} />}
      {ask.share && (
        <button
          type="button"
          className="lantern-btn ghost small mb-2 -ml-2.5"
          style={{ color: 'var(--lantern)' }}
          onClick={() =>
            openFiles({ kind: 'shared', showId: ask.share ?? undefined })
          }
        >
          Open what it shared
        </button>
      )}
      {hasOptions && (
        <div
          role="radiogroup"
          aria-label="Choices"
          className="mb-2 flex flex-col gap-1.5"
        >
          {ask.options.map((option, index) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={choice === index}
              className="lantern-ask-option"
              data-recommended={ask.recommended === index ? 'true' : undefined}
              onClick={() => setChoice(choice === index ? null : index)}
            >
              <b aria-hidden="true">{String.fromCharCode(65 + index)}</b>
              <span className="min-w-0 flex-1">{option}</span>
              {ask.recommended === index && <em>recommended</em>}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSend) return
          send({
            kind: 'answer',
            ...(choice !== null ? { option: choice } : {}),
            ...(noteText ? { note: noteText } : {}),
          })
        }}
      >
        <label className="lantern-field h-[30px] min-w-0 flex-1 px-2">
          <span className="sr-only">
            {hasOptions ? 'Note to the agent' : 'Reply to the agent'}
          </span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              hasOptions ? 'Optional note to the agent…' : 'Reply to the agent…'
            }
            maxLength={1000}
            className="text-[12.5px]"
          />
        </label>
        <button
          type="submit"
          className="lantern-btn primary small"
          disabled={!canSend}
        >
          Send
        </button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {!hasOptions && (
          <button
            type="button"
            className="lantern-btn small"
            disabled={reply.isPending}
            onClick={() => send({ kind: 'answer', text: 'Done' })}
          >
            Mark done
          </button>
        )}
        <button
          type="button"
          className="lantern-btn ghost small"
          disabled={reply.isPending}
          onClick={() => send({ kind: 'answer', text: 'Not now' })}
        >
          Not now
        </button>
        <OpenSession sessionId={asker.sessionId} onOpen={onOpenSession} />
      </div>
      {reply.isError && (
        <p
          role="alert"
          className="mt-1.5 text-[12px]"
          style={{ color: 'var(--ember)' }}
        >
          {reply.error.message}
        </p>
      )}
    </li>
  )
}

function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="lantern-ask-cmd mb-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap">{command}</code>
      <button
        type="button"
        className="lantern-btn ghost small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          } catch {
            setCopied(false)
          }
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" strokeWidth={1.7} />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={1.7} />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/** How the answer travels, in the owner's words. */
export function deliveryText(ask: OwnerAsk): string {
  if (ask.state === 'done') return 'Done: the agent acted on it.'
  if (ask.state === 'withdrawn') return 'The agent withdrew it.'
  if (ask.delivery === 'wake')
    return 'Sent to the session. The agent gets it once it is idle.'
  return 'Saved. The agent reads it when it checks; this session can’t be messaged.'
}

function AnsweredCard({ ask, now }: { ask: OwnerAsk; now: number }) {
  const asker = useAsker(ask)
  const reply = useAskReply()
  return (
    <li data-testid="answered-card" className="lantern-ask">
      <Meta>
        <span className="min-w-0 truncate" style={{ color: 'var(--bone)' }}>
          {asker.name}
        </span>
        <span aria-hidden="true">·</span>
        <span className="whitespace-nowrap">
          {formatAge(now - (ask.answeredAt ?? ask.updatedAt))}
        </span>
      </Meta>
      <p className="mb-1 font-semibold" style={{ overflowWrap: 'anywhere' }}>
        {ask.question}
      </p>
      <p className="text-[12.5px]" style={{ overflowWrap: 'anywhere' }}>
        {ask.answer ? (
          <>
            You answered <b>{ask.answer}</b>
          </>
        ) : (
          'You replied'
        )}
        {ask.note ? `: “${ask.note}”` : ''}
      </p>
      <p className="mt-1 text-[11.5px]" style={{ color: 'var(--mist)' }}>
        {deliveryText(ask)}
      </p>
      {ask.state === 'answered' && (
        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            className="lantern-btn ghost small -ml-2.5"
            disabled={reply.isPending}
            onClick={() =>
              reply.mutate({ id: ask.id, reply: { kind: 'done' } })
            }
            title="Close it here if the agent already handled it"
          >
            Clear
          </button>
          <OpenSession sessionId={asker.sessionId} />
        </div>
      )}
    </li>
  )
}

function ApprovalCard({ tap }: { tap: Approval }) {
  const minutes = Math.max(1, Math.round(tap.expiresInS / 60))
  return (
    <li className="lantern-ask">
      <Meta>
        <span>Nightshift · security key</span>
        <span aria-hidden="true">·</span>
        <span>
          expires in{' '}
          {minutes >= 60
            ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
            : `${minutes}m`}
        </span>
      </Meta>
      <p className="mb-1.5 font-semibold" style={{ overflowWrap: 'anywhere' }}>
        {tap.title}
      </p>
      <a
        href={tap.url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[12.5px]"
        style={{ color: 'var(--lantern)' }}
      >
        Approve in Nightshift →
      </a>
    </li>
  )
}
