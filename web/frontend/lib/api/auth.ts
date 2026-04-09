import { apiFetch } from '@/lib/api-fetch'

export interface AuthSessionResponse {
  enabled: boolean
  mode: 'none' | 'password' | 'proxy'
  authenticated: boolean
  identity: string | null
}

export function fetchAuthSession(): Promise<AuthSessionResponse> {
  return apiFetch<AuthSessionResponse>(
    '/api/auth/session',
    undefined,
    'Failed to load authentication status',
  )
}

export function loginWithPassword(
  password: string,
): Promise<AuthSessionResponse> {
  return apiFetch<AuthSessionResponse>(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    },
    'Sign-in failed',
  )
}

export function logoutSession(): Promise<AuthSessionResponse> {
  return apiFetch<AuthSessionResponse>(
    '/api/auth/logout',
    {
      method: 'POST',
    },
    'Sign-out failed',
  )
}
