/** The state chips a collapsed row's value can wear (the status-chip classes). */
export type GlanceTone =
  | 'ok'
  | 'warn'
  | 'failed'
  | 'late'
  | 'unknown'
  | 'off'
  | 'running'

/** What a glance tells its collapsed row: one short value beside the label. */
export interface GlanceHead {
  /** "60 problems", "72% left", "20 active"; or why there is none ("Checking…", "Couldn’t read"). */
  value: string | null
  /** The chip it wears when the value is a state; null for a plain value. */
  tone: GlanceTone | null
  /** How many things in this section need the owner to act (a late backup, a machine that is down): the
   * System section opens by itself for these and for nothing else. Absent or 0: nothing does. */
  needs?: number
}
