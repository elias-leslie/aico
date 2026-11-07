import { useEffect, useRef } from 'react'
import type { ChatView } from '@/lib/chat'

/** How far from the bottom still counts as reading the end of the thread. */
const FOLLOW_PX = 100

/** The thread scrolls to new content while the reader is at the bottom, and stops when they scroll up. */
export function useChatScroll(chat: ChatView | undefined) {
  const body = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const toEnd = () => body.current?.scrollTo({ top: body.current.scrollHeight })
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroll element mounts after the chat loads
  useEffect(() => {
    if (!body.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (follow.current) toEnd()
    })
    observer.observe(body.current)
    return () => observer.disconnect()
  }, [chat?.id])
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new transcript content while the reader is at the bottom
  useEffect(() => {
    if (follow.current) toEnd()
  }, [chat])
  return {
    body,
    follow,
    onScroll: () => {
      if (body.current)
        follow.current =
          body.current.scrollHeight -
            body.current.scrollTop -
            body.current.clientHeight <
          FOLLOW_PX
    },
    /** Jump to the end and keep following (the message box takes focus). */
    followEnd: () => {
      follow.current = true
      toEnd()
    },
  }
}
