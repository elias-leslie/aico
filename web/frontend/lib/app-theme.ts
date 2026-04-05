export const APP_THEME_STORAGE_KEY = 'aterm-app-theme'

export const APP_THEME_COLORS = {
  dark: '#0a0e14',
  light: '#f3f7ef',
} as const

export const APP_THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const

export type AppThemePreference = (typeof APP_THEME_OPTIONS)[number]['value']
export type ResolvedAppTheme = keyof typeof APP_THEME_COLORS

export function isAppThemePreference(
  value: unknown,
): value is AppThemePreference {
  return value === 'system' || value === 'dark' || value === 'light'
}

export function sanitizeAppThemePreference(
  value: unknown,
): AppThemePreference {
  return isAppThemePreference(value) ? value : 'system'
}

export function resolveAppTheme(
  preference: AppThemePreference,
  prefersDark: boolean,
): ResolvedAppTheme {
  if (preference === 'system') {
    return prefersDark ? 'dark' : 'light'
  }
  return preference
}

export function getThemeColor(theme: ResolvedAppTheme): string {
  return APP_THEME_COLORS[theme]
}

export const APP_THEME_INIT_SCRIPT = `
(() => {
  const storageKey = ${JSON.stringify(APP_THEME_STORAGE_KEY)}
  const themeColors = ${JSON.stringify(APP_THEME_COLORS)}
  const root = document.documentElement

  let stored = 'system'
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      if (parsed === 'system' || parsed === 'dark' || parsed === 'light') {
        stored = parsed
      }
    }
  } catch {}

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const resolved = stored === 'system' ? (prefersDark ? 'dark' : 'light') : stored
  root.dataset.theme = resolved
  root.style.colorScheme = resolved

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', themeColors[resolved])
  }
})()
`.trim()
