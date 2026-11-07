'use client'

import { useCallback, useEffect, useState } from 'react'
import { useHosts } from '@/lib/hooks/use-hosts'
import { shortWhen } from '@/lib/short-when'
import { HostSignIn } from './HostsSheet'
import styles from './LoginsPage.module.css'

const kinds = [
  'tool login',
  'API key',
  'password',
  'backup key',
  'lab login',
] as const
type Kind = (typeof kinds)[number]
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
  }
}
interface Data {
  entries: Entry[]
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
const title = (kind: Kind) =>
  ({
    'tool login': 'Tool logins',
    'API key': 'API keys',
    password: 'Passwords',
    'backup key': 'Backup keys',
    'lab login': 'Lab logins',
  })[kind]
const when = (time: string | null) => shortWhen(time)

export function LoginsPage() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [auditOpen, setAuditOpen] = useState(false)
  const [search, setSearch] = useState(''),
    [adding, setAdding] = useState(false)
  const [sessions, setSessions] = useState<{ id: string; label: string }[]>([]),
    [sessionError, setSessionError] = useState('')
  const { hosts, ...hostState } = useHosts()
  const load = useCallback(async () => {
    try {
      setData(await api<Data>('/api/logins'))
      setError('')
    } catch (error) {
      setError((error as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
    api<{ sessions: typeof sessions }>('/api/logins/sessions')
      .then((r) => setSessions(r.sessions))
      .catch(() =>
        setSessionError('Sessions could not load. Try reloading the page.'),
      )
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
  return (
    <main className={styles.page}>
      <header>
        <h1>Logins</h1>
        <button className="lantern-btn ghost small" onClick={() => void load()}>
          Refresh
        </button>
        <button
          className="lantern-btn small"
          disabled={data?.readOnly}
          onClick={() => setAdding(!adding)}
        >
          {adding ? 'Close' : 'Add login'}
        </button>
      </header>
      <p className={styles.help}>
        Saved logins for you and your agents. Choose which machines, roles and
        lab targets may use them.
      </p>
      {error && (
        <div role="alert" className={styles.notice}>
          <p>
            {data
              ? 'The list could not refresh. Showing the last loaded list.'
              : error}
          </p>
          <button
            className="lantern-btn ghost small"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}
      {!data && !error && <p role="status">Loading logins…</p>}
      {data?.warning && (
        <p role="status" className={styles.notice}>
          {data.warning}
        </p>
      )}
      {message && (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      )}
      {adding && (
        <AddLogin
          onSaved={(warning) => {
            setAdding(false)
            void changed(warning || 'Login saved.')
          }}
        />
      )}
      {data && (
        <>
          <label className={styles.search}>
            Find a login
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or kind"
            />
          </label>
          {data.entries.length === 0 && (
            <p>No logins saved yet. Add one to get started.</p>
          )}
          {search &&
            !data.entries.some((e) =>
              `${e.name} ${e.kind}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && <p>No logins match your search.</p>}
          {kinds.map((kind) => {
            const entries = data.entries.filter(
              (e) =>
                e.kind === kind &&
                `${e.name} ${e.kind}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            return (
              entries.length > 0 && (
                <section key={kind} aria-label={title(kind)}>
                  <h2>{title(kind)}</h2>
                  <ul className={styles.rows}>
                    {entries.map((entry) => (
                      <LoginRow
                        key={entry.name}
                        entry={entry}
                        onChanged={changed}
                        revealSeconds={data.revealSeconds}
                        readOnly={data.readOnly}
                      />
                    ))}
                  </ul>
                </section>
              )
            )
          })}
          <section aria-label="Lab assignments">
            <h2>Lab assignments</h2>
            <p className={styles.help}>
              A session can add, refresh and use logins only for its assigned
              targets. Removing a target ends that access.
            </p>
            {sessionError ? (
              <p role="alert">{sessionError}</p>
            ) : sessions.length === 0 ? (
              <p>No sessions are available to assign.</p>
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
          </section>
        </>
      )}
      <section aria-label="Tool sign-in">
        <h2>Tool sign-in</h2>
        {hostState.isLoading ? (
          <p>Checking machines…</p>
        ) : hostState.isError ? (
          <p role="alert">
            Machines could not load.{' '}
            <button
              className="lantern-btn ghost small"
              onClick={() => void hostState.refetch()}
            >
              Try again
            </button>
          </p>
        ) : hosts.length === 0 ? (
          <p>No linked machines are available.</p>
        ) : (
          hosts.map((host) => (
            <details key={host.name}>
              <summary>
                {host.name} ·{' '}
                {host.state === 'connected' ? 'Connected' : 'Not connected'}
              </summary>
              <HostSignIn
                host={host.name}
                connected={host.state === 'connected'}
                onOpened={() => {
                  window.location.href = '/'
                }}
              />
            </details>
          ))
        )}
      </section>
      <details>
        <summary>Recent activity</summary>
        <Audit />
      </details>
    </main>
  )
}
function AddLogin({ onSaved }: { onSaved(warning?: string): void }) {
  const [kind, setKind] = useState<Kind>('API key'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault()
        const form = event.currentTarget,
          f = new FormData(form)
        setBusy(true)
        setError('')
        try {
          let result: { warning?: string }
          if (kind === 'lab login')
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
          onSaved(result.warning)
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
      <h2>Add login</h2>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      {kind === 'lab login' ? (
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
      <label>
        {kind === 'lab login' ? 'Fields (JSON, hidden)' : 'Value (hidden)'}
        <input
          name="value"
          type="password"
          required
          autoComplete="new-password"
        />
      </label>
      <label>
        Notes
        <input name="notes" autoComplete="off" />
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} className="lantern-btn small">
        {busy ? 'Saving…' : 'Save login'}
      </button>
    </form>
  )
}
function LoginRow({
  entry,
  onChanged,
  revealSeconds,
  readOnly,
}: {
  entry: Entry
  onChanged(text: string): Promise<void>
  revealSeconds: number
  readOnly?: boolean
  warning?: string
}) {
  const [panel, setPanel] = useState<
      'replace' | 'edit' | 'grants' | 'remove' | null
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
  return (
    <li>
      <div className={styles.row}>
        <div className={styles.identity}>
          <strong>{entry.name}</strong>
          {entry.lab && (
            <small>
              {entry.lab.target} · {entry.lab.actor} · {entry.lab.kind}
              {entry.lab.expires_at
                ? ` · Expires ${when(entry.lab.expires_at)}`
                : ''}
            </small>
          )}
          {entry.notes && <p>{entry.notes}</p>}
          <small>Last used: {when(entry.lastUsed)}</small>
        </div>
        <span className={styles.badge}>{entry.state}</span>
        <div className={styles.actions}>
          {!entry.verifierOnly && (
            <>
              <button
                className="lantern-btn ghost small"
                disabled={busy}
                onClick={() =>
                  value === null ? void run(() => reveal()) : setValue(null)
                }
              >
                {value === null ? 'Reveal' : 'Hide'}
              </button>
              <button
                className="lantern-btn ghost small"
                disabled={busy}
                onClick={() => void run(() => reveal(true))}
              >
                Copy
              </button>
              <button
                className="lantern-btn ghost small"
                disabled={readOnly}
                onClick={() => {
                  setValue(null)
                  setPanel(panel === 'replace' ? null : 'replace')
                }}
              >
                Replace
              </button>
            </>
          )}
          {entry.lab && (
            <button
              className="lantern-btn ghost small"
              disabled={readOnly}
              onClick={() => {
                setValue(null)
                setPanel(panel === 'edit' ? null : 'edit')
              }}
            >
              Edit fields
            </button>
          )}
          <button
            className="lantern-btn ghost small"
            disabled={readOnly}
            onClick={() => {
              setValue(null)
              setPanel(panel === 'grants' ? null : 'grants')
            }}
          >
            Access
          </button>
          <button
            className="lantern-btn ghost small"
            disabled={readOnly}
            onClick={() => {
              setValue(null)
              setPanel(panel === 'remove' ? null : 'remove')
            }}
          >
            Remove
          </button>
        </div>
      </div>
      {value !== null && (
        <div className={styles.revealed}>
          <small>Hides after {revealSeconds} seconds.</small>
          <pre>{value}</pre>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {panel === 'replace' && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget,
              value = String(new FormData(form).get('value'))
            void run(async () => {
              const result = await api(`${path}/replace`, { value })
              form.reset()
              setPanel(null)
              await onChanged(result.warning || 'Login replaced.')
            })
          }}
        >
          <label>
            {entry.lab
              ? 'Complete bundle (JSON, hidden)'
              : 'New value (hidden)'}
            <input
              type="password"
              name="value"
              required
              autoComplete="new-password"
            />
          </label>
          <button className="lantern-btn small" disabled={busy}>
            Replace login
          </button>
        </form>
      )}
      {panel === 'edit' && entry.lab && (
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
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            const f = new FormData(event.currentTarget)
            void run(async () => {
              const result = await api(`${path}/grants`, {
                type: f.get('type'),
                value: f.get('value'),
                granted: f.get('action') === 'grant',
              })
              await onChanged(result.warning || 'Access saved.')
            })
          }}
        >
          <small>
            Machines: {entry.machines.join(', ') || 'None'}
            <br />
            Roles: {entry.roles.join(', ') || 'None'}
            {entry.deniedRoles?.length
              ? `; blocked: ${entry.deniedRoles.join(', ')}`
              : ''}
            <br />
            Created: {when(entry.created)} · Replaced: {when(entry.rotated)}
          </small>
          <label>
            Access type
            <select name="type">
              <option value="machine">Machine</option>
              <option value="role">Role</option>
            </select>
          </label>
          <label>
            Name
            <input name="value" required autoComplete="off" />
          </label>
          <label>
            Action
            <select name="action">
              <option value="grant">Allow</option>
              <option value="revoke">Remove access</option>
            </select>
          </label>
          <button className="lantern-btn small" disabled={busy}>
            Save access
          </button>
        </form>
      )}
      {panel === 'remove' && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            const confirm = new FormData(event.currentTarget).get('confirm')
            void run(async () => {
              const result = await api(`${path}/remove`, { confirm })
              setPanel(null)
              await onChanged(result.warning || 'Login removed.')
            })
          }}
        >
          <label>
            Type {entry.name} to remove it
            <input name="confirm" required autoComplete="off" />
          </label>
          <button className="lantern-btn danger small" disabled={busy}>
            Remove login
          </button>
          <button
            type="button"
            className="lantern-btn ghost small"
            onClick={() => setPanel(null)}
          >
            Cancel
          </button>
        </form>
      )}
    </li>
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
    <form
      className={styles.form}
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
      <button className="lantern-btn small" disabled={busy}>
        Save fields
      </button>
    </form>
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
    <form
      className={styles.form}
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
        {targets.length === 0 && <p>Add a lab login to assign its target.</p>}
        {targets.map((t) => (
          <label className={styles.check} key={t}>
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
      {error && <p role="alert">{error}</p>}
      <button className="lantern-btn small" disabled={busy}>
        Save targets
      </button>
    </form>
  )
}
function Audit() {
  const [events, setEvents] = useState<
      { at: string; action: string; name: string; actor: string }[] | null
    >(null),
    [error, setError] = useState('')
  useEffect(() => {
    api<{ events: NonNullable<typeof events> }>('/api/logins/audit')
      .then((r) => setEvents(r.events.slice(-30).reverse()))
      .catch(() => setError('Activity could not load.'))
  }, [])
  return error ? (
    <p role="alert">{error}</p>
  ) : !events ? (
    <p>Loading activity…</p>
  ) : events.length === 0 ? (
    <p>No activity recorded yet.</p>
  ) : (
    <ul className={styles.activity}>
      {events.map((e) => (
        <li key={`${e.at}-${e.action}-${e.name}-${e.actor}`}>
          {when(e.at)} · {e.action} · {e.name} · {e.actor}
        </li>
      ))}
    </ul>
  )
}
