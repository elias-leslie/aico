// The model for the next message in an Agent Hub chat. Empty means the agent's
// own routing, as on Agent Hub's chat page; a choice rides on the next message
// and on any follow-up queued behind a running turn (bridge-client.ts).

import type { ChatHubClient } from '@agent-hub/chat-ui'
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'

interface ModelPickerProps {
  client: ChatHubClient
  /** The chosen model id; empty for the agent's own routing. */
  value: string
  onChange(model: string): void
}

export function ModelPicker({ client, value, onChange }: ModelPickerProps) {
  const selectId = useId()
  const catalog = useQuery({
    queryKey: ['aico-chat', 'models', client.baseUrl ?? ''],
    queryFn: () => client.models.list(),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const routable = (catalog.data ?? [])
    .filter((model) => model.routable)
    .sort((a, b) => a.name.localeCompare(b.name))
  // A model the session already asks for stays visible when the catalog has not loaded or dropped it.
  const listed = routable.some((model) => model.id === value)
  return (
    <div className="chat-model">
      <label htmlFor={selectId}>Model</label>
      <select id={selectId} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{catalog.isLoading ? 'Loading models…' : 'Agent routing'}</option>
        {value && !listed ? <option value={value}>{value}</option> : null}
        {routable.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} ({model.provider})
          </option>
        ))}
      </select>
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
