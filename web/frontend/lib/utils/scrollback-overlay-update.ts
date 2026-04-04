interface ShouldDeferScrollbackOverlayWriteArgs {
  hasScrolled: boolean
  isAtBottom: boolean
}

export function shouldDeferScrollbackOverlayWrite({
  hasScrolled,
  isAtBottom,
}: ShouldDeferScrollbackOverlayWriteArgs): boolean {
  return hasScrolled && !isAtBottom
}

interface ShouldFlushPendingScrollbackOverlayWriteArgs {
  hasPendingLines: boolean
  isAtBottom: boolean
}

export function shouldFlushPendingScrollbackOverlayWrite({
  hasPendingLines,
  isAtBottom,
}: ShouldFlushPendingScrollbackOverlayWriteArgs): boolean {
  return hasPendingLines && isAtBottom
}
