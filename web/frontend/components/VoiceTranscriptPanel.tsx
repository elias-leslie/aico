'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getTranscriptAppendSuffix,
  mergeTranscriptSegments,
} from '@/lib/voice/transcript-merge'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'
import { VoiceMobilePanel } from './voice/VoiceMobilePanel'

interface VoiceTranscriptPanelProps {
  transcript: string
  interimTranscript: string
  status: TranscriptionStatus
  error: TranscriptionError
  onSend: (text: string) => void
  onCancel: () => void
  onToggleListening: () => void
}

export function VoiceTranscriptPanel({
  transcript,
  interimTranscript,
  status,
  error,
  onSend,
  onCancel,
  onToggleListening,
}: VoiceTranscriptPanelProps) {
  const [editedText, setEditedText] = useState(transcript)
  const [editBaseline, setEditBaseline] = useState<string | null>(null)
  const editBaselineRef = useRef<string | null>(null)
  const previousRecognizedTextRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  const hasText = combinedTranscript.trim().length > 0

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
      onClose={onCancel}
    />
  )
}
