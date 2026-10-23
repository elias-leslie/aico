import type { RefObject } from 'react'

export type CleanerState = 'idle' | 'processing' | 'preview' | 'refining'

export interface PromptCleanerProps {
  rawPrompt: string
  onSend: (cleanedPrompt: string) => void
  onCancel: () => void
  cleanPrompt: (prompt: string, refinement?: string) => Promise<string>
  errorMessage?: string | null
  onClearError?: () => void
  isCleaning?: boolean
  showDiffToggle?: boolean
}

export interface ProcessingViewProps {
  state: CleanerState
  rawPrompt: string
  scanProgress: number
}

export interface HeaderBarProps {
  showDiffToggle: boolean
  state: CleanerState
  showDiff: boolean
  onToggleDiff: () => void
  onClose: () => void
}

export interface ActionBarProps {
  isEditing: boolean
  onCancel: () => void
  onToggleEdit: () => void
  onSend: () => void
}

export interface PreviewViewProps {
  showDiff: boolean
  isEditing: boolean
  rawPrompt: string
  displayedText: string
  editedPrompt: string
  refinementInput: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onEditedChange: (value: string) => void
  onRefinementChange: (value: string) => void
  onRefine: () => void
  refinementDisabled: boolean
}

export interface ErrorBannerProps {
  errorMessage: string
  onDismiss?: () => void
}
