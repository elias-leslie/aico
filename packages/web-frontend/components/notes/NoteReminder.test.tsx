import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NoteReminder } from './NoteReminder'

const at = new Date(2030, 0, 15, 9, 30).getTime()

describe('NoteReminder', () => {
  it('starts as a button; a picked time is sent, and an unfinished one is not', () => {
    const onChange = vi.fn()
    render(
      <NoteReminder remindAt={null} remindedAt={null} onChange={onChange} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remind me' }))
    const input = screen.getByLabelText('Reminder time')
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '2030-01-15T09:30' } })
    expect(onChange).toHaveBeenCalledWith(at)
  })

  it('shows the time set and removes it', () => {
    const onChange = vi.fn()
    render(<NoteReminder remindAt={at} remindedAt={null} onChange={onChange} />)
    expect(screen.getByLabelText('Reminder time')).toHaveProperty(
      'value',
      '2030-01-15T09:30',
    )
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove reminder' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('says when it was sent, and when a past time is about to go out', () => {
    const { rerender } = render(
      <NoteReminder
        remindAt={at}
        remindedAt={at + 60_000}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toMatch(/^Sent /)
    const past = Date.now() - 60_000
    rerender(
      <NoteReminder remindAt={past} remindedAt={null} onChange={vi.fn()} />,
    )
    expect(screen.getByRole('status').textContent).toBe('Sending soon')
  })

  it('cancelling an unsaved reminder goes back to the button', () => {
    render(
      <NoteReminder remindAt={null} remindedAt={null} onChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remind me' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove reminder' }))
    expect(screen.getByRole('button', { name: 'Remind me' })).toBeTruthy()
  })
})
