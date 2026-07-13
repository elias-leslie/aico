import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

function projectFile(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

describe('desktop launcher ownership contract', () => {
  it('execs the real Electron binary so systemd tracks the window owner', () => {
    const runner = projectFile('scripts/aico-run-foreground.sh')

    expect(runner).toContain('exec ./node_modules/electron/dist/electron .')
    expect(runner).not.toContain('exec ./node_modules/.bin/electron .')
  })

  it('routes desktop activation through the canonical managed service', () => {
    const launcher = projectFile('scripts/aico-launch.sh')

    expect(launcher).toContain('RUNTIME_UNIT="aico-shell.service"')
    expect(launcher).toContain('systemctl --user start "$RUNTIME_UNIT"')
    expect(launcher).not.toContain('systemd-run --user')
    expect(launcher).not.toContain('RUNTIME_UNIT="aico-shell-runtime.service"')
  })

  it('gates early boot on DISPLAY and conflicts only the historical desktop unit', () => {
    const unit = projectFile('scripts/systemd/aico-shell.service')

    expect(unit).toContain('ConditionEnvironment=DISPLAY')
    expect(unit).toContain('Conflicts=aico-shell-runtime.service')
    expect(unit).toContain('Environment=AICO_WORKLOAD_CLASS=desktop-runtime')
    expect(unit).not.toMatch(/Conflicts=.*(?:tmux|codex)/)
  })

  it('accepts only the PID-derived desktop scope when Electron is reclassified', () => {
    const launcher = projectFile('scripts/aico-launch.sh')
    const stopper = projectFile('scripts/aico-stop.sh')

    expect(launcher).toMatch(/unit="app-aico-\$\{pid\}\.scope"/)
    expect(launcher).toContain('process_is_tracked_aico_application_scope "$PID"')
    expect(launcher).not.toMatch(/systemctl --user (?:stop|kill) ["']?app-aico-\*/)
    expect(stopper).toMatch(/unit="app-aico-\$\{pid\}\.scope"/)
    expect(stopper).toContain('process_is_tracked_aico_application_scope')
    expect(stopper).toContain('--property=InvocationID')
    expect(stopper).toContain('[ -z "$application_scope_identity" ] &&')
    expect(stopper).toContain('[ "$main_pid_environment_verified" -ne 1 ]')
    expect(stopper).toContain('systemctl --user stop "$application_scope_unit"')
    expect(stopper).toContain("grep -Fxq 'populated 0'")
    expect(stopper).not.toMatch(/systemctl --user (?:stop|kill) ["']?app-aico-\*/)
  })
})
