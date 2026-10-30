import { MobileKeyboard } from '@/components/keyboard/MobileKeyboard'

interface TerminalMobileSectionProps {
  sessions: Array<{ id: string }>
  activeSessionId?: string | null
  handleKeyboardInput: (input: string) => void
  handleKeyboardPaste: (text: string) => void
  handleFileSelect: (file: File) => void
  isMobile?: boolean
}

export function TerminalMobileSection({
  sessions,
  activeSessionId,
  handleKeyboardInput,
  handleKeyboardPaste,
  handleFileSelect,
  isMobile,
}: TerminalMobileSectionProps) {
  if (!isMobile || sessions.length === 0) return null

  return (
    <div className="order-3 shrink-0">
      <MobileKeyboard
        sessionId={activeSessionId}
        onSend={handleKeyboardInput}
        onPaste={handleKeyboardPaste}
        onFilePaste={handleFileSelect}
      />
    </div>
  )
}
