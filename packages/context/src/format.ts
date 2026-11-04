// Plain-text output of `aico memory | prompt | models`: the same lines `st memory`,
// `st prompt` and `st models route` print today, so agents read them unchanged.

import type { Found, Memory } from './memory'
import type { Prompt } from './prompts'
import type { LaunchRow, Refusal, RoutePayload, Usage, Window } from './route'

// -- memory ----------------------------------------------------------------------------------

function metaLine(memory: Memory): string | null {
  const parts: string[] = []
  if (memory.pinned) parts.push('pinned')
  if (memory.renderMode) parts.push(`render=${memory.renderMode}`)
  if (memory.triggers.length) parts.push(`triggers=${memory.triggers.join(',')}`)
  if (memory.tags.length)
    parts.push(`tags=${memory.tags.slice(0, 3).join(',')}${memory.tags.length > 3 ? '+' : ''}`)
  return parts.length ? parts.join(' | ') : null
}

function detail(memory: Memory, withPin: boolean): string[] {
  const lines = [
    `${memory.id.slice(0, 8)} [${memory.tier}] loaded=${memory.loadedCount} helpful=${memory.helpfulCount} harmful=${memory.harmfulCount}`,
  ]
  if (memory.summary) lines.push(`Summary: ${memory.summary}`)
  if (memory.triggers.length) lines.push(`Triggers: ${memory.triggers.join(', ')}`)
  if (withPin && memory.pinned) lines.push('Pinned: yes')
  if (withPin && memory.renderMode) lines.push(`Render mode: ${memory.renderMode}`)
  if (memory.tags.length) lines.push(`Tags: ${memory.tags.join(', ')}`)
  return lines
}

/** One memory in full, or several with a GET header and the ids not found. */
export function formatMemories(found: Memory[], missing: string[]): string {
  if (found.length === 1 && missing.length === 0) {
    const memory = found[0] as Memory
    return [...detail(memory, true), '', memory.content].join('\n')
  }
  const lines = [`GET[${found.length}/${found.length + missing.length}]:missing=${missing.length}`]
  for (const memory of found) lines.push('', ...detail(memory, false), memory.content)
  if (missing.length) lines.push(`\nMISSING: ${missing.map((id) => id.slice(0, 8)).join(', ')}`)
  return lines.join('\n')
}

export function formatMemoryList(memories: Memory[], next: number | null): string {
  const lines = [`EPISODES[${memories.length}]:cursor=${next ?? 'none'}`]
  for (const memory of memories) {
    lines.push(`  ${memory.id.slice(0, 8)} [${memory.tier}] summary=${memory.summary || '-'}`)
    const meta = metaLine(memory)
    if (meta) lines.push(`    ${meta}`)
    lines.push(`    ${memory.content}`)
  }
  return lines.join('\n')
}

export function formatSearch(query: string, found: Found[]): string {
  const lines = [`RESULTS[${found.length}]:query="${query}"`]
  for (const memory of found) {
    lines.push(
      `  ${memory.id.slice(0, 8)} [${memory.tier}] ${memory.score.toFixed(2)} ${memory.summary || '-'}`,
    )
    const meta = metaLine(memory)
    if (meta) lines.push(`    ${meta}`)
    lines.push(`    ${memory.content}`)
  }
  return lines.join('\n')
}

// -- prompts ---------------------------------------------------------------------------------

const lineCount = (text: string) =>
  text.split('\n').length - 1 + (text && !text.endsWith('\n') ? 1 : 0)

export function formatPromptList(prompts: Prompt[]): string {
  return [
    `PROMPTS[${prompts.length}]`,
    ...prompts.map(
      (prompt) =>
        `  ${prompt.slug.padEnd(20)} ${prompt.name.padEnd(24)} ${prompt.isGlobal ? 'Y' : 'N'} Y ${lineCount(prompt.content)}L`,
    ),
  ].join('\n')
}

export function formatPrompt(prompt: Prompt): string {
  return `PROMPT:${prompt.slug}|${prompt.name}|${prompt.isGlobal ? 'Y' : 'N'}|Y|${lineCount(prompt.content)}L\n${prompt.content}`
}

// -- models route ----------------------------------------------------------------------------

const pad2 = (value: number) => String(value).padStart(2, '0')

/** Local MM-DD HH:MM of an ISO time, or - when it is missing. */
export function when(iso: unknown): string {
  const at = typeof iso === 'string' ? new Date(iso) : null
  if (!at || Number.isNaN(at.getTime())) return '-'
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/** A length of time in the largest sensible unit: 5m, 4h, 2.6d. */
export function span(seconds: unknown): string {
  if (typeof seconds !== 'number') return '?'
  if (seconds < 60) return '<1m'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${(seconds / 86400).toFixed(1)}d`
}

const count = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toFixed(0)

function modelEffort(row: { model?: unknown; effort?: unknown; daybreak?: unknown }): string {
  return `${row.model || '-'} ${row.effort || '-'}${row.daybreak ? ' daybreak' : ''}`
}

const daybreakWord = (value: unknown) => (value === true ? 'on' : value === false ? 'off' : '-')

const reset = (window: Window) =>
  window.resets_at ? `${when(window.resets_at)} (${span(window.resets_in_seconds)})` : ''

function windowText(window: Window): string {
  const age = span(window.age_seconds)
  if (window.state === 'not_reported') return `${window.label} not reported`
  if (window.state === 'unknown')
    return `${window.label} unknown (its reset passed; last read ${age} ago)`
  if (window.state === 'used_up')
    return `${window.label} used up${window.resets_at ? ` until ${reset(window)}` : ''}, read ${age} ago`
  return `${window.label} ${window.left_percent}% left${window.resets_at ? `, resets ${reset(window)}` : ''}, read ${age} ago`
}

const STATUS: Record<string, string> = {
  ok: 'has room',
  used_up: 'used up',
  on_credits: 'running on credits',
  unknown: 'usage unknown',
  untracked: 'usage not tracked',
}

function statusText(usage: Partial<Usage>): string {
  if (usage.status === 'partly_unknown')
    return `has room in one window, ${usage.unknown_windows?.join(', ') || 'another window'} unknown`
  return STATUS[usage.status ?? ''] ?? 'usage unknown'
}

function usageLine(usage: Partial<Usage>): string {
  const windows = usage.windows ?? []
  if (!windows.length) return usage.status !== 'untracked' ? 'no usage readings' : ''
  return windows.map(windowText).join('; ')
}

function creditLine(usage: Partial<Usage>): string {
  const credit = usage.credits
  if (!credit) return ''
  let text = `${count(credit.balance)} credits`
  const resetDay = credit.reset_at ? when(credit.reset_at).slice(0, 5) : null
  if (credit.lasts_days === null) text += '; none drawn in the last 7 days'
  else if (credit.lasts_past_reset === true)
    text += `; at the last-7-day pace they last past the ${resetDay} reset`
  else if (credit.lasts_past_reset === false)
    text += `; at the last-7-day pace they run out in ${credit.lasts_days}d, before the ${resetDay} reset`
  else text += `; about ${credit.lasts_days}d at the last-7-day pace`
  if (credit.earliest_expiry)
    text += `; the earliest credits expire ${when(credit.earliest_expiry).slice(0, 5)}`
  return text
}

function refusalLine(refusal: Refusal | null | undefined): string {
  if (!refusal) return ''
  const who = [refusal.role || 'role unknown', refusal.project].filter(Boolean).join('/')
  const kind = refusal.category ? ` (${refusal.category})` : ''
  const recorded = (refusal.count ?? 1) > 1 ? ` (${refusal.count} recorded)` : ''
  return `last refusal ${when(refusal.at)}${kind}, ${who}${recorded}`
}

const projectTag = (row: LaunchRow) =>
  row.project_default ? ` (${row.project_default} default)` : ''

function alternateText(row: LaunchRow): string[] {
  return row.alternates.map((alt) => `${modelEffort(alt)} (when ${alt.when || '-'})`)
}

function optionLines(row: LaunchRow): string[] {
  if (!row.allowed) return [`${row.tool}  DENIED: ${row.deny_reason || '-'}`]
  if (!row.launchable) return [`${row.tool}  not launchable from here: ${row.why || '-'}`]
  if (!row.model) return [`${row.tool}  ${row.why || 'no model set'}`]
  const usage = row.usage ?? {}
  const whenText = row.when ? ` (when ${row.when})` : ''
  let head = `${row.tool}  ${modelEffort(row)}${projectTag(row)}${whenText}  ${statusText(usage)}`
  const alts = alternateText(row)
  if (alts.length) head += `  | also: ${alts.join('; ')}`
  return [
    head,
    ...[usageLine(usage), creditLine(usage), refusalLine(row.last_refusal)]
      .filter(Boolean)
      .map((text) => `    ${text}`),
  ]
}

/** `st models route --role R`: each tool's option for the job, with its facts. */
export function formatOptions(payload: RoutePayload, role: string, project?: string): string {
  const where = project ? ` project=${project}` : ''
  const lines = [
    `OPTIONS[${role}${where}] policy=v${payload.version} facts as of ${when(payload.facts_as_of)}; you choose, then st aico create --work-role ${role}${project ? ` --project ${project}` : ''} --tool T [--model M]`,
  ]
  if (!payload.facts_as_of)
    lines.push('  usage facts unavailable; allowed and denied are still right')
  for (const row of payload.rows) lines.push(...optionLines(row))
  return lines.join('\n')
}

/** `st models route --role R --tool T`: one row with its reasons. */
export function formatLaunch(payload: RoutePayload): string {
  const row = payload.rows[0] as LaunchRow
  const lines = [
    `LAUNCH[${payload.role} ${row.tool}] job=${row.job} (${row.label}) policy=v${payload.version}`,
    `  model=${row.model || '-'} effort=${row.effort || '-'} daybreak=${daybreakWord(row.daybreak)} context=${row.context}${row.use && row.launchable ? '' : ' (not used: no default applies)'}${projectTag(row)}`,
  ]
  if (!row.allowed) lines.push(`  DENIED: ${row.deny_reason || '-'}`)
  if (row.note) lines.push(`  note=${row.note}`)
  if (row.when) lines.push(`  when=${row.when}`)
  for (const alt of row.alternates)
    lines.push(`  instead: ${modelEffort(alt)} when ${alt.when || '-'}`)
  if (row.subagent) lines.push(`  native subagent: ${row.subagent}`)
  lines.push(`  why=${row.why || '-'}`)
  if (row.allowed) {
    const usage = row.usage ?? {}
    lines.push(`  usage: ${statusText(usage)}`)
    for (const text of [usageLine(usage), creditLine(usage), refusalLine(row.last_refusal)])
      if (text) lines.push(`    ${text}`)
  }
  return lines.join('\n')
}
