import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentHubModelCache,
  getClaudeModelOptions,
  getPromptCleanerAgentSlug,
} from './agent-hub-models'
import { getAgentHubProxyUrl } from './agent-hub-proxy'

describe('agent-hub-models', () => {
  afterEach(() => {
    clearAgentHubModelCache()
    vi.restoreAllMocks()
  })

  it('derives Claude model picker options from the Agent Hub catalog', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            alias: 'opus',
            provider: 'claude',
          },
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            alias: 'sonnet',
            provider: 'claude',
          },
          {
            id: 'claude-haiku-4-5',
            name: 'Claude Haiku 4.5',
            alias: 'haiku',
            provider: 'claude',
          },
          {
            id: 'gemini-3-flash-preview',
            name: 'Gemini 3 Flash',
            alias: 'flash',
            provider: 'gemini',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(getClaudeModelOptions()).resolves.toEqual([
      { id: 'claude-opus-4-6', label: 'Opus', command: '/model opus\r' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet', command: '/model sonnet\r' },
      { id: 'claude-haiku-4-5', label: 'Haiku', command: '/model haiku\r' },
    ])

    expect(fetchSpy).toHaveBeenCalledWith('/api/agent-hub/models')
  })

  it('always goes through the proxy, whatever the build saw', () => {
    expect(getAgentHubProxyUrl('models')).toBe('/api/agent-hub/models')
    expect(getAgentHubProxyUrl('complete')).toBe('/api/agent-hub/complete')
  })

  it('uses the built-in aliases when the server has no Agent Hub', async () => {
    const consoleSpy = vi.spyOn(console, 'error')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    )

    expect((await getClaudeModelOptions()).map((o) => o.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
    ])
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('falls back to built-in Claude aliases when the catalog is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network unavailable')),
    )

    await expect(getClaudeModelOptions()).resolves.toEqual([
      { id: 'opus', label: 'Opus', command: '/model opus\r' },
      { id: 'sonnet', label: 'Sonnet', command: '/model sonnet\r' },
      { id: 'haiku', label: 'Haiku', command: '/model haiku\r' },
    ])
  })

  it('routes prompt cleaning through a fixed agent slug', () => {
    expect(getPromptCleanerAgentSlug()).toBe('prompt-builder')
  })
})
