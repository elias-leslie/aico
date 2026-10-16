import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

function projectFile(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

describe('desktop launcher ownership contract', () => {
  it('execs the real Electron binary so systemd tracks the window owner', () => {
    const runner = projectFile('scripts/aico-run-foreground.sh')
    const packageManifest = JSON.parse(projectFile('package.json')) as {
      scripts: { postinstall?: string }
    }

    expect(runner).toContain('exec ./node_modules/electron/dist/electron .')
    expect(packageManifest.scripts.postinstall).toBe('install-electron')
  })

  it('routes desktop activation through the canonical managed service', () => {
    const launcher = projectFile('scripts/aico-launch.sh')

    expect(launcher).toContain('RUNTIME_UNIT="aico-shell.service"')
    expect(launcher).toContain('systemctl --user start "$RUNTIME_UNIT"')
  })

  it('gates early boot on DISPLAY and conflicts with nothing', () => {
    const unit = projectFile('scripts/systemd/aico-shell.service')

    expect(unit).toContain('ConditionEnvironment=DISPLAY')
    expect(unit).toContain('Environment=AICO_WORKLOAD_CLASS=desktop-runtime')
    expect(unit).not.toMatch(/^Conflicts=/m)
  })

  it('knows only the one canonical runtime unit', () => {
    for (const path of [
      'scripts/systemd/aico-shell.service',
      'scripts/aico-run-foreground.sh',
      'scripts/aico-stop.sh',
    ]) {
      expect(projectFile(path), path).not.toContain('aico-shell-runtime')
    }
  })

  it('hands Electron the pidfile so a clean quit can clear it', () => {
    const runner = projectFile('scripts/aico-run-foreground.sh')

    expect(runner).toContain('export AICO_PIDFILE="$PIDFILE"')
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

describe('foreground runner build step', () => {
  // Run the runner's own release check against throwaway directories; the rest
  // of the script refuses to run outside the exact systemd unit.
  const runner = projectFile('scripts/aico-run-foreground.sh')
  const check = runner.match(/^prebuilt_release\(\) \{\n[\s\S]*?\n\}\n/m)?.[0]

  function prebuilt(repo: string): boolean {
    try {
      execFileSync('bash', ['-c', `${check}\nREPO="$1"\nprebuilt_release`, 'test', repo])
      return true
    } catch {
      return false
    }
  }

  function tree(root: string, path: string, { built = true, git = false } = {}): string {
    const repo = join(root, path)
    mkdirSync(join(repo, 'out/main'), { recursive: true })
    if (built) {
      mkdirSync(join(repo, 'out/preload'), { recursive: true })
      mkdirSync(join(repo, 'out/renderer'), { recursive: true })
      writeFileSync(join(repo, 'out/main/index.js'), 'x')
      writeFileSync(join(repo, 'out/preload/index.cjs'), 'x')
      writeFileSync(join(repo, 'out/renderer/index.html'), 'x')
    }
    if (git) mkdirSync(join(repo, '.git'))
    return repo
  }

  it('skips the build only for a built managed release', () => {
    expect(check).toBeTruthy()
    const root = mkdtempSync(join(tmpdir(), 'aico-runner-'))
    try {
      const id = 'fb194fea91514420903783372c60afb5'
      expect(prebuilt(tree(root, `a/releases/${id}/source`))).toBe(true)
      // A source checkout always rebuilds, even with a leftover out/.
      expect(prebuilt(tree(root, 'checkout', { git: true }))).toBe(false)
      expect(prebuilt(tree(root, `b/releases/${id}/source`, { git: true }))).toBe(false)
      // A release whose build is missing or partial still builds.
      expect(prebuilt(tree(root, `c/releases/${id}/source`, { built: false }))).toBe(false)
      // Only a 32-hex build id under releases/ counts.
      expect(prebuilt(tree(root, 'd/releases/latest/source'))).toBe(false)
      expect(prebuilt(tree(root, `e/other/${id}/source`))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds unless that check passes', () => {
    expect(runner).toMatch(/if prebuilt_release; then[\s\S]*?else\n\s*npm run build\nfi/)
  })
})
