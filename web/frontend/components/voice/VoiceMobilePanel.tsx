'use client'

import { clsx } from 'clsx'
import { Keyboard, Mic, MicOff, Send, X } from 'lucide-react'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'
import styles from '../VoiceTranscriptPanel.module.css'
import { SHORT_ERROR_MESSAGES } from './voiceErrorMessages'

interface VoiceMobilePanelProps {
  editedText: string
  setEditedText: (text: string) => void
  interimTranscript: string
  status: TranscriptionStatus
  error: TranscriptionError
  hasText: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onMicTap: () => void
  onSend: () => void
  onClose: () => void
}

export function VoiceMobilePanel({
  editedText,
  setEditedText,
  interimTranscript,
  status,
  error,
  hasText,
  textareaRef,
  onMicTap,
  onSend,
  onClose,
}: VoiceMobilePanelProps) {
  const isListening = status === 'listening'
  const isProcessing = status === 'processing'
  const showPulse = isListening

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
          : hasText
            ? 'Paused'
            : 'Tap to speak'

  return (
    <div
      style={{
        background: 'var(--term-bg-surface)',
        borderTop: '1px solid var(--term-border)',
      }}
    >
      <textarea
        ref={textareaRef}
        className={styles.editTextarea}
        value={displayText}
        onChange={(event) => setEditedText(event.target.value)}
        readOnly={isListening || isProcessing}
        aria-label="Voice transcript"
        placeholder="Voice transcript"
        rows={3}
        style={{
          display: 'block',
          width: 'calc(100% - 24px)',
          maxHeight: 128,
          overflowY: 'auto',
          padding: '8px 12px',
          margin: '8px 12px 0',
          borderRadius: 8,
          background: 'var(--term-bg-elevated)',
          fontFamily: 'var(--font-mono)',
          fontSize: 16,
          lineHeight: 1.5,
          color: 'var(--term-text-primary)',
        }}
      />

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

      {/* Action row: cancel, microphone, send, keyboard */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
          padding: '6px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
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

        {/* Microphone control stays available while there is text to send. */}
        <button
          type="button"
          className={clsx(showPulse && styles.mobileMicPulse)}
          onClick={onMicTap}
          disabled={isProcessing}
          aria-label={
            isListening
              ? 'Pause dictation'
              : hasText
                ? 'Resume dictation'
                : 'Talk'
          }
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 2,
            cursor: isProcessing ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            border: `2px solid ${
              showPulse ? 'var(--term-error)' : 'var(--term-accent)'
            }`,
            background: showPulse
              ? 'color-mix(in srgb, var(--term-error) 15%, transparent)'
              : 'color-mix(in srgb, var(--term-accent) 8%, transparent)',
            color: showPulse ? 'var(--term-error)' : 'var(--term-accent)',
            opacity: isProcessing ? 0.5 : 1,
          }}
        >
          {isListening ? (
            <MicOff className="w-6 h-6" />
          ) : (
            <Mic className="w-6 h-6" />
          )}
          <span style={{ fontSize: 10 }}>
            {isListening ? 'Pause' : hasText ? 'Resume' : 'Talk'}
          </span>
        </button>

        {hasText && (
          <button
            type="button"
            onClick={onSend}
            disabled={isProcessing}
            aria-label="Send transcript"
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 2,
              background:
                'color-mix(in srgb, var(--term-accent) 15%, transparent)',
              border: '1px solid var(--term-accent)',
              color: 'var(--term-accent)',
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              opacity: isProcessing ? 0.5 : 1,
            }}
          >
            <Send className="w-5 h-5" />
            <span style={{ fontSize: 10 }}>Send</span>
          </button>
        )}

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
