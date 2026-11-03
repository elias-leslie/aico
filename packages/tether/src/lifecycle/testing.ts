// Test support for the ported Aico suites. Aico opened its catalog by path
// (`initStore`) and enumerated TUIs in code (`registerBuiltinTuis`); in Tether
// src/store.ts owns the schema and the seeded `agent_tools` rows are the
// registry.
import { Store } from '../store'
import { DEFAULT_TOOLS } from '../tools'
import { bindCatalog } from './catalog'
import { bindToolSource, toolSpec } from './tui/registry'
import type { TuiSpec } from './tui/spec'

let current: Store | null = null

export function initStore(dbPath: string): Store {
  current?.close()
  current = new Store(dbPath)
  bindCatalog(current.db)
  bindToolSource(current)
  return current
}

/** Bind the seeded tool registry (an in-memory store) when no catalog is open. */
export function registerBuiltinTuis(): void {
  if (!current) bindToolSource(new Store(':memory:'))
}

function seeded(slug: string): TuiSpec {
  const seed = DEFAULT_TOOLS.find((tool) => tool.slug === slug)
  if (!seed) throw new Error(`no seeded tool ${slug}`)
  return toolSpec({
    ...seed,
    id: slug,
    command: seed.argv.join(' '),
    createdAt: 0,
    updatedAt: 0,
  })
}

export const codexTui = seeded('codex')
export const claudeCodeTui = seeded('claude-code')
export const shellTui = seeded('shell')
