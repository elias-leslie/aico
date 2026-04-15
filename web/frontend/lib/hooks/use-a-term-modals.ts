import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect } from 'react'

interface UseATermModalsProps {
  showATermManager: boolean
  setShowATermManager: (show: boolean) => void
  showKeyboardHelp: boolean
  setShowKeyboardHelp: (show: boolean) => void
  onAttachExternalSession?: (sessionId: string) => void
  onAttachDetachedPane?: (
    paneId: string,
  ) => Promise<{
    sessionId: string | null
    urlUpdates?: Record<string, string | null>
  }>
}

interface UseATermModalsReturn {
  handleOpenATermManager: () => void
  handleCloseATermManager: () => void
  handleAttachExternalSession: (sessionId: string) => void
  handleAttachDetachedPane: (paneId: string) => Promise<void>
  handleCloseKeyboardHelp: () => void
}

/**
 * Custom hook for managing a-term modals with URL param synchronization
 * Handles aTerm manager and keyboard shortcuts modals
 */
export function useATermModals({
  showATermManager: _showATermManager,
  setShowATermManager,
  showKeyboardHelp: _showKeyboardHelp,
  setShowKeyboardHelp,
  onAttachExternalSession,
  onAttachDetachedPane,
}: UseATermModalsProps): UseATermModalsReturn {
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

  // Open a-term manager
  const handleOpenATermManager = useCallback(() => {
    setShowATermManager(true)
    updateUrlParams({ modal: 'a-term-manager' })
  }, [setShowATermManager, updateUrlParams])

  // Close a-term manager
  const handleCloseATermManager = useCallback(() => {
    setShowATermManager(false)
    updateUrlParams({ modal: null })
  }, [setShowATermManager, updateUrlParams])

  const handleAttachExternalSession = useCallback(
    (sessionId: string) => {
      setShowATermManager(false)
      onAttachExternalSession?.(sessionId)
      updateUrlParams({ modal: null, session: sessionId })
    },
    [onAttachExternalSession, setShowATermManager, updateUrlParams],
  )

  const handleAttachDetachedPane = useCallback(
    async (paneId: string) => {
      setShowATermManager(false)
      const result = await onAttachDetachedPane?.(paneId)
      const updates: Record<string, string | null> = {
        modal: null,
        ...(result?.urlUpdates ?? {}),
      }
      if (result?.sessionId) {
        updates.session = result.sessionId
      }
      updateUrlParams(updates)
    },
    [onAttachDetachedPane, setShowATermManager, updateUrlParams],
  )

  // Close keyboard help
  const handleCloseKeyboardHelp = useCallback(() => {
    setShowKeyboardHelp(false)
    updateUrlParams({ modal: null })
  }, [setShowKeyboardHelp, updateUrlParams])

  // Sync modal state from URL params
  useEffect(() => {
    setShowATermManager(urlModal === 'a-term-manager')
    setShowKeyboardHelp(urlModal === 'keyboard-shortcuts')
  }, [urlModal, setShowATermManager, setShowKeyboardHelp])

  return {
    handleOpenATermManager,
    handleCloseATermManager,
    handleAttachExternalSession,
    handleAttachDetachedPane,
    handleCloseKeyboardHelp,
  }
}
