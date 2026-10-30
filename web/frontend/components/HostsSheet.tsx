'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import {
  HostCallError,
  type HostLogins,
  type LoginState,
  powerHost,
  type ToolLogin,
  toolAction,
  trustHost,
  useHostLogins,
  useOpenSession,
  watchSignIn,
} from '@/lib/hooks/use-host-admin'
import {
  type HostChoice,
  isStarting,
  useHosts,
  WAKE_STEP_LABELS,
} from '@/lib/hooks/use-hosts'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { ConfirmationDialog } from './ConfirmationDialog'

const LOGIN_LABELS: Record<LoginState, string> = {
  signed_in: 'Signed in',
  needs_sign_in: 'Needs sign-in',
  expired: 'Expired',
  unknown: 'Unknown',
}

type Tone = 'good' | 'wait' | 'quiet'
const TONE_COLOR: Record<Tone, string> = {
  good: 'var(--jade)',
  wait: 'var(--beacon)',
  quiet: 'var(--mist)',
}
const LOGIN_TONE: Record<LoginState, Tone> = {
  signed_in: 'good',
  needs_sign_in: 'wait',
  expired: 'wait',
  unknown: 'quiet',
}

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? '' : 's'}`

/** The host's state, led by what the owner needs to know. */
export function hostStatus(host: HostChoice): { text: string; tone: Tone } {
  const wake = host.wake
  if (wake?.state === 'starting') {
    const step = wake.step ? WAKE_STEP_LABELS[wake.step] : null
    return { text: step ? `Starting… ${step}` : 'Starting…', tone: 'wait' }
  }
  if (wake?.state === 'failed') {
    return {
      text: wake.error ? `Didn’t start: ${wake.error}` : 'Didn’t start',
      tone: 'wait',
    }
  }
  switch (host.state) {
    case 'connected': {
      const count = host.sessions ?? 0
      return {
        text: `Connected · ${count === 0 ? 'no sessions' : plural(count, 'session')}`,
        tone: 'good',
      }
    }
    case 'connecting':
      return { text: 'Connecting…', tone: 'wait' }
    case 'offline':
      return { text: 'Offline', tone: 'quiet' }
    case 'powered_off':
      return { text: 'Powered off', tone: 'quiet' }
    case 'identity_changed':
      return { text: 'Not the same machine as before', tone: 'wait' }
  }
}

function Chip({
  tone,
  children,
  testId,
}: {
  tone: Tone
  children: ReactNode
  testId?: string
}) {
  const color = TONE_COLOR[tone]
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] leading-4 break-words"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0">{children}</span>
    </span>
  )
}

function sourceLabel(source: string): { label: string; detail: string } {
  if (source === 'agent-hub') return { label: 'Agent Hub', detail: '' }
  if (source.startsWith('host:'))
    return { label: 'This host', detail: source.slice(5) }
  return { label: source, detail: '' }
}

/** A tool's sign-in line: `Signed in · Agent Hub`, with Unknown saying why. */
export function loginText(
  tool: ToolLogin,
  agentHub: string,
): { text: string; detail: string } {
  const source = sourceLabel(tool.source)
  const cannotReach =
    tool.state === 'unknown' &&
    tool.source === 'agent-hub' &&
    agentHub !== 'reachable'
  return {
    text: `${LOGIN_LABELS[tool.state]} · ${
      cannotReach ? 'Agent Hub can’t be reached' : source.label
    }`,
    detail: source.detail,
  }
}

function credentialNote(tool: ToolLogin): string {
  return tool.credentials
    .filter((credential) => credential.detail)
    .map((credential) => `${credential.name}: ${credential.detail}`)
    .join(' · ')
}

type Confirm =
  | { kind: 'off'; message: string; confirmText: string }
  | { kind: 'trust' }

export function HostsSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const { hosts, isLoading, isError, refetch } = useHosts(open)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000]"
          style={{ backgroundColor: 'var(--scrim)' }}
        />
        <Dialog.Content
          data-testid="hosts-sheet"
          aria-describedby={undefined}
          className={clsx(
            'lantern-sheet fixed z-[10001] flex flex-col overflow-hidden outline-none',
            isMobile
              ? 'lantern-rise inset-x-0 bottom-0 h-[84dvh] rounded-t-[14px]'
              : 'lantern-enter top-1/2 left-1/2 max-h-[min(90dvh,720px)] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-xl',
          )}
          style={{ color: 'var(--bone)' }}
        >
          {isMobile && (
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-9 rounded-full"
              style={{ backgroundColor: 'var(--paper-veil)' }}
            />
          )}
          <div className="flex items-center gap-2 pt-3.5 pr-2 pb-2 pl-[18px]">
            <Dialog.Title
              className="flex-1"
              style={{ font: '500 18px/1.2 var(--font-display)' }}
            >
              Hosts
            </Dialog.Title>
            <Dialog.Close aria-label="Close" className="lantern-icon-btn">
              <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[18px] pb-[18px]">
            {isLoading ? (
              <Note>Loading hosts…</Note>
            ) : isError && hosts.length === 0 ? (
              <Note>
                Couldn’t load hosts.{' '}
                <LinkButton onClick={() => void refetch()}>
                  Try again
                </LinkButton>
              </Note>
            ) : hosts.length === 0 ? (
              <Note>No other hosts. Sessions run on this computer.</Note>
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Hosts">
                {hosts.map((host) => (
                  <HostCard
                    key={host.name}
                    host={host}
                    onOpened={() => onOpenChange(false)}
                  />
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function HostCard({
  host,
  onOpened,
}: {
  host: HostChoice
  onOpened: () => void
}) {
  const queryClient = useQueryClient()
  const status = hostStatus(host)
  const starting = isStarting(host)
  const connected = host.state === 'connected' && !starting
  const [busy, setBusy] = useState<'on' | 'off' | 'trust' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const sessions = host.sessions ?? 0

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['hosts'] })

  const powerOn = async () => {
    setBusy('on')
    setError(null)
    try {
      await powerHost(host.name, 'on')
      await refresh()
    } catch (failure) {
      setError(messageOf(failure, `Couldn’t power on ${host.name}.`))
    } finally {
      setBusy(null)
    }
  }

  const powerOff = async (force: boolean) => {
    setBusy('off')
    setError(null)
    setConfirmError(null)
    try {
      await powerHost(host.name, 'off', force)
      setConfirm(null)
      await refresh()
    } catch (failure) {
      if (force) {
        setConfirmError(messageOf(failure, `Couldn’t power off ${host.name}.`))
      } else if (failure instanceof HostCallError && failure.status === 409) {
        // The host says sessions are running there: offer to do it anyway.
        setConfirm({
          kind: 'off',
          message: failure.message,
          confirmText: 'Power off anyway',
        })
      } else {
        setError(messageOf(failure, `Couldn’t power off ${host.name}.`))
      }
    } finally {
      setBusy(null)
    }
  }

  const askPowerOff = () => {
    setConfirmError(null)
    if (sessions > 0) {
      setConfirm({
        kind: 'off',
        message: `${plural(sessions, 'session')} running on ${host.name} will end.`,
        confirmText: 'Power off',
      })
    } else {
      void powerOff(false)
    }
  }

  const trust = async () => {
    setBusy('trust')
    setConfirmError(null)
    try {
      await trustHost(host.name)
      setConfirm(null)
      await refresh()
    } catch (failure) {
      setConfirmError(messageOf(failure, `Couldn’t trust ${host.name}.`))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li
      data-testid={`host-${host.name}`}
      className="rounded-lg p-3"
      style={{
        border: '1px solid var(--paper-veil)',
        backgroundColor: 'var(--paper)',
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3
          className="min-w-0 break-words"
          style={{ font: '500 15px/1.2 var(--font-display)' }}
        >
          {host.name}
        </h3>
        <Chip tone={status.tone} testId="host-status">
          {status.text}
        </Chip>
        <div className="ml-auto flex flex-wrap gap-2">
          {host.state === 'identity_changed' && !starting && (
            <button
              type="button"
              className="lantern-btn small primary"
              disabled={busy !== null}
              onClick={() => {
                setConfirmError(null)
                setConfirm({ kind: 'trust' })
              }}
            >
              Trust
            </button>
          )}
          {host.state !== 'connected' &&
            host.state !== 'identity_changed' &&
            !starting && (
              <button
                type="button"
                className="lantern-btn small primary"
                disabled={busy !== null}
                onClick={() => void powerOn()}
              >
                {busy === 'on' ? 'Powering on…' : 'Power on'}
              </button>
            )}
          {connected && (
            <button
              type="button"
              className="lantern-btn small"
              disabled={busy !== null}
              onClick={askPowerOff}
            >
              {busy === 'off' ? 'Powering off…' : 'Power off'}
            </button>
          )}
        </div>
      </div>
      {host.error && host.state !== 'connected' && !starting && (
        <p
          className="mt-1.5 text-[12px] break-words"
          style={{ color: 'var(--mist)' }}
        >
          {host.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] break-words">
          {error}
        </p>
      )}

      <HostSignIn host={host.name} connected={connected} onOpened={onOpened} />

      <ConfirmationDialog
        isOpen={confirm !== null}
        title={
          confirm?.kind === 'trust'
            ? 'Trust this machine?'
            : `Power off ${host.name}?`
        }
        message={
          confirm?.kind === 'trust'
            ? `Trust the machine now answering as ${host.name}?`
            : (confirm?.message ?? '')
        }
        confirmText={
          confirm?.kind === 'trust'
            ? 'Trust'
            : (confirm?.confirmText ?? 'Power off')
        }
        pendingText={confirm?.kind === 'trust' ? 'Trusting…' : 'Powering off…'}
        variant={confirm?.kind === 'trust' ? 'warning' : 'danger'}
        isPending={busy === 'off' || busy === 'trust'}
        error={confirmError}
        onConfirm={() => {
          if (confirm?.kind === 'trust') void trust()
          else void powerOff(true)
        }}
        onCancel={() => {
          setConfirm(null)
          setConfirmError(null)
        }}
      />
    </li>
  )
}

function HostSignIn({
  host,
  connected,
  onOpened,
}: {
  host: string
  connected: boolean
  onOpened: () => void
}) {
  const queryClient = useQueryClient()
  const logins = useHostLogins(host, connected)
  const { enabledTools } = useAgentTools()
  const openSession = useOpenSession()
  const [busyTool, setBusyTool] = useState<string | null>(null)
  const [signOutTool, setSignOutTool] = useState<string | null>(null)
  const [toolError, setToolError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const toolName = (slug: string) =>
    enabledTools.find((tool) => tool.slug === slug)?.name ?? slug

  if (!connected) {
    return (
      <p className="mt-3 text-[12px]" style={{ color: 'var(--mist)' }}>
        Sign-in can be checked once {host} is connected.
      </p>
    )
  }

  const run = async (tool: string, action: 'sign_in' | 'sign_out') => {
    setBusyTool(tool)
    setToolError(null)
    setSignOutError(null)
    setDone(null)
    try {
      const answer = await toolAction(host, tool, action)
      if (answer.session) {
        // The tool's own sign-in or sign-out runs in a session on the host.
        watchSignIn(answer.session.id, host, queryClient)
        setSignOutTool(null)
        await openSession(answer.session.id)
        onOpened()
        return
      }
      setSignOutTool(null)
      setDone(
        answer.note ??
          (answer.signedOut ? `Signed out of ${toolName(tool)}.` : null),
      )
      await logins.refetch()
    } catch (failure) {
      const message = messageOf(
        failure,
        action === 'sign_in'
          ? `Couldn’t start sign-in on ${host}.`
          : `Couldn’t sign out on ${host}.`,
      )
      if (action === 'sign_out') setSignOutError(message)
      else setToolError(message)
    } finally {
      setBusyTool(null)
    }
  }

  let body: ReactNode
  if (logins.isLoading) {
    body = <Note flush>Checking sign-in…</Note>
  } else if (logins.isError || !logins.data) {
    body = (
      <p className="text-[13px] break-words">
        Couldn’t check sign-in on {host}:{' '}
        {logins.error instanceof Error
          ? logins.error.message
          : 'no answer from the host'}
        . <LinkButton onClick={() => void logins.refetch()}>Retry</LinkButton>
      </p>
    )
  } else {
    body = (
      <LoginRows
        host={host}
        data={logins.data}
        busyTool={busyTool}
        toolName={toolName}
        onSignIn={(tool) => void run(tool, 'sign_in')}
        onSignOut={(tool) => {
          setSignOutError(null)
          setSignOutTool(tool)
        }}
      />
    )
  }

  return (
    <section aria-label={`Sign-in on ${host}`} className="mt-3">
      <h4 className="lantern-sec mb-1.5">Sign-in</h4>
      {body}
      {toolError && (
        <p role="alert" className="mt-2 text-[13px] break-words">
          {toolError}
        </p>
      )}
      {done && (
        <p
          role="status"
          className="mt-2 text-[13px] break-words"
          style={{ color: 'var(--mist)' }}
        >
          {done}
        </p>
      )}
      <ConfirmationDialog
        isOpen={signOutTool !== null}
        title={`Sign out of ${signOutTool ? toolName(signOutTool) : ''}?`}
        message={
          logins.data?.actions[signOutTool ?? '']?.signOut === 'session'
            ? `A session opens on ${host} to finish signing out of ${signOutTool ? toolName(signOutTool) : ''}.`
            : `Sessions on ${host} will need to sign in to ${signOutTool ? toolName(signOutTool) : ''} again.`
        }
        confirmText="Sign out"
        pendingText="Signing out…"
        isPending={busyTool !== null && signOutTool !== null}
        error={signOutError}
        onConfirm={() => {
          if (signOutTool) void run(signOutTool, 'sign_out')
        }}
        onCancel={() => {
          setSignOutTool(null)
          setSignOutError(null)
        }}
      />
    </section>
  )
}

function LoginRows({
  host,
  data,
  busyTool,
  toolName,
  onSignIn,
  onSignOut,
}: {
  host: string
  data: HostLogins
  busyTool: string | null
  toolName: (slug: string) => string
  onSignIn: (tool: string) => void
  onSignOut: (tool: string) => void
}) {
  const hubAway = data.agent_hub !== 'reachable'
  if (data.tools.length === 0 && !hubAway) {
    return <Note flush>No tools to sign in to on {host}.</Note>
  }
  return (
    <>
      {hubAway && (
        <p
          data-testid="agent-hub-away"
          className="mb-2 text-[12px] break-words"
          style={{ color: 'var(--mist)' }}
        >
          Agent Hub can’t be reached from {host}
          {data.agent_hub ? ` (${data.agent_hub})` : ''}. Tools it serves show
          Unknown.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {data.tools.map((tool) => {
          const { text, detail } = loginText(tool, data.agent_hub)
          const note = tool.state === 'signed_in' ? '' : credentialNote(tool)
          const actions = data.actions[tool.tool]
          // Nothing to sign out of while it needs a sign-in; unknown may be signed in.
          const canSignOut =
            !!actions?.signOut && tool.state !== 'needs_sign_in'
          const busy = busyTool === tool.tool
          const name = toolName(tool.tool)
          return (
            <li
              key={tool.tool}
              data-testid={`login-${tool.tool}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
            >
              <span className="min-w-[7ch] text-[14px]">{name}</span>
              <span title={detail || undefined}>
                <Chip tone={LOGIN_TONE[tool.state]}>{text}</Chip>
              </span>
              {(actions?.signIn || canSignOut) && (
                <span className="ml-auto flex flex-wrap gap-2">
                  {actions.signIn && (
                    <button
                      type="button"
                      className="lantern-btn small"
                      aria-label={`Sign in to ${name} on ${host}`}
                      disabled={busyTool !== null}
                      onClick={() => onSignIn(tool.tool)}
                    >
                      {busy ? 'Opening…' : 'Sign in'}
                    </button>
                  )}
                  {canSignOut && (
                    <button
                      type="button"
                      className="lantern-btn small ghost"
                      aria-label={`Sign out of ${name} on ${host}`}
                      disabled={busyTool !== null}
                      onClick={() => onSignOut(tool.tool)}
                    >
                      Sign out
                    </button>
                  )}
                </span>
              )}
              {(detail || note) && (
                <p
                  className="basis-full text-[12px] break-words"
                  style={{ color: 'var(--mist)' }}
                >
                  {[detail, note].filter(Boolean).join(' · ')}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function messageOf(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message
    ? failure.message
    : fallback
}

function Note({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return (
    <p
      className={clsx('text-sm', !flush && 'pt-3')}
      style={{ color: 'var(--mist)' }}
    >
      {children}
    </p>
  )
}

function LinkButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="underline"
      style={{ color: 'var(--lantern)' }}
    >
      {children}
    </button>
  )
}
