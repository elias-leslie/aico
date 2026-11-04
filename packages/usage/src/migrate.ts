// Copies Agent Hub's usage accounting in (cutlist 3.1, M8-1) and can run again any time:
//   - plans and credit lots -> the plans file (written when absent; an existing file is
//     kept and compared, `replace` rewrites it);
//   - daily rows before the cutover day -> usage.db (from the cutover day on, the
//     collector counts them, so nothing is counted twice);
//   - the newest reading of each provider window and the refusals -> usage.db.
// Nothing here prints or logs a row's values: the result holds counts and sha256 hashes.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { transaction } from '@aico/store'
import config from '../data/usage.json' with { type: 'json' }
import { type Database, getState, putState } from './db'
import { type Lot, localDay, type Plan, type Plans, plansText } from './plans'

/** Read-only access to Agent Hub's database: one SELECT whose single column is a JSON value per row. */
export interface UsageSource {
  rows(sql: string): string[]
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const PLAN_COLUMNS = [
  'provider',
  'plan',
  'monthly_usd',
  'price_verified',
  'effective_from',
  'effective_to',
  'evidence',
] as const
const LOT_COLUMNS = [
  'provider',
  'source',
  'credits',
  'granted_at',
  'expires_at',
  'value_usd_per_credit',
  'paid_usd',
  'evidence',
] as const
export const DAILY_COLUMNS = [
  'day',
  'provider',
  'model',
  'project',
  'speed',
  'requests',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_tokens',
  'output_tokens',
  'api_equiv_usd',
  'unpriced_tokens',
  'credits_drawn',
] as const
const READING_COLUMNS = [
  'provider',
  'window_minutes',
  'observed_at',
  'used_percent',
  'resets_at',
  'source',
  'plan_type',
] as const

// Byte order, as SQLite sorts the same text.
const DAILY_ORDER =
  'day, provider COLLATE "C", model COLLATE "C", project COLLATE "C", speed COLLATE "C"'

const select = (columns: readonly string[], from: string, order: string, where = '') =>
  `SELECT row_to_json(t)::text FROM (SELECT ${columns.join(', ')} FROM ${from} ${where} ORDER BY ${order}) t`

const SQL = {
  plans: select(PLAN_COLUMNS, 'subscription_plans', 'id'),
  lots: select(LOT_COLUMNS, 'credit_lots', 'id'),
  daily: (cutover: string) =>
    select(DAILY_COLUMNS, 'subscription_usage_daily', DAILY_ORDER, `WHERE day < '${cutover}'`),
  dailyHash: (cutover: string) => `SELECT to_json(encode(sha256(convert_to(coalesce(
      string_agg(row_to_json(t)::text, E'\\n' ORDER BY t.day, t.provider COLLATE "C", t.model COLLATE "C", t.project COLLATE "C", t.speed COLLATE "C"), ''), 'UTF8')), 'hex'))::text
      FROM (SELECT ${DAILY_COLUMNS.join(', ')} FROM subscription_usage_daily WHERE day < '${cutover}') t`,
  readings: `SELECT row_to_json(t)::text FROM (SELECT DISTINCT ON (provider, window_minutes)
      ${READING_COLUMNS.join(', ')} FROM subscription_usage_snapshots
      WHERE observed_at >= now() - interval '${config.lookback_days} days'
      ORDER BY provider, window_minutes, observed_at DESC, used_percent DESC) t`,
  refusals: `SELECT row_to_json(t)::text FROM (SELECT e.created_at AS at,
      e.usage->'provider_outcome'->>'requested_model' AS requested_model,
      e.usage->'provider_outcome'->>'category' AS category,
      s.provider_metadata->'work_role'->>'id' AS role, s.project_id AS project
      FROM session_events e LEFT JOIN sessions s ON s.id = e.session_id
      WHERE e.usage->'provider_outcome'->>'kind' = 'refused'
        AND e.usage->'provider_outcome'->>'requested_model' IS NOT NULL
      ORDER BY e.created_at DESC LIMIT 1000) t`,
}

const parse = <T>(source: UsageSource, sql: string): T[] =>
  source.rows(sql).map((text) => JSON.parse(text) as T)

export interface ImportResult {
  plans: number
  lots: number
  /** 'written' (new file or replaced), 'unchanged', or 'differs' (kept: Aico's file is the owner's). */
  plansFile: 'written' | 'unchanged' | 'differs'
  /** The first day the collector counts; earlier days came from Agent Hub. */
  cutoverDay: string
  daily: number
  readings: number
  refusals: number
  /** sha256 of the daily rows: in Agent Hub, as received, and as stored here. */
  dailyHash: { source: string; received: string; stored: string; match: boolean }
}

/** The daily rows as stored here, in Agent Hub's row_to_json text, one per line. */
export function storedDailyText(db: Database, cutover: string): string {
  const rows = db
    .prepare(
      `SELECT ${DAILY_COLUMNS.join(', ')} FROM daily WHERE day < ? ORDER BY day, provider, model, project, speed`,
    )
    .all(cutover) as Record<string, unknown>[]
  return rows
    .map((row) =>
      JSON.stringify(Object.fromEntries(DAILY_COLUMNS.map((column) => [column, row[column]]))),
    )
    .join('\n')
}

const pick = <T>(row: Record<string, unknown>, columns: readonly string[]): T =>
  Object.fromEntries(columns.map((column) => [column, row[column] ?? null])) as T

const iso = (value: string) => new Date(Date.parse(value)).toISOString()

export interface ImportOptions {
  plansPath: string
  /** Rewrite an existing plans file with Agent Hub's rows. */
  replacePlans?: boolean
  now: number
}

export function importAgentHub(
  db: Database,
  source: UsageSource,
  options: ImportOptions,
): ImportResult {
  const cutoverDay = getState<string>(db, 'cutover_day') ?? localDay(options.now)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverDay)) throw new Error('the cutover day is not a date')
  const plans: Plans = {
    plans: parse<Record<string, unknown>>(source, SQL.plans).map((row) =>
      pick<Plan>(row, PLAN_COLUMNS),
    ),
    lots: parse<Record<string, unknown>>(source, SQL.lots).map((row) =>
      pick<Lot>(row, LOT_COLUMNS),
    ),
  }
  const wanted = plansText(plans)
  let plansFile: ImportResult['plansFile']
  if (!existsSync(options.plansPath) || options.replacePlans) {
    // Owner data: 0600, written whole and moved into place.
    const tmp = `${options.plansPath}.tmp`
    writeFileSync(tmp, wanted, { mode: 0o600 })
    renameSync(tmp, options.plansPath)
    plansFile = 'written'
  } else {
    const same = sha256(readFileSync(options.plansPath, 'utf8')) === sha256(wanted)
    plansFile = same ? 'unchanged' : 'differs'
  }

  const lines = source.rows(SQL.daily(cutoverDay))
  const [sourceHash] = parse<string>(source, SQL.dailyHash(cutoverDay))
  const readings = parse<Record<string, unknown>>(source, SQL.readings)
  const refusals = parse<Record<string, unknown>>(source, SQL.refusals)

  transaction(db, () => {
    putState(db, 'cutover_day', cutoverDay)
    db.prepare('DELETE FROM daily WHERE day < ?').run(cutoverDay)
    const put = db.prepare(
      `INSERT INTO daily (${DAILY_COLUMNS.join(', ')}) VALUES (${DAILY_COLUMNS.map(() => '?').join(', ')})`,
    )
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, string | number | null>
      put.run(...DAILY_COLUMNS.map((column) => row[column] ?? null))
    }
    const putReading = db.prepare(
      `INSERT OR IGNORE INTO readings (${READING_COLUMNS.join(', ')}) VALUES (${READING_COLUMNS.map(() => '?').join(', ')})`,
    )
    for (const row of readings)
      putReading.run(
        ...READING_COLUMNS.map((column) =>
          (column === 'observed_at' || column === 'resets_at') && row[column]
            ? iso(row[column] as string)
            : ((row[column] ?? null) as string | number | null),
        ),
      )
    db.exec('DELETE FROM refusals WHERE imported = 1')
    const putRefusal = db.prepare(
      'INSERT INTO refusals (requested_model, at, role, project, category, imported) VALUES (?, ?, ?, ?, ?, 1)',
    )
    for (const row of refusals)
      putRefusal.run(
        row.requested_model as string,
        row.at as string,
        (row.role ?? null) as string | null,
        (row.project ?? null) as string | null,
        (row.category ?? null) as string | null,
      )
  })

  const received = sha256(lines.join('\n'))
  const stored = sha256(storedDailyText(db, cutoverDay))
  return {
    plans: plans.plans.length,
    lots: plans.lots.length,
    plansFile,
    cutoverDay,
    daily: lines.length,
    readings: readings.length,
    refusals: refusals.length,
    dailyHash: {
      source: sourceHash ?? '',
      received,
      stored,
      match: sourceHash === received && received === stored,
    },
  }
}
