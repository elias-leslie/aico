import { type MutableRefObject, useCallback, useRef } from 'react'
import type { TerminalHandle } from '@/components/Terminal'
import { useFileUpload } from '@/lib/hooks/use-file-upload'

interface UseTerminalActionHandlersParams {
  terminalRefs: MutableRefObject<Map<string, TerminalHandle | null>>
  activeSessionId: string | null
  showCleaner: boolean
  setShowCleaner: (show: boolean) => void
  setCleanerRawPrompt: (prompt: string) => void
  // Voice input
  setShowVoice: (show: boolean) => void
  voiceStartListening: () => void
  voiceStopListening: () => void
  voiceResetTranscript: () => void
  voiceStatus: 'idle' | 'listening' | 'processing' | 'error'
}

/**
 * Find the active terminal ref. Tries activeSessionId first (URL-derived),
 * falls back to the first available ref (handles stale URL, e.g. when
 * pane mode is 'claude' but URL still points to the shell session).
 */
function findActiveRef(
  terminalRefs: Map<string, TerminalHandle | null>,
  activeSessionId: string | null,
): TerminalHandle | null {
  if (activeSessionId) {
    const ref = terminalRefs.get(activeSessionId)
    if (ref) return ref
  }
  // Fallback: first available ref (handles URL/slot desync on initial load)
  for (const ref of terminalRefs.values()) {
    if (ref) return ref
  }
  return null
}

export function useTerminalActionHandlers({
  terminalRefs,
  activeSessionId,
  setShowCleaner,
  setCleanerRawPrompt,
  setShowVoice,
  voiceStartListening,
  voiceStopListening,
  voiceResetTranscript,
  voiceStatus,
}: UseTerminalActionHandlersParams) {
  // File upload functionality
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    uploadFile,
    progress,
    isUploading,
    error: uploadError,
    clearError: clearUploadError,
  } = useFileUpload()
  const uploadTargetRef = useRef<string | null>(null)

  const handleUploadClick = useCallback((targetSessionId?: string) => {
    uploadTargetRef.current = targetSessionId ?? null
    fileInputRef.current?.click()
  }, [])

  const handleFileSelect = useCallback(
    async (file: File) => {
      const result = await uploadFile(file)
      if (result) {
        const terminalRef = uploadTargetRef.current
          ? terminalRefs.current.get(uploadTargetRef.current) ?? null
          : findActiveRef(terminalRefs.current, activeSessionId)
        if (terminalRef) {
          terminalRef.pasteInput(result.path)
        }
      }
      uploadTargetRef.current = null
    },
    [uploadFile, activeSessionId, terminalRefs],
  )

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        // Errors are captured by useFileUpload's error state; void the promise
        void handleFileSelect(file)
      } else {
        uploadTargetRef.current = null
      }
      // Reset input so the same file can be selected again
      e.target.value = ''
    },
    [handleFileSelect],
  )

  // Prompt cleaner handlers
  const handleCleanerSend = useCallback(
    (cleanedPrompt: string) => {
      const terminalRef = findActiveRef(terminalRefs.current, activeSessionId)
      if (terminalRef) {
        // Clear current line (send Ctrl+U) then paste cleaned prompt
        terminalRef.sendInput('\x15') // Ctrl+U
        terminalRef.pasteInput(cleanedPrompt)
      }
      setShowCleaner(false)
      setCleanerRawPrompt('')
    },
    [activeSessionId, terminalRefs, setShowCleaner, setCleanerRawPrompt],
  )

  const handleCleanerCancel = useCallback(() => {
    setShowCleaner(false)
    setCleanerRawPrompt('')
  }, [setShowCleaner, setCleanerRawPrompt])

  // Voice input handlers
  // Track which terminal pane triggered voice input
  const voiceTargetRef = useRef<string | null>(null)

  const handleVoiceOpen = useCallback((targetSessionId?: string) => {
    voiceTargetRef.current = targetSessionId ?? null
    setShowVoice(true)
    voiceStartListening()
  }, [setShowVoice, voiceStartListening])

  const handleVoiceSend = useCallback(
    (text: string) => {
      // Use the specific pane that triggered voice, fall back to active/first available
      const terminalRef = voiceTargetRef.current
        ? terminalRefs.current.get(voiceTargetRef.current) ?? null
        : findActiveRef(terminalRefs.current, activeSessionId)
      if (terminalRef) {
        // Use bracketed paste so TUI apps (Claude Code, vim, etc.) recognize the input
        terminalRef.pasteInput(text)
        // Send Enter separately — 150ms delay gives TUI apps time to process the paste
        setTimeout(() => terminalRef.sendInput('\r'), 150)
      }
      voiceTargetRef.current = null
      voiceStopListening()
      voiceResetTranscript()
      setShowVoice(false)
    },
    [activeSessionId, terminalRefs, voiceStopListening, voiceResetTranscript, setShowVoice],
  )

  const handleVoiceInsert = useCallback(
    (text: string) => {
      const terminalRef = voiceTargetRef.current
        ? terminalRefs.current.get(voiceTargetRef.current) ?? null
        : findActiveRef(terminalRefs.current, activeSessionId)
      if (terminalRef) {
        terminalRef.pasteInput(text)
      }
      voiceTargetRef.current = null
      voiceStopListening()
      voiceResetTranscript()
      setShowVoice(false)
    },
    [activeSessionId, terminalRefs, voiceStopListening, voiceResetTranscript, setShowVoice],
  )

  const handleVoiceCancel = useCallback(() => {
    voiceStopListening()
    voiceResetTranscript()
    setShowVoice(false)
  }, [voiceStopListening, voiceResetTranscript, setShowVoice])

  const handleVoiceToggle = useCallback(() => {
    if (voiceStatus === 'listening') {
      voiceStopListening()
    } else {
      voiceStartListening()
    }
  }, [voiceStatus, voiceStopListening, voiceStartListening])

  return {
    // File upload
    fileInputRef,
    progress,
    isUploading,
    uploadError,
    clearUploadError,
    handleUploadClick,
    handleFileSelect,
    handleFileInputChange,
    handleCleanerSend,
    handleCleanerCancel,
    // Voice input
    handleVoiceOpen,
    handleVoiceSend,
    handleVoiceInsert,
    handleVoiceCancel,
    handleVoiceToggle,
    handleVoiceReset: voiceResetTranscript,
  }
}
