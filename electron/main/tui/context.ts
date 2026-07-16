// Universal supplemental-context verifier. `ensureContext` dispatches on the
// declarative hook `kind` to a handler implemented ONCE here and shared by every
// TUI that declares that kind. New TUIs reuse a kind; only a genuinely new
// delivery mechanism adds a handler. No per-tool verification code lives outside.

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { effectiveTuiPath } from './launch'
import type { ContextStatus, TuiSpec } from './spec'

interface ContextProbe {
  cwd?: string
  session?: string
}

/** Verify (not install) a TUI's supplemental-context path after native launch.
 * The result drives visible status only; it never gates pane dispatch. */
export async function ensureContext(
  spec: TuiSpec,
  probe: ContextProbe = {},
): Promise<ContextStatus> {
  if (!spec.context) return { state: 'ok', detail: 'no context hook' }
  let installed: ContextStatus
  switch (spec.context.kind) {
    case 'claude-session-start':
      installed = await claudeSessionStart(spec)
      break
    case 'codex-hooks':
      installed = await codexHooks(spec)
      break
    case 'gemini-hooks':
      installed = geminiHooks()
      break
    case 'pi-extension':
      installed = piExtension()
      break
    case 'hermes-shell-hooks':
      return hermesShellHooks()
  }
  if (installed.state !== 'ok') return installed
  const surface =
    spec.context.kind === 'claude-session-start'
      ? 'claude_code'
      : spec.context.kind === 'codex-hooks'
        ? 'codex'
        : spec.context.kind === 'gemini-hooks'
          ? 'gemini'
          : 'pi'
  return verifyLiveDelivery(surface, installed.detail, probe)
}

/** A green badge means the source-owned chain and live delivery availability
 * were verified by an independent probe. It does not prove what an already-
 * running native session received. This observability probe runs after pane
 * dispatch; failure returns degraded status but never stops the model. */
function verifyLiveDelivery(
  surface: string,
  installedDetail: string,
  probe: ContextProbe,
): Promise<ContextStatus> {
  const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
  const args = [
    'deliver',
    '--surface',
    surface,
    '--cwd',
    probe.cwd ?? process.cwd(),
    '--phase',
    'aico_status',
    '--emit',
    'descriptor',
  ]
  if (probe.session) args.push('--session', probe.session)
  return new Promise((resolve) => {
    execFile(client, args, { timeout: 20000 }, (error, stdout, stderr) => {
      try {
        const descriptor = JSON.parse(stdout) as { status?: unknown; payload_hash?: unknown }
        if (
          !error &&
          descriptor.status === 'ok' &&
          typeof descriptor.payload_hash === 'string' &&
          /^[0-9a-f]{64}$/.test(descriptor.payload_hash)
        ) {
          resolve({
            state: 'ok',
            detail: `${installedDetail}; live delivery available ${descriptor.payload_hash.slice(0, 8)}`,
          })
          return
        }
      } catch {
        // Use the single degraded result below.
      }
      const detail = stderr.trim() || error?.message || 'invalid delivery descriptor'
      resolve({
        state: 'missing',
        detail: `Agent Hub live delivery unavailable or unconfirmed; native model continues (${detail})`,
      })
    })
  })
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
 * SessionStart/SubagentStart hooks bind that artifact to real IDs and warn on
 * degraded delivery; they do not block native launch or inject a second copy. */
async function claudeSessionStart(spec: TuiSpec): Promise<ContextStatus> {
  const settings = join(homedir(), '.claude', 'settings.json')
  const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
  const repo = process.env.AGENT_HUB_REPO || '/srv/workspaces/projects/agent-hub'
  const expectedLauncher = join(repo, 'integrations', 'context-delivery', 'claude', 'launcher')
  const claudeConfigRepo =
    process.env.CLAUDE_CONFIG_REPO || '/srv/workspaces/projects/claude-config'
  const expectedGptLauncher = join(claudeConfigRepo, 'bin', 'claude-gpt')
  const expectedGptSettings = join(claudeConfigRepo, 'claude-gpt-settings.json')
  if (!existsSync(settings) || !existsSync(client)) {
    return {
      state: 'missing',
      detail: `${settings} or ${client} absent — canonical context cannot deliver`,
    }
  }
  const command = spec.command[0]
  const launcher = command ? await resolveLauncher(command, spec) : null
  if (!launcher) {
    return {
      state: 'missing',
      detail: `${command || 'Claude command'} not on the managed pane PATH — Agent Hub context delivery is unavailable or unconfirmed; native Claude continues`,
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
    const resolved = realpathSync(launcher)
    const canonicalLauncher = resolved === expectedLauncher
    const gptTransport = resolved === expectedGptLauncher
    const canonicalEntry = join(homedir(), '.claude', 'bin', 'claude')
    const launcherBody = readFileSync(canonicalLauncher ? launcher : canonicalEntry, 'utf8')
    const additive =
      realpathSync(canonicalLauncher ? launcher : canonicalEntry) === expectedLauncher &&
      launcherBody.includes('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD') &&
      launcherBody.includes('"--add-dir"') &&
      launcherBody.includes('CLAUDE.md')
    let transportValid = canonicalLauncher
    if (gptTransport) {
      const transportBody = readFileSync(launcher, 'utf8')
      const gptSettings = join(homedir(), '.claude', 'claude-gpt-settings.json')
      const additionalSettings = JSON.parse(readFileSync(gptSettings, 'utf8')) as {
        hooks?: unknown
      }
      transportValid =
        realpathSync(gptSettings) === expectedGptSettings &&
        transportBody.includes('$' + '{HOME}/.claude/bin/claude') &&
        transportBody.includes('AGENT_HUB_CONTEXT_PROVIDER=openai') &&
        transportBody.includes('AGENT_HUB_CONTEXT_TRANSPORT_VARIANT=claude-gpt') &&
        !transportBody.includes('agent-hub-context-client') &&
        additionalSettings.hooks === undefined
    }
    if (transportValid && additive && hasHook('SessionStart') && hasHook('SubagentStart')) {
      return {
        state: 'ok',
        detail: `${launcher} reaches the canonical additive Claude launcher and native hooks bind its session IDs`,
      }
    }
  } catch {
    // Fall through to the single degraded result below.
  }
  return {
    state: 'missing',
    detail: `${launcher} or Claude native hooks are drifted from canonical Agent Hub sources`,
  }
}

/** Codex: on fresh threads the source-linked launcher places exact canonical
 * bytes in additive developer_instructions; native hook output is not used
 * because Codex spills larger hook context to a truncated preview. Native hooks
 * bind that fresh immutable delivery to real IDs. Resume/fork deliberately make
 * no fresh delivery or binding claim because Codex restores saved thread
 * context. Ask Codex's app-server for the effective hook registry too. */
async function codexHooks(spec: TuiSpec): Promise<ContextStatus> {
  const launcher = await resolveLauncher('codex', spec)
  if (!launcher) {
    return {
      state: 'missing',
      detail:
        'codex not on the managed pane PATH — Agent Hub context delivery is unavailable or unconfirmed; native Codex continues',
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
                detail: `${launcher} injects lossless context on fresh threads and has trusted native session bindings; resume/fork preserve saved native context without a fresh delivery`,
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
    return {
      state: 'missing',
      detail: `${config} absent — Agent Hub context delivery is unavailable or unconfirmed; native Gemini continues`,
    }
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
    return {
      state: 'missing',
      detail: `${config} is not readable JSON — Agent Hub context delivery is unavailable or unconfirmed; native Gemini continues`,
    }
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
