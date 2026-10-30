import { type MutableRefObject, useCallback, useRef, useState } from 'react'
import type { TerminalHandle } from '@/components/Terminal'
import { useFileUpload } from '@/lib/hooks/use-file-upload'

/** A finished upload, for its confirmation. */
export interface UploadDone {
  /** The file's own name, as picked or dropped. */
  name: string
  /** Where it landed, as the session reads it. */
  path: string
  /** The host it went to; null for this computer. */
  host: string | null
  /** Whether its path was typed into the session. */
  typed: boolean
}

interface UseTerminalActionHandlersParams {
  terminalRefs: MutableRefObject<Map<string, TerminalHandle | null>>
  activeSessionId: string | null
}

/**
 * Find the active terminal ref and its session. Tries activeSessionId first (URL-derived),
 * falls back to the first available ref (handles stale URL, e.g. when
 * pane mode is 'claude' but URL still points to the shell session).
 */
function findActiveTarget(
  terminalRefs: Map<string, TerminalHandle | null>,
  activeSessionId: string | null,
): { id: string; ref: TerminalHandle } | null {
  if (activeSessionId) {
    const ref = terminalRefs.get(activeSessionId)
    if (ref) return { id: activeSessionId, ref }
  }
  // Fallback: first available ref (handles URL/slot desync on initial load)
  for (const [id, ref] of terminalRefs) {
    if (ref) return { id, ref }
  }
  return null
}

function findActiveRef(
  terminalRefs: Map<string, TerminalHandle | null>,
  activeSessionId: string | null,
): TerminalHandle | null {
  return findActiveTarget(terminalRefs, activeSessionId)?.ref ?? null
}

export function useTerminalActionHandlers({
  terminalRefs,
  activeSessionId,
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
  const [uploadDone, setUploadDone] = useState<UploadDone | null>(null)
  const clearUploadDone = useCallback(() => setUploadDone(null), [])

  const handleUploadClick = useCallback((targetSessionId?: string) => {
    uploadTargetRef.current = targetSessionId ?? null
    fileInputRef.current?.click()
  }, [])

  const handleFileSelect = useCallback(
    async (file: File, targetSessionId?: string) => {
      const uploadTargetSessionId = targetSessionId ?? uploadTargetRef.current
      // The session that gets the path, so the server stores the file where it can read it.
      const target = uploadTargetSessionId
        ? {
            id: uploadTargetSessionId,
            ref: terminalRefs.current.get(uploadTargetSessionId) ?? null,
          }
        : findActiveTarget(terminalRefs.current, activeSessionId)
      setUploadDone(null)
      const result = await uploadFile(file, target?.id)
      if (result) {
        // The pane is looked up again: it may have gone while the file was on its way.
        const terminalRef = uploadTargetSessionId
          ? (terminalRefs.current.get(uploadTargetSessionId) ?? null)
          : findActiveRef(terminalRefs.current, activeSessionId)
        if (terminalRef) {
          terminalRef.pasteInput(result.path)
        }
        setUploadDone({
          name: file.name || result.filename,
          path: result.path,
          host: result.host ?? null,
          typed: !!terminalRef,
        })
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

  return {
    // File upload
    fileInputRef,
    progress,
    isUploading,
    uploadError,
    clearUploadError,
    uploadDone,
    clearUploadDone,
    handleUploadClick,
    handleFileSelect,
    handleFileInputChange,
  }
}
