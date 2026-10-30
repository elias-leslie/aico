// Terminal input handler type
export type TerminalInputHandler = (sequence: string) => void

// Sizes of the key row, in design pixels.
export const KEY_ROW_METRICS = {
  buttonSize: 44,
  iconSize: 18,
  keyGap: 4,
  paddingX: 4,
  paddingY: 6,
} as const

/**
 * Convert a design pixel value to a root-relative size.
 *
 * The accessory bar sits against the phone's own keyboard, whose size the OS
 * owns. Sizing the bar in rem lets the phone's text-scaling setting scale it
 * too, so the two stay in proportion; fixed pixels ignore that setting.
 */
export function remSize(px: number): string {
  return `${px / 16}rem`
}

/**
 * Keep the on-screen keyboard open when an accessory-bar key is pressed.
 *
 * A plain button takes focus on pointerdown, and losing focus on the input
 * dismisses the phone's keyboard -- so every tap on Esc or an arrow closed the
 * keyboard and the bar had to re-focus the input to bring it back, which reads
 * as a flicker. Preventing the default keeps focus, and the click still fires.
 */
export function keepKeyboardOpen(event: { preventDefault: () => void }): void {
  event.preventDefault()
}
