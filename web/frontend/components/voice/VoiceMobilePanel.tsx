'use client'

import { clsx } from 'clsx'
import { Keyboard, Mic, MicOff, Send, X } from 'lucide-react'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'
import styles from '../VoiceTranscriptPanel.module.css'
import { SHORT_ERROR_MESSAGES } from './voiceErrorMessages'

interface VoiceMobilePanelProps {
  editedText: string
  interimTranscript: string
  status: TranscriptionStatus
  error: TranscriptionError
  hasText: boolean
  onMicTap: () => void
  onClose: () => void
}

export function VoiceMobilePanel({
  editedText,
  interimTranscript,
  status,
  error,
  hasText,
  onMicTap,
  onClose,
}: VoiceMobilePanelProps) {
  const isListening = status === 'listening'
  const isProcessing = status === 'processing'
  const showSendIcon = hasText
  const showPulse = isListening && !hasText

  const displayText = interimTranscript
    ? `${editedText}${editedText ? ' ' : ''}${interimTranscript}`
    : editedText

  const statusMessage =
    status === 'error' && error
      ? (SHORT_ERROR_MESSAGES[error] ?? 'Error')
      : isListening
        ? 'Listening...'
        : isProcessing
          ? 'Processing...'
          : 'Tap to speak'

  return (
    <div
      style={{
        background: 'var(--term-bg-surface)',
        borderTop: '1px solid var(--term-border)',
      }}
    >
      {/* Transcript bubble — only when there's text */}
      {displayText.trim() && (
        <div
          style={{
            maxHeight: 128,
            overflowY: 'auto',
            padding: '8px 12px',
            margin: '8px 12px 0',
            borderRadius: 8,
            background: 'var(--term-bg-elevated)',
            border: '1px solid var(--term-border-active)',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--term-text-primary)',
          }}
        >
          {editedText}
          {interimTranscript && (
            <span style={{ color: 'var(--term-accent)', opacity: 0.7 }}>
              {editedText ? ' ' : ''}
              {interimTranscript}
            </span>
          )}
        </div>
      )}

      {/* Status line */}
      <div
        style={{
          textAlign: 'center',
          padding: '6px 0 2px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color:
            status === 'error'
              ? 'var(--term-error)'
              : isListening
                ? 'var(--term-accent)'
                : 'var(--term-text-muted)',
        }}
      >
        {statusMessage}
      </div>

      {/* Action row: [X] [MIC] [keyboard] */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
          padding: '6px 16px 12px',
        }}
      >
        {/* Cancel button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Cancel voice input"
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--term-border-active)',
            color: 'var(--term-text-muted)',
            cursor: 'pointer',
          }}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Main mic / send button — 64x64 */}
        <button
          type="button"
          className={clsx(showPulse && styles.mobileMicPulse)}
          onClick={onMicTap}
          disabled={isProcessing}
          aria-label={
            showSendIcon
              ? 'Send transcript'
              : isListening
                ? 'Stop listening'
                : 'Start listening'
          }
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: isProcessing ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            border: `2px solid ${
              showPulse ? 'var(--term-error)' : 'var(--term-accent)'
            }`,
            background: showPulse
              ? 'color-mix(in srgb, var(--term-error) 15%, transparent)'
              : showSendIcon
                ? 'color-mix(in srgb, var(--term-accent) 15%, transparent)'
                : 'color-mix(in srgb, var(--term-accent) 8%, transparent)',
            color: showPulse ? 'var(--term-error)' : 'var(--term-accent)',
            opacity: isProcessing ? 0.5 : 1,
          }}
        >
          {showSendIcon ? (
            <Send className="w-6 h-6" />
          ) : isListening ? (
            <MicOff className="w-6 h-6" />
          ) : (
            <Mic className="w-6 h-6" />
          )}
        </button>

        {/* Keyboard button — dismiss voice, return to keyboard */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Return to keyboard"
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--term-border-active)',
            color: 'var(--term-text-muted)',
            cursor: 'pointer',
          }}
        >
          <Keyboard className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}
