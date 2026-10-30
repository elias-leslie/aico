// How a window names the device holding a session's shared size, worded the
// same on the desktop and the web app ("Sized for …").

/** Which app on which device holds the size; null when the claimer sent none. */
export interface SizeHolderViewer {
  app: string
  device: string
}

/** The device holding the size, as "Sized for …" names it. */
export function sizeHolderName(viewer: SizeHolderViewer | null | undefined): string {
  if (viewer?.app === 'desktop') return 'Aico desktop'
  return viewer?.device || 'another device'
}

/** The hint after "Sized for …" where there is room for it. */
export const SIZE_HOLDER_HINT = '. Type here to size it for this window.'
