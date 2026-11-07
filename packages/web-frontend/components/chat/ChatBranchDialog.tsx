'use client'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ChatMessage, ChatView } from '@/lib/chat'

/** Branch from a reply: a message and a model for the new chat. `branch` is the reply branched from, or null when closed. */
export function ChatBranchDialog({
  branch,
  chain,
  message,
  model,
  busy,
  error,
  onMessage,
  onModel,
  onClose,
  onStart,
}: {
  branch: ChatMessage | null
  chain: ChatView['chain']
  message: string
  model: string
  busy: boolean
  error: string | null
  onMessage: (message: string) => void
  onModel: (model: string) => void
  onClose: () => void
  onStart: () => void
}) {
  return (
    <Dialog.Root
      open={branch !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="chat-scrim" />
        <Dialog.Content
          className="lantern-sheet chat-dialog"
          aria-describedby="chat-branch-description"
        >
          <header>
            <Dialog.Title>Branch from turn {branch?.turn}</Dialog.Title>
            <Dialog.Close
              className="lantern-icon-btn"
              aria-label="Close branch dialog"
            >
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="chat-fields">
            <p id="chat-branch-description">
              {branch?.stop_reason === 'aborted' ? (
                <>
                  This reply is unfinished. The new chat keeps the text that
                  arrived and sends your message from the last complete reply.
                </>
              ) : (
                <>
                  A new chat starts with everything up to the end of turn{' '}
                  {branch?.turn} ({branch?.model}’s reply).
                </>
              )}{' '}
              This chat stays as it is.
            </p>
            <label>
              Message for the new chat
              <textarea
                value={message}
                rows={4}
                onChange={(e) => onMessage(e.target.value)}
                placeholder="What should go differently?"
              />
            </label>
            <label>
              Model
              <select value={model} onChange={(e) => onModel(e.target.value)}>
                {chain.map((m) => (
                  <option key={m.id}>{m.id}</option>
                ))}
              </select>
            </label>
            {error && <p role="alert">{error}</p>}
          </div>
          <footer>
            <Dialog.Close className="lantern-btn ghost">Cancel</Dialog.Close>
            <button
              className="lantern-btn primary"
              type="button"
              disabled={!message.trim() || busy}
              onClick={onStart}
            >
              Start branch
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
