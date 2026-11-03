// The model catalog the composer's Model and Effort selects share: one query,
// one cache entry, through the chat client.

import type { ChatHubClient } from '@agent-hub/chat-ui'
import { useQuery } from '@tanstack/react-query'

export function useModelCatalog(client: ChatHubClient) {
  return useQuery({
    queryKey: ['aico-chat', 'models', client.baseUrl ?? ''],
    queryFn: () => client.models.list(),
    staleTime: 5 * 60_000,
    retry: false,
  })
}
