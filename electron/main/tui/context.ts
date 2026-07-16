// Universal context-injection engine. `ensureContext` dispatches on the
// declarative hook `kind` to a handler implemented ONCE here and shared by every
// TUI that declares that kind. New TUIs reuse a kind; only a genuinely new
// injection mechanism adds a handler. No per-tool injection code lives outside.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
    case 'pi-extension':
      return piExtension()
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

/** Codex: canonical context rides native SessionStart and SubagentStart hooks.
 * Ask Codex's own app-server for the EFFECTIVE hook registry instead of reading
 * a launcher or grepping config text: this proves both hooks are enabled,
 * trusted, and point directly at the canonical Agent Hub client. Native
 * additionalContext is additive developer context, unlike
 * model_instructions_file, which replaces Codex's built-in base instructions. */
async function codexHooks(): Promise<ContextStatus> {
  const launcher = await resolveLauncher('codex')
  if (!launcher) {
    return {
      state: 'missing',
      detail: 'codex not on the login-shell PATH — mandates will not inject',
    }
  }

  const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
  if (!existsSync(client)) {
    return { state: 'missing', detail: `${client} absent — canonical context cannot deliver` }
  }

  return new Promise((resolve) => {
    const child = execFile(
      launcher,
      ['app-server'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            state: 'missing',
            detail: `codex app-server hook check failed: ${stderr.trim() || error.message}`,
          })
          return
        }

        try {
          const messages = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
          const response = messages.find((message) => message.id === 1) as
            | { result?: { data?: Array<{ hooks?: Array<Record<string, unknown>> }> } }
            | undefined
          const hooks = response?.result?.data?.[0]?.hooks ?? []
          const expectedCommand = `${client} hook --surface codex`
          const required = ['sessionStart', 'subagentStart']
          const unhealthy = required.filter(
            (eventName) =>
              !hooks.some(
                (hook) =>
                  hook.eventName === eventName &&
                  hook.command === expectedCommand &&
                  hook.enabled === true &&
                  hook.trustStatus === 'trusted',
              ),
          )
          resolve(
            unhealthy.length === 0
              ? {
                  state: 'ok',
                  detail: `${launcher} has trusted native SessionStart + SubagentStart Agent Hub hooks`,
                }
              : {
                  state: 'missing',
                  detail: `Codex canonical hooks missing/untrusted: ${unhealthy.join(', ')}`,
                },
          )
        } catch (parseError) {
          resolve({
            state: 'missing',
            detail: `codex app-server returned unreadable hook state: ${String(parseError)}`,
          })
        }
      },
    )
    child.stdin?.end(
      [
        JSON.stringify({
          method: 'initialize',
          id: 0,
          params: { clientInfo: { name: 'aico', title: 'Aico', version: '0.1.1' } },
        }),
        JSON.stringify({ method: 'initialized', params: {} }),
        JSON.stringify({ method: 'hooks/list', id: 1, params: { cwds: [process.cwd()] } }),
        '',
      ].join('\n'),
    )
  })
}

/** Gemini CLI: canonical context rides BeforeAgent so the current prompt is
 * available and a failed delivery can block the turn. Verify Gemini's nested
 * native hook schema and the direct canonical-client command; legacy Aico
 * SessionStart shims are explicitly unhealthy because they can reinstall drift. */
function geminiHooks(): ContextStatus {
  const base = process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini')
  const config = join(base, 'settings.json')
  if (!existsSync(config)) {
    return { state: 'missing', detail: `${config} absent — mandates will not inject` }
  }
  try {
    const parsed = JSON.parse(readFileSync(config, 'utf8')) as {
      hooks?: {
        BeforeAgent?: Array<{ hooks?: Array<{ type?: string; command?: string }> }>
      }
    }
    const expected = `${join(homedir(), '.local', 'bin', 'agent-hub-context-client')} hook --surface gemini`
    const declared = parsed.hooks?.BeforeAgent?.some((group) =>
      group.hooks?.some((hook) => hook.type === 'command' && hook.command === expected),
    )
    const legacy = JSON.stringify(parsed).includes('aico-mandates-gemini.sh')
    return declared && !legacy
      ? { state: 'ok', detail: `${config} declares the canonical Gemini BeforeAgent hook` }
      : {
          state: 'missing',
          detail: `${config} lacks the canonical BeforeAgent hook or still contains the legacy Aico shim`,
        }
  } catch {
    return { state: 'missing', detail: `${config} is not readable JSON — mandates will not inject` }
  }
}

/** Pi loads source-controlled extensions from ~/.pi/agent/extensions. Verify
 * that the active entry resolves to Agent Hub's canonical adapter source and
 * that the adapter preserves Pi's native system prompt before appending the
 * delivered contract. */
function piExtension(): ContextStatus {
  const extension = join(homedir(), '.pi', 'agent', 'extensions', 'agent-hub.ts')
  const repo = process.env.AGENT_HUB_REPO || '/srv/workspaces/projects/agent-hub'
  const expected = join(repo, 'integrations', 'context-delivery', 'pi', 'agent-hub.ts')
  if (!existsSync(extension)) {
    return { state: 'missing', detail: `${extension} absent — canonical context cannot deliver` }
  }
  try {
    const body = readFileSync(extension, 'utf8')
    const canonical = realpathSync(extension) === expected
    const additive =
      body.includes('before_agent_start') &&
      body.includes('event.systemPrompt') &&
      body.includes('contract.rendered')
    return canonical && additive
      ? { state: 'ok', detail: `${extension} is the canonical additive Agent Hub extension` }
      : {
          state: 'missing',
          detail: `${extension} is drifted or does not preserve Pi's native system prompt`,
        }
  } catch {
    return { state: 'missing', detail: `${extension} is unreadable — cannot verify context` }
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
