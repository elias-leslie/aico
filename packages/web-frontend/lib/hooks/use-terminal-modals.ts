import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect } from 'react'

interface UseTerminalModalsProps {
  setShowTerminalManager: (show: boolean) => void
}

/**
 * The new-session picker, kept in sync with the `modal` URL param.
 */
export function useTerminalModals({
  setShowTerminalManager,
}: UseTerminalModalsProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlModal = searchParams.get('modal')

  const setModalParam = useCallback(
    (value: string | null) => {
      const params =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search)
          : new URLSearchParams(searchParams.toString())
      if (value === null) params.delete('modal')
      else params.set('modal', value)
      const query = params.toString()
      router.replace(`${pathname}${query ? `?${query}` : ''}`, {
        scroll: false,
      })
    },
    [searchParams, router, pathname],
  )

  const handleOpenTerminalManager = useCallback(() => {
    setShowTerminalManager(true)
    setModalParam('terminal-manager')
  }, [setShowTerminalManager, setModalParam])

  const handleCloseTerminalManager = useCallback(() => {
    setShowTerminalManager(false)
    setModalParam(null)
  }, [setShowTerminalManager, setModalParam])

  useEffect(() => {
    setShowTerminalManager(urlModal === 'terminal-manager')
  }, [urlModal, setShowTerminalManager])

  return {
    handleOpenTerminalManager,
    handleCloseTerminalManager,
  }
}
