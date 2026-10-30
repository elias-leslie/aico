import { arrowSequence, KEY_SEQUENCES } from './keyMappings'

/**
 * What the session needs to match an edit the phone keyboard made in the
 * hidden typing field. Lengths count characters (code points), as a line
 * editor's Backspace and arrows do.
 */
export interface TypingEdit {
  /** Arrows to send first: positive moves right, negative left. */
  move: number
  /** Backspaces to send after moving. */
  deletes: number
  /** Text to send after the backspaces. */
  insert: string
  /** Where the session's cursor ends up, in characters into `after`. */
  caret: number
}

export function charCount(text: string): number {
  return Array.from(text).length
}

/**
 * Diff the field before and after one input event. `caret` is where the
 * session's cursor is in `before`; `newCaret` is the field's caret in `after`.
 * The changed span is taken to reach both carets, so typing a repeated letter
 * edits at the caret and a replaced word is backspaced from its end.
 */
export function typingEdit(
  before: string,
  after: string,
  caret: number,
  newCaret: number,
): TypingEdit {
  const a = Array.from(before)
  const b = Array.from(after)
  const limit = Math.min(a.length, b.length, caret, newCaret)
  let prefix = 0
  while (prefix < limit && a[prefix] === b[prefix]) prefix++
  const suffixLimit = Math.min(
    a.length - Math.max(prefix, caret),
    b.length - Math.max(prefix, newCaret),
  )
  let suffix = 0
  while (
    suffix < suffixLimit &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++
  const removedEnd = a.length - suffix
  const insertEnd = b.length - suffix
  return {
    move: removedEnd - caret,
    deletes: removedEnd - prefix,
    insert: b.slice(prefix, insertEnd).join(''),
    caret: insertEnd,
  }
}

/** Left or right arrows for a caret move of `count` characters. */
export function caretMoves(count: number): string {
  if (count === 0) return ''
  return arrowSequence(count > 0 ? 'right' : 'left').repeat(Math.abs(count))
}

/** The keys that make the session's line match `edit`, before its text. */
export function editKeys(edit: TypingEdit): string {
  return caretMoves(edit.move) + KEY_SEQUENCES.BACKSPACE.repeat(edit.deletes)
}
