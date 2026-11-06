// The keys a repo's .st-check.toml may use. Anything else is an error naming the file, the key and
// the nearest valid key, so a misspelt or retired key never silently does nothing.

import type { TomlTable } from './toml'

/** A table's valid keys; `open` tables take any key (tool names, env vars) and `sub` nests. */
interface Shape {
  keys?: string[]
  sub?: Record<string, Shape>
  /** Every element of the array-of-tables key is checked against this shape. */
  each?: Record<string, Shape>
  open?: true
}

const stage: Shape = {
  keys: [
    'id',
    'argv',
    'cwd',
    'kind',
    'coverage',
    'required',
    'applicable',
    'reason',
    'quick',
    'quick_paths',
    'inputs',
    'exclude',
    'covered_by',
    'timeout_seconds',
    'evidence',
  ],
  sub: {
    evidence: {
      keys: [
        'format',
        'source',
        'path',
        'success_pattern',
        'failure_pattern',
        'executed_pattern',
        'not_applicable_tests',
      ],
      sub: { not_applicable_tests: { open: true } },
    },
  },
}

const SHAPE: Shape = {
  keys: ['native', 'paths', 'pytest', 'acceptance', 'deep', 'agent_context'],
  sub: {
    paths: { open: true },
    pytest: { keys: ['no_cov', 'workers'] },
    // agent_context belongs to another reader of this file.
    agent_context: { open: true },
    deep: { keys: ['stages'], each: { stages: { keys: ['id', 'argv', 'timeout_seconds'] } } },
    acceptance: {
      keys: ['env', 'pass_env', 'host_tools', 'pytest'],
      sub: {
        env: { open: true },
        pytest: {
          keys: ['working_directory', 'argv', 'setup', 'tools', 'services'],
          sub: { services: { open: true } },
        },
      },
    },
    native: {
      keys: [
        'schema_version',
        'locks',
        'paths',
        'environment_inputs',
        'legacy_tools',
        'tools',
        'environment',
        'stages',
      ],
      sub: { tools: { open: true }, environment: { open: true } },
      each: { stages: stage },
    },
  },
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/** The valid key a wrong one most likely meant: one it contains or sits inside, else the nearest spelling. */
function closestKey(wrong: string, valid: string[]): string | undefined {
  const inside = valid
    .filter((key) => wrong.includes(key) || key.includes(wrong))
    .sort((a, b) => b.length - a.length)[0]
  if (inside) return inside
  const [best] = valid.map((key) => ({ key, d: distance(wrong, key) })).sort((a, b) => a.d - b.d)
  return best && best.d <= Math.max(2, Math.floor(wrong.length / 3)) ? best.key : undefined
}

function walk(table: unknown, shape: Shape, where: string, file: string): string | undefined {
  if (typeof table !== 'object' || table === null || Array.isArray(table) || shape.open) return
  const valid = shape.keys ?? []
  for (const [key, value] of Object.entries(table)) {
    if (!valid.includes(key)) {
      const near = closestKey(key, valid)
      return `${file}: unknown key ${where ? `${where}.` : ''}${key}${near ? `; did you mean ${near}?` : `; valid keys here: ${valid.join(', ')}`}`
    }
    const child = `${where ? `${where}.` : ''}${key}`
    const each = shape.each?.[key]
    if (each) {
      for (const [i, item] of (Array.isArray(value) ? value : []).entries()) {
        const bad = walk(item, each, `${child}[${i}]`, file)
        if (bad) return bad
      }
    } else if (shape.sub?.[key]) {
      const bad = walk(value, shape.sub[key], child, file)
      if (bad) return bad
    }
  }
}

/** The error (naming file, key and nearest valid key) when the parsed config has a key nothing reads. */
export function unknownKey(data: TomlTable, file: string): string | undefined {
  return walk(data, SHAPE, '', file)
}
