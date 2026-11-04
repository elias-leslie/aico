// The pi-ai providers this harness may call: only the ones harness.json allows, built
// from this fixed list of factories. Anthropic is not in the list, so it can never be
// registered (Claude runs only through `claude -p`).
//
// Auth is Pi's own: credentials are the ones `pi /login` stored, read by Pi's
// readStoredCredential, and an expiring OAuth token is refreshed by `pi auth check`, which
// refreshes under Pi's lock and saves it. This code never reads, prints or logs a token.

import { spawnSync } from 'node:child_process'
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  MutableModels,
  Provider,
} from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { readStoredCredential } from '@earendil-works/pi-coding-agent'

const FACTORIES: Readonly<Record<string, () => Provider>> = {
  openai: openaiProvider,
  'opencode-go': opencodeGoProvider,
}

/** Pi's stored credentials, limited to the allowed providers. */
export class PiAuthStore implements CredentialStore {
  constructor(
    private readonly allowed: ReadonlySet<string>,
    /** Has Pi refresh the provider's OAuth token in its own store. */
    private readonly refresh: (providerId: string) => void = piRefresh,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return this.allowed.has(providerId) ? readStoredCredential(providerId) : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const out: CredentialInfo[] = []
    for (const providerId of this.allowed) {
      const credential = readStoredCredential(providerId)
      if (credential) out.push({ providerId, type: credential.type })
    }
    return out
  }

  /** pi-ai calls this only to refresh an expiring OAuth token: Pi does it and saves it. */
  async modify(providerId: string): Promise<Credential | undefined> {
    if (!this.allowed.has(providerId)) throw new Error(`provider ${providerId} is not allowed`)
    this.refresh(providerId)
    return readStoredCredential(providerId)
  }

  async delete(): Promise<void> {
    throw new Error('log out with pi, not through Aico')
  }
}

function piRefresh(providerId: string): void {
  const result = spawnSync('pi', ['auth', 'check', '--provider', providerId, '--json'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 60_000,
  })
  if (result.status !== 0)
    throw new Error(
      `pi auth check --provider ${providerId} failed (exit ${result.status ?? result.signal})`,
    )
}

/** A models collection holding only the allowed providers, with Pi's credentials. */
export function allowedModels(
  providerIds: Iterable<string>,
  credentials?: CredentialStore,
): MutableModels {
  const ids = new Set(providerIds)
  for (const id of ids) if (!FACTORIES[id]) throw new Error(`no provider factory for '${id}'`)
  const models = createModels({ credentials: credentials ?? new PiAuthStore(ids) })
  for (const id of ids) models.setProvider((FACTORIES[id] as () => Provider)())
  return models
}
