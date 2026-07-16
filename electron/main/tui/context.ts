// Universal context-injection engine. `ensureContext` dispatches on the
// declarative hook `kind` to a handler implemented ONCE here and shared by every
// TUI that declares that kind. New TUIs reuse a kind; only a genuinely new
// injection mechanism adds a handler. No per-tool injection code lives outside.

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { effectiveTuiPath } from './launch'
import type { ContextStatus, TuiSpec } from './spec'

/** Verify (not install) a TUI's mandate-injection hook before launch. */
export async function ensureContext(spec: TuiSpec): Promise<ContextStatus> {
  if (!spec.context) return { state: 'ok', detail: 'no context hook' }
  switch (spec.context.kind) {
    case 'claude-session-start':
      return claudeSessionStart(spec)
    case 'codex-hooks':
      return codexHooks(spec)
    case 'gemini-hooks':
      return geminiHooks()
    case 'pi-extension':
      return piExtension()
    case 'hermes-shell-hooks':
      return hermesShellHooks()
  }
}

/** Resolve `name` with the exact PATH inherited by the no-profile/no-RC pane.
 * No login shell participates in launch: Aico explicitly writes its service
 * PATH into each tmux session/respawn environment, and a TUI may override it
 * declaratively. The verifier must therefore use that same value rather than a
 * separately sourced profile that could resolve a launcher the pane cannot. */
function resolveLauncher(name: string, spec: TuiSpec): Promise<string | null> {
  const pathValue = effectiveTuiPath(spec)
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', 'command -v -- "$1"', 'aico-resolve-launcher', name],
      { env: { ...process.env, PATH: pathValue }, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const path = stdout.trim()
        resolve(path.startsWith('/') && existsSync(path) ? path : null)
      },
    )
  })
}

/** Claude Code: the source-linked launcher exposes exact canonical context as
 * one immutable additional-directory CLAUDE.md without replacing Claude's
 * native prompt. Claude preloads it for parent and spawned agents. Native
 * SessionStart/SubagentStart hooks bind that artifact to real IDs and block
 * direct-binary bypass; they do not inject a second, size-spilled copy. */
async function claudeSessionStart(spec: TuiSpec): Promise<ContextStatus> {
  const settings = join(homedir(), '.claude', 'settings.json')
  const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
  const repo = process.env.AGENT_HUB_REPO || '/srv/workspaces/projects/agent-hub'
  const expectedLauncher = join(repo, 'integrations', 'context-delivery', 'claude', 'launcher')
  if (!existsSync(settings) || !existsSync(client)) {
    return {
      state: 'missing',
      detail: `${settings} or ${client} absent — canonical context cannot deliver`,
    }
  }
  const launcher = await resolveLauncher('claude', spec)
  if (!launcher) {
    return {
      state: 'missing',
      detail: 'claude not on the managed pane PATH — mandates will not inject',
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    const expectedCommand = `${client} bind --surface claude_code`
    const hasHook = (event: string): boolean =>
      parsed.hooks?.[event]?.some((group) =>
        group.hooks?.some((hook) => hook.command === expectedCommand),
      ) ?? false
    const canonicalLauncher = realpathSync(launcher) === expectedLauncher
    const launcherBody = readFileSync(launcher, 'utf8')
    const additive =
      launcherBody.includes('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD') &&
      launcherBody.includes('"--add-dir"') &&
      launcherBody.includes('CLAUDE.md')
    if (canonicalLauncher && additive && hasHook('SessionStart') && hasHook('SubagentStart')) {
      return {
        state: 'ok',
        detail: `${launcher} injects lossless context and native hooks bind its session IDs`,
      }
    }
  } catch {
    // Fall through to the single fail-closed result below.
  }
  return {
    state: 'missing',
    detail: `${launcher} or Claude native hooks are drifted from canonical Agent Hub sources`,
  }
}

/** Codex: the source-linked launcher places exact canonical bytes in additive
 * developer_instructions; native hook output is not used because Codex spills
 * larger hook context to a truncated preview. Session/Subagent hooks only bind
 * the immutable delivery to real native IDs. Ask Codex's own app-server for the
 * effective registry so those audit hooks must also be enabled and trusted. */
async function codexHooks(spec: TuiSpec): Promise<ContextStatus> {
  const launcher = await resolveLauncher('codex', spec)
  if (!launcher) {
    return {
      state: 'missing',
      detail: 'codex not on the managed pane PATH — mandates will not inject',
    }
  }

  const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
  if (!existsSync(client)) {
    return { state: 'missing', detail: `${client} absent — canonical context cannot deliver` }
  }

  const codexConfigRepo = process.env.CODEX_CONFIG_REPO || '/srv/workspaces/projects/codex-config'
  const expectedLauncher = join(codexConfigRepo, 'bin', 'codex')
  try {
    const body = readFileSync(launcher, 'utf8')
    const executableBody = body
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    const canonicalLauncher = realpathSync(launcher) === expectedLauncher
    const additive =
      executableBody.includes('CODEX_REAL') &&
      executableBody.includes('developer_instructions=') &&
      executableBody.includes('AGENT_HUB_CONTEXT_CLIENT') &&
      !executableBody.includes('model_instructions_file') &&
      !executableBody.includes('runtime-context-startup')
    if (!canonicalLauncher || !additive) {
      return {
        state: 'missing',
        detail: `${launcher} is not the canonical lossless additive Codex launcher`,
      }
    }
  } catch {
    return { state: 'missing', detail: `${launcher} is unreadable — cannot verify Codex launcher` }
  }

  return new Promise((resolve) => {
    const child = spawn(launcher, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (status: ContextStatus): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(status)
    }
    const inspectLines = (): void => {
      for (;;) {
        const newline = stdout.indexOf('\n')
        if (newline < 0) return
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (!line) continue
        let response: {
          id?: number
          result?: { data?: Array<{ hooks?: Array<Record<string, unknown>> }> }
        }
        try {
          response = JSON.parse(line) as typeof response
        } catch {
          continue
        }
        if (response.id !== 1) continue
        const hooks = response.result?.data?.[0]?.hooks ?? []
        const expectedCommand = `${client} bind --surface codex`
        const unhealthy = ['sessionStart', 'subagentStart'].filter(
          (eventName) =>
            !hooks.some(
              (hook) =>
                hook.eventName === eventName &&
                hook.command === expectedCommand &&
                hook.enabled === true &&
                hook.trustStatus === 'trusted',
            ),
        )
        finish(
          unhealthy.length === 0
            ? {
                state: 'ok',
                detail: `${launcher} injects lossless context and has trusted native session bindings`,
              }
            : {
                state: 'missing',
                detail: `Codex canonical hooks missing/untrusted: ${unhealthy.join(', ')}`,
              },
        )
        return
      }
    }
    const timer = setTimeout(
      () =>
        finish({
          state: 'missing',
          detail: `codex app-server hook check timed out: ${stderr.trim() || 'no response'}`,
        }),
      5000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      inspectLines()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ state: 'missing', detail: `codex app-server hook check failed: ${error.message}` })
    })
    child.on('close', () => {
      if (!settled) {
        finish({
          state: 'missing',
          detail: `codex app-server closed before hook state: ${stderr.trim() || 'no response'}`,
        })
      }
    })
    child.stdin.write(
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

/** Gemini CLI: canonical context rides BeforeModel so exact bytes are appended
 * to the stable request without angle-bracket escaping. Verify Gemini's nested
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
        BeforeModel?: Array<{ hooks?: Array<{ type?: string; command?: string }> }>
      }
    }
    const expected = `${join(homedir(), '.local', 'bin', 'agent-hub-context-client')} hook --surface gemini`
    const declared = parsed.hooks?.BeforeModel?.some((group) =>
      group.hooks?.some((hook) => hook.type === 'command' && hook.command === expected),
    )
    const legacy = JSON.stringify(parsed).includes('aico-mandates-gemini.sh')
    return declared && !legacy
      ? { state: 'ok', detail: `${config} declares the canonical Gemini BeforeModel hook` }
      : {
          state: 'missing',
          detail: `${config} lacks the canonical BeforeModel hook or still contains the legacy Aico shim`,
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
      body.includes('pi.on("input"') &&
      body.includes('action: "continue"') &&
      body.includes('before_agent_start') &&
      body.includes('event.systemPrompt') &&
      body.includes('contract.rendered') &&
      body.includes('AH: DEGRADED')
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
