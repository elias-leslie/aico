import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect } from 'react'

interface UseTerminalModalsProps {
  showTerminalManager: boolean
  setShowTerminalManager: (show: boolean) => void
  showKeyboardHelp: boolean
  setShowKeyboardHelp: (show: boolean) => void
  onAttachExternalSession?: (sessionId: string) => void
  onAttachDetachedPane?: (paneId: string) => Promise<string | null>
}

interface UseTerminalModalsReturn {
  handleOpenTerminalManager: () => void
  handleCloseTerminalManager: () => void
  handleAttachExternalSession: (sessionId: string) => void
  handleAttachDetachedPane: (paneId: string) => Promise<void>
  handleCloseKeyboardHelp: () => void
}

/**
 * Custom hook for managing terminal modals with URL param synchronization
 * Handles terminal manager and keyboard shortcuts modals
 */
export function useTerminalModals({
  showTerminalManager: _showTerminalManager,
  setShowTerminalManager,
  showKeyboardHelp: _showKeyboardHelp,
  setShowKeyboardHelp,
  onAttachExternalSession,
  onAttachDetachedPane,
}: UseTerminalModalsProps): UseTerminalModalsReturn {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlModal = searchParams.get('modal')

  const getLatestSearchParams = useCallback(() => {
    if (typeof window !== 'undefined') {
      return new URLSearchParams(window.location.search)
    }
    return new URLSearchParams(searchParams.toString())
  }, [searchParams])

  // Helper to update URL params
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const newParams = getLatestSearchParams()
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          newParams.delete(key)
        } else {
          newParams.set(key, value)
        }
      }
      const query = newParams.toString()
      router.replace(`${pathname}${query ? `?${query}` : ''}`, {
        scroll: false,
      })
    },
    [getLatestSearchParams, router, pathname],
  )

  // Open terminal manager
  const handleOpenTerminalManager = useCallback(() => {
    setShowTerminalManager(true)
    updateUrlParams({ modal: 'terminal-manager' })
  }, [setShowTerminalManager, updateUrlParams])

  // Close terminal manager
  const handleCloseTerminalManager = useCallback(() => {
    setShowTerminalManager(false)
    updateUrlParams({ modal: null })
  }, [setShowTerminalManager, updateUrlParams])

  const handleAttachExternalSession = useCallback(
    (sessionId: string) => {
      setShowTerminalManager(false)
      onAttachExternalSession?.(sessionId)
      updateUrlParams({ modal: null, session: sessionId })
    },
    [onAttachExternalSession, setShowTerminalManager, updateUrlParams],
  )

  const handleAttachDetachedPane = useCallback(
    async (paneId: string) => {
      setShowTerminalManager(false)
      const sessionId = await onAttachDetachedPane?.(paneId)
      const updates: Record<string, string | null> = { modal: null }
      if (sessionId) {
        updates.session = sessionId
      }
      updateUrlParams(updates)
    },
    [onAttachDetachedPane, setShowTerminalManager, updateUrlParams],
  )

  // Close keyboard help
  const handleCloseKeyboardHelp = useCallback(() => {
    setShowKeyboardHelp(false)
    updateUrlParams({ modal: null })
  }, [setShowKeyboardHelp, updateUrlParams])

  // Sync modal state from URL params
  useEffect(() => {
    setShowTerminalManager(urlModal === 'terminal-manager')
    setShowKeyboardHelp(urlModal === 'keyboard-shortcuts')
  }, [urlModal, setShowTerminalManager, setShowKeyboardHelp])

  return {
    handleOpenTerminalManager,
    handleCloseTerminalManager,
    handleAttachExternalSession,
    handleAttachDetachedPane,
    handleCloseKeyboardHelp,
  }
}
