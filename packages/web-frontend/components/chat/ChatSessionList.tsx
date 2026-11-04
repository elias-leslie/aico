'use client'
import { Plus } from 'lucide-react'
import { newChat } from '@/lib/chat'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouLauncher } from '../asks/NeedsYou'
import { SessionList } from '../SessionList'
import './chat.css'

/** The same session groups as the desktop sidebar, with room for phone rows. */
export function ChatSessionList({
  slots,
  onSelect,
  onNewSession,
}: {
  slots: (TerminalSlot | PaneSlot)[]
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  onNewSession?: () => void
}) {
  const attention = useSessionAttention()
  return (
    <section className="chat-phone-list" aria-label="Sessions">
      <header>
        <h1>Sessions</h1>
        <button className="lantern-btn" type="button" onClick={onNewSession}>
          New session
        </button>
        <button className="lantern-btn primary" type="button" onClick={newChat}>
          <Plus size={16} />
          New chat
        </button>
      </header>
      <NeedsYouLauncher variant="row" />
      <SessionList
        slots={slots}
        attention={attention}
        onSelect={onSelect}
        phone
      />
    </section>
  )
}
