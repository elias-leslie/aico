import { describe, expect, it } from 'vitest'
import { terminalShouldTakeFocus } from './terminal-focus'

describe('terminal focus on window focus', () => {
  const body = {} as HTMLElement
  it('takes focus when nothing in the window holds it', () => {
    expect(terminalShouldTakeFocus({ activeElement: null, body })).toBe(true)
    expect(terminalShouldTakeFocus({ activeElement: body, body })).toBe(true)
  })

  it('leaves focus with another control', () => {
    const input = {} as Element
    expect(terminalShouldTakeFocus({ activeElement: input, body })).toBe(false)
  })
})
