// The prompt of `aico agent run --interactive`: one prompt per Enter, read from the terminal
// or from Tether's paste into the pane. A bracketed paste (ESC[200~ … ESC[201~) is one
// prompt however many lines it holds; the markers are dropped. null at end of input.

import { createInterface } from 'node:readline'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export type NextPrompt = () => Promise<string | null>

export function promptReader(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  mark = '› ',
): { next: NextPrompt; close(): void } {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY, terminal: false })[
    Symbol.asyncIterator
  ]()
  const next: NextPrompt = async () => {
    for (;;) {
      output.write(mark)
      const parts: string[] = []
      let pasting = false
      for (;;) {
        const line = await lines.next()
        if (line.done) {
          const rest = parts.join('\n').trim()
          return rest || null
        }
        let text = line.value
        if (text.includes(PASTE_START)) pasting = true
        if (text.includes(PASTE_END)) pasting = false
        text = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '')
        parts.push(text)
        if (!pasting) break
      }
      const prompt = parts.join('\n').trim()
      if (prompt) return prompt
    }
  }
  return { next, close: () => void lines.return?.() }
}
