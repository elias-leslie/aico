import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentHubServerUrl } from './agent-hub'
import { proxyAgentHubRequest } from './agent-hub-proxy'

vi.mock('./agent-hub', () => ({
  getAgentHubServerUrl: vi.fn(),
}))

describe('proxyAgentHubRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('names A-Term and its registered client to Agent Hub', async () => {
    vi.mocked(getAgentHubServerUrl).mockReturnValue('http://agent-hub.test')
    vi.stubEnv('AGENT_HUB_CLIENT_ID', ' 11111111-2222-3333-4444-555555555555 ')
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)

    await proxyAgentHubRequest({
      method: 'POST',
      path: '/api/complete',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    const sent = new Headers(fetchSpy.mock.calls[0][1].headers)
    expect(sent.get('x-request-source')).toBe('a-term')
    expect(sent.get('x-client-id')).toBe('11111111-2222-3333-4444-555555555555')
    expect(sent.get('content-type')).toBe('application/json')
  })

  it('sends no client id when none is configured', async () => {
    vi.mocked(getAgentHubServerUrl).mockReturnValue('http://agent-hub.test')
    vi.stubEnv('AGENT_HUB_CLIENT_ID', '')
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)

    await proxyAgentHubRequest({ method: 'GET', path: '/api/models' })

    const sent = new Headers(fetchSpy.mock.calls[0][1].headers)
    expect(sent.has('x-client-id')).toBe(false)
    expect(sent.get('x-request-source')).toBe('a-term')
  })

  it('returns 503 when Agent Hub is not configured', async () => {
    vi.mocked(getAgentHubServerUrl).mockReturnValue(null)

    const response = await proxyAgentHubRequest({
      method: 'GET',
      path: '/api/models',
    })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      detail: 'Agent Hub is not configured',
    })
  })

  it('returns successful upstream bodies unchanged', async () => {
    vi.mocked(getAgentHubServerUrl).mockReturnValue('http://agent-hub.test')
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ id: 'haiku' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const response = await proxyAgentHubRequest({
      method: 'GET',
      path: '/api/models',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://agent-hub.test/api/models',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
      }),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      models: [{ id: 'haiku' }],
    })
  })

  it('sanitizes upstream error responses instead of forwarding raw bodies', async () => {
    vi.mocked(getAgentHubServerUrl).mockReturnValue('http://agent-hub.test')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Traceback: secret stack' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    const response = await proxyAgentHubRequest({
      method: 'GET',
      path: '/api/models',
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      detail: 'Agent Hub is temporarily unavailable',
    })
  })

  it('forwards allowed headers for completion requests and hides network errors', async () => {
    vi.mocked(getAgentHubServerUrl).mockReturnValue('http://agent-hub.test')
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.9'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchSpy)

    const response = await proxyAgentHubRequest({
      method: 'POST',
      path: '/api/complete',
      body: '{"model":"haiku"}',
      headers: new Headers({
        'content-type': 'application/json',
        'x-source-client': 'a-term',
        'x-source-path': 'frontend/lib/hooks/use-prompt-cleaner.ts',
      }),
    })

    const call = fetchSpy.mock.calls[0]
    const forwardedHeaders = new Headers(call?.[1]?.headers)

    expect(forwardedHeaders.get('content-type')).toBe('application/json')
    expect(forwardedHeaders.get('x-source-client')).toBe('a-term')
    expect(forwardedHeaders.get('x-source-path')).toBe(
      'frontend/lib/hooks/use-prompt-cleaner.ts',
    )
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      detail: 'Failed to reach Agent Hub',
    })
  })
})
