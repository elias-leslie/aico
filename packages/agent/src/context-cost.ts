// Observe the exact prelude the harness already built. This never changes its
// file loader, prompt or model request; a failed inventory cannot stop a run.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  budgetHint,
  COST,
  type CostDelivery,
  type Delivery,
  observeDelivery,
  openContext,
  recentDeliveries,
  recordDelivery,
  type UseEvent,
} from '@aico/context'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { projectFor } from './rules'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export interface ContextRecorder {
  message(message: AgentMessage): void
  finish(complete: boolean): void
}
export function recordAgentContext(
  path: string | undefined,
  run: { id: string; role: string; cwd: string },
  parts: { id: string; title: string; text: string; type: 'rule' | 'file' }[],
  log: (line: string) => void,
): ContextRecorder | undefined {
  if (!path || !existsSync(path)) return
  try {
    const db = openContext(path)
    let id: number
    let inventory: CostDelivery | undefined
    try {
      const roots = (
        db
          .prepare(
            "SELECT project_id, root_path FROM project_permissions WHERE coalesce(root_path, '') != ''",
          )
          .all() as { project_id: string; root_path: string }[]
      ).map((r) => ({ id: r.project_id, root: r.root_path }))
      const project = projectFor(roots, run.cwd) ?? null
      if (COST.excludedProjects.includes(project ?? '')) return
      const text = parts.map((p) => p.text).join('\n\n')
      const delivery: Delivery = {
        tool: 'aico-agent',
        role: run.role,
        project,
        session: run.id,
        text,
        hash: hash(text),
        bytes: Buffer.byteLength(text),
        budget: 0,
        over: false,
        cut: [],
        missing: [],
        sections: parts.map((p) => ({
          id: p.id,
          title: p.title,
          kind: 'instruction',
          bytes: Buffer.byteLength(p.text),
          items: [
            {
              id: p.id,
              title: p.title,
              type: p.type,
              bytes: Buffer.byteLength(p.text),
              hash: hash(p.text),
            },
          ],
        })),
      }
      const hint = budgetHint(db, delivery)
      if (hint) log(hint)
      id = recordDelivery(db, delivery, 'agent-prelude', new Date())
      inventory = recentDeliveries(db).find((d) => d.id === id)
    } finally {
      db.close()
    }
    let intact = true
    let sawReply = false
    const save = (events: UseEvent[], complete: boolean) => {
      try {
        const db = openContext(path)
        try {
          if (inventory)
            observeDelivery(
              db,
              inventory,
              events,
              complete && intact && sawReply,
              `aico-agent:${run.id}`,
            )
        } finally {
          db.close()
        }
      } catch (error) {
        intact = false
        log(`Context use was not recorded: ${(error as Error).message}`)
      }
    }
    return {
      message(m) {
        if (!inventory || m.role !== 'assistant' || m.timestamp < Date.parse(inventory.at)) return
        const events: UseEvent[] = m.content.map((part) =>
          part.type === 'toolCall'
            ? {
                role: 'assistant',
                kind: 'tool_call',
                tool: part.name,
                text: JSON.stringify(part.arguments),
                at: m.timestamp,
              }
            : {
                role: 'assistant',
                kind: 'text',
                text:
                  part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : '',
                at: m.timestamp,
              },
        )
        sawReply ||= events.some((e) => e.kind === 'text' && e.text.trim().length > 0)
        // Persist markers immediately: later compaction cannot erase their use.
        save(events, false)
      },
      finish(complete) {
        save([], complete)
      },
    }
  } catch (error) {
    log(`Context inventory was not recorded: ${(error as Error).message}`)
  }
}
