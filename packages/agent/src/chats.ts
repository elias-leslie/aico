// Chat sessions own their state and transcript here. The web server is a transport;
// Tether receives pushed state/totals and never opens this database.
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { Catalog, contextDbPath } from '@aico/context'
import type { Database } from '@aico/store'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { ImageContent, Models } from '@earendil-works/pi-ai'
import { HARNESS, loadRoleRules, type Refused, type RoleRules } from './rules'
import { type RunOptions, runAgent } from './run'
import type { PushRun } from './tether'
import { findRun, runReport, Transcript } from './transcript'

export type ChatState = 'working' | 'idle' | 'stopped' | 'failed' | 'ended' | 'swapped'
interface ChatRow {
  run_id: string
  title: string
  state: ChatState
  updated_at: number
  draft: string
  draft_attachments: string
  queued: string
  partial: string | null
  note: string | null
  model: string | null
  effort: string | null
}
export interface ChatMessage {
  seq: number
  role: string
  model: string | null
  turn: number
  at: string
  stop_reason: string | null
  content: unknown
  meta: Record<string, unknown>
  outcome: Record<string, unknown> | null
  input: number | null
  cache_read: number | null
  cache_write: number | null
  output: number | null
}
export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
const parse = <T>(value: string | null, fallback: T): T =>
  value === null ? fallback : (JSON.parse(value) as T)
type QueuedMessage = string | { text: string; attachments: string[] }
const promptText = (value: QueuedMessage) => (typeof value === 'string' ? value : value.text)
const promptFiles = (value: QueuedMessage) => (typeof value === 'string' ? [] : value.attachments)
const FILE_FAILURE = 'Files weren’t sent: '
const assistantText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('')
    : ''

export class ChatSessions {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly listeners = new Map<string, Set<() => void>>()
  constructor(
    readonly db: Database,
    private readonly options: {
      dataDir: string
      push: PushRun
      models?: Models
      rules?: (role: string, cwd: string) => RoleRules | Refused
      contextFiles?: RunOptions['contextFiles']
      attachments?: (ids: string[]) => Promise<{ text: string; images: ImageContent[] }>
    },
  ) {
    const interrupted = db
      .prepare("SELECT * FROM chats WHERE state = 'working' AND partial IS NOT NULL")
      .all() as unknown as ChatRow[]
    for (const row of interrupted) {
      const partial = parse<{ text: string; model: string } | null>(row.partial, null)
      if (partial?.text) {
        const transcript = Transcript.open(db, row.run_id)
        transcript.message({
          role: 'assistant',
          model: partial.model,
          stop_reason: 'aborted',
          content: [{ type: 'text', text: partial.text }],
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: partial.text }],
            stopReason: 'aborted',
            timestamp: Date.now(),
          } as import('@earendil-works/pi-agent-core').AgentMessage,
        })
      }
    }
    db.prepare(
      "UPDATE chats SET state = 'stopped', partial = NULL, note = 'Aico restarted while this reply was being written.' WHERE state = 'working'",
    ).run()
  }
  private rules(role: string, cwd: string): RoleRules {
    const result =
      this.options.rules?.(role, cwd) ??
      loadRoleRules(contextDbPath(this.options.dataDir), { role, cwd })
    if ('kind' in result) throw new ChatError(409, `Can’t start this chat. ${result.detail}`)
    return result
  }
  choices(cwd: string) {
    const catalog = new Catalog()
    return Object.entries(HARNESS.roles).map(([role]) => {
      try {
        const rules = this.rules(role, cwd)
        return {
          role,
          description: HARNESS.chat.roles[role as keyof typeof HARNESS.chat.roles],
          chain: rules.chain.map((entry) => ({
            id: entry.id,
            effort: entry.effort,
            reason: catalog.get(entry.id)?.name ?? entry.id,
          })),
          error: null,
        }
      } catch (error) {
        return {
          role,
          description: HARNESS.chat.roles[role as keyof typeof HARNESS.chat.roles],
          chain: [],
          error: (error as Error).message,
        }
      }
    })
  }
  private row(id: string): ChatRow {
    const row = this.db.prepare('SELECT * FROM chats WHERE run_id = ?').get(id) as unknown as
      | ChatRow
      | undefined
    if (!row) throw new ChatError(404, 'Couldn’t open this chat. It is no longer listed.')
    return row
  }
  has(id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM chats WHERE run_id = ?').get(id))
  }
  list() {
    return (
      this.db.prepare('SELECT run_id FROM chats ORDER BY updated_at DESC').all() as {
        run_id: string
      }[]
    ).map(({ run_id }) => this.summary(run_id))
  }
  summary(id: string) {
    const row = this.row(id)
    const run = findRun(this.db, id)
    const last = this.db
      .prepare(
        "SELECT content FROM messages WHERE run_id = ? AND role IN ('user', 'assistant') ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as { content: string } | undefined
    const transcript = Transcript.open(this.db, id)
    const rules = this.rulesOrNull(run.role, run.cwd)
    return {
      id,
      title: row.title,
      role: run.role,
      cwd: run.cwd,
      state: row.state,
      updatedAt: row.updated_at,
      startedAt: runReport(this.db, id).startedAt,
      model: transcript.lastModel ?? row.model ?? rules?.chain[0]?.id ?? null,
      nextModel: transcript.nextModel ?? rules?.chain[0]?.id ?? null,
      firstModel: rules?.chain[0]?.id ?? null,
      last: last ? assistantText(parse(last.content, [])) : '',
    }
  }
  private rulesOrNull(role: string, cwd: string) {
    try {
      return this.rules(role, cwd)
    } catch {
      return null
    }
  }
  get(id: string) {
    const row = this.row(id)
    const run = findRun(this.db, id)
    const messages = (
      this.db
        .prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY seq')
        .all(id) as unknown as (Omit<ChatMessage, 'content' | 'meta' | 'outcome'> & {
        content: string
        meta: string | null
        outcome: string | null
      })[]
    ).map((m) => ({
      ...m,
      content: parse<unknown>(m.content, null),
      meta: parse<Record<string, unknown>>(m.meta, {}),
      outcome: parse<Record<string, unknown> | null>(m.outcome, null),
    }))
    return {
      ...this.summary(id),
      draft: row.draft,
      draftAttachments: parse<string[]>(row.draft_attachments, []),
      queued: parse<QueuedMessage[]>(row.queued, []).map(promptText),
      partial: parse<{ text: string; model: string; turn: number } | null>(row.partial, null),
      note: row.note,
      effort: row.effort,
      parent: run.parent_id,
      branchTurn: run.branch_turn,
      messages: messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((block) =>
              block.type === 'image' ? { type: 'image', mimeType: block.mimeType } : block,
            )
          : message.content,
      })),
      handoffs: this.db.prepare('SELECT * FROM handoffs WHERE run_id = ? ORDER BY seq').all(id),
      tools: this.db.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY seq').all(id),
      totals: runReport(this.db, id),
      chain: this.rulesOrNull(run.role, run.cwd)?.chain ?? [],
      outcome: parse<Record<string, unknown> | null>(
        (
          this.db.prepare('SELECT outcome_detail FROM runs WHERE id = ?').get(id) as {
            outcome_detail: string | null
          }
        ).outcome_detail,
        null,
      ),
    }
  }
  private pick(rules: RoleRules, model?: string): RoleRules {
    if (!model) return rules
    const first = rules.chain.find((entry) => entry.id === model)
    if (!first) throw new ChatError(422, 'Pick a model from this role’s order.')
    return { ...rules, chain: [first, ...rules.chain.filter((entry) => entry.id !== model)] }
  }
  async start(input: {
    role: string
    cwd: string
    message: string
    model?: string
    effort?: string | null
    branch?: { id: string; turn: number }
    attachments?: string[]
  }) {
    let { role, cwd } = input
    if (input.branch) {
      const from = findRun(this.db, this.row(input.branch.id).run_id)
      role = from.role
      cwd = from.cwd
    }
    if (
      !cwd.startsWith('/') ||
      !(() => {
        try {
          return statSync(cwd).isDirectory()
        } catch {
          return false
        }
      })()
    )
      throw new ChatError(422, 'Choose an existing project folder.')
    const rules = this.pick(this.rules(role, cwd), input.model)
    if (
      input.branch &&
      !this.get(input.branch.id).messages.some(
        (m) => m.role === 'assistant' && m.turn === input.branch?.turn,
      )
    )
      throw new ChatError(422, 'Choose a reply to branch from.')
    const id = randomBytes(4).toString('hex')
    if (input.branch)
      Transcript.branch(
        this.db,
        findRun(this.db, input.branch.id),
        input.branch.turn,
        id,
        input.message,
      )
    else new Transcript(this.db, id, { role, cwd, task: input.message, chain: rules.chain })
    const title = input.branch
      ? `Branch at turn ${input.branch.turn} · ${this.row(input.branch.id).title}`
      : input.message.split('\n')[0]?.slice(0, 100) || 'New chat'
    this.db
      .prepare(
        "INSERT INTO chats (run_id, title, state, updated_at, model, effort) VALUES (?, ?, 'idle', ?, ?, ?)",
      )
      .run(id, title, Date.now(), input.model ?? null, input.effort ?? null)
    this.launch(id, input.message, rules, Boolean(input.model), input.effort, input.attachments)
    return this.get(id)
  }
  send(
    id: string,
    message: string,
    model?: string,
    effort?: string | null,
    attachments: string[] = [],
  ) {
    const row = this.row(id)
    if (row.state === 'ended')
      throw new ChatError(409, 'This chat ended. Branch from a reply to start a new one.')
    const run = findRun(this.db, id)
    const rules = this.pick(this.rules(run.role, run.cwd), model)
    if (this.active.has(id)) {
      if (model || effort !== undefined)
        throw new ChatError(
          409,
          'Stop this reply before changing its model or effort. Your message is kept below.',
        )
      const queued = parse<QueuedMessage[]>(row.queued, [])
      queued.push(attachments.length ? { text: message, attachments } : message)
      this.db
        .prepare(
          "UPDATE chats SET queued = ?, draft = '', draft_attachments = '[]' WHERE run_id = ?",
        )
        .run(JSON.stringify(queued), id)
      this.changed(id)
    } else this.launch(id, message, rules, Boolean(model), effort, attachments)
    return this.get(id)
  }
  resume(id: string, selectedModel?: string, selectedEffort?: string | null) {
    const row = this.row(id)
    if (!['stopped', 'failed', 'swapped'].includes(row.state))
      throw new ChatError(409, 'This chat has no unfinished reply.')
    const run = findRun(this.db, id)
    const latest = this.db
      .prepare(
        "SELECT model FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as { model: string | null } | undefined
    const model =
      selectedModel ??
      (row.state === 'failed' ? undefined : (latest?.model ?? this.summary(id).model ?? undefined))
    const rules = this.pick(this.rules(run.role, run.cwd), model)
    this.db
      .prepare('UPDATE chats SET note = ? WHERE run_id = ?')
      .run(
        `Resumed at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. ${rules.chain[0]?.id} is finishing the stopped turn. Its unfinished text stays above as it was.`,
        id,
      )
    const files = row.note?.startsWith(FILE_FAILURE)
      ? parse<string[]>(row.draft_attachments, [])
      : []
    this.launch(
      id,
      files.length ? row.draft : null,
      rules,
      true,
      selectedEffort === undefined ? row.effort : selectedEffort,
      files,
    )
    return this.get(id)
  }
  async stop(id: string, end = false) {
    const row = this.row(id)
    const queued = parse<QueuedMessage[]>(row.queued, [])
    const draft = [row.draft, ...queued.map(promptText)].filter(Boolean).join('\n\n')
    const attachments = [
      ...new Set([...parse<string[]>(row.draft_attachments, []), ...queued.flatMap(promptFiles)]),
    ]
    this.db
      .prepare("UPDATE chats SET queued = '[]', draft = ?, draft_attachments = ? WHERE run_id = ?")
      .run(draft, JSON.stringify(attachments), id)
    const active = this.active.get(id)
    active?.controller.abort()
    await active?.done
    if (end)
      this.db
        .prepare("UPDATE chats SET state = 'ended', updated_at = ? WHERE run_id = ?")
        .run(Date.now(), id)
    this.changed(id)
    await this.push(id)
    return this.get(id)
  }
  answer(
    id: string,
    askId: string,
    question: string,
    answer: string,
    attachments: string[] = [],
    consumesDraft = false,
  ) {
    const row = this.row(id)
    if (row.state === 'ended') return
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO chat_answers (ask_id, run_id) VALUES (?, ?)')
      .run(askId, id)
    if (!Number(inserted.changes)) return
    try {
      this.send(
        id,
        `[Answer to your question: ${question}]\n${answer}`,
        undefined,
        undefined,
        attachments,
      )
      if (!consumesDraft) {
        this.draft(id, row.draft, parse<string[]>(row.draft_attachments, []))
        this.changed(id)
      }
    } catch (error) {
      this.db.prepare('DELETE FROM chat_answers WHERE ask_id = ?').run(askId)
      throw error
    }
  }
  async question(id: string, waiting: boolean) {
    if (this.has(id)) {
      this.changed(id)
      await this.push(id, waiting ? 'needs-you' : undefined)
    }
  }
  draft(id: string, value: string, attachments?: string[]) {
    this.row(id)
    this.db.prepare('UPDATE chats SET draft = ? WHERE run_id = ?').run(value, id)
    if (attachments)
      this.db
        .prepare('UPDATE chats SET draft_attachments = ? WHERE run_id = ?')
        .run(JSON.stringify(attachments), id)
  }
  rename(id: string, title: string) {
    this.row(id)
    this.db.prepare('UPDATE chats SET title = ? WHERE run_id = ?').run(title, id)
    this.changed(id)
  }
  subscribe(id: string, listener: () => void) {
    this.row(id)
    const set = this.listeners.get(id) ?? new Set()
    set.add(listener)
    this.listeners.set(id, set)
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(id)
    }
  }
  changed(id?: string) {
    for (const [key, listeners] of this.listeners)
      if (!id || key === id) for (const listener of listeners) listener()
  }
  async settled(id: string) {
    await this.active.get(id)?.done
  }
  private async push(id: string, state?: string) {
    const row = this.row(id)
    try {
      await this.options.push({
        ...runReport(this.db, id),
        chat: { title: row.title, state: state ?? row.state, updatedAt: row.updated_at },
      })
    } catch (error) {
      console.warn('[aico-agent] session state not pushed:', (error as Error).message)
    }
  }
  private launch(
    id: string,
    task: string | null,
    rules: RoleRules,
    keepHead: boolean,
    effort?: string | null,
    attachments: string[] = [],
  ) {
    if (this.active.has(id)) throw new ChatError(409, 'This chat is already working.')
    const controller = new AbortController()
    const configuredEffort = effort === undefined ? this.row(id).effort : effort
    this.db
      .prepare(
        "UPDATE chats SET state = 'working', updated_at = ?, draft = CASE WHEN ? THEN '' ELSE draft END, draft_attachments = CASE WHEN ? THEN '[]' ELSE draft_attachments END, effort = ? WHERE run_id = ?",
      )
      .run(Date.now(), task !== null ? 1 : 0, task !== null ? 1 : 0, configuredEffort ?? null, id)
    const done = Promise.resolve().then(async () => {
      let prepared = false
      try {
        const run = findRun(this.db, id)
        const files = attachments.length ? await this.options.attachments?.(attachments) : undefined
        if (attachments.length && !files)
          throw new ChatError(503, 'Attachments are unavailable. Your files are kept in the draft.')
        prepared = true
        const result = await runAgent({
          db: this.db,
          onStart: () => this.push(id),
          rules,
          cwd: run.cwd,
          task: task === null ? null : [task, files?.text].filter(Boolean).join('\n\n'),
          images: files?.images,
          resume: run,
          keepHead,
          effort: configuredEffort ?? undefined,
          models: this.options.models,
          contextFiles: this.options.contextFiles,
          sessionId: id,
          signal: controller.signal,
          onEvent: (event, model, turn) => this.live(id, event, model, turn),
        })
        const state: ChatState = controller.signal.aborted
          ? 'stopped'
          : result.outcome.kind === 'done'
            ? 'idle'
            : result.outcome.kind === 'model_swap'
              ? 'swapped'
              : 'failed'
        this.db
          .prepare('UPDATE chats SET state = ?, partial = NULL, updated_at = ? WHERE run_id = ?')
          .run(state, Date.now(), id)
      } catch (error) {
        this.db
          .prepare("UPDATE chats SET state = 'failed', note = ?, updated_at = ? WHERE run_id = ?")
          .run(
            `${!prepared && attachments.length ? FILE_FAILURE : ''}${(error as Error).message}`,
            Date.now(),
            id,
          )
        if (!prepared && attachments.length) this.draft(id, task ?? '', attachments)
      } finally {
        this.active.delete(id)
        this.changed(id)
        await this.push(id)
      }
      const row = this.row(id)
      const queued = parse<QueuedMessage[]>(row.queued, [])
      if (!controller.signal.aborted && row.state === 'idle' && queued.length) {
        const next = queued.shift() as QueuedMessage
        this.db
          .prepare('UPDATE chats SET queued = ? WHERE run_id = ?')
          .run(JSON.stringify(queued), id)
        this.send(id, promptText(next), undefined, undefined, promptFiles(next))
      }
    })
    this.active.set(id, { controller, done })
    this.changed(id)
  }
  private live(id: string, event: AgentEvent, model: string, turn: number) {
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      this.db
        .prepare('UPDATE chats SET partial = ?, updated_at = ? WHERE run_id = ?')
        .run(
          JSON.stringify({ text: assistantText(event.message.content), model, turn }),
          Date.now(),
          id,
        )
      this.changed(id)
    } else if (
      event.type === 'message_end' ||
      event.type === 'tool_execution_end' ||
      event.type === 'tool_execution_start'
    ) {
      // The harness stores the event immediately after this observer returns.
      queueMicrotask(() => {
        this.db.prepare('UPDATE chats SET partial = NULL WHERE run_id = ?').run(id)
        this.changed(id)
      })
    }
  }
  async shutdown() {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)))
  }
}
