// The model for the next message in an Agent Hub chat, a select in the
// composer's bar. Empty means the agent's own routing, as on Agent Hub's chat
// page; a choice rides on the next message and on any follow-up queued behind
// a running turn (bridge-client.ts). The Effort select sits next to it
// (effort-picker.tsx). There is no Tools select: Tether's read-only flag is a
// label, not a tool limit, so a select would change nothing.

import type { ChatHubClient } from '@agent-hub/chat-ui'
import type { ReactNode } from 'react'
import { useModelCatalog } from './model-catalog'

interface ModelPickerProps {
  client: ChatHubClient
  /** The chosen model id; empty for the agent's own routing. */
  value: string
  onChange(model: string): void
  /** More controls for the same bar (the effort select). */
  children?: ReactNode
}

export function ModelPicker({ client, value, onChange, children }: ModelPickerProps) {
  const catalog = useModelCatalog(client)
  const routable = (catalog.data ?? [])
    .filter((model) => model.routable)
    .sort((a, b) => a.name.localeCompare(b.name))
  // A model the session already asks for stays visible when the catalog has not loaded or dropped it.
  const listed = routable.some((model) => model.id === value)
  return (
    <div className="chat-model">
      <label className="chat-model-pick">
        <span>Model</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{catalog.isLoading ? 'Loading models…' : 'Agent routing'}</option>
          {value && !listed ? <option value={value}>{value}</option> : null}
          {routable.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} ({model.provider})
            </option>
          ))}
        </select>
      </label>
      {children}
      {catalog.isError ? (
        <span role="status" className="chat-model-failed">
          The model list did not load.{' '}
          <button type="button" onClick={() => void catalog.refetch()}>
            Try again
          </button>
        </span>
      ) : null}
    </div>
  )
}
