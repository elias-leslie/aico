import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePromptCleaner } from './use-prompt-cleaner'

describe('usePromptCleaner', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.NEXT_PUBLIC_AGENT_HUB_URL
  })

  function stubFetch() {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: 'cleaned' }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  function sentMessages(fetchSpy: ReturnType<typeof vi.fn>) {
    return JSON.parse(fetchSpy.mock.calls[0][1].body).messages
  }

  it('leaves the cleaning rules to the prompt-builder agent in Agent Hub', async () => {
    process.env.NEXT_PUBLIC_AGENT_HUB_URL = 'http://agent-hub.test'
    const fetchSpy = stubFetch()
    const { result } = renderHook(() => usePromptCleaner())

    let cleaned = ''
    await act(async () => {
      cleaned = await result.current.cleanPrompt('fix teh bug', 'shorter')
    })

    expect(cleaned).toBe('cleaned')
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.agent_slug).toBe('prompt-builder')
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: 'CURRENT PROMPT:\nfix teh bug\n\nREFINEMENT:\nshorter',
      },
    ])
  })

  it('asks for a plain clean-up when no refinement is given', async () => {
    process.env.NEXT_PUBLIC_AGENT_HUB_URL = 'http://agent-hub.test'
    const fetchSpy = stubFetch()
    const { result } = renderHook(() => usePromptCleaner())

    await act(async () => {
      await result.current.cleanPrompt('fix teh bug', '  ')
    })

    const [message] = sentMessages(fetchSpy)
    expect(message.role).toBe('user')
    expect(message.content).toMatch(
      /^CURRENT PROMPT:\nfix teh bug\n\nREFINEMENT:\nFix typos/,
    )
  })

  it('returns the draft unchanged when Agent Hub is not configured', async () => {
    const fetchSpy = stubFetch()
    const { result } = renderHook(() => usePromptCleaner())

    let cleaned = ''
    await act(async () => {
      cleaned = await result.current.cleanPrompt('  draft  ')
    })

    expect(cleaned).toBe('draft')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
