'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import { ArrowLeft, Check, Copy, Inbox, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { formatAge } from '@/lib/attention'
import { dropAskCaptureQueue } from '@/lib/capture-queue'
import { openFiles } from '@/lib/files-opener'
import {
  type Approval,
  type AskReply,
  type AttachedFile,
  answeredAsks,
  type OwnerAsk,
  openAsks,
  useApprovals,
  useAskReply,
  useOwnerAsks,
} from '@/lib/hooks/use-asks'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useTerminalSessions } from '@/lib/hooks/use-terminal-sessions'
import { AttachedFiles, AttachedFileView } from './AskAttached'
import {
  AnsweredFiles,
  AskFilesBlock,
  addMoreText,
  useAskFiles,
} from './AskFiles'

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
  /** Session lists on screen: while one is, Needs you takes its place
   * instead of opening a drawer over the session. */
  hosts: number
  /** Opened by a click (focus moves into it), not by a push link or the
   * window widening while it was open. */
  byHand: boolean
}
let drawerState: DrawerState = {
  open: false,
  focus: null,
  owner: null,
  hosts: 0,
  byHand: false,
}
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

/** Open Needs you, with one question first (a push link, the session's own
 * question on the phone). */
export function openNeedsYou(focus: string | null = null): void {
  setDrawer({ open: true, focus, byHand: true })
}

export function closeNeedsYou(): void {
  setDrawer({ open: false, focus: null, owner: null })
}

export function useNeedsYouState(): DrawerState {
  return useSyncExternalStore(subscribeDrawer, readDrawer, readDrawer)
}

/** The session list calls this while it is on screen, so Needs you opens in
 * its place. */
export function useHostNeedsYou(): void {
  useEffect(() => {
    setDrawer({ hosts: drawerState.hosts + 1 })
    return () => setDrawer({ hosts: drawerState.hosts - 1 })
  }, [])
}

/** Where the launcher sits: the session bar on a desktop (`pill`), the
 * session list's tool row beside Status and Hosts (`tool`: labelled), its
 * folded rail (`icon`), the phone's session bar (`compact`: the count alone,
 * nothing when nothing waits), the session sheet (`row`: labelled, mounted
 * only while the sheet is open) or no button at all (`none`: a session's own
 * question opening the drawer). */
type Variant = 'pill' | 'tool' | 'icon' | 'compact' | 'row' | 'none'

/** The "N need you" pill and its drawer: questions agents asked, access
 * requests waiting for your security key (links only) and what was answered. */
export function NeedsYouLauncher({ variant = 'pill' }: { variant?: Variant }) {
  const { asks } = useOwnerAsks()
  const { approvals } = useApprovals()
  const me = useId()
  const drawer = useNeedsYouState()
  const waiting = openAsks(asks).length
  const taps = approvals?.taps.length ?? 0
  const count = waiting + taps

  // The sheet row mounts only while the sheet is open; the bar or the list
  // that is always on screen takes the push link and an orphaned drawer.
  useEffect(() => {
    if (variant === 'row') return
    const id = takeAskFromUrl()
    if (id) setDrawer({ open: true, focus: id, owner: null, byHand: false })
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

  // Agents' questions and access requests only; check results
  // count under Status.
  const summary =
    count === 0
      ? 'Needs you: no agent questions or approvals waiting'
      : `Needs you: ${[
          waiting ? plural(waiting, 'agent question') : null,
          taps ? plural(taps, 'approval') : null,
        ]
          .filter(Boolean)
          .join(' and ')} waiting`
  // The bar's button toggles its dropdown.
  const show = () =>
    drawer.open && drawer.owner === me && drawer.hosts === 0
      ? closeNeedsYou()
      : setDrawer({ open: true, focus: null, owner: me, byHand: true })

  let button: ReactNode
  if (variant === 'none') button = null
  else if (variant === 'row' || variant === 'tool')
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
        <Inbox className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
        Needs you
        {count > 0 && (
          <span aria-hidden="true" style={{ color: 'var(--lantern)' }}>
            {count}
          </span>
        )}
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
      {drawer.open && drawer.owner === me && drawer.hosts === 0 && (
        <NeedsYouDrawer
          open
          onOpenChange={(next) => {
            if (!next) closeNeedsYou()
          }}
          focus={drawer.focus}
        />
      )}
    </>
  )
}

/** Phones: a sheet over most of the screen. A desktop without the session
 * list beside the session: a dropdown under the bar's button. */
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
          // The bar's button toggles it; a click there is not a dismissal.
          onInteractOutside={(event) => {
            const target = event.target as Element | null
            if (target?.closest?.('[data-testid="needs-you-pill"]'))
              event.preventDefault()
          }}
          className={clsx(
            'lantern-sheet fixed z-[10001] flex flex-col overflow-hidden outline-none',
            isMobile
              ? 'lantern-rise inset-x-0 bottom-0 h-[84dvh] rounded-t-[14px]'
              : 'lantern-enter top-12 right-2 max-h-[min(680px,calc(100dvh-64px))] w-[380px] max-w-[calc(100vw-16px)] rounded-[10px]',
          )}
          style={{
            color: 'var(--bone)',
            border: isMobile ? undefined : '1px solid var(--paper-veil)',
          }}
        >
          {isMobile && (
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 rounded-full"
              style={{ backgroundColor: 'var(--paper-veil)' }}
            />
          )}
          <NeedsYouBody
            focus={focus}
            onOpenSession={isMobile ? () => onOpenChange(false) : undefined}
            header={(summary) => (
              <>
                <Dialog.Title
                  className="min-w-0 flex-1"
                  style={{ font: '500 18px/1.2 var(--font-display)' }}
                >
                  Needs you
                </Dialog.Title>
                <span className="text-[12px]" style={{ color: 'var(--mist)' }}>
                  {summary}
                </span>
                <Dialog.Close aria-label="Close" className="lantern-icon-btn">
                  <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
                </Dialog.Close>
              </>
            )}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A desktop with the session list: Needs you in the list's place, under the
 * button that opened it, beside the session instead of over it. Back, or Esc
 * from inside it, brings the list back. */
export function NeedsYouPanel() {
  const { focus, byHand } = useNeedsYouState()
  const backRef = useRef<HTMLButtonElement>(null)
  // Only when clicked open; else the session keeps the keyboard.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useEffect(() => {
    if (byHand) backRef.current?.focus({ preventScroll: true })
  }, [])
  const back = () => {
    closeNeedsYou()
    // Back on the button that opened it, once the list is back.
    window.requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '[data-testid="session-sidebar"] [data-testid="needs-you-pill"]',
        )
        ?.focus(),
    )
  }
  return (
    <section
      aria-labelledby="needs-you-panel-title"
      data-testid="needs-you-panel"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // Esc in a half-typed reply keeps the reply.
        const target = event.target as HTMLInputElement
        if (target.tagName === 'INPUT' && target.value) return
        event.stopPropagation()
        back()
      }}
    >
      <NeedsYouBody
        focus={focus}
        onBack={back}
        header={(summary) => (
          <>
            <button
              ref={backRef}
              type="button"
              className="lantern-icon-btn compact -ml-1.5"
              onClick={back}
              aria-label="Back to sessions"
              title="Back to sessions"
            >
              <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </button>
            <h2
              id="needs-you-panel-title"
              className="min-w-0 flex-1 truncate"
              style={{ font: '500 17px/1.2 var(--font-display)' }}
            >
              Needs you
            </h2>
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
  onBack,
}: {
  focus: string | null
  /** The title row, given the "N agent questions" line. */
  header: (summary: string) => ReactNode
  /** Called after a card opens its session (the phone closes the sheet). */
  onOpenSession?: () => void
  /** In the session list's place: a way back once nothing is left. */
  onBack?: () => void
}) {
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
  /** What the last Send said, until the owner moves on. */
  const [sent, setSent] = useState<string | null>(null)
  useEffect(() => {
    if (!sent) return
    const timer = window.setTimeout(() => setSent(null), 8000)
    return () => window.clearTimeout(timer)
  }, [sent])
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
  const summary = [
    plural(waiting.length, 'agent question'),
    blockedSessions ? plural(blockedSessions, 'waiting session') : null,
  ]
    .filter(Boolean)
    .join(' · ')

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
          Approvals{taps.length ? ` ${taps.length}` : ''}
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
        {tab === 'approvals' ? (
          approvalsLoading ? (
            <Note>Checking access requests…</Note>
          ) : approvals?.state !== 'ok' ? (
            <Note>
              Can’t read access requests right now. Open the Aico tray on your
              computer to see them.
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
              <>
                <Note>
                  {sent
                    ? 'Nothing else waiting.'
                    : 'No agent questions waiting. Check results are under Status.'}
                </Note>
                {onBack && (
                  <button
                    type="button"
                    className="lantern-btn small mt-1"
                    onClick={onBack}
                  >
                    Back to sessions
                  </button>
                )}
              </>
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

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 py-2 text-[13px]" style={{ color: 'var(--mist)' }}>
      {children}
    </p>
  )
}

/** A session's name from the list the app already has, else null. */
function useSessionName(): (id: string) => string | null {
  const { sessions } = useTerminalSessions({ includeDetached: true })
  return useCallback(
    (id: string) => sessions?.find((item) => item.id === id)?.name ?? null,
    [sessions],
  )
}

/** Who asked: the session's name, else the requester's label. */
function useAsker(ask: OwnerAsk): { name: string; sessionId: string | null } {
  const nameOf = useSessionName()
  return useMemo(() => {
    const name = ask.session ? nameOf(ask.session) : null
    if (ask.session && name !== null) return { name, sessionId: ask.session }
    if (ask.session) return { name: 'An ended session', sessionId: null }
    return { name: ask.requester ?? 'An agent', sessionId: null }
  }, [ask.session, ask.requester, nameOf])
}

/** Which session gets the owner's answer, in the owner's words (`text` short
 * for the phone, `detail` for the tooltip); null on an older Tether that does
 * not say (`answerTo` absent). */
function answerRoute(
  ask: OwnerAsk,
  nameOf: (id: string) => string | null,
  chat = false,
): { text: string; detail: string } | null {
  if (chat && ask.session)
    return {
      text: 'Answer goes to this chat',
      detail: 'The chat that asked gets it.',
    }
  if (ask.answerTo === undefined) return null
  if (ask.answerTo === null)
    return {
      text: 'No session will get the answer',
      detail: 'The agent reads it when it checks.',
    }
  const name = nameOf(ask.answerTo)
  const label = name ? `“${name}”` : `session ${ask.answerTo}`
  if (ask.answerTo === ask.session)
    return {
      text: `Answer goes to ${label}`,
      detail: 'The session that asked gets it.',
    }
  return {
    text: `Answer goes to ${label} (asker ended)`,
    detail:
      'The session that asked has ended, so the session that launched it gets the answer.',
  }
}

/** An ask an app filed (a notice or a failed Status row): nobody is waiting to read the
 * answer, so the card shows its choices and the link it opens, nothing to say to an agent. */
function isAppAsk(ask: OwnerAsk): boolean {
  return Boolean(ask.origin)
}

/** The https link the ask opens, else null. */
function openLink(ask: OwnerAsk): string | null {
  return typeof ask.open === 'string' && /^https:\/\//.test(ask.open)
    ? ask.open
    : null
}

/** The question as the owner reads it: a notice's ask ends with a short id that only keeps
 * two notices from merging in Tether. */
function askTitle(ask: OwnerAsk): string {
  return ask.origin === 'notice'
    ? ask.question.replace(/\s*\(#[0-9a-f]{6}\)$/, '') || ask.question
    : ask.question
}

/** What a down host is, in the owner's words. */
function awayText(state: string | undefined): string {
  return state === 'powered_off'
    ? 'powered off'
    : state === 'connecting'
      ? 'still connecting'
      : 'not reachable'
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <div
      className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[12px]"
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

export function AskCard({
  ask,
  now,
  onSent,
  onOpenSession,
  onOpenFile,
  inSession = false,
}: {
  ask: OwnerAsk
  now: number
  /** Called with what was said once the answer is saved. */
  onSent?: (text: string) => void
  onOpenSession?: () => void
  /** Opens an attached file in place; without it, the session's Files viewer. */
  onOpenFile?: (file: AttachedFile) => void
  /** Shown in the session that asked: no asker line, no Open session. */
  inSession?: boolean
}) {
  const asker = useAsker(ask)
  const nameOf = useSessionName()
  const { sessions } = useTerminalSessions({ includeDetached: true })
  const chat =
    !ask.host &&
    sessions?.some(
      (session) => session.id === ask.session && session.mode === 'aico-chat',
    )
  const app = isAppAsk(ask)
  const link = openLink(ask)
  const route = app ? null : answerRoute(ask, nameOf, chat)
  const reply = useAskReply()
  const [choice, setChoice] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const hasOptions = ask.options.length > 0
  const files = useAskFiles(ask)
  const wantsFiles = files.wants !== null
  // The card leaves the list once the answer is saved, so the drawer says it.
  const send = (answer: AskReply, said: string) =>
    reply
      .mutateAsync({ id: ask.id, reply: answer })
      .then(({ ask: saved }) => {
        // Sent: the files are the agent's now, not a draft.
        dropAskCaptureQueue(ask.id)
        onSent?.(
          `${saved.delivery === 'wake' ? 'Sent to' : 'Saved for'} “${(saved.answerTo && nameOf(saved.answerTo)) || asker.name}”: ${said}.`,
        )
      })
      .catch(() => {
        // reply.error shows under the card; saved files stay saved.
      })
  const noteText = note.trim()
  const said = choice !== null || noteText.length > 0
  // A linked host that is down cannot take the answer; this is its last copy.
  const away = ask.peer !== undefined
  const canSend =
    !away &&
    !reply.isPending &&
    files.waiting === 0 &&
    (wantsFiles ? files.enough && (said || files.saved.length > 0) : said)
  const sendLabel =
    files.waiting > 0
      ? `Waiting for ${files.waiting} upload${files.waiting === 1 ? '' : 's'}`
      : files.wants && !files.enough
        ? addMoreText(files.wants, files.saved.length)
        : 'Send'

  const Item = inSession ? 'div' : 'li'
  return (
    <Item
      data-testid="ask-card"
      className={inSession ? undefined : 'lantern-ask'}
      data-blocking={ask.blocking ? 'true' : undefined}
    >
      {!inSession && (
        <Meta>
          <span className="min-w-0 truncate" style={{ color: 'var(--bone)' }}>
            {asker.name}
          </span>
          <span aria-hidden="true">·</span>
          <span className="whitespace-nowrap">
            {ask.blocking ? 'agent is waiting' : 'whenever'} ·{' '}
            {formatAge(now - ask.createdAt)}
            {ask.host ? ` · on ${ask.host}` : ''}
          </span>
        </Meta>
      )}
      {away && (
        <p
          data-testid="ask-away"
          className="mb-1.5 text-[12px]"
          style={{ color: 'var(--ember)' }}
        >
          {ask.host ?? 'That computer'} is {awayText(ask.peer?.state)}. This is
          the last copy seen; you can answer when it is back.
        </p>
      )}
      <p className="mb-1.5 font-semibold" style={{ overflowWrap: 'anywhere' }}>
        {askTitle(ask)}
      </p>
      {ask.body && (
        <p
          className="mb-2 text-[13.5px] whitespace-pre-wrap"
          style={{
            color: 'rgb(var(--bone-rgb) / 0.72)',
            overflowWrap: 'anywhere',
          }}
        >
          {ask.body}
        </p>
      )}
      {ask.command && <CommandBox command={ask.command} />}
      <AttachedFiles
        ask={ask}
        onOpen={
          onOpenFile ?? ((file) => openFiles({ kind: 'path', path: file.path }))
        }
      />
      {ask.share && !ask.attached?.length && (
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
              <b aria-hidden="true">{index + 1}</b>
              <span className="min-w-0 flex-1">{option}</span>
              {ask.recommended === index && <em>recommended</em>}
            </button>
          ))}
        </div>
      )}
      {wantsFiles && <AskFilesBlock files={files} disabled={reply.isPending} />}
      {route && (
        <p
          data-testid="answer-route"
          className="mb-1.5 truncate text-[12px]"
          style={{ color: 'var(--mist)' }}
          title={`${route.text}. ${route.detail}`}
        >
          {route.text}
        </p>
      )}
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSend) return
          const picked = choice !== null ? ask.options[choice] : undefined
          const ids = files.saved.map((item) => item.capture?.id as string)
          send(
            {
              kind: 'answer',
              ...(choice !== null ? { option: choice } : {}),
              ...(noteText ? { note: noteText } : {}),
              ...(ids.length ? { files: ids } : {}),
            },
            [
              picked,
              noteText && `“${noteText}”`,
              ids.length && plural(ids.length, 'file'),
            ]
              .filter(Boolean)
              .join(', '),
          )
        }}
      >
        {!app && (
          <label className="lantern-field lantern-ask-note min-w-0 flex-1 px-2">
            <span className="sr-only">
              {hasOptions ? 'Note to the agent' : 'Reply to the agent'}
            </span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                hasOptions
                  ? 'Optional note to the agent…'
                  : 'Reply to the agent…'
              }
              maxLength={1000}
              className="text-[13px]"
            />
          </label>
        )}
        {(!app || hasOptions) && (
          <button
            type="submit"
            className="lantern-btn primary small"
            disabled={!canSend}
          >
            {sendLabel}
          </button>
        )}
        {app && !hasOptions && (
          <button
            type="button"
            className="lantern-btn primary small"
            disabled={reply.isPending || away}
            onClick={() => send({ kind: 'answer', text: 'Done' }, 'Done')}
          >
            Done
          </button>
        )}
        {app && link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="lantern-btn small"
          >
            Open
          </a>
        )}
      </form>
      {!app && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {!hasOptions && !wantsFiles && (
            <button
              type="button"
              className="lantern-btn small"
              disabled={reply.isPending || away}
              onClick={() => send({ kind: 'answer', text: 'Done' }, 'Done')}
              title="Tells the agent: Done"
            >
              Reply “Done”
            </button>
          )}
          <button
            type="button"
            className="lantern-btn ghost small"
            disabled={reply.isPending || away}
            onClick={() =>
              send(
                {
                  kind: 'answer',
                  text: 'Not now',
                  // A decline is the one answer a files ask takes without its files.
                  ...(wantsFiles ? { skippedFiles: true } : {}),
                },
                'Not now',
              )
            }
            title="Tells the agent: Not now"
          >
            Reply “Not now”
          </button>
          {!inSession && (
            <OpenSession sessionId={asker.sessionId} onOpen={onOpenSession} />
          )}
        </div>
      )}
      {reply.isError && (
        <p
          role="alert"
          className="mt-1.5 text-[12px]"
          style={{ color: 'var(--ember)' }}
        >
          {reply.error.message}
        </p>
      )}
    </Item>
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
function deliveryText(ask: OwnerAsk): string {
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
        {askTitle(ask)}
      </p>
      <p className="text-[13.5px]" style={{ overflowWrap: 'anywhere' }}>
        {ask.answer ? (
          <>
            You answered <b>{ask.answer}</b>
          </>
        ) : ask.files?.length ? (
          `You sent ${plural(ask.files.length, 'file')}`
        ) : (
          'You replied'
        )}
        {ask.note ? `: “${ask.note}”` : ''}
        {ask.answer && ask.files?.length
          ? ` (${plural(ask.files.length, 'file')})`
          : ''}
      </p>
      <AnsweredFiles files={ask.files ?? []} />
      <p className="mt-1 text-[12.5px]" style={{ color: 'var(--mist)' }}>
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
        <span>Access request · security key</span>
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
        className="text-[13.5px]"
        style={{ color: 'var(--lantern)' }}
      >
        Review and approve →
      </a>
    </li>
  )
}
