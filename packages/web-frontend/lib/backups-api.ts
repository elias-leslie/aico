// The Backups routes the page and the Panel's glance both call.

export async function backupsApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  ).catch(() => {
    throw new Error('Aico is not answering.')
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(
      value.detail || value.error || `Aico answered ${response.status}.`,
    )
  return value as T
}
