'use client'

import { clsx } from 'clsx'
import { Mic, MicOff, Send, X } from 'lucide-react'
import type { TranscriptionError, TranscriptionStatus } from '@/lib/voice/types'
import styles from '../VoiceTranscriptPanel.module.css'
import { ERROR_MESSAGES } from './voiceErrorMessages'

interface VoiceDesktopPanelProps {
  editedText: string
  setEditedText: (text: string) => void
  interimTranscript: string
  status: TranscriptionStatus
  error: TranscriptionError
  hasText: boolean
  visible: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onSend: () => void
  onInsert: () => void
  onClose: () => void
  onToggleListening: () => void
  onReset: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

export function VoiceDesktopPanel({
  editedText,
  setEditedText,
  interimTranscript,
  status,
  error,
  hasText,
  visible,
  textareaRef,
  onSend,
  onInsert,
  onClose,
  onToggleListening,
  onReset,
  onKeyDown,
}: VoiceDesktopPanelProps) {
  const isListening = status === 'listening'
  const isProcessing = status === 'processing'

  return (
    <>
      {/* Backdrop */}
      <div
        className={clsx(styles.backdrop, visible && styles.backdropVisible)}
        onClick={onClose}
      />

      {/* Panel */}
      <div className={clsx(styles.panel, visible && styles.panelVisible)}>
        <div className={styles.glowTop} />

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {isListening && <div className={styles.pulsingDot} />}
            <span className={styles.headerTitle}>VOICE_INPUT</span>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Textarea */}
        <div className={styles.textareaWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.editTextarea}
            value={
              interimTranscript
                ? `${editedText}${editedText ? ' ' : ''}${interimTranscript}`
                : editedText
            }
            onChange={(e) => setEditedText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isListening
                ? 'Listening... speak now'
                : 'Tap the mic to start dictating'
            }
            readOnly={isListening || isProcessing}
            aria-label="Voice transcript"
          />
        </div>

        {/* Status bar */}
        <div className={styles.statusBar}>
          <span
            className={clsx(
              styles.statusText,
              isListening && styles.statusListening,
              isProcessing && styles.statusProcessing,
              status === 'error' && styles.statusError,
            )}
          >
            {status === 'error' && error
              ? (ERROR_MESSAGES[error] ?? 'Unknown error')
              : isListening
                ? 'Listening...'
                : isProcessing
                  ? 'Processing...'
                  : 'Ready'}
          </span>
          <span className={styles.charCount}>{editedText.length} chars</span>
        </div>

        {/* Action bar */}
        <div className={styles.actionBar}>
          <button
            type="button"
            className={clsx(styles.actionBtn, styles.actionBtnSecondary)}
            onClick={onClose}
            aria-label="Cancel voice input"
          >
            CANCEL
          </button>

          <button
            type="button"
            className={clsx(styles.micBtn, isListening && styles.micBtnActive)}
            onClick={() => {
              if (status === 'error') onReset()
              onToggleListening()
            }}
            title={isListening ? 'Stop listening' : 'Start listening'}
            aria-label={isListening ? 'Stop listening' : 'Start listening'}
          >
            {isListening ? (
              <MicOff className="w-5 h-5" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>

          <div className={styles.sendGroup}>
            <button
              type="button"
              className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
              onClick={onSend}
              disabled={!hasText || isProcessing}
              aria-label="Send transcript"
            >
              <Send className="w-3.5 h-3.5" />
              SEND
            </button>
            <button
              type="button"
              className={styles.insertLink}
              onClick={onInsert}
              disabled={!hasText || isProcessing}
              aria-label="Insert transcript without enter"
            >
              insert without enter
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
