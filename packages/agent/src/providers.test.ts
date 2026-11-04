// The provider allowlist: only the factories harness.json names are registered, Anthropic
// never, and Pi's credential store answers nothing for a provider outside the allowed set.
// No test here reads Pi's real credentials.

import type { CredentialStore } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { allowedModels, PiAuthStore } from './providers'

const noCredentials: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => undefined,
  delete: async () => {},
}

describe('allowedModels', () => {
  it('registers only the allowed providers', () => {
    const models = allowedModels(['openai'], noCredentials)
    expect(models.getProviders().map((provider) => provider.id)).toEqual(['openai'])
    expect(models.getModel('openai', 'gpt-6.1-sol')).toBeDefined()
    expect(models.getModels('anthropic')).toEqual([])
    expect(models.getModels('opencode-go')).toEqual([])
  })

  it('has no factory for Anthropic or any provider outside the list', () => {
    expect(() => allowedModels(['anthropic'], noCredentials)).toThrow(/no provider factory/)
    expect(() => allowedModels(['openai', 'google'], noCredentials)).toThrow(/google/)
  })
})

describe('PiAuthStore', () => {
  it('answers nothing for a provider outside the allowed set and never refreshes it', async () => {
    const refresh = vi.fn()
    const store = new PiAuthStore(new Set(['openai']), refresh)
    expect(await store.read('anthropic')).toBeUndefined()
    await expect(store.modify('anthropic')).rejects.toThrow(/not allowed/)
    expect(refresh).not.toHaveBeenCalled()
    await expect(store.delete()).rejects.toThrow(/log out with pi/)
  })
})
