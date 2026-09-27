import type { ArrowDirection } from './keyMappings'

/** Move or extend the caret in a focused mobile compose draft. */
export function moveComposeCaret(
  input: HTMLInputElement | HTMLTextAreaElement,
  direction: ArrowDirection,
  shift: boolean,
): boolean {
  if (direction !== 'left' && direction !== 'right') return false
  const start = input.selectionStart
  const end = input.selectionEnd
  if (start === null || end === null || !input.value) return false

  if (!shift) {
    const position =
      start !== end
        ? direction === 'left'
          ? start
          : end
        : Math.max(
            0,
            Math.min(
              input.value.length,
              start + (direction === 'left' ? -1 : 1),
            ),
          )
    input.setSelectionRange(position, position)
    return true
  }

  const backward = input.selectionDirection === 'backward'
  const anchor = backward ? end : start
  const focus = backward ? start : end
  const next = Math.max(
    0,
    Math.min(input.value.length, focus + (direction === 'left' ? -1 : 1)),
  )
  input.setSelectionRange(
    Math.min(anchor, next),
    Math.max(anchor, next),
    next < anchor ? 'backward' : 'forward',
  )
  return true
}
