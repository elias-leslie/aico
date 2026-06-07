// Universal context-injection engine. `ensureContext` dispatches on the
// declarative hook `kind` to a handler implemented ONCE here and shared by every
// TUI that declares that kind. New TUIs reuse a kind; only a genuinely new
// injection mechanism adds a handler. No per-tool injection code lives outside.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ContextStatus, TuiSpec } from './spec'

/** Verify (not install) a TUI's mandate-injection hook before launch. */
export async function ensureContext(spec: TuiSpec): Promise<ContextStatus> {
  if (!spec.context) return { state: 'ok', detail: 'no context hook' }
  switch (spec.context.kind) {
    case 'claude-session-start':
      return claudeSessionStart()
    case 'codex-hooks':
      return codexHooks()
    case 'gemini-hooks':
      return geminiHooks()
    case 'hermes-shell-hooks':
      return hermesShellHooks()
  }
}

/** Resolve `name` the way a spawned agent pane actually will: through a LOGIN
 * shell, which sources the user's profile — where optional launcher-wrapper
 * dirs may be placed ahead of ~/.local/bin. Aico launches agents by typing
 * `env … name …` into a login-shell tmux pane, so a login shell IS the mechanism
 * that runs. Resolving via aico's OWN process.env.PATH instead would make the
 * badge hostage to however *aico* was started — e.g. another agent restarting it
 * from a shell without the wrapper dirs would flip a perfectly-injecting setup to
 * a false `missing`. This check only depends on the user's profile + the wrapper
 * install, both of which survive any aico restart. */
function resolveLauncher(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', `command -v -- ${name}`], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const path = stdout.trim()
      resolve(path && existsSync(path) ? path : null)
    })
  })
}

/** Claude Code (and any Claude-family TUI): two channels carry the mandate union,
 * and a healthy launch needs the second. (1) The host-provisioned SessionStart
 * hook emits context on stdout — but Claude Code hard-caps hook stdout (~10K) and
 * silently truncates the ~18K union, dropping rules before the model sees them.
 * (2) A local `claude` launcher wrapper can pass the full render via
 * `--append-system-prompt-file` (no cap). So `ok` requires BOTH the hook present
 * AND the `claude` that will run being the wrapper; a bare upstream `claude`
 * reports missing because mandates then inject only truncated. Symmetric with
 * codexHooks(): verify the launcher that runs, not a file that merely exists. */
async function claudeSessionStart(): Promise<ContextStatus> {
  const hook = join(homedir(), '.claude', 'hooks', 'SessionStart.sh')
  if (!existsSync(hook)) {
    return { state: 'missing', detail: `${hook} absent — mandates will not inject` }
  }
  const launcher = await resolveLauncher('claude')
  if (!launcher) {
    return {
      state: 'missing',
      detail: 'claude not on the login-shell PATH — mandates will not inject',
    }
  }
  let body: string
  try {
    body = readFileSync(launcher, 'utf8')
  } catch {
    body = '' // unreadable (e.g. a raw binary) → not the shell wrapper
  }
  return body.includes('--append-system-prompt-file')
    ? {
        state: 'ok',
        detail: `${launcher} injects the full mandate union via --append-system-prompt-file`,
      }
    : {
        state: 'missing',
        detail: `${launcher} does not pass --append-system-prompt-file — mandates inject only truncated via the capped SessionStart hook`,
      }
}

/** Codex: mandates do NOT ride a native SessionStart hook — `~/.codex/config.toml`
 * documents that deliberately ("Do not use SessionStart.additionalContext… Codex
 * records/renders that payload as a large developer item"). They ride the codex
 * launcher, which passes `model_instructions_file`, delegating to the shared
 * local runtime-context renderer (the same mechanism Claude Code can use).
 * So the canonical check is whether the launcher that will run actually wires
 * `model_instructions_file` — not a config key codex never reads for this. A
 * stock OpenAI shim (no wiring) correctly reports missing: mandates truly won't
 * inject through it. */
async function codexHooks(): Promise<ContextStatus> {
  const launcher = await resolveLauncher('codex')
  if (!launcher) {
    return {
      state: 'missing',
      detail: 'codex not on the login-shell PATH — mandates will not inject',
    }
  }
  let body: string
  try {
    body = readFileSync(launcher, 'utf8')
  } catch {
    return { state: 'missing', detail: `${launcher} unreadable — cannot verify mandate injection` }
  }
  return body.includes('model_instructions_file')
    ? { state: 'ok', detail: `${launcher} injects mandates via model_instructions_file` }
    : {
        state: 'missing',
        detail: `${launcher} does not wire model_instructions_file — mandates will not inject`,
      }
}

/** Gemini CLI: mandates ride a native SessionStart hook declared in
 * ~/.gemini/settings.json. The hook returns `hookSpecificOutput.additionalContext`,
 * which Gemini injects into interactive history at startup. Aico verifies that the
 * installed hook is the Aico mandate hook, not merely any SessionStart hook. */
function geminiHooks(): ContextStatus {
  const base = process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')
  const config = join(base, 'settings.json')
  if (!existsSync(config)) {
    return { state: 'missing', detail: `${config} absent — mandates will not inject` }
  }
  try {
    const parsed = JSON.parse(readFileSync(config, 'utf8')) as {
      hooks?: { SessionStart?: Array<{ command?: string }> }
    }
    const declared = parsed.hooks?.SessionStart?.some((h) =>
      h.command?.includes('aico-mandates-gemini.sh'),
    )
    return declared
      ? { state: 'ok', detail: `${config} declares the Aico SessionStart hook` }
      : {
          state: 'missing',
          detail: `${config} has no Aico SessionStart hook — mandates will not inject`,
        }
  } catch {
    return { state: 'missing', detail: `${config} is not readable JSON — mandates will not inject` }
  }
}

/** Hermes: mandates ride a native shell hook on `pre_llm_call`, declared in
 * ~/.hermes/config.yaml. Hermes expects `{"context": "..."}` from the script. */
function hermesShellHooks(): ContextStatus {
  const config = join(homedir(), '.hermes', 'config.yaml')
  if (!existsSync(config)) {
    return { state: 'missing', detail: `${config} absent — mandates will not inject` }
  }
  const body = readFileSync(config, 'utf8')
  const declared = /^[ \t]*hooks:[\s\S]*^[ \t]*pre_llm_call:[\s\S]*aico-mandates-hermes\.sh/m.test(
    body,
  )
  return declared
    ? { state: 'ok', detail: `${config} declares the Aico pre_llm_call hook` }
    : {
        state: 'missing',
        detail: `${config} has no Aico pre_llm_call hook — mandates will not inject`,
      }
}
