'use client'

import { type ReactNode, useEffect, useState } from 'react'
import {
  api,
  chipOf,
  type Entry,
  type Event,
  eventLine,
  type Kind,
  kinds,
  labPath,
  meta,
  metaTip,
  type Probe,
  STATE_TIP,
  savedChars,
  shownName as shownNameOf,
  when,
} from '@/lib/logins'
import {
  type Access,
  AccessChecklist,
  type AccessChoices,
  accessOf,
  applyAccess,
  applySessions,
  knownRoles,
  planAccess,
  planSessions,
  sessionsOf,
} from './LoginAccess'
import { SecretField } from './LoginSecretField'
import { Actions, Form, Quiet, Row } from './settings/kit'
import kit from './settings/kit.module.css'

export function LoginRow({
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
  const shownName = shownNameOf(entry)
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
      meta={<span title={metaTip(entry)}>{meta(entry)}</span>}
      chip={chipOf(entry.state)}
      chipText={entry.state}
      chipTitle={STATE_TIP[entry.state]}
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
                labPath(entry),
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
              const result = await api(labPath(entry), patch, 'PATCH')
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
        Created: {when(entry.created)} ·{' '}
        {entry.rotated
          ? `Replaced: ${when(entry.rotated)}`
          : 'Not replaced yet'}
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
    kind?: Kind
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
          site = String(f.get('target') ?? ''),
          kind = f.get('kind') as Kind | null
        void save({
          notes: String(f.get('notes') ?? ''),
          ...(kind && kind !== entry.kind ? { kind } : {}),
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
      {!entry.lab && !entry.tool && (
        <label>
          Kind
          <select name="kind" defaultValue={entry.kind}>
            {kinds
              .filter(
                (kind) =>
                  kind !== 'lab login' &&
                  (kind !== 'tool login' || entry.kind === 'tool login'),
              )
              .map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
          </select>
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
