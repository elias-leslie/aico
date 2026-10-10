// Turns the terminal's raw output bursts (on while bytes flow, off ~0.5s after
// they stop) into the steadier signal the arcade wants: "the agent is working"
// once output has kept coming for a while, and "done" once it has been quiet
// for a few seconds. Typing echoes back as output, so output right after a
// keystroke doesn't count as work.

export const START_AFTER_MS = 1500 // sustained output before it counts as work
export const DONE_AFTER_MS = 3000 // quiet before work counts as finished
export const INPUT_ECHO_MS = 1000 // output this soon after typing is echo
export const GAP_MS = 1000 // a pause this short doesn't break a stretch of output

export class ActivityGate {
  private flowing = false
  private runStart = 0 // when the current stretch of output began (0 = none)
  private lastInput = -Infinity
  private busySince = 0 // 0 = not working
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly emit: (busy: boolean, ranMs: number) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Output started (true) or settled (false). */
  output(on: boolean): void {
    this.flowing = on
    const now = this.now()
    if (on && !this.runStart) this.runStart = now
    this.check()
  }

  /** The user typed something. */
  input(): void {
    this.lastInput = this.now()
    // a stretch of output that is only echo starts again after the typing
    if (!this.busySince && this.runStart) this.runStart = this.lastInput
  }

  private check(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const now = this.now()
    if (this.flowing) {
      if (this.busySince) return
      const startAt = Math.max(this.runStart + START_AFTER_MS, this.lastInput + INPUT_ECHO_MS)
      if (now >= startAt) {
        this.busySince = now
        this.emit(true, 0)
      } else this.wait(startAt - now)
      return
    }
    // quiet: a short pause inside a stretch of output doesn't end it
    if (!this.busySince) {
      this.wait(GAP_MS, () => {
        if (!this.flowing && !this.busySince) this.runStart = 0
      })
      return
    }
    this.wait(DONE_AFTER_MS, () => {
      if (this.flowing || !this.busySince) return
      const ran = this.now() - this.busySince
      this.busySince = 0
      this.runStart = 0
      this.emit(false, ran)
    })
  }

  private wait(ms: number, then: () => void = () => this.check()): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      then()
    }, ms)
  }
}
