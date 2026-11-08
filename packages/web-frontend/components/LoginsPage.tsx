'use client'

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useHosts } from '@/lib/hooks/use-hosts'
import { shortWhen } from '@/lib/short-when'
import { HostSignIn } from './HostsSheet'
import {
  type Access,
  AccessChecklist,
  type AccessChoices,
  accessOf,
  applyAccess,
  applySessions,
  defaultAccess,
  knownRoles,
  planAccess,
  planSessions,
  sessionsOf,
} from './LoginAccess'
import {
  Actions,
  type Chip,
  Find,
  Form,
  Group,
  Notice,
  Quiet,
  Row,
  SectionHead,
} from './settings/kit'
import kit from './settings/kit.module.css'

const kinds = [
  'tool login',
  'API key',
  'password',
  'backup key',
  'lab login',
] as const
type Kind = (typeof kinds)[number]
/** What the Add form offers: the kinds plus account logins (a username, password and login page). */
const ACCOUNT = 'account login'
type Choice = Kind | typeof ACCOUNT
const groups = [
  ACCOUNT,
  ...kinds.filter((k) => k !== 'lab login'),
  'lab login',
] as const
const groupOf = (e: Entry): Choice =>
  e.lab?.kind === 'account' ? ACCOUNT : e.kind
interface Entry {
  name: string
  kind: Kind
  notes: string
  state: string
  machines: string[]
  roles: string[]
  deniedRoles?: string[]
  created: string
  rotated: string | null
  lastUsed: string | null
  verifierOnly?: boolean
  lab?: {
    target: string
    actor: string
    kind: string
    fields: string[]
    expires_at: string | null
    username?: string
    login_url?: string
  }
}
interface Event {
  at: string
  action: string
  name: string
  actor: string
  detail?: string
}
/** A saved login page that shows no password field, and the page that does when one was found. */
interface Probe {
  password: boolean
  suggestion: string | null
  warning: string
}
/** What the page last checked, for one login. */
interface Checked extends Probe {
  name: string
  /** Shown in the login's own row (after Edit) rather than at the top (after Add). */
  inRow?: boolean
}
interface Data {
  entries: Entry[]
  /** This computer's name: where a new login is allowed until changed. */
  machine?: string
  assignments: Record<string, string[]>
  revealSeconds: number
  readOnly?: boolean
  warning?: string
}
async function api<T = { warning?: string }>(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        },
  )
  const result = await response.json()
  if (!response.ok)
    throw new Error(result.detail || 'Logins could not complete the operation.')
  return result as T
}
const title = (kind: Choice) =>
  ({
    [ACCOUNT]: 'Account logins',
    'tool login': 'Tool logins',
    'API key': 'API keys',
    password: 'Passwords',
    'backup key': 'Backup keys',
    'lab login': 'Lab logins',
  })[kind]
const when = (time: string | null) => shortWhen(time)
const characters = (n: number) => `${n} ${n === 1 ? 'character' : 'characters'}`
/** The confirmation after a value is stored: its length only, never the value. */
const savedChars = (value: string) => `Saved, ${characters([...value].length)}`
const MAX_DOTS = 32

/** A hidden value field that shows masked dots and a character count as soon as something is pasted or typed. */
function SecretField({
  label,
  name = 'value',
}: {
  label: string
  name?: string
}) {
  const [length, setLength] = useState(0),
    input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const form = input.current?.form
    if (!form) return
    const clear = () => setLength(0)
    form.addEventListener('reset', clear)
    return () => form.removeEventListener('reset', clear)
  }, [])
  return (
    <>
      <label>
        {label}
        <input
          ref={input}
          name={name}
          type="password"
          required
          autoComplete="new-password"
          onChange={(e) => setLength([...e.target.value].length)}
        />
      </label>
      {length > 0 && (
        <small role="status">
          <span aria-hidden="true">
            {'•'.repeat(Math.min(length, MAX_DOTS))}
            {length > MAX_DOTS ? '…' : ''}
          </span>{' '}
          {characters(length)}
        </small>
      )}
    </>
  )
}
/** The long list gets a find box from here. */
const FIND_FROM = 8
const CHIP: Record<string, Chip> = {
  'In use': 'ok',
  Unused: 'off',
  Expired: 'failed',
  'Needs sign-in': 'late',
  Unavailable: 'failed',
}
const chipOf = (state: string): Chip => CHIP[state] ?? 'off'
const meta = (entry: Entry) =>
  entry.lab
    ? `${entry.lab.actor} · ${entry.lab.kind}${
        entry.lab.expires_at ? ` · Expires ${when(entry.lab.expires_at)}` : ''
      }`
    : `Last used: ${when(entry.lastUsed)}`

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
      label: e.lab ? e.lab.target : e.name,
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
    <section aria-label="Logins">
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
function AddLogin({
  choices,
  onSaved,
}: {
  choices: AccessChoices
  onSaved(saved: string, warning?: string, probe?: Checked): void
}) {
  const [kind, setKind] = useState<Choice>('API key'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [edited, setEdited] = useState<Access | null>(null)
  const access = edited ?? defaultAccess(choices)
  return (
    <div className={kit.panel}>
      <Form
        onSubmit={async (event) => {
          event.preventDefault()
          const form = event.currentTarget,
            f = new FormData(form)
          setBusy(true)
          setError('')
          try {
            let result: { warning?: string; entry?: Entry; probe?: Probe }
            const secret = String(f.get('value') ?? '')
            if (kind === ACCOUNT)
              result = await api('/api/logins/lab', {
                target: f.get('target'),
                actor: 'default',
                kind: 'account',
                values: {
                  username: f.get('username'),
                  password: secret,
                  login_url: f.get('loginUrl'),
                },
                notes: f.get('notes'),
              })
            else if (kind === 'lab login')
              result = await api('/api/logins/lab', {
                target: f.get('target'),
                actor: f.get('actor'),
                kind: f.get('labKind'),
                expires_at: f.get('expiry') || null,
                values: JSON.parse(String(f.get('value'))),
                notes: f.get('notes'),
              })
            else
              result = await api('/api/logins', {
                name: f.get('name'),
                kind,
                value: f.get('value'),
                notes: f.get('notes'),
              })
            form.reset()
            const made = result.entry
            const failed = made
              ? [
                  ...(await applyAccess(
                    `/api/logins/${encodeURIComponent(made.name)}`,
                    planAccess(made, access, knownRoles(choices)),
                    api,
                  )),
                  ...(made.lab
                    ? await applySessions(
                        planSessions(choices, made.lab.target, access.sessions),
                        api,
                      )
                    : []),
                ]
              : []
            onSaved(
              savedChars(secret),
              [result.warning, ...failed].filter(Boolean).join('. ') ||
                undefined,
              made && result.probe
                ? { name: made.name, ...result.probe }
                : undefined,
            )
          } catch (error) {
            setError(
              error instanceof SyntaxError
                ? 'Lab fields need a JSON object.'
                : (error as Error).message,
            )
          } finally {
            setBusy(false)
          }
        }}
      >
        <h3 className="lantern-sec">Add login</h3>
        <label>
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Choice)}
          >
            {[ACCOUNT, ...kinds].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        {kind === ACCOUNT ? (
          <>
            <label>
              Site name
              <input
                name="target"
                required
                autoComplete="off"
                pattern="[a-z0-9][a-z0-9._\-]*"
              />
            </label>
            <label>
              Username or email
              <input name="username" required autoComplete="off" />
            </label>
            <label>
              Login page
              <input
                name="loginUrl"
                type="url"
                required
                autoComplete="off"
                placeholder="https://example.com/login"
              />
            </label>
          </>
        ) : kind === 'lab login' ? (
          <>
            <label>
              Target
              <input name="target" required autoComplete="off" />
            </label>
            <label>
              Actor
              <input
                name="actor"
                defaultValue="default"
                required
                autoComplete="off"
              />
            </label>
            <label>
              Lab kind
              <select name="labKind">
                <option value="account">Account</option>
                <option value="synthetic">Synthetic</option>
                <option value="temporary">Temporary</option>
              </select>
            </label>
            <label>
              Expires at (optional)
              <input name="expiry" placeholder="2026-12-01T00:00:00Z" />
            </label>
          </>
        ) : (
          <label>
            Name
            <input
              name="name"
              required
              autoComplete="off"
              pattern="[a-z0-9_][a-z0-9_.-]*"
            />
          </label>
        )}
        <SecretField
          label={
            kind === ACCOUNT
              ? 'Password (hidden)'
              : kind === 'lab login'
                ? 'Fields (JSON, hidden)'
                : 'Value (hidden)'
          }
        />
        <label>
          Notes
          <input name="notes" autoComplete="off" />
        </label>
        <AccessChecklist
          choices={choices}
          value={access}
          onChange={setEdited}
          disabled={busy}
          lab={kind === ACCOUNT || kind === 'lab login'}
          account={kind === ACCOUNT}
        />
        {error && <Quiet role="alert">{error}</Quiet>}
        <button type="submit" disabled={busy} className="lantern-btn small">
          {busy ? 'Saving…' : 'Save login'}
        </button>
      </Form>
    </div>
  )
}
function LoginRow({
  entry,
  choices,
  onChanged,
  onChecked,
  check,
  events,
  revealSeconds,
  readOnly,
}: {
  entry: Entry
  choices: AccessChoices
  onChanged(text: string): Promise<void>
  onChecked(name: string, probe?: Probe): void
  /** The login page check after an Edit, shown under the page it is about. */
  check?: ReactNode
  /** This login's activity, oldest first. */
  events: Event[]
  revealSeconds: number
  readOnly?: boolean
  warning?: string
}) {
  const account = entry.lab?.kind === 'account'
  const [panel, setPanel] = useState<
      'replace' | 'edit' | 'fields' | 'grants' | 'remove' | null
    >(null),
    [value, setValue] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    if (value === null) return
    const hide = () => setValue(null),
      timer = setTimeout(hide, revealSeconds * 1000)
    window.addEventListener('blur', hide)
    window.addEventListener('pagehide', hide)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('blur', hide)
      window.removeEventListener('pagehide', hide)
    }
  }, [value, revealSeconds])
  const path = `/api/logins/${encodeURIComponent(entry.name)}`
  // The name the row shows: a lab login's site, else the login's own name.
  const shownName = entry.lab ? entry.lab.target : entry.name
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function reveal(copy = false) {
    const result = await api<{ value: string; warning?: string }>(
      `${path}/reveal`,
      {},
    )
    if (copy) {
      await navigator.clipboard.writeText(result.value)
      await onChanged(result.warning || 'Copied.')
    } else {
      setValue(result.value)
      if (result.warning) await onChanged(result.warning)
    }
  }
  const toggle = (next: NonNullable<typeof panel>) => {
    setValue(null)
    setPanel(panel === next ? null : next)
  }
  return (
    <Row
      name={shownName}
      meta={meta(entry)}
      chip={chipOf(entry.state)}
      chipText={entry.state}
    >
      {entry.lab?.username && <small>Username: {entry.lab.username}</small>}
      {entry.lab?.login_url && <small>Login page: {entry.lab.login_url}</small>}
      {check}
      {entry.notes && <p>{entry.notes}</p>}
      {entry.lab && <small>Last used: {when(entry.lastUsed)}</small>}
      <Actions>
        {!entry.verifierOnly && (
          <>
            <button
              type="button"
              className="lantern-btn small"
              disabled={busy}
              onClick={() =>
                value === null ? void run(() => reveal()) : setValue(null)
              }
            >
              {value === null ? 'Reveal' : 'Hide'}
            </button>
            <button
              type="button"
              className="lantern-btn small"
              disabled={busy}
              onClick={() => void run(() => reveal(true))}
            >
              Copy
            </button>
            <button
              type="button"
              className="lantern-btn small"
              disabled={readOnly}
              onClick={() => toggle('replace')}
            >
              Replace
            </button>
          </>
        )}
        <button
          type="button"
          className="lantern-btn small"
          disabled={readOnly}
          onClick={() => toggle('edit')}
        >
          Edit
        </button>
        {entry.lab && !account && (
          <button
            type="button"
            className="lantern-btn small"
            disabled={readOnly}
            onClick={() => toggle('fields')}
          >
            Edit fields
          </button>
        )}
        <button
          type="button"
          className="lantern-btn small"
          disabled={readOnly}
          onClick={() => toggle('grants')}
        >
          Access
        </button>
        <button
          type="button"
          className="lantern-btn danger small"
          disabled={readOnly}
          onClick={() => toggle('remove')}
        >
          Remove
        </button>
      </Actions>
      {value !== null && (
        <div>
          <small>Hides after {revealSeconds} seconds.</small>
          <pre className={kit.secret}>{value}</pre>
        </div>
      )}
      {error && <Quiet role="alert">{error}</Quiet>}
      {panel === 'replace' && account && (
        <Form
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget,
              f = new FormData(form),
              password = String(f.get('value'))
            void run(async () => {
              const result = await api(
                `/api/logins/lab/${entry.lab?.target}/${entry.lab?.actor}`,
                { set: { username: String(f.get('username')), password } },
                'PATCH',
              )
              form.reset()
              setPanel(null)
              await onChanged(
                result.warning
                  ? `${savedChars(password)}. ${result.warning}`
                  : `Login replaced. ${savedChars(password)}`,
              )
            })
          }}
        >
          <label>
            Username or email
            <input
              name="username"
              required
              autoComplete="off"
              defaultValue={entry.lab?.username ?? ''}
            />
          </label>
          <SecretField label="Password (hidden)" />
          <button type="submit" className="lantern-btn small" disabled={busy}>
            Replace login
          </button>
        </Form>
      )}
      {panel === 'replace' && !account && (
        <Form
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget,
              value = String(new FormData(form).get('value'))
            void run(async () => {
              const result = await api(`${path}/replace`, { value })
              form.reset()
              setPanel(null)
              await onChanged(
                result.warning
                  ? `${savedChars(value)}. ${result.warning}`
                  : `Login replaced. ${savedChars(value)}`,
              )
            })
          }}
        >
          <SecretField
            label={
              entry.lab
                ? 'Complete bundle (JSON, hidden)'
                : 'New value (hidden)'
            }
          />
          <button type="submit" className="lantern-btn small" disabled={busy}>
            Replace login
          </button>
        </Form>
      )}
      {panel === 'edit' && (
        <DetailsEdit
          entry={entry}
          busy={busy}
          save={(patch) =>
            run(async () => {
              const result = await api<{
                warning?: string
                probe?: Probe
                entry: Entry
              }>(`${path}/edit`, patch)
              setPanel(null)
              onChecked(result.entry.name, result.probe)
              await onChanged(result.warning || 'Login saved.')
            })
          }
        />
      )}
      {panel === 'fields' && entry.lab && (
        <LabEdit
          entry={entry}
          busy={busy}
          save={(patch) =>
            run(async () => {
              const result = await api(
                `/api/logins/lab/${entry.lab?.target}/${entry.lab?.actor}`,
                patch,
                'PATCH',
              )
              setPanel(null)
              await onChanged(result.warning || 'Lab fields saved.')
            })
          }
        />
      )}
      {panel === 'grants' && (
        <AccessPanel
          entry={entry}
          choices={choices}
          path={path}
          onSaved={onChanged}
          onCancel={() => setPanel(null)}
          events={events}
        />
      )}
      {panel === 'remove' && (
        <Form
          onSubmit={(event) => {
            event.preventDefault()
            const typed = String(
              new FormData(event.currentTarget).get('confirm') ?? '',
            ).trim()
            void run(async () => {
              if (typed !== shownName && typed !== entry.name)
                throw new Error(`Type ${shownName} exactly to remove it.`)
              const result = await api(`${path}/remove`, {
                confirm: entry.name,
              })
              setPanel(null)
              await onChanged(result.warning || 'Login removed.')
            })
          }}
        >
          <label>
            Type {shownName} to remove it
            <input name="confirm" required autoComplete="off" />
          </label>
          <Actions>
            <button
              type="button"
              className="lantern-btn small"
              onClick={() => setPanel(null)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="lantern-btn danger small"
              disabled={busy}
            >
              Remove login
            </button>
          </Actions>
        </Form>
      )}
    </Row>
  )
}
function AccessPanel({
  entry,
  choices,
  path,
  onSaved,
  onCancel,
  events,
}: {
  entry: Entry
  choices: AccessChoices
  path: string
  onSaved(text: string): Promise<void>
  onCancel(): void
  events: Event[]
}) {
  const known = knownRoles(choices),
    current = accessOf(entry, known, sessionsOf(choices, entry.lab?.target))
  const [edited, setEdited] = useState<Access | null>(null),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState<string[]>([])
  const access = edited ?? current
  const ops = planAccess(entry, access, known)
  const assigns = entry.lab
    ? planSessions(choices, entry.lab.target, access.sessions)
    : []
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setFailed([])
        void (async () => [
          ...(await applyAccess(path, ops, api)),
          ...(await applySessions(assigns, api)),
        ])()
          .then(async (errors) => {
            setFailed(errors)
            setEdited(null)
            await onSaved(
              errors.length ? 'Access partly saved.' : 'Access saved.',
            )
          })
          .finally(() => setBusy(false))
      }}
    >
      <small>
        Created: {when(entry.created)} · Replaced: {when(entry.rotated)}
      </small>
      <AccessChecklist
        choices={choices}
        value={access}
        onChange={setEdited}
        exclude={entry.name}
        disabled={busy}
        lab={!!entry.lab}
        account={entry.lab?.kind === 'account'}
      />
      {events.length > 0 && (
        <ul className={kit.activity} aria-label="This login's activity">
          {events
            .slice(-5)
            .reverse()
            .map((e) => (
              <li key={`${e.at}-${e.action}-${e.actor}`}>
                {eventLine(e, false, choices.sessions)}
              </li>
            ))}
        </ul>
      )}
      {failed.map((text) => (
        <Quiet role="alert" key={text}>
          {text}
        </Quiet>
      ))}
      <Actions>
        <button type="button" className="lantern-btn small" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="lantern-btn small"
          disabled={busy || ops.length + assigns.length === 0}
        >
          {busy ? 'Saving…' : 'Save access'}
        </button>
      </Actions>
    </Form>
  )
}
function LabEdit({
  entry,
  busy,
  save,
}: {
  entry: Entry
  busy: boolean
  save(patch: unknown): Promise<void>
}) {
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget,
          f = new FormData(form),
          name = String(f.get('field') || ''),
          value = String(f.get('value') || ''),
          remove = String(f.get('remove') || '')
        void save({
          ...(name && value ? { set: { [name]: value } } : {}),
          ...(remove ? { remove: [remove] } : {}),
        }).then(() => form.reset())
      }}
    >
      <p>
        Change one field or remove an optional field. Other fields stay saved.
      </p>
      <label>
        Field name
        <input name="field" list={`fields-${entry.name}`} autoComplete="off" />
        <datalist id={`fields-${entry.name}`}>
          {entry.lab?.fields.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>
      <label>
        New value (hidden)
        <input name="value" type="password" autoComplete="new-password" />
      </label>
      <label>
        Remove a field
        <select name="remove">
          <option value="">Keep all fields</option>
          {entry.lab?.fields.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="lantern-btn small" disabled={busy}>
        Save fields
      </button>
    </Form>
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
/** One activity line: when, what, which login, who, and what changed when it says. */
/** Sessions by id, so activity names the session rather than its id. */
type Who = { id: string; label: string }[]
const eventLine = (e: Event, named = true, who: Who = []) =>
  [
    when(e.at),
    e.action,
    named ? e.name : null,
    who.find((s) => s.id === e.actor)?.label ?? e.actor,
    e.detail,
  ]
    .filter(Boolean)
    .join(' · ')
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
/** Notes for any login; the login page and site name for an account or lab login. */
function DetailsEdit({
  entry,
  busy,
  save,
}: {
  entry: Entry
  busy: boolean
  save(patch: {
    notes: string
    login_url?: string
    target?: string
  }): Promise<void>
}) {
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        const f = new FormData(event.currentTarget),
          page = String(f.get('loginUrl') ?? ''),
          site = String(f.get('target') ?? '')
        void save({
          notes: String(f.get('notes') ?? ''),
          ...(page && page !== entry.lab?.login_url ? { login_url: page } : {}),
          ...(site && site !== entry.lab?.target ? { target: site } : {}),
        })
      }}
    >
      {entry.lab && (
        <label>
          Site name
          <input
            name="target"
            required
            autoComplete="off"
            pattern="[a-z0-9][a-z0-9._\-]*"
            defaultValue={entry.lab.target}
          />
        </label>
      )}
      {entry.lab?.kind === 'account' && (
        <label>
          Login page
          <input
            name="loginUrl"
            type="url"
            required
            autoComplete="off"
            defaultValue={entry.lab.login_url ?? ''}
          />
        </label>
      )}
      <label>
        Notes
        <input name="notes" autoComplete="off" defaultValue={entry.notes} />
      </label>
      <button type="submit" className="lantern-btn small" disabled={busy}>
        Save
      </button>
    </Form>
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
