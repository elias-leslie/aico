'use client'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { type ChatOptions, chatCall } from '@/lib/chat'
import './chat.css'
export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const client = useQueryClient()
  const [cwd, setCwd] = useState('')
  const [role, setRole] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options = useQuery({
    queryKey: ['chat-options', cwd],
    queryFn: () =>
      apiFetch<ChatOptions>(`/api/chat/options?cwd=${encodeURIComponent(cwd)}`),
    retry: false,
  })
  const folder = cwd || options.data?.projects.find((p) => p.root)?.root || ''
  const routed = useQuery({
    queryKey: ['chat-options', folder],
    queryFn: () =>
      apiFetch<ChatOptions>(
        `/api/chat/options?cwd=${encodeURIComponent(folder)}`,
      ),
    enabled: Boolean(folder),
    retry: false,
  })
  const roles = routed.data?.roles ?? []
  const selected = roles.find(
    (r) => r.role === (role || routed.data?.defaultRole),
  )
  const chain = selected?.chain ?? []
  const chosenModel = chain.some((m) => m.id === model)
    ? model
    : (chain[0]?.id ?? '')
  const start = async () => {
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    try {
      const chat = await chatCall('', {
        role: selected.role,
        cwd: folder,
        message,
        ...(model && { model: chosenModel }),
        ...(effort && { effort }),
      })
      await client.invalidateQueries({ queryKey: ['terminal-sessions'] })
      router.push(`/?session=${chat.id}`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="chat-scrim" />
        <Dialog.Content
          className="lantern-sheet chat-dialog"
          aria-describedby="chat-start-description"
        >
          <header>
            <Dialog.Title>New chat</Dialog.Title>
            <Dialog.Close
              className="lantern-icon-btn"
              aria-label="Close"
              disabled={busy}
            >
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="chat-fields">
            <p id="chat-start-description">
              Pick a role and a project folder, then say what you need.
            </p>
            <label>
              Project folder
              <input
                list="chat-projects"
                value={folder}
                onChange={(e) => setCwd(e.target.value)}
              />
              <datalist id="chat-projects">
                {options.data?.projects
                  .filter((p) => p.root)
                  .map((p) => (
                    <option key={p.id} value={p.root ?? ''}>
                      {p.name}
                    </option>
                  ))}
              </datalist>
            </label>
            {options.isPending || routed.isPending ? (
              <p role="status">Loading roles and models…</p>
            ) : null}
            {(options.isError || routed.isError) && (
              <div role="alert">
                <p>Couldn’t read the role’s rules. No chat has started.</p>
                <button
                  className="lantern-btn"
                  type="button"
                  onClick={() => {
                    void options.refetch()
                    void routed.refetch()
                  }}
                >
                  Try again
                </button>
              </div>
            )}
            <fieldset>
              <legend>Role</legend>
              <div className="chat-roles">
                {roles.map((r) => (
                  <label key={r.role}>
                    <input
                      type="radio"
                      name="chat-role"
                      value={r.role}
                      checked={selected?.role === r.role}
                      onChange={() => {
                        setRole(r.role)
                        setModel('')
                        setEffort('')
                      }}
                    />
                    <span>
                      <b>{r.role}</b>
                      <small>{r.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              Model
              <select
                value={chosenModel}
                onChange={(e) => setModel(e.target.value)}
              >
                {chain.map((m, i) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.effort ? `, ${m.effort}` : ''}
                    {i === 0 ? ' (from routing)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <p className="chat-muted">
              The role’s order: {chain.map((m) => m.id).join(' → ') || '—'}. If
              a model can’t answer, the next one takes the whole chat.
            </p>
            <label>
              Effort
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">From routing</option>
                {[
                  'off',
                  'minimal',
                  'low',
                  'medium',
                  'high',
                  'xhigh',
                  'max',
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Message
              <textarea
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What do you need?"
              />
            </label>
            {(selected?.error || error) && (
              <p role="alert">{error || selected?.error}</p>
            )}
          </div>
          <footer>
            <button
              className="lantern-btn ghost"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="lantern-btn primary"
              type="button"
              disabled={
                busy ||
                !message.trim() ||
                !chosenModel ||
                Boolean(selected?.error)
              }
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Start chat'}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
