// One `aico agent run`: the loop policy around pi-agent-core's Agent. The role rules pick
// the model chain and tools (or refuse); every message, tool call, handoff and compaction
// goes to agent.db as it happens. A refusal hands the same conversation to the next model
// in the chain with a short note; a provider error (not a refusal, not a tool error) hands
// that turn to the next model; a model swap stops the run. A run can be resumed, or
// branched at a turn, from agent.db, and Pi's compaction keeps a long one in the window.

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Database } from '@aico/store'
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import {
  type Api,
  type AssistantMessage,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  type Model,
  type Models,
} from '@earendil-works/pi-ai'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import {
  compact,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  getAgentDir,
  loadProjectContextFiles,
  shouldCompact,
} from '@earendil-works/pi-coding-agent'
import { type CompactionSettings, contextMessages, piCompaction } from './compaction'
import { type ModelRefusal, type ModelSwap, refusalOf, swapOf } from './outcomes'
import { allowedModels } from './providers'
import { type ChainModel, HARNESS, type Harness, type Refused, type RoleRules } from './rules'
import { credentialMarkers, guardBash, leanTools, touchesCredentials } from './tools'
import { type StoredRun, type Tokens, Transcript } from './transcript'

export type Outcome =
  | { kind: 'done'; model: string; text: string }
  | Refused
  | { kind: 'model_refused'; model: string; refusal: ModelRefusal }
  | ModelSwap
  | { kind: 'error'; model: string; detail: string }

export interface HandoffStat {
  from: string
  to: string
  /** The refusal category, or `provider_error` for a turn-level fallback. */
  reason: string
  handoff_tokens: number
  context_messages: number
  context_tokens: number
}

export interface RunResult {
  runId: string
  outcome: Outcome
  tokens: Tokens
  toolCalls: number
  wallMs: number
  handoffs: HandoffStat[]
  /** The model that answered each turn of this invocation, by the run's turn number. */
  turns: { turn: number; model: string; stop: string }[]
  compactions: number
}

export interface RunOptions {
  rules: RoleRules
  /** The prompt; null goes on from a resumed run whose last turn did not finish. */
  task: string | null
  cwd: string
  db: Database
  /** The id of a new run (Tether picks one); default a fresh UUID. */
  runId?: string
  /** Go on in this stored run. */
  resume?: StoredRun
  /** A new run with this stored run's conversation up to the end of turn `turn`. */
  branch?: { from: StoredRun; turn: number }
  /** Pi's compaction settings; default Pi's own. */
  compaction?: CompactionSettings
  /** Thinking level for every model; else each chain row's effort; else high. */
  effort?: string
  /** Test hook: the Nth provider request on the first model returns a synthetic refusal. */
  testRefuseAt?: number
  /** Test hook: this chain model is sent to an address that refuses connections. */
  testUnreachable?: string
  /** The provider collection; defaults to the allowed pi-ai providers with Pi's credentials. */
  models?: Models
  /** Project context files (AGENTS.md and the like); defaults to Pi's loader for `cwd`. */
  contextFiles?: { path: string; content: string }[]
  harness?: Harness
  log?: (line: string) => void
}

/** Where --test-unreachable sends a model: the discard port, which refuses connections. */
/** A base URL's host name, or the URL itself when it does not parse (never inside a profile). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return baseUrl
  }
}

const UNREACHABLE = 'http://127.0.0.1:9/v1'

const LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function thinking(model: Model<Api>, effort: string | null | undefined): ThinkingLevel {
  const wanted = LEVELS.includes(effort as ThinkingLevel) ? (effort as ThinkingLevel) : 'high'
  return clampThinkingLevel(model, wanted) as ThinkingLevel
}

export function systemPrompt(
  harness: Harness,
  cwd: string,
  contextFiles: { path: string; content: string }[],
): string {
  const parts = [harness.prompt.join('\n').replaceAll('{cwd}', cwd)]
  for (const { path, content } of contextFiles)
    parts.push(`<project_instructions path="${path}">\n${content}\n</project_instructions>`)
  return parts.join('\n\n')
}

const tokensOf = (messages: readonly AgentMessage[]) =>
  messages.reduce(
    (sum, message) => sum + (message.role === 'system' ? 0 : estimateTokens(message)),
    0,
  )

function syntheticRefusal(model: Model<Api>) {
  const stream = createAssistantMessageEventStream()
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: 'cyber_policy: synthetic refusal from the test hook (--test-refuse-at)',
    timestamp: Date.now(),
  }
  queueMicrotask(() => {
    stream.push({ type: 'error', reason: 'error', error: message })
    stream.end(message)
  })
  return stream
}

const lastAssistant = (messages: readonly AgentMessage[]) =>
  [...messages].reverse().find((message) => message.role === 'assistant') as
    | AssistantMessage
    | undefined

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')

export function handoffNote(from: string, to: string, refusal: ModelRefusal): string {
  return `[handoff] ${from} stopped with a ${refusal.category} refusal. You are ${to}: continue the task from this conversation; nothing above is lost.`
}

/** pi-ai's Claude wire protocol: never spoken by this harness, whichever provider serves it. */
const CLAUDE_API = 'anthropic-messages'

const usageTokens = (usage: AssistantMessage['usage'] | undefined): Tokens => ({
  input: usage?.input ?? 0,
  cache_read: usage?.cacheRead ?? 0,
  cache_write: usage?.cacheWrite ?? 0,
  output: usage?.output ?? 0,
})

export async function runAgent(options: RunOptions): Promise<RunResult> {
  const harness = options.harness ?? HARNESS
  const { rules, cwd, db } = options
  const log = options.log ?? (() => {})
  const settings = options.compaction ?? DEFAULT_COMPACTION_SETTINGS
  const started = Date.now()
  const transcript = options.resume
    ? Transcript.resume(db, options.resume.id)
    : options.branch
      ? Transcript.branch(
          db,
          options.branch.from,
          options.branch.turn,
          options.runId ?? randomUUID(),
          options.task ?? '',
        )
      : new Transcript(db, options.runId ?? randomUUID(), {
          role: rules.role,
          cwd,
          task: options.task ?? '',
          chain: rules.chain,
        })
  const runId = transcript.runId
  const totals: Tokens = { input: 0, cache_read: 0, cache_write: 0, output: 0 }
  const handoffs: HandoffStat[] = []
  const turns: RunResult['turns'] = []
  let compactions = 0
  let toolCalls = 0
  let inUse = rules.chain[0]?.id ?? ''
  const finish = (outcome: Outcome): RunResult => {
    const wallMs = Date.now() - started
    const detail = outcome.kind === 'done' ? { model: outcome.model } : outcome
    transcript.finish(outcome.kind, detail, totals, toolCalls, wallMs)
    return { runId, outcome, tokens: totals, toolCalls, wallMs, handoffs, turns, compactions }
  }
  const add = (usage: Tokens) => {
    for (const key of Object.keys(totals) as (keyof Tokens)[]) totals[key] += usage[key]
  }

  const loop = async (): Promise<RunResult> => {
    const models =
      options.models ?? allowedModels(new Set(rules.chain.map((entry) => entry.piProvider)))
    const chain: { entry: ChainModel; model: Model<Api> }[] = []
    const outside: string[] = []
    for (const entry of rules.chain) {
      const model = models.getModel(entry.piProvider, entry.piModel)
      const host = model && hostOf(model.baseUrl)
      if (!model)
        log(`skip ${entry.id}: provider ${entry.piProvider} has no model ${entry.piModel}`)
      else if (model.api === CLAUDE_API)
        log(`skip ${entry.id}: it speaks ${CLAUDE_API}; Claude runs only through claude -p`)
      else if (rules.hosts && !rules.hosts.includes(host as string)) {
        outside.push(`${entry.id} at ${host}`)
        log(`skip ${entry.id}: ${host} is outside egress profile '${rules.egress}'`)
      } else chain.push({ entry, model })
    }
    if (!chain.length)
      return finish(
        outside.length
          ? {
              kind: 'refused',
              reason: 'egress_denied',
              detail: `egress profile '${rules.egress}' allows ${rules.hosts?.join(', ')}; no chain model is there (${outside.join('; ')})`,
            }
          : {
              kind: 'refused',
              reason: 'no_model',
              detail: 'no chain model is served by the registered providers',
            },
      )
    const history = contextMessages(transcript.entries)
    if (options.task === null && (history.length === 0 || history.at(-1)?.role === 'assistant'))
      return finish({
        kind: 'error',
        model: inUse,
        detail: 'the run finished its last turn: give a prompt to go on',
      })

    const contextFiles =
      options.contextFiles ?? loadProjectContextFiles({ cwd, agentDir: getAgentDir() })
    const markers = credentialMarkers([getAgentDir(), ...harness.credential_paths], homedir())
    const withheld = new Set<string>()
    let current = 0
    let firstModelRequests = 0
    let swap: ModelSwap | null = null
    const at = () => chain[current] as (typeof chain)[number]
    inUse = at().entry.id

    const streamFn = (
      model: Model<Api>,
      context: Parameters<Models['streamSimple']>[1],
      streamOptions: Parameters<Models['streamSimple']>[2],
    ) => {
      if (current === 0 && ++firstModelRequests === options.testRefuseAt)
        return syntheticRefusal(model)
      if (options.testUnreachable === at().entry.id)
        return models.streamSimple({ ...model, baseUrl: UNREACHABLE }, context, streamOptions)
      return models.streamSimple(model, context, streamOptions)
    }

    const pi = await piCompaction()
    const overThreshold = () =>
      settings.enabled &&
      at().model.contextWindow > 0 &&
      shouldCompact(
        pi.estimateContextTokens(contextMessages(transcript.entries)).tokens,
        at().model.contextWindow,
        settings,
      )

    const agent: Agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(harness, cwd, contextFiles),
        model: at().model,
        thinkingLevel: thinking(at().model, options.effort ?? at().entry.effort),
        tools: leanTools(cwd, rules.tools, harness.tool_descriptions, rules.contain) as AgentTool[],
        messages: history,
      },
      sessionId: runId,
      convertToLlm,
      streamFn,
      // Pi compacts before the next response when the context is over the threshold.
      prepareNextTurnWithContext: async (turn) => {
        if (!overThreshold() || !(await compactNow('threshold'))) return undefined
        return { context: { ...turn.context, messages: agent.state.messages.slice() } }
      },
      beforeToolCall: async ({ toolCall, args }) => {
        if (swap) return { block: true, reason: 'The run stopped: the provider swapped the model.' }
        if (!rules.guardHook || toolCall.name !== 'bash') return undefined
        const command = String((args as { command?: unknown })?.command ?? '')
        const reason = await guardBash(rules.guardHook, command, cwd, toolCall.id)
        if (!reason) return undefined
        transcript.blocked(toolCall.id, reason)
        return { block: true, reason }
      },
    })

    /** Pi's compaction of the run so far; true when it compacted. */
    async function compactNow(reason: 'threshold' | 'overflow'): Promise<boolean> {
      const preparation = pi.prepareCompaction(transcript.entries, settings)
      if (!preparation) return false
      try {
        const result = await compact(
          preparation,
          at().model,
          undefined,
          undefined,
          undefined,
          undefined,
          agent.state.thinkingLevel,
          streamFn,
        )
        add(usageTokens(result.usage))
        transcript.compaction({
          summary: result.summary,
          firstKeptSeq: Number(result.firstKeptEntryId),
          tokensBefore: result.tokensBefore,
          details: result.details,
          model: at().entry.id,
        })
        agent.state.messages = contextMessages(transcript.entries)
        compactions++
        log(
          `compacted (${reason}) on ${at().entry.id}: ${result.tokensBefore} tokens summarized, kept from message ${result.firstKeptEntryId}`,
        )
        return true
      } catch (error) {
        log(`compaction failed (${reason}): ${(error as Error)?.message ?? String(error)}`)
        return false
      }
    }

    /** The next model takes over; the dropped response never reaches it. */
    const hand = (
      failed: AssistantMessage,
      stat: Omit<HandoffStat, 'context_messages' | 'context_tokens'>,
    ) => {
      const kept = agent.state.messages.filter((message) => message !== failed)
      agent.state.messages = kept
      const full: HandoffStat = {
        ...stat,
        context_messages: kept.filter((message) => message.role !== 'system').length,
        context_tokens: tokensOf(kept),
      }
      handoffs.push(full)
      transcript.handoff({
        from_model: full.from,
        to_model: full.to,
        reason: full.reason,
        handoff_tokens: full.handoff_tokens,
        context_messages: full.context_messages,
        context_tokens: full.context_tokens,
      })
      current++
      inUse = at().entry.id
      agent.state.model = at().model
      agent.state.thinkingLevel = thinking(at().model, options.effort ?? at().entry.effort)
    }

    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        toolCalls++
        if (touchesCredentials(event.args, cwd, markers)) withheld.add(event.toolCallId)
        transcript.toolStart(event.toolCallId, event.toolName, event.args)
        log(`tool ${event.toolName}`)
      } else if (event.type === 'tool_execution_end') {
        const chars = JSON.stringify(event.result?.content ?? '').length
        transcript.toolEnd(event.toolCallId, Boolean(event.isError), chars)
      } else if (event.type === 'message_end') {
        const message = event.message
        if (message.role === 'system') return
        if (message.role !== 'assistant') {
          const content = 'content' in message ? message.content : message
          const callId = 'toolCallId' in message ? message.toolCallId : undefined
          return transcript.message({
            role: message.role,
            message,
            content:
              callId && withheld.has(callId)
                ? {
                    withheld: 'the call names a credential path',
                    chars: JSON.stringify(content).length,
                  }
                : content,
          })
        }
        const usage = usageTokens(message.usage)
        add(usage)
        const requested = at().entry
        const outcome = refusalOf(message, harness) ?? swapOf(message, requested.piModel)
        transcript.message({
          role: 'assistant',
          message,
          model: requested.id,
          served_model: message.responseModel ?? null,
          stop_reason: message.stopReason,
          outcome:
            outcome ??
            (message.errorMessage ? { kind: 'error', detail: message.errorMessage } : null),
          content: message.content,
          usage,
        })
        turns.push({ turn: transcript.turn, model: requested.id, stop: message.stopReason })
        log(`turn ${transcript.turn}: ${requested.id} (${message.stopReason})`)
        if (outcome?.kind === 'model_swap' && !swap) {
          swap = outcome
          log(`model swap: asked ${outcome.requested}, served ${outcome.served}`)
          agent.abort()
        }
      }
    })

    let input: string | null = options.task
    let overflowRetried = false
    for (;;) {
      // Pi checks the context before it sends a prompt.
      if (overThreshold()) await compactNow('threshold')
      if (input === null) await agent.continue()
      else await agent.prompt(input)
      input = null
      if (swap) return finish(swap)
      const last = lastAssistant(agent.state.messages)
      const { entry, model } = at()
      if (!last) return finish({ kind: 'error', model: entry.id, detail: 'no response' })
      if (last.stopReason !== 'error' && last.stopReason !== 'aborted') {
        // A finished response over the threshold compacts now, without a retry (as Pi).
        if (overThreshold() || isContextOverflow(last, model.contextWindow))
          await compactNow('threshold')
        return finish({ kind: 'done', model: entry.id, text: textOf(last) })
      }
      if (last.stopReason === 'error' && isContextOverflow(last, model.contextWindow)) {
        // Pi: compact and retry the turn once.
        if (overflowRetried || !(await compactNow('overflow')))
          return finish({
            kind: 'error',
            model: entry.id,
            detail: `context overflow, and compaction could not recover it: ${last.errorMessage}`,
          })
        overflowRetried = true
        agent.state.messages = agent.state.messages.filter((message) => message !== last)
        continue
      }
      const next = chain[current + 1]
      const refusal = refusalOf(last, harness)
      if (refusal) {
        if (!next) return finish({ kind: 'model_refused', model: entry.id, refusal })
        input = handoffNote(entry.id, next.entry.id, refusal)
        hand(last, {
          from: entry.id,
          to: next.entry.id,
          reason: refusal.category,
          handoff_tokens: estimateTokens({
            role: 'user',
            content: input,
            timestamp: Date.now(),
          } as AgentMessage),
        })
        log(`handoff ${entry.id} -> ${next.entry.id} (${refusal.category})`)
        continue
      }
      const detail = last.errorMessage ?? last.stopReason
      if (last.stopReason === 'aborted' || !next)
        return finish({ kind: 'error', model: entry.id, detail })
      // A provider error: the next model in the chain takes this same turn.
      hand(last, { from: entry.id, to: next.entry.id, reason: 'provider_error', handoff_tokens: 0 })
      log(
        `turn ${transcript.turn}: provider error on ${entry.id} (${detail}); ${next.entry.id} takes the turn`,
      )
    }
  }

  try {
    return await loop()
  } catch (error) {
    const detail = (error as Error)?.message ?? String(error)
    log(`error: ${detail}`)
    return finish({ kind: 'error', model: inUse, detail })
  }
}
