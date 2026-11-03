import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blankSlateBase, forWorkspace, isBlankSlateRoot, supportsBlankSlate } from './blank-slate'
import { staticContextStatus } from './context'
import type { TuiSpec } from './spec'

const env = { HOME: '/home/fixture', TETHER_LIB_DIR: '/opt/tether' }
const blank = join(blankSlateBase(env), 'b8f2')
const tool = (slug: string, command: string[]) =>
  ({ slug, command, context: { kind: 'codex-hooks' } }) as unknown as TuiSpec

describe('Blank Slate', () => {
  it('is keyed on a direct child of the Blank Slate directory', () => {
    expect(isBlankSlateRoot(blank, env)).toBe(true)
    for (const root of [blankSlateBase(env), join(blank, 'nested'), '/srv/project', null])
      expect(isBlankSlateRoot(root, env)).toBe(false)
  })

  it('launches a supported tool through the launcher and keeps its other argv', () => {
    for (const slug of ['claude-code', 'codex', 'pi']) {
      const spec = tool(slug, [slug === 'claude-code' ? 'claude' : slug, '--approve'])
      const launched = forWorkspace(spec, blank, env)
      expect(launched.command).toEqual([
        '/opt/tether/scripts/aico-blank-slate',
        slug,
        ...spec.command.slice(1),
      ])
      expect(launched.context).toEqual({ kind: 'blank-slate' })
      expect(staticContextStatus(launched)?.state).toBe('not_applicable')
    }
  })

  it('leaves normal launches unchanged', () => {
    for (const slug of ['claude-code', 'codex', 'pi']) {
      const spec = tool(slug, [slug])
      expect(forWorkspace(spec, '/srv/project', env)).toBe(spec)
    }
    const shell = tool('shell', [])
    expect(forWorkspace(shell, blank, env)).toBe(shell)
    expect(forWorkspace(undefined, blank, env)).toBeUndefined()
    expect(supportsBlankSlate('antigravity')).toBe(false)
  })
})
