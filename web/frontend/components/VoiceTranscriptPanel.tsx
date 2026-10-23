'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getTranscriptAppendSuffix,
  mergeTranscriptSegments,
} from '@/lib/voice/transcript-merge'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'
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
  const [editBaseline, setEditBaseline] = useState<string | null>(null)
  const editBaselineRef = useRef<string | null>(null)
  const previousRecognizedTextRef = useRef('')
  const [visible, setVisible] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Animate in on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Keep manual corrections as the draft base when dictation resumes.
  useEffect(() => {
    const recognizedText = mergeTranscriptSegments([
      transcript,
      interimTranscript,
    ])
    if (!recognizedText && previousRecognizedTextRef.current) {
      editBaselineRef.current = null
      setEditBaseline(null)
    }
    previousRecognizedTextRef.current = recognizedText
    if (editBaselineRef.current === null) setEditedText(transcript)
  }, [transcript, interimTranscript])

  // Auto-focus textarea (desktop only)
  useEffect(() => {
    if (visible && !isMobile) {
      textareaRef.current?.focus()
    }
  }, [visible, isMobile])

  const pendingText =
    editBaseline === null
      ? interimTranscript
      : getTranscriptAppendSuffix(
          editBaseline,
          mergeTranscriptSegments([transcript, interimTranscript]),
        )
  const interimSuffix = getTranscriptAppendSuffix(editedText, pendingText)
  const combinedTranscript = mergeTranscriptSegments([editedText, pendingText])

  const handleEdit = useCallback(
    (text: string) => {
      const baseline = mergeTranscriptSegments([transcript, interimTranscript])
      editBaselineRef.current = baseline
      setEditBaseline(baseline)
      setEditedText(text)
    },
    [transcript, interimTranscript],
  )

  const handleSend = useCallback(() => {
    const text = combinedTranscript.trim()
    if (text) onSend(text)
  }, [combinedTranscript, onSend])

  const handleInsert = useCallback(() => {
    const text = combinedTranscript.trim()
    if (text) onInsert(text)
  }, [combinedTranscript, onInsert])

  // Clean up close animation timer on unmount
  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    [],
  )

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

  const hasText = combinedTranscript.trim().length > 0

  if (isMobile) {
    return (
      <VoiceMobilePanel
        editedText={editedText}
        setEditedText={handleEdit}
        interimTranscript={interimSuffix}
        status={status}
        error={error}
        hasText={hasText}
        textareaRef={textareaRef}
        onMicTap={onToggleListening}
        onSend={handleSend}
        onClose={handleClose}
      />
    )
  }

  return (
    <VoiceDesktopPanel
      editedText={editedText}
      setEditedText={handleEdit}
      interimTranscript={interimSuffix}
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
