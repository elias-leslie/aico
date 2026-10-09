import type { ScrollbackPage } from '../types'
import {
  capturePageTargetArgs,
  paneScrollbackInfoTargetArgs,
  scrollbackPageBounds,
  type TmuxTarget,
} from './tmux'

const SCROLLBACK_PAGE_DEFAULT_LINES = 5000
const SCROLLBACK_PAGE_MAX_LINES = 5000

/** Runs one tmux argv and resolves its stdout. */
export type TmuxStdout = (args: string[], maxBuffer: number) => Promise<string>

export const EMPTY_SCROLLBACK_PAGE: Readonly<ScrollbackPage> = Object.freeze({
  fromLine: 0,
  totalLines: 0,
  historySize: 0,
  text: '',
})

export function scrollbackPageCount(input: unknown): number {
  const n = typeof input === 'number' ? input : SCROLLBACK_PAGE_DEFAULT_LINES
  if (!Number.isFinite(n)) return SCROLLBACK_PAGE_DEFAULT_LINES
  return Math.min(SCROLLBACK_PAGE_MAX_LINES, Math.max(1, Math.floor(n)))
}

export function scrollbackPageFromLine(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined
  return Math.max(0, Math.floor(input))
}

/** One page of a pane's history plus visible rows, from untrusted renderer input. */
export async function readScrollbackPage(
  tmux: TmuxStdout,
  target: TmuxTarget,
  request: unknown,
): Promise<ScrollbackPage> {
  const req =
    request && typeof request === 'object'
      ? (request as { fromLine?: unknown; count?: unknown; plain?: unknown })
      : {}
  const count = scrollbackPageCount(req.count)
  const requestedFromLine = scrollbackPageFromLine(req.fromLine)

  const info = await tmux(paneScrollbackInfoTargetArgs(target), 1024)
  const [historyRaw, heightRaw] = info.trim().split(/\s+/)
  const historySize = Number(historyRaw)
  const paneHeight = Number(heightRaw)
  const bounds = scrollbackPageBounds(historySize, paneHeight, count, requestedFromLine)
  if (!bounds) return { ...EMPTY_SCROLLBACK_PAGE }

  const plain = req.plain === true
  const text = await tmux(capturePageTargetArgs(target, bounds, { plain }), 16 * 1024 * 1024)
  return {
    fromLine: bounds.fromLine,
    totalLines: bounds.totalLines,
    historySize: Math.max(0, Math.floor(historySize) || 0),
    text,
  }
}
