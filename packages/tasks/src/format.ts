// Output shapes of the `st` verbs agents use today (list, create, context, claim lines), so the
// alias swap at the M10d cutover changes nothing they parse.

import type { Claim, SessionLink, Subtask, Task } from './tasks'

export function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`
}

/** `P2 task-... project   type       status    title`, as `st list` prints it. */
export function taskLine(task: Task): string {
  const triage = !task.complexity && task.acceptance.length === 0 ? '[TRIAGE] ' : ''
  return `P${task.priority} ${task.id} ${task.project_id.padEnd(12)} ${task.task_type.slice(0, 10).padEnd(10)} ${task.status.padEnd(9)} ${triage}${truncate(task.title, 50 - triage.length)}`
}

/** `st create`'s answer: id|project|status|P|type|complexity|done/total|mode|decisions|title. */
export function createdLine(task: Task, subtasks: Subtask[]): string {
  const done = subtasks.filter((subtask) => subtask.status === 'completed').length
  return `${task.id}|${task.project_id}|${task.status}|P${task.priority}|${task.task_type}|${task.complexity ?? 'SIMPLE'}|${done}/${subtasks.length}|manual|decisions:0|${task.title}`
}

export function subtaskLine(subtask: Subtask): string {
  const mark = subtask.status === 'completed' ? 'PASS' : '____'
  return `${subtask.ref.padEnd(5)} ${mark} ${truncate(subtask.description, 40).padEnd(40)}`
}

export function time(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

export interface ContextInput {
  task: Task
  subtasks: Subtask[]
  claim: Claim | null
  blockers: { id: string; status: string }[]
  recent: { at: number; message: string }[]
  sessions: SessionLink[]
}

/** `st context TASK`: one KEY:value line each, the lists as KEY[n] lines. */
export function contextLines(input: ContextInput): string[] {
  const { task } = input
  const lines = [
    `TASK:${task.id}|${task.status}|P${task.priority}|${task.task_type}|${task.complexity ?? 'SIMPLE'}`,
    `TITLE:${task.title}`,
    `DESCRIPTION:${task.description || 'none recorded'}`,
    `PROJECT:${task.project_id}`,
    `CLAIM:${input.claim ? `${input.claim.owner} since ${time(input.claim.claimed_at)}` : 'none'}`,
    `BLOCKERS:${input.blockers.length ? input.blockers.map((b) => `${b.id} (${b.status})`).join(', ') : 'none explicit'}`,
    `RECENT_PROGRESS:${input.recent.length ? input.recent.map((e) => e.message).join(' | ') : 'none recorded'}`,
  ]
  if (task.acceptance.length)
    lines.push(`DONE_WHEN[${task.acceptance.length}]:${task.acceptance.join(' | ')}`)
  if (input.subtasks.length) {
    lines.push(`SUBTASKS[${input.subtasks.length}]`)
    for (const subtask of input.subtasks) lines.push(`  ${subtaskLine(subtask)}`)
  }
  if (input.sessions.length)
    lines.push(
      `SESSIONS[${input.sessions.length}]:${input.sessions.map((s) => s.session_id).join(' | ')}`,
    )
  return lines
}
