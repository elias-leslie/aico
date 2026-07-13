export interface AudioMediaPermissionRequest {
  permission: string
  trustedRenderer: boolean
  currentUrl: string
  requestingUrl: string
  isMainFrame: boolean
  mediaTypes: readonly string[] | undefined
}

function sameRendererDocument(requestingUrl: string, currentUrl: string): boolean {
  try {
    const requesting = new URL(requestingUrl)
    const current = new URL(currentUrl)
    if (current.protocol === 'file:') {
      return requesting.protocol === 'file:' && requesting.pathname === current.pathname
    }
    return requesting.origin === current.origin
  } catch {
    return false
  }
}

/** Allow only the Aico widget's main renderer frame to capture audio. */
export function allowTrustedAudioMedia(request: AudioMediaPermissionRequest): boolean {
  return (
    request.permission === 'media' &&
    request.trustedRenderer &&
    request.isMainFrame &&
    sameRendererDocument(request.requestingUrl, request.currentUrl) &&
    request.mediaTypes !== undefined &&
    request.mediaTypes.length > 0 &&
    request.mediaTypes.every((type) => type === 'audio')
  )
}
