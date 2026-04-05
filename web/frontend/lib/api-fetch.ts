import { buildApiUrl } from './api-config'

/**
 * Fetch wrapper with standard error handling for A-Term API calls.
 * Parses error details from JSON responses and throws with the detail message.
 */
export async function apiFetch<T>(
  url: string,
  options?: RequestInit,
  defaultError = 'Request failed',
): Promise<T> {
  const res = await fetch(buildApiUrl(url), options)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: defaultError }))
    throw new Error(error.detail || defaultError)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}
