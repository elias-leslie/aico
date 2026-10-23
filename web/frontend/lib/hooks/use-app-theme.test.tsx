import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_THEME_COLORS,
  APP_THEME_STORAGE_KEY,
  resolveAppTheme,
  sanitizeAppThemePreference,
} from '@/lib/app-theme'
import { AppThemeProvider, useAppTheme } from './use-app-theme'

function installMatchMedia(matches: boolean) {
  let currentMatches = matches
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const mediaQuery = {
    get matches() {
      return currentMatches
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (
      _event: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      listeners.add(listener)
    },
    removeEventListener: (
      _event: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      listeners.delete(listener)
    },
  }

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => mediaQuery),
  })

  return {
    setMatches(next: boolean) {
      currentMatches = next
      for (const listener of listeners) {
        listener({ matches: next })
      }
    },
  }
}

function ThemeConsumer() {
  const { themePreference, resolvedTheme, setThemePreference } = useAppTheme()

  return (
    <div>
      <div data-testid="theme-preference">{themePreference}</div>
      <div data-testid="resolved-theme">{resolvedTheme}</div>
      <button type="button" onClick={() => setThemePreference('dark')}>
        dark
      </button>
      <button type="button" onClick={() => setThemePreference('light')}>
        light
      </button>
      <button type="button" onClick={() => setThemePreference('system')}>
        system
      </button>
    </div>
  )
}

describe('app theme utilities', () => {
  it('sanitizes invalid preferences to system', () => {
    expect(sanitizeAppThemePreference('light')).toBe('light')
    expect(sanitizeAppThemePreference('nope')).toBe('system')
    expect(sanitizeAppThemePreference(null)).toBe('system')
  })

  it('resolves system preference from matchMedia', () => {
    expect(resolveAppTheme('system', true)).toBe('dark')
    expect(resolveAppTheme('system', false)).toBe('light')
    expect(resolveAppTheme('dark', false)).toBe('dark')
    expect(resolveAppTheme('light', true)).toBe('light')
  })
})

describe('AppThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />'
  })

  it('uses system light preference by default', () => {
    installMatchMedia(false)

    render(
      <AppThemeProvider>
        <ThemeConsumer />
      </AppThemeProvider>,
    )

    expect(screen.getByTestId('theme-preference').textContent).toBe('system')
    expect(screen.getByTestId('resolved-theme').textContent).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe(APP_THEME_COLORS.light)
  })

  it('loads stored theme preference and persists updates', () => {
    installMatchMedia(false)
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, JSON.stringify('dark'))

    render(
      <AppThemeProvider>
        <ThemeConsumer />
      </AppThemeProvider>,
    )

    expect(screen.getByTestId('theme-preference').textContent).toBe('dark')
    expect(screen.getByTestId('resolved-theme').textContent).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe(APP_THEME_COLORS.dark)

    fireEvent.click(screen.getByRole('button', { name: 'light' }))

    expect(screen.getByTestId('theme-preference').textContent).toBe('light')
    expect(screen.getByTestId('resolved-theme').textContent).toBe('light')
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe(
      JSON.stringify('light'),
    )
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content'),
    ).toBe(APP_THEME_COLORS.light)
  })

  it('tracks system preference changes when set to system', () => {
    const media = installMatchMedia(true)

    render(
      <AppThemeProvider>
        <ThemeConsumer />
      </AppThemeProvider>,
    )

    expect(screen.getByTestId('resolved-theme').textContent).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: 'system' }))
    act(() => {
      media.setMatches(false)
    })

    expect(screen.getByTestId('theme-preference').textContent).toBe('system')
    expect(screen.getByTestId('resolved-theme').textContent).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
