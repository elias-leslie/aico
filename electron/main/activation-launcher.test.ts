import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const launcher = resolve(import.meta.dirname, '../../scripts/aico-launch.sh')
const children: ChildProcess[] = []
const fixtures: string[] = []

interface Fixture {
  electron: string
  launch: () => { child: ChildProcess; completed: Promise<{ code: number | null; stderr: string }> }
  marker: string
  activations: string
  timeoutArgs: string
  pid: number
  starttime: string
}

function fixture(helperExit = 0, fakeTimeout = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'aico-launch-test-'))
  fixtures.push(root)
  const repo = join(root, 'repo')
  const state = join(root, 'state')
  const electron = join(repo, 'node_modules/electron/dist/electron')
  const marker = join(state, 'aico/activation.ready')
  const activations = join(root, 'activations')
  const timeoutArgs = join(root, 'timeout-args')
  mkdirSync(dirname(electron), { recursive: true })
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(
    electron,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AICO_TEST_ACTIVATIONS"\nexit "$AICO_TEST_HELPER_EXIT"\n',
    { mode: 0o755 },
  )

  // A real live PID supplies procfs liveness, cwd, and the Linux start time.
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: repo,
    stdio: 'ignore',
  })
  children.push(owner)
  if (!owner.pid) throw new Error('fixture owner did not start')
  const pid = owner.pid
  writeFileSync(join(state, 'aico/aico.pid'), `${pid}\n`)
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  if (!starttime) throw new Error('fixture owner has no Linux start time')

  // Bash functions replace only the systemd and executable identity boundaries.
  // The launcher itself, its lock, PID checks, marker checks, and helper call run.
  const shell = `
systemctl() {
  case "$*" in
    *--property=WorkingDirectory*) printf '%s\\n' "$AICO_TEST_REPO" ;;
    *--property=MainPID*) printf '%s\\n' "$AICO_TEST_PID" ;;
    *--property=ActiveState*) printf 'active\\n' ;;
    *--property=ControlGroup*) printf '%s\\n' "$AICO_TEST_GROUP" ;;
    *) return 1 ;;
  esac
}
readlink() {
  if [ "$1" = -f ] && [ "\${2:-}" = "/proc/$AICO_TEST_PID/exe" ]; then
    printf '%s\\n' "$AICO_TEST_ELECTRON"
  else
    command readlink "$@"
  fi
}
awk() {
  if [ "\${!#}" = "/proc/$AICO_TEST_PID/cgroup" ]; then
    printf '%s\\n' "$AICO_TEST_GROUP"
  else
    command awk "$@"
  fi
}
timeout() {
  if [ "$AICO_TEST_FAKE_TIMEOUT" = 1 ]; then
    printf '%s\\n' "$@" > "$AICO_TEST_TIMEOUT_ARGS"
    return 124
  fi
  command timeout "$@"
}
export -f systemctl readlink awk timeout
exec bash "$1"
`
  const env = {
    ...process.env,
    AICO_REPO_ROOT: repo,
    AICO_TEST_REPO: repo,
    AICO_TEST_PID: String(pid),
    AICO_TEST_GROUP: `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/aico-shell.service`,
    AICO_TEST_ELECTRON: electron,
    AICO_TEST_ACTIVATIONS: activations,
    AICO_TEST_HELPER_EXIT: String(helperExit),
    AICO_TEST_FAKE_TIMEOUT: fakeTimeout ? '1' : '0',
    AICO_TEST_TIMEOUT_ARGS: timeoutArgs,
    XDG_STATE_HOME: state,
    DISPLAY: ':test',
  }

  return {
    electron,
    marker,
    activations,
    timeoutArgs,
    pid,
    starttime,
    launch: () => {
      const child = spawn('bash', ['-c', shell, 'launcher-fixture', launcher], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      children.push(child)
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const completed = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve({ code, stderr }))
      })
      return { child, completed }
    },
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop launcher activation readiness', () => {
  it('waits for the matching ready marker before invoking the activation helper', async () => {
    const setup = fixture()
    const { child, completed } = setup.launch()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(child.exitCode).toBeNull()
    expect(existsSync(setup.activations)).toBe(false)

    writeFileSync(setup.marker, `${setup.pid} ${setup.starttime}\n`)
    const result = await completed
    expect(result).toMatchObject({ code: 0 })
    expect(readFileSync(setup.activations, 'utf8')).toBe('. --aico-activate\n')
  }, 10_000)

  it('rejects a marker from an earlier incarnation of the same PID', async () => {
    const setup = fixture()
    writeFileSync(setup.marker, `${setup.pid} 0\n`)
    const { child, completed } = setup.launch()
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(child.exitCode).toBeNull()
    expect(existsSync(setup.activations)).toBe(false)

    writeFileSync(setup.marker, `${setup.pid} ${setup.starttime}\n`)
    expect((await completed).code).toBe(0)
    expect(readFileSync(setup.activations, 'utf8')).toBe('. --aico-activate\n')
  }, 10_000)

  it('returns the activation helper failure to the desktop caller', async () => {
    const setup = fixture(42)
    writeFileSync(setup.marker, `${setup.pid} ${setup.starttime}\n`)
    const result = await setup.launch().completed
    expect(readFileSync(setup.activations, 'utf8')).toBe('. --aico-activate\n')
    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toContain('activated managed runtime')
  }, 10_000)

  it('uses a bounded helper call and reports timeout as failed activation', async () => {
    const setup = fixture(0, true)
    writeFileSync(setup.marker, `${setup.pid} ${setup.starttime}\n`)
    const result = await setup.launch().completed
    expect(readFileSync(setup.timeoutArgs, 'utf8')).toBe(
      `--foreground\n--kill-after=2s\n10s\n${setup.electron}\n.\n--aico-activate\n`,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toContain('activated managed runtime')
  }, 10_000)
})
