'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  APP_THEME_STORAGE_KEY,
  type AppThemePreference,
  getThemeColor,
  type ResolvedAppTheme,
  resolveAppTheme,
  sanitizeAppThemePreference,
} from '@/lib/app-theme'
import { useLocalStorageState } from './use-local-storage-state'

interface AppThemeContextValue {
  themePreference: AppThemePreference
  resolvedTheme: ResolvedAppTheme
  setThemePreference: (theme: AppThemePreference) => void
}

const AppThemeContext = createContext<AppThemeContextValue | null>(null)

function applyResolvedTheme(theme: ResolvedAppTheme) {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', getThemeColor(theme))
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [storedPreference, setStoredPreference] =
    useLocalStorageState<AppThemePreference>(APP_THEME_STORAGE_KEY, 'system')
  const themePreference = sanitizeAppThemePreference(storedPreference)
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true,
  )

  useEffect(() => {
    if (storedPreference !== themePreference) {
      setStoredPreference(themePreference)
    }
  }, [setStoredPreference, storedPreference, themePreference])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const updatePreference = () => {
      setPrefersDark(mediaQuery.matches)
    }

    updatePreference()
    mediaQuery.addEventListener('change', updatePreference)
    return () => mediaQuery.removeEventListener('change', updatePreference)
  }, [])

  const resolvedTheme = resolveAppTheme(themePreference, prefersDark)

  useEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  const setThemePreference = useCallback(
    (theme: AppThemePreference) => {
      setStoredPreference(theme)
    },
    [setStoredPreference],
  )

  const value = useMemo<AppThemeContextValue>(
    () => ({
      themePreference,
      resolvedTheme,
      setThemePreference,
    }),
    [resolvedTheme, setThemePreference, themePreference],
  )

  return (
    <AppThemeContext.Provider value={value}>
      {children}
    </AppThemeContext.Provider>
  )
}

export function useAppTheme() {
  const context = useContext(AppThemeContext)
  if (!context) {
    throw new Error('useAppTheme must be used within AppThemeProvider')
  }
  return context
}
