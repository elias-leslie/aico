import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ChatView } from '@/lib/chat'

/**
 * Keeps one opened chat live: each message from /api/chat/:id/stream replaces the cached chat. A
 * broken or malformed stream marks the page disconnected until `reconnect` reopens it.
 */
export function useChatStream(id: string, ready: boolean) {
  const client = useQueryClient()
  const [disconnected, setDisconnected] = useState(false)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [connection, setConnection] = useState(0)
  const summaryKey = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection explicitly reopens the stream; token updates do not
  useEffect(() => {
    if (!ready) return
    const stream = new EventSource(`/api/chat/${id}/stream`)
    stream.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data) as ChatView
        if (value.id !== id || !Array.isArray(value.messages))
          throw new Error('Invalid chat stream')
        client.setQueryData(['aico-chat', id], value)
        setDisconnected(false)
        setConnectedAt(Date.now())
        const key = `${value.state}:${value.model}:${value.messages.length}:${value.questions?.length}`
        if (summaryKey.current !== key) {
          summaryKey.current = key
          void client.invalidateQueries({ queryKey: ['terminal-sessions'] })
        }
      } catch {
        setDisconnected(true)
      }
    }
    stream.onerror = () => {
      setDisconnected(true)
      stream.close()
    }
    return () => stream.close()
    // The connection follows one opened chat, not each token.
  }, [id, ready, client, connection])
  return {
    disconnected,
    connectedAt,
    reconnect: () => setConnection((v) => v + 1),
  }
}
