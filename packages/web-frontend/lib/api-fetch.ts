/** A refused request: the server's detail as the message, plus the HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** A refusal that asking again won't change (4xx other than a timeout or rate limit). */
export function isPermanentRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  )
}

/**
 * Fetch wrapper with standard error handling for web app API calls.
 * Parses error details from JSON responses and throws with the detail message.
 */
export async function apiFetch<T>(
  url: string,
  options?: RequestInit,
  defaultError = 'Request failed',
): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: defaultError }))
    throw new ApiError(error.detail || defaultError, res.status)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}
