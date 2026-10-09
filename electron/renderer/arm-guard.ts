// Destructive-action arming ("click again to confirm"). Replace-with-<TUI>
// actions kill whatever's running in the focused pane, and the launchers can be
// pinned to the titlebar where a stray click is easy. So they arm on the first
// click and only run on a deliberate second click on the same target within
// ARM_MS. Any timeout, mouse-leave, or other click disarms.

export const ARM_MS = 3000

/** All destructive to the focused pane's session, so all arm before they fire:
 * replace = different TUI, project = same TUI in a new dir, retire = end the pane. */
export function needsConfirm(id: string): boolean {
  return id.startsWith('replace:') || id.startsWith('project:') || id === 'retire-widget'
}

type ArmGuardOptions<T> = {
  onArm: (target: T) => void
  onDisarm: (target: T) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export function createArmGuard<T>({
  onArm,
  onDisarm,
  setTimer = (fn, ms) => window.setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer as number),
}: ArmGuardOptions<T>) {
  let armed: T | null = null
  let timer: unknown

  function disarm(): void {
    if (armed !== null) {
      onDisarm(armed)
      armed = null
    }
    if (timer) {
      clearTimer(timer)
      timer = undefined
    }
  }

  return {
    /** True if this activation only ARMED the action (the caller must not run it
     * yet); false means run now (a non-guarded action or the confirming repeat). */
    guard(id: string, target: T): boolean {
      if (!needsConfirm(id)) return false
      if (armed === target) {
        disarm() // second activation on the same target → confirm
        return false
      }
      disarm() // clear any other armed target first
      armed = target
      onArm(target)
      timer = setTimer(disarm, ARM_MS)
      return true
    },
    /** Disarm only if `target` is the armed one (mouse-leave / blur). */
    release(target: T): void {
      if (armed === target) disarm()
    },
    disarm,
  }
}
