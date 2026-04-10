'use client'

import { type FormEvent, useState, useTransition } from 'react'
import { fetchAuthSession, loginWithPassword } from '@/lib/api/auth'

interface LoginScreenProps {
  authMode: 'none' | 'password' | 'proxy'
}

export function getNextPath(): string {
  if (typeof window === 'undefined') return '/'
  const params = new URLSearchParams(window.location.search)
  const next = params.get('next')
  if (!next) return '/'
  try {
    const target = new URL(next, window.location.origin)
    if (target.origin !== window.location.origin) return '/'
    const safePath = `${target.pathname}${target.search}${target.hash}`
    return safePath.startsWith('/login') ? '/' : safePath
  } catch {
    return '/'
  }
}

export function LoginScreen({ authMode }: LoginScreenProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    try {
      await loginWithPassword(password)
      window.location.replace(getNextPath())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    }
  }

  async function handleProxyRetry() {
    setError(null)
    try {
      const session = await fetchAuthSession()
      if (!session.authenticated) {
        setError(
          'Upstream identity was not available yet. Finish the proxy sign-in and retry.',
        )
        return
      }
      startTransition(() => {
        window.location.replace(getNextPath())
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access check failed')
    }
  }

  return (
    <div
      className="flex min-h-dvh items-center justify-center px-6 py-10"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <div
        className="w-full max-w-md rounded-[2rem] border px-6 py-7 shadow-[0_24px_72px_rgba(0,0,0,0.34)]"
        style={{
          borderColor: 'var(--term-border)',
          backgroundColor: 'var(--term-bg-surface)',
        }}
      >
        <div
          className="mb-4 inline-flex rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em]"
          style={{
            borderColor: 'var(--term-border-active)',
            color: 'var(--term-text-muted)',
          }}
        >
          A-Term access
        </div>
        <h1
          className="text-2xl font-semibold"
          style={{
            color: 'var(--term-text-primary)',
            fontFamily: 'var(--font-ui)',
          }}
        >
          Sign in
        </h1>
        <p
          className="mt-2 text-sm leading-6"
          style={{ color: 'var(--term-text-muted)' }}
        >
          {authMode === 'proxy'
            ? 'This deployment expects identity from a trusted reverse proxy before it unlocks the workspace.'
            : 'This A-Term instance protects browser access with a shared password.'}
        </p>

        {authMode === 'proxy' ? (
          <div
            className="mt-6 rounded-2xl border px-4 py-4 text-sm leading-6"
            style={{
              borderColor: 'var(--term-border)',
              color: 'var(--term-text-muted)',
              backgroundColor: 'var(--term-surface-overlay)',
            }}
          >
            Finish the upstream sign-in flow, then retry. A-Term will store the
            verified proxy identity in its session cookie and send you back to
            the requested page.
            <div className="mt-4">
              <button
                type="button"
                onClick={() => void handleProxyRetry()}
                className="rounded-xl px-4 py-2 text-sm font-medium"
                style={{
                  backgroundColor: 'var(--term-accent)',
                  color: 'var(--term-accent-foreground)',
                }}
              >
                Retry access check
              </button>
            </div>
          </div>
        ) : (
          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <label
              className="block text-sm"
              style={{ color: 'var(--term-text-muted)' }}
            >
              Workspace password
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-2 w-full rounded-xl border px-4 py-3 outline-none transition-colors"
                style={{
                  borderColor: 'var(--term-border)',
                  backgroundColor: 'var(--term-bg-elevated)',
                  color: 'var(--term-text-primary)',
                }}
              />
            </label>

            <button
              type="submit"
              disabled={!password || isPending}
              className="w-full rounded-xl px-4 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                backgroundColor: 'var(--term-accent)',
                color: 'var(--term-accent-foreground)',
              }}
            >
              {isPending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        {error ? (
          <div
            className="mt-4 rounded-2xl px-4 py-3 text-sm"
            style={{
              backgroundColor: 'var(--term-error-muted)',
              color: 'var(--term-error-text)',
            }}
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
