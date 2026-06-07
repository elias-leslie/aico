import type { TuiSpec } from './spec'

const BASE_TUI_ENV = {
  COLORTERM: 'truecolor',
  CLICOLOR: '1',
} as const

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}

/** The shell line typed into a freshly-created session to launch the TUI, or
 * null for a bare shell (empty command). Any per-TUI env is exported inline so
 * it applies to the launched process. Universal — never branches on slug. */
export function launchLine(spec: TuiSpec): string | null {
  if (spec.command.length === 0) return null
  const env = { ...BASE_TUI_ENV, ...(spec.env ?? {}) }
  const prefix = [
    'env',
    '-u',
    'NO_COLOR',
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
  ]
  return [...prefix, ...spec.command.map(shellQuote)].join(' ')
}
