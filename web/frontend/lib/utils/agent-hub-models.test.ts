import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAgentHubModelCache,
  getClaudeModelOptions,
  getPromptCleanerModel,
} from './agent-hub-models'
import { getAgentHubProxyUrl, isAgentHubConfigured } from './agent-hub-proxy'

describe('agent-hub-models', () => {
  afterEach(() => {
    clearAgentHubModelCache()
    vi.restoreAllMocks()
    delete process.env.NEXT_PUBLIC_AGENT_HUB_URL
  })

  it('derives Claude model picker options from the Agent Hub catalog', async () => {
    process.env.NEXT_PUBLIC_AGENT_HUB_URL = 'http://agent-hub.test'
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', alias: 'opus', provider: 'claude' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', alias: 'sonnet', provider: 'claude' },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', alias: 'haiku', provider: 'claude' },
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', alias: 'flash', provider: 'gemini' },
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

  it('reports whether Agent Hub companion features are configured', () => {
    expect(isAgentHubConfigured()).toBe(false)
    expect(getAgentHubProxyUrl('models')).toBeNull()

    process.env.NEXT_PUBLIC_AGENT_HUB_URL = 'http://agent-hub.test'

    expect(isAgentHubConfigured()).toBe(true)
    expect(getAgentHubProxyUrl('models')).toBe('/api/agent-hub/models')
    expect(getAgentHubProxyUrl('complete')).toBe('/api/agent-hub/complete')
  })

  it('falls back to built-in Claude aliases when the catalog is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')))

    await expect(getClaudeModelOptions()).resolves.toEqual([
      { id: 'opus', label: 'Opus', command: '/model opus\r' },
      { id: 'sonnet', label: 'Sonnet', command: '/model sonnet\r' },
      { id: 'haiku', label: 'Haiku', command: '/model haiku\r' },
    ])
  })

  it('prefers the fastest Claude model for prompt cleaning', async () => {
    process.env.NEXT_PUBLIC_AGENT_HUB_URL = 'http://agent-hub.test'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', alias: 'opus', provider: 'claude' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', alias: 'sonnet', provider: 'claude' },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', alias: 'haiku', provider: 'claude' },
            { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', alias: 'flash', provider: 'gemini' },
          ],
        }),
      }),
    )
    

    await expect(getPromptCleanerModel()).resolves.toBe('claude-haiku-4-5')
  })
})
