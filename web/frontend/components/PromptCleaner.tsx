'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './PromptCleaner.module.css'
import {
  ActionBar,
  ErrorBanner,
  HeaderBar,
  PreviewView,
  ProcessingView,
} from './PromptCleaner.parts'
import type { CleanerState, PromptCleanerProps } from './PromptCleaner.types'

export function PromptCleaner({
  rawPrompt,
  onSend,
  onCancel,
  cleanPrompt,
  errorMessage,
  onClearError,
  isCleaning = false,
  showDiffToggle = true,
}: PromptCleanerProps) {
  const [state, setState] = useState<CleanerState>('idle')
  const [cleanedPrompt, setCleanedPrompt] = useState('')
  const [displayedText, setDisplayedText] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const [refinementInput, setRefinementInput] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState('')
  const [scanProgress, setScanProgress] = useState(0)
  const [isVisible, setIsVisible] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasInitialized = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleClean = useCallback(
    async (refinement?: string) => {
      onClearError?.()
      setState(refinement ? 'refining' : 'processing')
      const result = await cleanPrompt(rawPrompt, refinement)
      setCleanedPrompt(result)
      setEditedPrompt(result)
      setState('preview')
    },
    [cleanPrompt, onClearError, rawPrompt],
  )

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    handleClean()
  }, [handleClean])

  useEffect(() => {
    if (state !== 'preview' || !cleanedPrompt) return
    let index = 0
    setDisplayedText('')
    const interval = setInterval(() => {
      if (index < cleanedPrompt.length) {
        setDisplayedText(cleanedPrompt.slice(0, index + 1))
        index += 1
      } else {
        clearInterval(interval)
      }
    }, 12)
    return () => clearInterval(interval)
  }, [cleanedPrompt, state])

  useEffect(() => {
    if (state !== 'processing') {
      setScanProgress(0)
      return
    }
    const interval = setInterval(() => {
      setScanProgress((previous) => (previous >= 100 ? 0 : previous + 2))
    }, 50)
    return () => clearInterval(interval)
  }, [state])

  useEffect(
    () => () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    },
    [],
  )

  const sendValue = (isEditing ? editedPrompt : cleanedPrompt).trim()

  const handleSend = () => {
    if (!sendValue) return
    onSend(sendValue)
  }

  const handleClose = useCallback(() => {
    onClearError?.()
    setIsVisible(false)
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
    }
    closeTimerRef.current = setTimeout(onCancel, 300)
  }, [onCancel, onClearError])

  const handleRefine = () => {
    const refinement = refinementInput.trim()
    if (!refinement || isCleaning) return
    handleClean(refinement)
    setRefinementInput('')
  }

  const toggleEditMode = () => {
    setIsEditing((current) => !current)
    if (!isEditing) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }

  return (
    <>
      <div
        className={`${styles.backdrop} ${isVisible ? styles.backdropVisible : ''}`}
        onClick={handleClose}
        aria-hidden="true"
      />
      <div
        data-testid="prompt-cleaner-modal"
        className={`${styles.panel} ${isVisible ? styles.panelVisible : ''}`}
      >
        <div className={styles.scanlineOverlay} />
        <HeaderBar
          showDiffToggle={showDiffToggle}
          state={state}
          showDiff={showDiff}
          onToggleDiff={() => setShowDiff((current) => !current)}
          onClose={handleClose}
        />
        {errorMessage && (
          <ErrorBanner errorMessage={errorMessage} onDismiss={onClearError} />
        )}
        {(state === 'processing' || state === 'refining') && (
          <ProcessingView
            state={state}
            rawPrompt={rawPrompt}
            scanProgress={scanProgress}
          />
        )}
        {state === 'preview' && (
          <PreviewView
            showDiff={showDiff}
            isEditing={isEditing}
            rawPrompt={rawPrompt}
            displayedText={displayedText}
            editedPrompt={editedPrompt}
            refinementInput={refinementInput}
            textareaRef={textareaRef}
            onEditedChange={setEditedPrompt}
            onRefinementChange={setRefinementInput}
            onRefine={handleRefine}
            refinementDisabled={isCleaning || state !== 'preview'}
          />
        )}
        {state === 'preview' && (
          <ActionBar
            isEditing={isEditing}
            onCancel={handleClose}
            onToggleEdit={toggleEditMode}
            onSend={handleSend}
          />
        )}
        <div className={styles.glowTop} />
        <div className={styles.glowBottom} />
      </div>
    </>
  )
}
