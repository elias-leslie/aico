'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TranscriptionError,
  TranscriptionStatus,
} from '@/lib/voice/types'
import { VoiceDesktopPanel } from './voice/VoiceDesktopPanel'
import { VoiceMobilePanel } from './voice/VoiceMobilePanel'

interface VoiceTranscriptPanelProps {
  transcript: string
  interimTranscript: string
  status: TranscriptionStatus
  error: TranscriptionError
  onSend: (text: string) => void
  onInsert: (text: string) => void
  onCancel: () => void
  onToggleListening: () => void
  onReset: () => void
  isMobile?: boolean
}

export function VoiceTranscriptPanel({
  transcript,
  interimTranscript,
  status,
  error,
  onSend,
  onInsert,
  onCancel,
  onToggleListening,
  onReset,
  isMobile,
}: VoiceTranscriptPanelProps) {
  const [editedText, setEditedText] = useState(transcript)
  const [visible, setVisible] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Animate in on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Sync transcript updates into edited text
  useEffect(() => {
    setEditedText(transcript)
  }, [transcript])

  // Auto-focus textarea (desktop only)
  useEffect(() => {
    if (visible && !isMobile) {
      textareaRef.current?.focus()
    }
  }, [visible, isMobile])

  const handleSend = useCallback(() => {
    const text = editedText.trim()
    if (text) onSend(text)
  }, [editedText, onSend])

  const handleInsert = useCallback(() => {
    const text = editedText.trim()
    if (text) onInsert(text)
  }, [editedText, onInsert])

  // Clean up close animation timer on unmount
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  const handleClose = useCallback(() => {
    if (isMobile) {
      onCancel()
      return
    }
    setVisible(false)
    closeTimerRef.current = setTimeout(onCancel, 300)
  }, [onCancel, isMobile])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    },
    [handleSend, handleClose],
  )

  const hasText = editedText.trim().length > 0 || interimTranscript.length > 0

  const handleMicTap = useCallback(() => {
    if (status === 'error') onReset()
    if (hasText) {
      handleSend()
      return
    }
    onToggleListening()
  }, [status, hasText, onReset, handleSend, onToggleListening])

  if (isMobile) {
    return (
      <VoiceMobilePanel
        editedText={editedText}
        interimTranscript={interimTranscript}
        status={status}
        error={error}
        hasText={hasText}
        onMicTap={handleMicTap}
        onClose={handleClose}
      />
    )
  }

  return (
    <VoiceDesktopPanel
      editedText={editedText}
      setEditedText={setEditedText}
      interimTranscript={interimTranscript}
      status={status}
      error={error}
      hasText={hasText}
      visible={visible}
      textareaRef={textareaRef}
      onSend={handleSend}
      onInsert={handleInsert}
      onClose={handleClose}
      onToggleListening={onToggleListening}
      onReset={onReset}
      onKeyDown={handleKeyDown}
    />
  )
}
