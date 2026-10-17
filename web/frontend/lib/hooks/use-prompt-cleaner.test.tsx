import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePromptCleaner } from './use-prompt-cleaner'

const CLEAN_UP = /^Fix typos, grammar and punctuation/

describe('usePromptCleaner', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(content = 'cleaned') {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  async function cleanWith(prompt: string, refinement?: string) {
    const { result } = renderHook(() => usePromptCleaner())
    let cleaned = ''
    await act(async () => {
      cleaned = await result.current.cleanPrompt(prompt, refinement)
    })
    return { cleaned, error: result.current.error }
  }

  async function clean(prompt: string, refinement?: string) {
    return (await cleanWith(prompt, refinement)).cleaned
  }

  function sentBody(fetchSpy: ReturnType<typeof vi.fn>) {
    return JSON.parse(fetchSpy.mock.calls[0][1].body)
  }

  function refinementOf(content: string) {
    const [head, refinement] = content.split('\n\nREFINEMENT:\n')
    return { head, refinement }
  }

  it('leaves the cleaning rules to the prompt-builder agent in Agent Hub', async () => {
    const fetchSpy = stubFetch('  cleaned\n')

    expect(await clean('fix teh bug')).toBe('cleaned')

    const body = sentBody(fetchSpy)
    expect(body.agent_slug).toBe('prompt-builder')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    const { head, refinement } = refinementOf(body.messages[0].content)
    expect(head).toBe('CURRENT PROMPT:\nfix teh bug')
    expect(refinement).toMatch(CLEAN_UP)
  })

  it('still asks for the clean-up when refining the raw draft', async () => {
    const fetchSpy = stubFetch()

    await clean('fix teh bug', '  shorter ')

    const { refinement } = refinementOf(sentBody(fetchSpy).messages[0].content)
    expect(refinement).toMatch(CLEAN_UP)
    expect(refinement.endsWith('\nshorter')).toBe(true)
  })

  it('sends only the request when the draft is empty', async () => {
    const fetchSpy = stubFetch()

    await clean('  ', 'write a release checklist')

    expect(sentBody(fetchSpy).messages).toEqual([
      { role: 'user', content: 'write a release checklist' },
    ])
  })

  it('sends nothing when there is neither a draft nor a request', async () => {
    const fetchSpy = stubFetch()

    expect(await clean(' ', ' ')).toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps the draft and says why when the server has no Agent Hub', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'Agent Hub is not configured' }),
      }),
    )

    expect(await cleanWith('  draft  ')).toEqual({
      cleaned: 'draft',
      error: 'Agent Hub is not configured',
    })
  })
})
