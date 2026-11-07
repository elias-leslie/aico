// Sessions this browser just started. The one that starts a session is the one looking at it, so
// its view takes the size when nobody holds it, even when the server would otherwise leave an
// automated browser unsized (a headless test run, say).

const KEY = 'aico:created-here'
const created = new Set<string>()

function stored(): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function markCreatedHere(ids: readonly string[]): void {
  for (const id of ids) created.add(id)
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify([...stored(), ...ids].slice(-20)),
    )
  } catch {
    // Storage blocked: the memory copy still covers this page load.
  }
}

export function wasCreatedHere(id: string): boolean {
  return created.has(id) || stored().includes(id)
}
