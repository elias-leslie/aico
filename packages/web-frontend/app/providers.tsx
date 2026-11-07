'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { watchServerReach } from '@/lib/frame/server-reach'
import { watchShownProject } from '@/lib/frame/shown-project'
import { watchOffline } from '@/lib/offline'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  // The offline strip's "Can't reach Aico since ..." follows the app's own polls.
  useEffect(() => watchServerReach(queryClient), [queryClient])
  // Notes and Capture open on the project of the session on screen.
  useEffect(() => watchShownProject(queryClient), [queryClient])

  // The service worker makes the phone app installable. Registered from here,
  // not an inline script, so the page's CSP allows only hashed inline scripts.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch(() => {})
    return watchOffline()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
