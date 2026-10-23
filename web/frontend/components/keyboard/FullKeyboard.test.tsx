import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ControlBar } from './ControlBar'
import { FullKeyboard } from './FullKeyboard'
import { ModifierProvider } from './ModifierContext'

const keyboardMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    options: { layoutName: string }
    press: (button: string) => void
  }>,
}))

vi.mock('simple-keyboard', () => ({
  default: class {
    options: { layoutName: string }
    onKeyPress: (button: string) => void

    constructor(
      _element: HTMLElement,
      options: { layoutName: string; onKeyPress: (button: string) => void },
    ) {
      this.options = { layoutName: options.layoutName }
      this.onKeyPress = options.onKeyPress
      keyboardMocks.instances.push(this)
    }

    press(button: string) {
      this.onKeyPress(button)
    }

    setOptions(options: { layoutName?: string }) {
      Object.assign(this.options, options)
    }

    destroy() {}
  },
}))

describe('FullKeyboard', () => {
  it('sends backtab and returns to lowercase after custom Shift then utility Tab', () => {
    keyboardMocks.instances.length = 0
    const onSend = vi.fn()
    render(
      <ModifierProvider>
        <ControlBar onSend={onSend} />
        <FullKeyboard onSend={onSend} />
      </ModifierProvider>,
    )
    const keyboard = keyboardMocks.instances[0]

    act(() => keyboard.press('{shift}'))
    expect(keyboard.options.layoutName).toBe('shift')

    fireEvent.click(screen.getByRole('button', { name: 'Tab' }))
    expect(keyboard.options.layoutName).toBe('default')

    act(() => keyboard.press('a'))
    expect(onSend.mock.calls).toEqual([['\x1b[Z'], ['a']])
  })
})
