'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { AppThemeProvider } from '@/lib/hooks/use-app-theme'

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

  return (
    <AppThemeProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </AppThemeProvider>
  )
}
