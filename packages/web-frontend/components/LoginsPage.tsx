'use client'

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useHosts } from '@/lib/hooks/use-hosts'
import {
  api,
  type Checked,
  type Data,
  type Event,
  eventLine,
  groupOf,
  groups,
  type Probe,
  sourceLabel,
  title,
  type Who,
} from '@/lib/logins'
import { AddLogin } from './AddLogin'
import { HostSignIn } from './HostsSheet'
import type { AccessChoices } from './LoginAccess'
import { LoginRow } from './LoginRow'
import {
  Find,
  Form,
  Group,
  Notice,
  Quiet,
  Row,
  SectionHead,
} from './settings/kit'
import kit from './settings/kit.module.css'

/** The long list gets a find box from here. */
const FIND_FROM = 8

/** A titled block that holds a form or free content, not rows. */
function Block({
  title,
  label,
  children,
}: {
  title: string
  label?: string
  children: ReactNode
}) {
  return (
    <section className={kit.group} aria-label={label ?? title}>
      <h3 className="lantern-sec">{title}</h3>
      {children}
    </section>
  )
}

export function LoginsPage() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [search, setSearch] = useState(''),
    [adding, setAdding] = useState(false)
  const [sessions, setSessions] = useState<{ id: string; label: string }[]>([]),
    [sessionError, setSessionError] = useState('')
  const { hosts, ...hostState } = useHosts()
  const [registered, setRegistered] = useState<string[]>([]),
    [registeredFailed, setRegisteredFailed] = useState(false)
  const [events, setEvents] = useState<Event[] | null>(null),
    [eventsFailed, setEventsFailed] = useState(false),
    [checked, setChecked] = useState<Checked | null>(null)
  const load = useCallback(async () => {
    api<{ events: Event[] }>('/api/logins/audit')
      .then((r) => {
        setEvents(r.events)
        setEventsFailed(false)
      })
      .catch(() => setEventsFailed(true))
    try {
      setData(await api<Data>('/api/logins'))
      setError('')
    } catch (error) {
      setError((error as Error).message)
    }
  }, [])
  /** A login page check after a save: kept only when it found something to say. */
  const check = (name: string, probe?: Probe, inRow = false) =>
    setChecked(probe?.warning ? { name, ...probe, inRow } : null)
  const pageCheck = (c: Checked) => (
    <PageCheck
      checked={c}
      onFixed={(text) => {
        setChecked(null)
        void changed(text)
      }}
    />
  )
  useEffect(() => {
    void load()
    api<{ sessions: typeof sessions }>('/api/logins/sessions')
      .then((r) => setSessions(r.sessions))
      .catch(() =>
        setSessionError('Sessions could not load. Try reloading the page.'),
      )
    api<{ roles: string[] }>('/api/logins/roles')
      .then((r) => setRegistered(r.roles ?? []))
      .catch(() => setRegisteredFailed(true))
  }, [load])
  const changed = async (text: string) => {
    setMessage(text)
    await load()
  }
  const targets = [
    ...new Set(
      data?.entries.flatMap((e) => (e.lab ? [e.lab.target] : [])) || [],
    ),
  ]
  const choices: AccessChoices = {
    sources: (data?.entries ?? []).map((e) => ({
      name: e.name,
      label: sourceLabel(e, data?.entries ?? []),
      machines: e.machines,
      roles: e.roles,
      deniedRoles: e.deniedRoles,
      target: e.lab?.target,
    })),
    hosts: hosts.map((h) => h.name),
    hostsStatus: hostState.isLoading
      ? 'loading'
      : hostState.isError
        ? 'error'
        : 'ready',
    registered,
    registeredFailed,
    machine: data?.machine ?? '',
    sessions,
    sessionsFailed: !!sessionError,
    assignments: data?.assignments ?? {},
  }
  const shown = data
    ? data.entries.filter((e) =>
        `${e.name} ${e.kind}`.toLowerCase().includes(search.toLowerCase()),
      )
    : []
  return (
    // A notice about the last change stays until the next thing the owner does on the page.
    <section
      aria-label="Logins"
      onPointerDownCapture={() => message && setMessage('')}
      onKeyDownCapture={() => message && setMessage('')}
    >
      <SectionHead
        title="Logins"
        sub="Saved logins for you and your agents. Choose which machines, roles and lab targets may use them."
      >
        <button
          type="button"
          className="lantern-btn small"
          onClick={() => void load()}
        >
          Refresh
        </button>
        <button
          type="button"
          className="lantern-btn small"
          disabled={data?.readOnly}
          onClick={() => setAdding(!adding)}
        >
          {adding ? 'Close' : 'Add login'}
        </button>
      </SectionHead>
      {error && (
        <Notice
          failed
          actions={
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => void load()}
            >
              Try again
            </button>
          }
        >
          {data
            ? 'The list could not refresh. Showing the last loaded list.'
            : error}
        </Notice>
      )}
      {!data && !error && <Quiet role="status">Loading logins…</Quiet>}
      {data?.warning && <Notice>{data.warning}</Notice>}
      {message && <Notice>{message}</Notice>}
      {checked && !checked.inRow && pageCheck(checked)}
      {adding && (
        <AddLogin
          choices={choices}
          onSaved={(saved, warning, probe) => {
            setAdding(false)
            if (probe) check(probe.name, probe)
            void changed(warning ? `${saved}. ${warning}` : saved)
          }}
        />
      )}
      {data && (
        <>
          {data.entries.length >= FIND_FROM && (
            <Find
              value={search}
              onChange={setSearch}
              label="Find a login"
              placeholder="Name or kind"
            />
          )}
          {data.entries.length === 0 && (
            <Quiet>No logins saved yet. Add one to get started.</Quiet>
          )}
          {search && shown.length === 0 && (
            <Quiet>No logins match your search.</Quiet>
          )}
          {groups.map((kind) => {
            const entries = shown.filter((e) => groupOf(e) === kind)
            return (
              entries.length > 0 && (
                <Group
                  key={kind}
                  title={title(kind)}
                  count={entries.length}
                  label={title(kind)}
                >
                  {entries.map((entry) => (
                    <LoginRow
                      key={entry.name}
                      entry={entry}
                      choices={choices}
                      onChanged={changed}
                      onChecked={(name, probe) => check(name, probe, true)}
                      check={
                        checked?.inRow && checked.name === entry.name
                          ? pageCheck(checked)
                          : undefined
                      }
                      events={(events ?? []).filter(
                        (e) => e.name === entry.name,
                      )}
                      revealSeconds={data.revealSeconds}
                      readOnly={data.readOnly}
                    />
                  ))}
                </Group>
              )
            )
          })}
          <Block title="Lab assignments">
            <Quiet>
              A session can add, refresh and use logins only for its assigned
              targets. Removing a target ends that access.
            </Quiet>
            {sessionError ? (
              <Quiet role="alert">{sessionError}</Quiet>
            ) : sessions.length === 0 ? (
              <Quiet>No sessions are available to assign.</Quiet>
            ) : (
              <Assignment
                sessions={sessions}
                targets={targets}
                assignments={data.assignments}
                onSaved={(warning) =>
                  void changed(warning || 'Lab targets saved.')
                }
              />
            )}
          </Block>
        </>
      )}
      {hostState.isLoading ? (
        <Block title="Tool sign-in">
          <Quiet role="status">Checking machines…</Quiet>
        </Block>
      ) : hostState.isError ? (
        <Block title="Tool sign-in">
          <Notice
            failed
            actions={
              <button
                type="button"
                className="lantern-btn small"
                onClick={() => void hostState.refetch()}
              >
                Try again
              </button>
            }
          >
            Machines could not load.
          </Notice>
        </Block>
      ) : hosts.length === 0 ? (
        <Block title="Tool sign-in">
          <Quiet>No linked machines are available.</Quiet>
        </Block>
      ) : (
        <Group title="Tool sign-in" count={hosts.length} label="Tool sign-in">
          {hosts.map((host) => (
            <Row
              key={host.name}
              name={host.name}
              chip={host.state === 'connected' ? 'ok' : 'off'}
              chipText={
                host.state === 'connected' ? 'Connected' : 'Not connected'
              }
            >
              <HostSignIn
                host={host.name}
                connected={host.state === 'connected'}
                onOpened={() => {
                  window.location.href = '/'
                }}
              />
            </Row>
          ))}
        </Group>
      )}
      <Group title="Activity" label="Activity">
        <Row name="Recent activity" meta="The last 30 changes to logins">
          <Audit events={events} failed={eventsFailed} who={choices.sessions} />
        </Row>
      </Group>
    </section>
  )
}

function Assignment({
  sessions,
  targets,
  assignments,
  onSaved,
}: {
  sessions: { id: string; label: string }[]
  targets: string[]
  assignments: Record<string, string[]>
  onSaved(warning?: string): void
}) {
  const [session, setSession] = useState(sessions[0]?.id || ''),
    [selected, setSelected] = useState<string[]>(
      assignments[sessions[0]?.id] || [],
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <Form
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError('')
        try {
          const result = await api('/api/logins/assign', {
            session,
            targets: selected,
          })
          onSaved(result.warning)
        } catch (error) {
          setError((error as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <label>
        Session
        <select
          value={session}
          onChange={(e) => {
            setSession(e.target.value)
            setSelected(assignments[e.target.value] || [])
          }}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Allowed targets</legend>
        {targets.length === 0 && (
          <Quiet>Add a lab login to assign its target.</Quiet>
        )}
        {targets.map((t) => (
          <label className={kit.check} key={t}>
            <input
              type="checkbox"
              checked={selected.includes(t)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, t]
                    : selected.filter((v) => v !== t),
                )
              }
            />
            {t}
          </label>
        ))}
      </fieldset>
      {error && <Quiet role="alert">{error}</Quiet>}
      <button type="submit" className="lantern-btn small" disabled={busy}>
        Save targets
      </button>
    </Form>
  )
}

function Audit({
  events,
  failed,
  who,
}: {
  events: Event[] | null
  failed: boolean
  who: Who
}) {
  const recent = events ? events.slice(-30).reverse() : null
  return failed && !recent ? (
    <Quiet role="alert">Activity could not load.</Quiet>
  ) : !recent ? (
    <Quiet role="status">Loading activity…</Quiet>
  ) : recent.length === 0 ? (
    <Quiet>No activity recorded yet.</Quiet>
  ) : (
    <ul className={kit.activity}>
      {recent.map((e) => (
        <li key={`${e.at}-${e.action}-${e.name}-${e.actor}`}>
          {eventLine(e, true, who)}
        </li>
      ))}
    </ul>
  )
}

/** A saved login page with no password field: what was found, and one tap to save the page that has one. */
function PageCheck({
  checked,
  onFixed,
}: {
  checked: Checked
  onFixed(text: string): void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    at = useRef<HTMLDivElement>(null)
  const suggestion = checked.suggestion
  // On a phone the saved panel closes and the list moves; bring the check into view.
  useEffect(() => {
    at.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [])
  return (
    <div ref={at}>
      <Notice
        failed={!!error}
        actions={
          suggestion && (
            <button
              type="button"
              className="lantern-btn small"
              disabled={busy}
              title={suggestion}
              onClick={() => {
                setBusy(true)
                api(`/api/logins/${encodeURIComponent(checked.name)}/edit`, {
                  login_url: suggestion,
                })
                  .then((r) => onFixed(r.warning || 'Login page saved.'))
                  .catch((e) => setError((e as Error).message))
                  .finally(() => setBusy(false))
              }}
            >
              Use this page
            </button>
          )
        }
      >
        {error || checked.warning}
      </Notice>
    </div>
  )
}
