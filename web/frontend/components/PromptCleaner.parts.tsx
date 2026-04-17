'use client'

import styles from './PromptCleaner.module.css'
import type {
  ActionBarProps,
  ErrorBannerProps,
  HeaderBarProps,
  PreviewViewProps,
  ProcessingViewProps,
} from './PromptCleaner.types'

function getPromptPreviewLines(prompt: string) {
  const previewLines: Array<{ id: string; text: string }> = []
  let offset = 0

  for (const line of prompt.split('\n')) {
    previewLines.push({
      id: `${offset}:${line.length}:${line}`,
      text: line,
    })
    offset += line.length + 1
  }

  return previewLines
}

export function ProcessingView({
  state,
  rawPrompt,
  scanProgress,
}: ProcessingViewProps) {
  return (
    <div className={styles.processingContainer}>
      <div className={styles.scanAnimation}>
        <div className={styles.scanLine} style={{ top: `${scanProgress}%` }} />
        <div className={styles.scanText}>
          {state === 'refining' ? '> REFINING...' : '> ANALYZING PROMPT...'}
        </div>
        <div className={styles.originalPreview}>
          {getPromptPreviewLines(rawPrompt).map((line) => (
            <div key={line.id} className={styles.scanLineText}>
              {line.text || '\u00A0'}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.progressBar}>
        <div
          className={styles.progressFill}
          style={{ width: `${scanProgress}%` }}
        />
      </div>
    </div>
  )
}

export function PreviewView({
  showDiff,
  isEditing,
  rawPrompt,
  displayedText,
  editedPrompt,
  refinementInput,
  textareaRef,
  onEditedChange,
  onRefinementChange,
  onRefine,
  refinementDisabled,
}: PreviewViewProps) {
  return (
    <div className={styles.previewContainer}>
      {showDiff ? (
        <div className={styles.diffView}>
          <div className={`${styles.diffPanel} ${styles.diffPanelOriginal}`}>
            <div className={`${styles.diffLabel} ${styles.diffLabelOriginal}`}>
              ORIGINAL
            </div>
            <div className={styles.diffContent}>{rawPrompt}</div>
          </div>
          <div className={styles.diffDivider}>
            <span className={styles.arrow}>→</span>
          </div>
          <div className={`${styles.diffPanel} ${styles.diffPanelCleaned}`}>
            <div className={`${styles.diffLabel} ${styles.diffLabelCleaned}`}>
              CLEANED
            </div>
            <div className={styles.diffContent}>{displayedText}</div>
          </div>
        </div>
      ) : (
        <div className={styles.singleView}>
          {isEditing ? (
            <textarea
              ref={textareaRef}
              className={styles.editTextarea}
              value={editedPrompt}
              onChange={(event) => onEditedChange(event.target.value)}
              placeholder="Edit your prompt..."
              aria-label="Edit cleaned prompt"
            />
          ) : (
            <div className={styles.cleanedPreview}>
              <div className={styles.outputLabel}>
                <span className={styles.labelIcon}>▸</span>OUTPUT
              </div>
              <div className={styles.cleanedText}>
                {displayedText}
                <span className={styles.cursorBlink}>█</span>
              </div>
            </div>
          )}
        </div>
      )}
      <div className={styles.refinementSection}>
        <div className={styles.refinementInputWrapper}>
          <span className={styles.inputPrefix}>$</span>
          <input
            type="text"
            className={styles.refinementInput}
            placeholder="Refine: 'make it shorter', 'add context about X'..."
            value={refinementInput}
            onChange={(event) => onRefinementChange(event.target.value)}
            onKeyDown={(event) =>
              event.key === 'Enter' && !refinementDisabled && onRefine()
            }
            disabled={refinementDisabled}
            aria-label="Refine cleaned prompt"
          />
          {refinementInput && (
            <button
              type="button"
              className={styles.refineBtn}
              onClick={onRefine}
              disabled={refinementDisabled}
              aria-label="Apply prompt refinement"
            >
              ↵
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function ErrorBanner({ errorMessage, onDismiss }: ErrorBannerProps) {
  return (
    <div className={styles.errorBanner} role="status" aria-live="polite">
      <span>
        {errorMessage}. Showing the original prompt so you can keep working.
      </span>
      {onDismiss ? (
        <button
          type="button"
          className={styles.errorDismiss}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      ) : null}
    </div>
  )
}

export function HeaderBar({
  showDiffToggle,
  state,
  showDiff,
  onToggleDiff,
  onClose,
}: HeaderBarProps) {
  return (
    <div className={styles.header}>
      <div className={styles.headerLeft}>
        <span className={styles.aTermIcon}>⌘</span>
        <span className={styles.headerTitle}>PROMPT_CLEANER</span>
        <span className={styles.headerVersion}>v1.0</span>
      </div>
      <div className={styles.headerRight}>
        {showDiffToggle && state === 'preview' && (
          <button
            type="button"
            className={`${styles.toggleBtn} ${showDiff ? styles.toggleBtnActive : ''}`}
            onClick={onToggleDiff}
          >
            <span className={styles.toggleIcon}>◐</span>DIFF
          </button>
        )}
        <button
          type="button"
          data-testid="prompt-cleaner-modal-close"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close prompt cleaner"
        >
          <span>×</span>
        </button>
      </div>
    </div>
  )
}

export function ActionBar({
  isEditing,
  onCancel,
  onToggleEdit,
  onSend,
}: ActionBarProps) {
  return (
    <div className={styles.actionBar}>
      <button
        type="button"
        className={`${styles.actionBtn} ${styles.actionBtnSecondary}`}
        onClick={onCancel}
        aria-label="Cancel prompt cleaning"
      >
        <span className={styles.btnIcon}>✕</span>CANCEL
      </button>
      <button
        type="button"
        className={`${styles.actionBtn} ${styles.actionBtnSecondary}`}
        onClick={onToggleEdit}
        aria-label={isEditing ? 'Preview prompt' : 'Edit prompt'}
      >
        <span className={styles.btnIcon}>{isEditing ? '◉' : '✎'}</span>
        {isEditing ? 'PREVIEW' : 'EDIT'}
      </button>
      <button
        type="button"
        className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
        onClick={onSend}
        aria-label="Send cleaned prompt"
      >
        <span className={styles.btnIcon}>▶</span>SEND
        <span className={styles.keyHint}>⏎</span>
      </button>
    </div>
  )
}
