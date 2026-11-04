// One `aico agent run`: the loop policy around pi-agent-core's Agent. The role rules pick
// the model chain and tools (or refuse); every message, tool call and handoff goes to
// agent.db as it happens; a refusal hands the same conversation to the next model in the
// chain with a short note; a model swap stops the run. Compaction is not wired in: this
// slice runs single tasks that fit the context window.

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
import {
  estimateTokens,
  getAgentDir,
  loadProjectContextFiles,
} from '@earendil-works/pi-coding-agent'
import { type ModelRefusal, type ModelSwap, refusalOf, swapOf } from './outcomes'
import { allowedModels } from './providers'
import { type ChainModel, HARNESS, type Harness, type Refused, type RoleRules } from './rules'
import { credentialMarkers, guardBash, leanTools, touchesCredentials } from './tools'
import { type Tokens, Transcript } from './transcript'

export type Outcome =
  | { kind: 'done'; model: string; text: string }
  | Refused
  | { kind: 'model_refused'; model: string; refusal: ModelRefusal }
  | ModelSwap
  | { kind: 'error'; model: string; detail: string }

export interface HandoffStat {
  from: string
  to: string
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
}

export interface RunOptions {
  rules: RoleRules
  task: string
  cwd: string
  db: Database
  /** Thinking level for every model; else each chain row's effort; else high. */
  effort?: string
  /** Test hook: the Nth provider request on the first model returns a synthetic refusal. */
  testRefuseAt?: number
  /** The provider collection; defaults to the allowed pi-ai providers with Pi's credentials. */
  models?: Models
  /** Project context files (AGENTS.md and the like); defaults to Pi's loader for `cwd`. */
  contextFiles?: { path: string; content: string }[]
  harness?: Harness
  log?: (line: string) => void
}

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

function usageOf(message: AssistantMessage): Tokens {
  const usage = message.usage
  return {
    input: usage?.input ?? 0,
    cache_read: usage?.cacheRead ?? 0,
    cache_write: usage?.cacheWrite ?? 0,
    output: usage?.output ?? 0,
  }
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

export async function runAgent(options: RunOptions): Promise<RunResult> {
  const harness = options.harness ?? HARNESS
  const { rules, cwd, db } = options
  const log = options.log ?? (() => {})
  const started = Date.now()
  const runId = randomUUID()
  const transcript = new Transcript(db, runId, {
    role: rules.role,
    cwd,
    task: options.task,
    chain: rules.chain,
  })
  const totals: Tokens = { input: 0, cache_read: 0, cache_write: 0, output: 0 }
  const handoffs: HandoffStat[] = []
  let toolCalls = 0
  let inUse = rules.chain[0]?.id ?? ''
  const finish = (outcome: Outcome): RunResult => {
    const wallMs = Date.now() - started
    const detail = outcome.kind === 'done' ? { model: outcome.model } : outcome
    transcript.finish(outcome.kind, detail, totals, toolCalls, wallMs)
    return { runId, outcome, tokens: totals, toolCalls, wallMs, handoffs }
  }

  const loop = async (): Promise<RunResult> => {
    const models =
      options.models ?? allowedModels(new Set(rules.chain.map((entry) => entry.piProvider)))
    const chain: { entry: ChainModel; model: Model<Api> }[] = []
    for (const entry of rules.chain) {
      const model = models.getModel(entry.piProvider, entry.piModel)
      if (!model)
        log(`skip ${entry.id}: provider ${entry.piProvider} has no model ${entry.piModel}`)
      else if (model.api === CLAUDE_API)
        log(`skip ${entry.id}: it speaks ${CLAUDE_API}; Claude runs only through claude -p`)
      else chain.push({ entry, model })
    }
    if (!chain.length)
      return finish({
        kind: 'refused',
        reason: 'no_model',
        detail: 'no chain model is served by the registered providers',
      })

    const contextFiles =
      options.contextFiles ?? loadProjectContextFiles({ cwd, agentDir: getAgentDir() })
    const markers = credentialMarkers([getAgentDir(), ...harness.credential_paths], homedir())
    const withheld = new Set<string>()
    let current = 0
    let firstModelRequests = 0
    let swap: ModelSwap | null = null
    const first = chain[0] as (typeof chain)[number]
    inUse = first.entry.id

    const agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(harness, cwd, contextFiles),
        model: first.model,
        thinkingLevel: thinking(first.model, options.effort ?? first.entry.effort),
        tools: leanTools(cwd, rules.tools, harness.tool_descriptions) as AgentTool[],
        messages: [],
      },
      sessionId: runId,
      streamFn: (model, context, streamOptions) => {
        if (current === 0 && ++firstModelRequests === options.testRefuseAt)
          return syntheticRefusal(model)
        return models.streamSimple(model, context, streamOptions)
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
            content:
              callId && withheld.has(callId)
                ? {
                    withheld: 'the call names a credential path',
                    chars: JSON.stringify(content).length,
                  }
                : content,
          })
        }
        const usage = usageOf(message)
        for (const key of Object.keys(totals) as (keyof Tokens)[]) totals[key] += usage[key]
        const requested = (chain[current] as (typeof chain)[number]).entry
        const outcome = refusalOf(message, harness) ?? swapOf(message, requested.piModel)
        transcript.message({
          role: 'assistant',
          model: requested.id,
          served_model: message.responseModel ?? null,
          stop_reason: message.stopReason,
          outcome:
            outcome ??
            (message.errorMessage ? { kind: 'error', detail: message.errorMessage } : null),
          content: message.content,
          usage,
        })
        if (outcome?.kind === 'model_swap' && !swap) {
          swap = outcome
          log(`model swap: asked ${outcome.requested}, served ${outcome.served}`)
          agent.abort()
        }
      }
    })

    let input: string = options.task
    for (;;) {
      await agent.prompt(input)
      if (swap) return finish(swap)
      const last = lastAssistant(agent.state.messages)
      const at = chain[current] as (typeof chain)[number]
      if (!last) return finish({ kind: 'error', model: at.entry.id, detail: 'no response' })
      if (last.stopReason !== 'error' && last.stopReason !== 'aborted')
        return finish({ kind: 'done', model: at.entry.id, text: textOf(last) })
      const refusal = refusalOf(last, harness)
      if (!refusal)
        return finish({
          kind: 'error',
          model: at.entry.id,
          detail: last.errorMessage ?? last.stopReason,
        })
      const next = chain[current + 1]
      if (!next) return finish({ kind: 'model_refused', model: at.entry.id, refusal })

      // Hand the conversation over: drop the empty refused response, keep everything else.
      const kept = agent.state.messages.filter((message) => message !== last)
      agent.state.messages = kept
      input = handoffNote(at.entry.id, next.entry.id, refusal)
      const stat: HandoffStat = {
        from: at.entry.id,
        to: next.entry.id,
        reason: refusal.category,
        handoff_tokens: estimateTokens({
          role: 'user',
          content: input,
          timestamp: Date.now(),
        } as AgentMessage),
        context_messages: kept.filter((message) => message.role !== 'system').length,
        context_tokens: tokensOf(kept),
      }
      handoffs.push(stat)
      transcript.handoff({
        from_model: stat.from,
        to_model: stat.to,
        reason: stat.reason,
        handoff_tokens: stat.handoff_tokens,
        context_messages: stat.context_messages,
        context_tokens: stat.context_tokens,
      })
      log(
        `handoff ${stat.from} -> ${stat.to} (${refusal.category}); ${stat.handoff_tokens} handoff tokens`,
      )
      current++
      inUse = next.entry.id
      agent.state.model = next.model
      agent.state.thinkingLevel = thinking(next.model, options.effort ?? next.entry.effort)
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
