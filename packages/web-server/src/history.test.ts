import { describe, expect, it } from 'vitest'
import { chatEvents } from './history'

const message = (role: string, content: unknown) => ({
  seq: 0,
  role,
  model: 'test-model',
  turn: 1,
  at: '2026-11-04T00:00:00Z',
  stop_reason: null,
  content,
  meta: {},
  outcome: null,
  input: null,
  cache_read: null,
  cache_write: null,
  output: null,
})
describe('retained chat history', () => {
  it('projects text, thinking, calls, results and image markers without exposing image data', () => {
    const page = chatEvents(
      [
        message('user', 'A question'),
        message('assistant', [
          { type: 'thinking', thinking: 'A thought' },
          { type: 'toolCall', name: 'read', arguments: { path: '/scratch/test' } },
        ]),
        message('toolResult', [{ type: 'text', text: 'A result' }]),
        message('user', [{ type: 'image', data: 'not-a-real-image' }]),
        message('assistant', [{ type: 'text', text: 'An answer' }]),
      ],
      {},
    )
    expect(page.items.map((e) => [e.offset, e.role, e.kind, e.text])).toEqual([
      [0, 'user', 'text', 'A question'],
      [1, 'assistant', 'thinking', 'A thought'],
      [2, 'assistant', 'tool_call', '{"path":"/scratch/test"}'],
      [3, 'tool', 'tool_result', 'A result'],
      [4, 'user', 'note', 'Image attachment'],
      [5, 'assistant', 'text', 'An answer'],
    ])
    expect(page.items[2].tool).toBe('read')
    expect(JSON.stringify(page)).not.toContain('not-a-real-image')
    expect(chatEvents([], {})).toEqual({ items: [], size: 0, older: null, newer: null })
  })

  it('hides known token shapes in retained messages', () => {
    const token = `ghp_${'Fake0123456789abcdefghijklmnopqrstuv'}`
    const page = chatEvents(
      [
        message('assistant', [
          { type: 'toolCall', name: 'bash', arguments: { command: `echo ${token}` } },
        ]),
      ],
      {},
    )
    expect(JSON.stringify(page)).not.toContain('Fake0123456789')
  })
})
