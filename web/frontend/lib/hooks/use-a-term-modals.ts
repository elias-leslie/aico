import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect } from 'react'

interface UseATermModalsProps {
  setShowATermManager: (show: boolean) => void
}

/**
 * The new-session picker, kept in sync with the `modal` URL param.
 */
export function useATermModals({ setShowATermManager }: UseATermModalsProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlModal = searchParams.get('modal')

  const setModalParam = useCallback(
    (value: string | null, sessionId?: string) => {
      const params =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search)
          : new URLSearchParams(searchParams.toString())
      if (value === null) params.delete('modal')
      else params.set('modal', value)
      if (sessionId) params.set('session', sessionId)
      const query = params.toString()
      router.replace(`${pathname}${query ? `?${query}` : ''}`, {
        scroll: false,
      })
    },
    [searchParams, router, pathname],
  )

  const handleOpenATermManager = useCallback(() => {
    setShowATermManager(true)
    setModalParam('a-term-manager')
  }, [setShowATermManager, setModalParam])

  const handleCloseATermManager = useCallback(() => {
    setShowATermManager(false)
    setModalParam(null)
  }, [setShowATermManager, setModalParam])

  // Opens a running session from the picker: one URL change, so the
  // session switch cannot bring the closed picker back.
  const handleOpenSession = useCallback(
    (sessionId: string) => {
      setShowATermManager(false)
      setModalParam(null, sessionId)
    },
    [setShowATermManager, setModalParam],
  )

  useEffect(() => {
    setShowATermManager(urlModal === 'a-term-manager')
  }, [urlModal, setShowATermManager])

  return {
    handleOpenATermManager,
    handleCloseATermManager,
    handleOpenSession,
  }
}
