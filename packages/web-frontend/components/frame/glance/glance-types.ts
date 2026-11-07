/** What a glance tells its heading, whether or not its body is showing. */
export interface GlanceHead {
  /** Short and beside the heading ("9 problems", "4 up, 4 off"); null when unread or not wanted. */
  count: string | null
  /** The one line shown under a folded heading, or the reason there is no count. Null when the count says it all. */
  line: string | null
}
