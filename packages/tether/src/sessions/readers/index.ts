import type { HistoryTool, Reader } from '../types'
import { claudeReader } from './claude'
import { codexReader } from './codex'
import { piReader } from './pi'

export const READERS: Reader[] = [claudeReader, codexReader, piReader]

export function readerFor(tool: string): Reader | undefined {
  return READERS.find((reader) => reader.tool === (tool as HistoryTool))
}
