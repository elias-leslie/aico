// Environment hygiene for tmux servers and every session Tether creates.
//
// tmux servers start from an allow-listed environment (never the daemon's or an
// app's full environment, and never an app's `.env`). Secrets in
// FILTERED_ENV_VARS are removed even if an operator allow-lists them.

/**
 * A-Term's filter (a_term/utils/tmux/core.py FILTERED_ENV_VARS), applied to
 * every session regardless of which app asked for it. Keep this a superset of
 * A-Term's set.
 */
export const FILTERED_ENV_VARS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'SECRET_KEY',
  'JWT_SECRET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'SLACK_TOKEN',
  'DISCORD_TOKEN',
])

/** Exact names a tmux server may inherit from the user manager. */
export const SERVER_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
])

/** The desktop session's variables. The daemon can start before the graphical
 * session imports them into the user manager (e.g. right after a reboot), so
 * they are read from the user manager at spawn time, not from the daemon. */
export const GRAPHICAL_ENV_VARS: readonly string[] = [
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
]

/** The graphical variables in `systemctl --user show-environment` output.
 * Values systemd had to quote (`$'...'`) are skipped rather than unescaped. */
export function parseGraphicalEnvironment(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const name = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (!GRAPHICAL_ENV_VARS.includes(name) || !value || value.startsWith("$'")) continue
    env[name] = value
  }
  return env
}

/** Prefixes a tmux server may inherit (locale and XDG base directories). */
export const SERVER_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_', 'XDG_']

/** Terminal nesting markers that would make tmux target the wrong server. */
const ALWAYS_DROPPED: ReadonlySet<string> = new Set([
  'TMUX',
  'TMUX_PANE',
  'TMUX_TMPDIR',
  'NO_COLOR',
])

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function allowed(name: string, extra: ReadonlySet<string>): boolean {
  return (
    SERVER_ENV_ALLOWLIST.has(name) ||
    extra.has(name) ||
    SERVER_ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

/** `TETHER_ENV_PASSTHROUGH=NAME,NAME` lets an operator add exact names. */
export function passthroughFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const names = (env.TETHER_ENV_PASSTHROUGH ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => ENV_NAME_RE.test(name))
  return new Set(names)
}

/**
 * The environment a new tmux server starts with. Values outside the allow-list,
 * filtered secrets and tmux nesting markers are dropped; terminal defaults that
 * Aico's tmux profile relies on are set.
 */
export function tmuxServerEnvironment(
  base: NodeJS.ProcessEnv,
  extraAllowed: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'string' || value.includes('\0')) continue
    if (!ENV_NAME_RE.test(name) || ALWAYS_DROPPED.has(name) || FILTERED_ENV_VARS.has(name)) continue
    if (allowed(name, extraAllowed)) env[name] = value
  }
  env.COLORTERM = 'truecolor'
  env.CLICOLOR = '1'
  if (!env.LANG || env.LANG === 'C') env.LANG = 'en_US.UTF-8'
  if (!env.LC_CTYPE || env.LC_CTYPE === 'C') env.LC_CTYPE = 'C.UTF-8'
  return env
}

/**
 * Per-session variables (pane markers, root launch intent) after the filter.
 * A caller cannot smuggle a filtered secret or a nesting marker through here.
 */
export function sessionEnvironment(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    if (!ENV_NAME_RE.test(name) || value.includes('\0')) {
      throw new Error(`invalid session environment variable: ${name}`)
    }
    if (FILTERED_ENV_VARS.has(name) || ALWAYS_DROPPED.has(name)) continue
    env[name] = value
  }
  return env
}

/**
 * argv prefix that replaces the user manager's environment with exactly `env`
 * (systemd-run services otherwise inherit the whole manager block).
 */
export function cleanEnvArgv(env: Record<string, string>): string[] {
  return [
    '/usr/bin/env',
    '-i',
    ...Object.entries(env)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`),
  ]
}
