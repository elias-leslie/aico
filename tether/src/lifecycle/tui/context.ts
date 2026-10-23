// Supplemental-context installation checks. `ensureContext` dispatches on the
// declarative hook `kind` to a handler implemented ONCE here and shared by every
// TUI that declares that kind. New TUIs reuse a kind; only a genuinely new
// delivery mechanism adds a handler. No per-tool verification code lives outside.

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { currentPaneRefusal } from '../../pane-policy'
import { effectiveTuiPath } from './launch'
import type { ContextStatus, TuiSpec } from './spec'

/** A sibling checkout (agent-hub, codex-config): `$<override>` when set, else
 * `$TETHER_PROJECTS_DIR/<name>`. With neither set there is no guess (the old
 * `~/projects` default named a folder that need not exist); the caller shows
 * {@link unknownCheckout} instead. */
function checkout(override: string, name: string): string | null {
  const direct = process.env[override]
  if (direct) return direct
  const projects = process.env.TETHER_PROJECTS_DIR
  return projects ? join(projects, name) : null
}

function agentHubRepo(): string | null {
  return checkout('AGENT_HUB_REPO', 'agent-hub')
}

function unknownCheckout(override: string, name: string): ContextStatus {
  return {
    state: 'missing',
    detail: `TETHER_PROJECTS_DIR is not set and neither is ${override}, so the ${name} checkout can't be found; native agent continues`,
  }
}

/** The answer for a TUI with no context hook, known without probing. */
export function staticContextStatus(spec: TuiSpec): ContextStatus | null {
  if (spec.context) return null
  return spec.command.length
    ? {
        state: 'unsupported',
        detail: 'No canonical context adapter is registered; native agent continues.',
      }
    : { state: 'not_applicable', detail: 'A bare shell has no model context.' }
}

/** Check installation availability only; model receipt is unverified.
 * The result drives visible status and never gates pane dispatch. */
export async function ensureContext(spec: TuiSpec): Promise<ContextStatus> {
  const fixed = staticContextStatus(spec)
  if (fixed || !spec.context) return fixed as ContextStatus
  switch (spec.context.kind) {
    case 'claude-session-start':
      return claudeSessionStart(spec)
    case 'codex-hooks':
      return codexHooks(spec)
    case 'pi-extension':
      return piExtension()
    case 'canonical-retrieval':
      return canonicalRetrieval(spec.context.surface)
  }
}

/** Reuse the canonical installer's registration/link checks for retrieval clients. */
function canonicalRetrieval(surface: 'antigravity'): Promise<ContextStatus> {
  const repo = agentHubRepo()
  if (!repo) return Promise.resolve(unknownCheckout('AGENT_HUB_REPO', 'agent-hub'))
  return new Promise((resolve) => {
    execFile(
      'python3',
      [join(repo, 'integrations/context-delivery/install.py'), '--surface', surface, '--check'],
      { timeout: 20000 },
      (error, stdout) => {
        try {
          const result = JSON.parse(stdout) as { passed?: unknown }
          if (!error && result.passed === true) {
            resolve({
              state: 'available',
              detail:
                'Canonical retrieval rule installed; agent retrieval is required. Model receipt is unverified.',
            })
            return
          }
        } catch {
          // Failed installation checks remain visible and never block launch.
        }
        resolve({
          state: 'missing',
          detail:
            'Canonical retrieval rule installation is unavailable or unconfirmed; native agent continues',
        })
      },
    )
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
  const repo = agentHubRepo()
  if (!repo) return unknownCheckout('AGENT_HUB_REPO', 'agent-hub')
  const expectedLauncher = join(repo, 'integrations', 'context-delivery', 'claude', 'launcher')
  if (!existsSync(settings) || !existsSync(client)) {
    return {
      state: 'missing',
      detail: `${settings} or ${client} absent — canonical context installation is incomplete`,
    }
  }
  const command = spec.command[0]
  const launcher = command ? await resolveLauncher(command, spec) : null
  if (!launcher) {
    return {
      state: 'missing',
      detail: `${command || 'Claude command'} not on the managed pane PATH — canonical context launcher unavailable; native Claude continues`,
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    // The shared settings.json spells the client home-relative so every user's sessions bind.
    const expectedCommands = [
      `${client} bind --surface claude_code`,
      '"$HOME"/.local/bin/agent-hub-context-client bind --surface claude_code',
    ]
    const hasHook = (event: string): boolean =>
      parsed.hooks?.[event]?.some((group) =>
        group.hooks?.some((hook) => expectedCommands.includes(hook.command ?? '')),
      ) ?? false
    const resolved = realpathSync(launcher)
    const canonicalLauncher = resolved === expectedLauncher
    const launcherBody = readFileSync(launcher, 'utf8')
    const additive =
      launcherBody.includes('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD') &&
      launcherBody.includes('"--add-dir"') &&
      launcherBody.includes('CLAUDE.md')
    if (canonicalLauncher && additive && hasHook('SessionStart') && hasHook('SubagentStart')) {
      return {
        state: 'available',
        detail: `${launcher} reaches the canonical additive Claude launcher with native session binding hooks installed; model receipt is unverified`,
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
  const codexConfigRepo = checkout('CODEX_CONFIG_REPO', 'codex-config')
  if (!codexConfigRepo) return unknownCheckout('CODEX_CONFIG_REPO', 'codex-config')
  const launcher = await resolveLauncher('codex', spec)
  if (!launcher) {
    return {
      state: 'missing',
      detail:
        'codex not on the managed pane PATH — canonical context launcher unavailable; native Codex continues',
    }
  }

  const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
  if (!existsSync(client)) {
    return {
      state: 'missing',
      detail: `${client} absent — canonical context installation is incomplete`,
    }
  }

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

  // The daemon starts this Codex process itself, so the uid refusal covers it too.
  const uidRefusal = currentPaneRefusal()
  if (uidRefusal) return { state: 'missing', detail: uidRefusal }

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
        const expectedCommands = [
          `${client} bind --surface codex`,
          '$HOME/.local/bin/agent-hub-context-client bind --surface codex',
          '"$HOME"/.local/bin/agent-hub-context-client bind --surface codex',
        ]
        const unhealthy = ['sessionStart', 'subagentStart'].filter(
          (eventName) =>
            !hooks.some(
              (hook) =>
                hook.eventName === eventName &&
                expectedCommands.includes(String(hook.command ?? '')) &&
                hook.enabled === true &&
                hook.trustStatus === 'trusted',
            ),
        )
        finish(
          unhealthy.length === 0
            ? {
                state: 'available',
                detail: `${launcher} has the canonical lossless context launcher and trusted native session binding hooks installed; model receipt is unverified`,
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

/** SummitFlow's deployed Pi coordination extension: `$ST_PI_COORD_EXTENSION`,
 * else the current SummitFlow release under ~/.summitflow. */
function stCoordSource(): string {
  return (
    process.env.ST_PI_COORD_EXTENSION ||
    join(
      homedir(),
      '.summitflow/services/projects/summitflow/current/source/scripts/lib/pi-coord-extension.ts',
    )
  )
}

/** Null when ~/.pi/agent/extensions/st-coord.ts resolves to SummitFlow's
 * current extension, else what drifted. Installing it is SummitFlow's job. */
function stCoordDrift(): string | null {
  const link = join(homedir(), '.pi', 'agent', 'extensions', 'st-coord.ts')
  try {
    return realpathSync(link) === realpathSync(stCoordSource())
      ? null
      : `${link} does not resolve to SummitFlow's current ${stCoordSource()}`
  } catch {
    return `${link} or ${stCoordSource()} is missing`
  }
}

/** Pi loads source-controlled extensions from ~/.pi/agent/extensions. Verify
 * that the active entry resolves to Agent Hub's canonical adapter source and
 * that the adapter preserves Pi's native system prompt before appending the
 * delivered contract, and that SummitFlow's coordination extension has not
 * drifted from its current release. */
function piExtension(): ContextStatus {
  const extension = join(homedir(), '.pi', 'agent', 'extensions', 'agent-hub.ts')
  const repo = agentHubRepo()
  if (!repo) return unknownCheckout('AGENT_HUB_REPO', 'agent-hub')
  const expected = join(repo, 'integrations', 'context-delivery', 'pi', 'agent-hub.ts')
  if (!existsSync(extension)) {
    return {
      state: 'missing',
      detail: `${extension} absent — canonical context installation is incomplete`,
    }
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
    if (!canonical || !additive) {
      return {
        state: 'missing',
        detail: `${extension} is drifted or does not preserve Pi's native system prompt`,
      }
    }
    const drift = stCoordDrift()
    return drift
      ? { state: 'missing', detail: `${drift}; native Pi continues` }
      : {
          state: 'available',
          detail: `${extension}: canonical additive Agent Hub extension installed and st-coord.ts current; model receipt is unverified`,
        }
  } catch {
    return { state: 'missing', detail: `${extension} is unreadable — cannot verify context` }
  }
}

/** Run only after Tether has retired the exact owned workload. */
export function finalizeContext(
  spec: TuiSpec | undefined,
  ownershipId: string,
): Promise<boolean | null> {
  const surface = spec?.context?.kind === 'pi-extension' ? 'pi' : null
  if (!surface) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      join(homedir(), '.local', 'bin', 'agent-hub-context-client'),
      [`retire-${surface}`, '--surface', surface, '--aico-session', ownershipId],
      { timeout: 20000 },
      (error) => resolve(!error),
    )
  })
}
