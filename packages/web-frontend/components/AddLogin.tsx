'use client'

import { useState } from 'react'
import {
  ACCOUNT,
  api,
  type Checked,
  type Choice,
  type Entry,
  kinds,
  type Probe,
  savedChars,
} from '@/lib/logins'
import {
  type Access,
  AccessChecklist,
  type AccessChoices,
  applyAccess,
  applySessions,
  defaultAccess,
  knownRoles,
  planAccess,
  planSessions,
} from './LoginAccess'
import { SecretField } from './LoginSecretField'
import { Form, Quiet } from './settings/kit'
import kit from './settings/kit.module.css'

export function AddLogin({
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
