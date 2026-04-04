import { MOBILE_WIDTH_THRESHOLD } from '../constants/terminal'

/**
 * Check if we're on a mobile device (used for pull-to-refresh prevention)
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    ) || window.innerWidth < MOBILE_WIDTH_THRESHOLD
  )
}
