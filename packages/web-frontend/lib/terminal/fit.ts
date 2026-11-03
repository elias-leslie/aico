import type { FitAddon } from '@xterm/addon-fit'
import { MIN_FIT_COLS, MIN_FIT_ROWS } from '../constants/terminal'

type Fit = Pick<InstanceType<typeof FitAddon>, 'fit' | 'proposeDimensions'>

/** The grid the container holds, or null while it is not laid out or too
 * small to be a terminal (see MIN_FIT_COLS). */
export function usableDimensions(
  addon: Pick<Fit, 'proposeDimensions'>,
): { cols: number; rows: number } | null {
  const dims = addon.proposeDimensions()
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows))
    return null
  if (dims.cols < MIN_FIT_COLS || dims.rows < MIN_FIT_ROWS) return null
  return { cols: dims.cols, rows: dims.rows }
}

/** Fit the terminal to its container unless the container is unusably small. */
export function fitTerminal(addon: Fit): boolean {
  if (!usableDimensions(addon)) return false
  addon.fit()
  return true
}
