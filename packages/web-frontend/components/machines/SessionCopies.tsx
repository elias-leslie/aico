'use client'

import { Clock, FileText, FileX, GitBranch } from 'lucide-react'
import { AgentIcon } from '@/components/AgentIcon'
import {
  type CopySession,
  useSessionCopies,
} from '@/lib/hooks/use-machine-guests'
import type { Machine } from '@/lib/machines'
import { at } from '@/lib/status'
import mine from './MachinesPage.module.css'

const STATE: Record<string, { dot: string; word: string }> = {
  working: { dot: 'var(--jade)', word: 'Working' },
  idle: { dot: 'var(--mist)', word: 'Idle' },
  blocked: { dot: 'var(--beacon)', word: 'Needs you' },
}
const NEEDS_YOU = { dot: 'var(--beacon)', word: 'Needs you' }
const UNKNOWN = { dot: 'var(--paper-veil)', word: 'State unknown' }

const stateOf = (session: CopySession) =>
  session.needsYou ? NEEDS_YOU : (STATE[session.state] ?? UNKNOWN)

const megabytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`

/** What was running on a machine at its last change, from the copies this Aico holds: nothing
 * when it holds none. Read-only; picking a session up here isn't built yet, so nothing offers it. */
export function SessionCopies({ machine }: { machine: Machine }) {
  const { machines, failed } = useSessionCopies()
  const held = machines?.find((entry) => entry.machine === machine.key)
  // Copies of sessions that already ended stay readable by `aico shift show`; this list is what was running.
  const running = held?.sessions.filter((session) => !session.endedAt) ?? []
  // Couldn't read isn't the same as holding none, on the machine a copy would be of.
  if (failed && !machines && machine.sessionHost && !machine.here)
    return (
      <span
        className="status-chip unknown"
        title="This Aico couldn’t read its copies of the sessions on that machine."
      >
        Sessions unknown
      </span>
    )
  if (!held || !running.length) return null
  const now = Date.now()
  const heard = at(held.at, now)
  const waiting = running.filter((session) => session.needsYou).length
  const count = running.length
  return (
    <details className={mine.services} data-testid="session-copies">
      <summary
        title={`${count} ${count === 1 ? 'session was' : 'sessions were'} running on ${machine.name} at its last change, ${heard}; nothing is sent while nothing changes. Their conversations and a short state are kept here.`}
      >
        Sessions
        <span
          className={`status-chip ${waiting ? 'warn' : 'ok'}`}
          title={
            waiting ? `${waiting} needed you` : `${count} on ${machine.name}`
          }
        >
          {count}
        </span>
        <span className={mine.heardAt} aria-label={`Last change ${heard}`}>
          <Clock size={12} aria-hidden="true" />
          {heard}
        </span>
      </summary>
      <ul className={mine.serviceList}>
        {running.map((session) => (
          <CopyRow key={session.id} session={session} now={now} />
        ))}
      </ul>
    </details>
  )
}

function CopyRow({ session, now }: { session: CopySession; now: number }) {
  const state = stateOf(session)
  const copyTip = session.copy
    ? `Conversation copy here, ${megabytes(session.copy.bytes)}${session.copy.cut ? ', the latest part' : ''}`
    : 'No copy of this conversation here'
  return (
    <li className={mine.copyRow}>
      <details style={{ flex: 1, minWidth: 0 }}>
        <summary title={session.doing ?? session.title}>
          <span
            className={mine.copyDot}
            style={{ backgroundColor: state.dot }}
            role="img"
            aria-label={state.word}
            title={
              session.detail ? `${state.word}: ${session.detail}` : state.word
            }
          />
          <AgentIcon slug={session.tool} size={14} />
          <span className={mine.copyTitle}>{session.title}</span>
          {session.git && session.git.dirty > 0 && (
            <span
              className={mine.copyBadge}
              title={`${session.git.dirty} uncommitted on ${session.git.branch}`}
            >
              <GitBranch size={12} aria-hidden="true" />
              {session.git.dirty}
            </span>
          )}
          <span
            className={mine.copyBadge}
            title={copyTip}
            role="img"
            aria-label={copyTip}
          >
            {session.copy ? (
              <FileText size={12} aria-hidden="true" />
            ) : (
              <FileX size={12} aria-hidden="true" />
            )}
          </span>
        </summary>
        <div className={mine.copyDetail}>
          {session.doing && <p>{session.doing}</p>}
          {session.lastOwner && (
            <p>
              <b>You</b> {session.lastOwner.text}
            </p>
          )}
          {session.lastAgent && (
            <p>
              <b>Agent</b> {session.lastAgent.text}
            </p>
          )}
          <p>
            {[
              session.project,
              session.lastActivity === null
                ? null
                : at(session.lastActivity, now),
              session.copy ? megabytes(session.copy.bytes) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </details>
    </li>
  )
}
