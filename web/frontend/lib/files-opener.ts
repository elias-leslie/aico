/**
 * Opens the Files viewer from anywhere: the share notice, a share link from a
 * push, or a file path clicked in the terminal. The open session's view
 * registers the opener; with no session open there is nowhere to show it.
 */
export type FilesRequest =
  | { kind: 'shared'; showId?: string }
  | { kind: 'path'; path: string }

let opener: ((request: FilesRequest) => void) | null = null

export function setFilesOpener(
  next: ((request: FilesRequest) => void) | null,
): void {
  opener = next
}

/** False when no session view is open to show it. */
export function openFiles(request: FilesRequest): boolean {
  if (!opener) return false
  opener(request)
  return true
}
