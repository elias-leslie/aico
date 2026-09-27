import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FullKeyboard } from './FullKeyboard'
import { ModifierProvider, useModifiers } from './ModifierContext'

const keyboardMocks = vi.hoisted(() => ({
  instances: [] as Array<{ options: { layoutName: string } }>,
}))

vi.mock('simple-keyboard', () => ({
  default: class {
    options: { layoutName: string }

    constructor(_element: HTMLElement, options: { layoutName: string }) {
      this.options = { layoutName: options.layoutName }
      keyboardMocks.instances.push(this)
    }

    setOptions(options: { layoutName?: string }) {
      Object.assign(this.options, options)
    }

    destroy() {}
  },
}))

function ModifierControls() {
  const { toggleModifier, resetModifiers } = useModifiers()
  return (
    <>
      <button onClick={() => toggleModifier('shift')}>Shift</button>
      <button onClick={resetModifiers}>Consume Shift</button>
    </>
  )
}

describe('FullKeyboard', () => {
  it('returns to lowercase after another keyboard control consumes Shift', () => {
    keyboardMocks.instances.length = 0
    render(
      <ModifierProvider>
        <FullKeyboard onSend={vi.fn()} />
        <ModifierControls />
      </ModifierProvider>,
    )
    const keyboard = keyboardMocks.instances[0]

    fireEvent.click(screen.getByRole('button', { name: 'Shift' }))
    expect(keyboard.options.layoutName).toBe('shift')

    fireEvent.click(screen.getByRole('button', { name: 'Consume Shift' }))
    expect(keyboard.options.layoutName).toBe('default')
  })
})
