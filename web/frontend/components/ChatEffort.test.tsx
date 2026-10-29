import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatRoot } from '../../../electron/shared/chat/chat-view'
import type {
  ChatCallResult,
  ChatTransport,
} from '../../../electron/shared/chat/types'

const model = (id: string, caps: Record<string, unknown>) => ({
  id,
  name: id,
  alias: id,
  provider: 'p',
  routable: true,
  capabilities: caps,
})

const CATALOG = [
  model('claude', {
    has_thinking: true,
    supports_xhigh: true,
    thinking_level_map: { minimal: 'low' },
  }),
  model('deepseek', {
    has_thinking: true,
    supports_xhigh: false,
    thinking_level_map: {
      low: 'low',
      high: 'high',
      medium: null,
      minimal: null,
      xhigh: null,
    },
  }),
  model('plain', { has_thinking: false, supports_xhigh: false }),
]

function transport(restored: string[] = []) {
  const calls: [string, Record<string, unknown>][] = []
  const value: ChatTransport = {
    call: async (method, args): Promise<ChatCallResult> => {
      calls.push([method, args])
      if (method === 'models') return { ok: true, value: CATALOG }
      if (method === 'session')
        return {
          ok: true,
          value: {
            id: 'hub-1',
            status: 'active',
            messages: [],
            turn_state: 'idle',
            agent_slug: 'coder',
          },
        }
      if (method === 'queue') return { ok: true, value: [] }
      if (method === 'cancel')
        return { ok: true, value: { cancelled: true, restored } }
      return { ok: true, value: { queued: false } }
    },
    openStream: async () => () => undefined,
  }
  return { value, calls }
}

const info = { sessionId: 'hub-1', agentSlug: 'coder', requestedModel: null }

function open(
  t: ChatTransport,
  extra: Partial<typeof info> & { answeredModel?: string } = {},
) {
  return render(
    <ChatRoot
      info={{ ...info, ...extra }}
      transport={t}
      recovery="Reopen the window."
    />,
  )
}

describe('the composer’s Effort select', () => {
  it('offers the levels the catalog allows the chosen model, and none for a model without reasoning', async () => {
    const { value } = transport()
    open(value)
    const model = await screen.findByLabelText('Model')
    expect(screen.queryByLabelText('Effort')).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /claude/ })).toBeTruthy(),
    )
    fireEvent.change(model, { target: { value: 'claude' } })
    const effort = await screen.findByLabelText('Effort')
    expect(
      [...(effort as HTMLSelectElement).options].map((o) => o.text),
    ).toEqual(['Default', 'Minimal', 'Low', 'Medium', 'High', 'Extra high'])
    fireEvent.change(model, { target: { value: 'deepseek' } })
    await waitFor(() =>
      expect(
        [...(screen.getByLabelText('Effort') as HTMLSelectElement).options].map(
          (o) => o.text,
        ),
      ).toEqual(['Default', 'Low', 'High']),
    )
    fireEvent.change(model, { target: { value: 'plain' } })
    await waitFor(() => expect(screen.queryByLabelText('Effort')).toBeNull())
  })

  it('sends the chosen level with the message, and none after the model stops taking it', async () => {
    const { value, calls } = transport()
    open(value)
    const model = await screen.findByLabelText('Model')
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /claude/ })).toBeTruthy(),
    )
    fireEvent.change(model, { target: { value: 'claude' } })
    fireEvent.change(await screen.findByLabelText('Effort'), {
      target: { value: 'ultrathink' },
    })
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.click(
      screen.getByRole('button', { name: /(Send|Queue) message/ }),
    )
    await waitFor(() => expect(calls.some(([m]) => m === 'send')).toBe(true))
    expect(calls.find(([m]) => m === 'send')?.[1]).toMatchObject({
      text: 'hello',
      model: 'claude',
      thinkingLevel: 'ultrathink',
    })
    // A model that does not take that level sends none.
    fireEvent.change(model, { target: { value: 'deepseek' } })
    await waitFor(() =>
      expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe(
        '',
      ),
    )
    fireEvent.change(box, { target: { value: 'again' } })
    fireEvent.click(
      screen.getByRole('button', { name: /(Send|Queue) message/ }),
    )
    await waitFor(() =>
      expect(calls.filter(([m]) => m === 'send')).toHaveLength(2),
    )
    expect(calls.filter(([m]) => m === 'send')[1]?.[1]).toMatchObject({
      thinkingLevel: null,
    })
  })

  it('follows the model Agent Hub reports when the agent routes', async () => {
    const { value } = transport()
    open(value, { answeredModel: 'deepseek' })
    const effort = await screen.findByLabelText('Effort')
    expect(
      [...(effort as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual(['', 'low', 'high'])
  })

  it('shows no Tools control', async () => {
    const { value } = transport()
    open(value)
    await screen.findByLabelText('Model')
    expect(screen.queryByLabelText(/tools/i)).toBeNull()
  })

  it('is hidden in a read-only step view', async () => {
    const { value } = transport()
    open(value, { readOnly: true } as never)
    await waitFor(() => expect(vi.isMockFunction(console.error)).toBe(false))
    expect(screen.queryByLabelText('Effort')).toBeNull()
    expect(screen.queryByLabelText('Model')).toBeNull()
  })
})
