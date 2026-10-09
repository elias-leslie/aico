// Loopback CDP driver for a packaged Aico widget on the private Xvfb display.
const [portText, action, sidecarPortText] = process.argv.slice(2)
const port = Number(portText)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid CDP port')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function rendererTarget(deadline = Date.now() + 30_000) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      })
      const targets = await res.json()
      const target = targets.find(
        (item) =>
          item.type === 'page' &&
          item.url?.includes('/renderer/index.html') &&
          typeof item.webSocketDebuggerUrl === 'string',
      )
      if (target) return target
    } catch {
      // The packaged main process is still starting or restarting.
    }
    await sleep(200)
  }
  throw new Error('timed out waiting for packaged renderer CDP target')
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP handshake timeout')), 5000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('CDP handshake failed'))
      },
      { once: true },
    )
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP socket closed'))
    }
    pending.clear()
  })
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const commandId = ++id
      const timer = setTimeout(() => {
        pending.delete(commandId)
        reject(new Error(`${method} timed out`))
      }, 7000)
      pending.set(commandId, { resolve, reject, timer })
      socket.send(JSON.stringify({ id: commandId, method, params }))
    })
  await command('Runtime.enable')
  const evaluate = async (expression) => {
    const response = await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response.exceptionDetails) {
      throw new Error(`renderer evaluation failed: ${response.exceptionDetails.text}`)
    }
    return response.result?.value
  }
  return { socket, command, evaluate }
}

const target = await rendererTarget()
const { socket, command, evaluate } = await connect(target.webSocketDebuggerUrl)
const key = async (type, name, code, virtualKeyCode) =>
  command('Input.dispatchKeyEvent', {
    type,
    key: name,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  })
const wheel = async (x, y, deltaY) =>
  command('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY,
  })
try {
  if (action === 'ready') {
    const deadline = Date.now() + 30_000
    let state
    do {
      state = await evaluate(`({
        preload: typeof window.aico?.pty?.input === 'function',
        terminal: !!document.querySelector('#terminal .xterm-screen'),
        menu: !!document.querySelector('#aico-menu .aico-row'),
        close: !!document.querySelector('.ctl.close')
      })`)
      if (Object.values(state).every(Boolean)) break
      await sleep(200)
    } while (Date.now() < deadline)
    if (!Object.values(state).every(Boolean))
      throw new Error(`renderer not ready: ${JSON.stringify(state)}`)
    const diagnostics = await evaluate('window.aico.actions.sessionDiagnostics()')
    console.log(JSON.stringify({ action, state, diagnosticsError: diagnostics?.error ?? null }))
    if (diagnostics?.error) throw new Error(`session diagnostics: ${diagnostics.error}`)
  } else if (action === 'run-output') {
    const pythonCommand =
      "python3 -c 'import time; [print(i, flush=True) or time.sleep(0.003) for i in range(5000)]'"
    const start = Date.now()
    const focused = await evaluate(`(() => {
      const input = document.querySelector('#terminal .xterm-helper-textarea');
      input?.focus();
      window.__aicoSmokePulse = { gaps: [], last: performance.now() };
      window.__aicoSmokePulse.timer = setInterval(() => {
        const now = performance.now();
        const pulse = window.__aicoSmokePulse;
        pulse.gaps.push(now - pulse.last);
        pulse.last = now;
      }, 50);
      return document.activeElement === input;
    })()`)
    if (!focused) throw new Error('xterm keyboard input is not focused')
    await command('Input.insertText', { text: pythonCommand })
    await key('keyDown', 'Enter', 'Enter', 13)
    await key('keyUp', 'Enter', 'Enter', 13)
    let maxPingMs = 0
    const pings = []
    let output = { lines: 0, hasLast: false }
    let lastCapture = 0
    while (Date.now() - start < 40_000) {
      const pingStart = performance.now()
      const responsive = await evaluate(
        '({mounted: !!document.querySelector("#terminal .xterm-screen"), now: performance.now()})',
      )
      const ping = performance.now() - pingStart
      pings.push(ping)
      maxPingMs = Math.max(maxPingMs, ping)
      if (!responsive?.mounted) throw new Error('terminal renderer unmounted during output')
      if (Date.now() - lastCapture >= 2_000) {
        output = await evaluate(`window.aico.scrollback.capture().then((text) => {
          const numbers = new Set(text.split(/\\r?\\n/).map((line) => line.trim())
            .filter((line) => /^\\d{1,4}$/.test(line)).map(Number));
          return { lines: numbers.size, hasLast: numbers.has(4999) };
        })`)
        lastCapture = Date.now()
      }
      if (output?.hasLast && output.lines === 5000) break
      await sleep(250)
    }
    const pulse = await evaluate(`(() => {
      const pulse = window.__aicoSmokePulse;
      clearInterval(pulse.timer);
      return { count: pulse.gaps.length, maxGapMs: Math.round(Math.max(...pulse.gaps)),
        meanGapMs: Math.round(pulse.gaps.reduce((a,b) => a+b, 0) / pulse.gaps.length) };
    })()`)
    const result = {
      action,
      command: pythonCommand,
      outputLines: output?.lines,
      saw4999: output?.hasLast,
      outputLatencyMs: Date.now() - start,
      rendererPings: pings.length,
      maxRendererPingMs: Math.round(maxPingMs),
      meanRendererPingMs: Math.round(pings.reduce((a, b) => a + b, 0) / pings.length),
      rendererInterval: pulse,
    }
    console.log(JSON.stringify(result))
    if (!output?.hasLast || output.lines !== 5000)
      throw new Error('5000-line terminal output incomplete')
    if (maxPingMs > 2000) throw new Error('renderer ping exceeded 2 seconds')
  } else if (action === 'scrollback') {
    // Deep tmux history: more than the overlay's 10k-line window, so paging,
    // window slides, and copies that cross page boundaries are all exercised.
    const FIXTURE_LINES = 30_000
    const fixture = `python3 -c 'for i in range(${FIXTURE_LINES}): print("AICO_SCROLL_"+str(i))'`
    const last = `AICO_SCROLL_${FIXTURE_LINES - 1}`
    const focused = await evaluate(`(() => {
      const input = document.querySelector('#terminal .xterm-helper-textarea');
      input?.focus();
      return document.activeElement === input;
    })()`)
    if (!focused) throw new Error('xterm keyboard input is not focused for scrollback fixture')
    await command('Input.insertText', { text: fixture })
    await key('keyDown', 'Enter', 'Enter', 13)
    await key('keyUp', 'Enter', 'Enter', 13)
    let tail
    for (let i = 0; i < 150; i++) {
      tail =
        await evaluate(`window.aico.scrollback.page({ count: 100 }).then(({ totalLines, text }) => ({
        totalLines, fixtureDone: text.includes(${JSON.stringify(last)})
      }))`)
      if (tail.fixtureDone) break
      await sleep(100)
    }
    if (!tail?.fixtureDone || tail.totalLines < FIXTURE_LINES) {
      throw new Error(`scrollback fixture incomplete: ${JSON.stringify(tail)}`)
    }
    await sleep(300)
    const firstLine = await evaluate(
      'window.aico.scrollback.page({ fromLine: 0, count: 1, plain: true }).then(({ text }) => text.split(/\\r?\\n/)[0].trimEnd())',
    )

    // Geometry of the live or overlay xterm screen. Rows come from the char
    // measure so this works with both the WebGL and DOM renderers.
    const geometry = (overlayScreen) =>
      evaluate(`(() => {
      const overlay = document.querySelector('#scrollback-overlay');
      const screens = [...document.querySelectorAll('#terminal .xterm-screen')];
      const screen = screens.find((el) => ${overlayScreen} === !!overlay?.contains(el));
      const measure = screen?.parentElement?.querySelector('.xterm-char-measure-element');
      if (!screen || !measure) return null;
      const r = screen.getBoundingClientRect();
      const rows = Math.max(1, Math.round(r.height / measure.getBoundingClientRect().height));
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, rows, cellH: r.height / rows };
    })()`)
    const state = () =>
      evaluate(`(() => {
      const overlay = document.querySelector('#scrollback-overlay');
      const rail = document.querySelector('.scroll-rail');
      const thumb = rail?.querySelector('.scroll-rail-thumb');
      const railRect = rail?.getBoundingClientRect();
      const thumbRect = thumb?.getBoundingClientRect();
      return {
        overlay: !!overlay && getComputedStyle(overlay).display !== 'none',
        rail: !!rail && !rail.hidden,
        railRect: railRect && { left: railRect.left, top: railRect.top, right: railRect.right, bottom: railRect.bottom },
        thumbTop: thumbRect && railRect ? Math.round(thumbRect.top - railRect.top) : null,
        thumbHeight: thumbRect ? Math.round(thumbRect.height) : null,
      };
    })()`)
    const until = async (label, check, tries = 60) => {
      let value
      for (let i = 0; i < tries; i++) {
        value = await state()
        if (check(value)) return value
        await sleep(100)
      }
      throw new Error(`${label}: ${JSON.stringify(value)}`)
    }
    const mouse = (type, x, y, extra = {}) =>
      command('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' && !extra.buttons ? 'none' : 'left',
        ...extra,
      })
    const sentinel = 'AICO_CLIPBOARD_SENTINEL'
    const resetClipboard = () =>
      evaluate(`(window.aico.clipboard.write(${JSON.stringify(sentinel)}), true)`)
    const readClipboard = async () => {
      let text = sentinel
      for (let i = 0; i < 30; i++) {
        text = await evaluate('window.aico.clipboard.read()')
        if (text !== sentinel) return text
        await sleep(100)
      }
      return text
    }
    const fixtureNumber = (line) => {
      const match = /^AICO_SCROLL_(\d+)$/.exec(line.trimEnd())
      return match ? Number(match[1]) : null
    }
    // A triple-click on the overlay's top row copies that whole line.
    const topLineText = async () => {
      const g = await geometry(true)
      if (!g) throw new Error('scrollback overlay screen missing')
      await resetClipboard()
      const x = g.left + 4
      const y = g.top + g.cellH / 2
      for (const clickCount of [1, 2, 3]) {
        await mouse('mousePressed', x, y, { clickCount, buttons: 1 })
        await mouse('mouseReleased', x, y, { clickCount, buttons: 0 })
      }
      return (await readClipboard()).trimEnd()
    }
    // A copy must be a run of consecutive fixture lines.
    const copiedRun = (text) => {
      const lines = text.split('\n').filter((line) => line.trim())
      const numbers = lines.map(fixtureNumber)
      const fixtureNumbers = numbers.filter((n) => n !== null)
      let consecutive = fixtureNumbers.length > 0
      for (let i = 1; i < fixtureNumbers.length; i++)
        if (fixtureNumbers[i] !== fixtureNumbers[i - 1] + 1) consecutive = false
      return {
        lines: lines.length,
        fixtureLines: fixtureNumbers.length,
        first: fixtureNumbers[0] ?? null,
        last: fixtureNumbers.at(-1) ?? null,
        consecutive,
      }
    }
    const dismissOverlay = async () => {
      await key('keyDown', 'Escape', 'Escape', 27)
      await key('keyUp', 'Escape', 'Escape', 27)
      await until('Escape did not dismiss scrollback overlay', (s) => !s.overlay)
    }

    // 1. The live view shows the rail at the bottom of the whole history.
    const live = await geometry(false)
    if (!live) throw new Error('live terminal screen missing')
    const center = {
      x: Math.round((live.left + live.right) / 2),
      y: Math.round((live.top + live.bottom) / 2),
    }
    await evaluate(
      `(() => { window.__aicoEnter = 0; document.querySelector('#terminal').addEventListener('mouseenter', () => window.__aicoEnter++); return true })()`,
    )
    await mouse('mouseMoved', center.x, center.y)
    let liveRail
    try {
      liveRail = await until('live rail did not appear', (s) => s.rail && s.thumbTop !== null)
    } catch (error) {
      const diag = await evaluate(
        `window.aico.scrollback.paneMode().then((mode) => ({ mode, enters: window.__aicoEnter, hasFocus: document.hasFocus() }))`,
      )
      throw new Error(`${error.message} diag=${JSON.stringify(diag)}`)
    }

    // 2. Wheel-up opens the overlay on the tail page.
    await wheel(center.x, center.y, -500)
    await until('wheel-up did not open scrollback overlay', (s) => s.overlay)
    await sleep(300)
    const afterWheel = await topLineText()

    // 3. Ctrl+Home seeks to the oldest line tmux holds.
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Home',
      code: 'Home',
      modifiers: 2,
      windowsVirtualKeyCode: 36,
    })
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Home',
      code: 'Home',
      modifiers: 2,
      windowsVirtualKeyCode: 36,
    })
    await sleep(800)
    const atOldest = await topLineText()
    if (atOldest !== firstLine) {
      throw new Error(
        `Ctrl+Home top line ${JSON.stringify(atOldest)} != oldest ${JSON.stringify(firstLine)}`,
      )
    }
    const oldestRail = await state()

    // 4. Wheel down through more than one window of history; newer pages load
    // and the oldest drop out, so the top line keeps advancing. Earlier smoke
    // output sits above the fixture, so the top line only becomes a fixture
    // line partway down.
    const og = await geometry(true)
    const ocenter = {
      x: Math.round((og.left + og.right) / 2),
      y: Math.round((og.top + og.bottom) / 2),
    }
    const progress = []
    let topNumber = -1
    for (let i = 0; i < 120 && topNumber < 15_000; i++) {
      await wheel(ocenter.x, ocenter.y, 3000)
      await sleep(i % 10 === 9 ? 400 : 60)
      if (i % 10 === 9) {
        const text = await topLineText()
        const n = fixtureNumber(text)
        progress.push(n ?? text)
        if (n === null && topNumber < 0) continue
        if (n === null || n <= topNumber)
          throw new Error(`paging down stalled at ${JSON.stringify(progress)}`)
        topNumber = n
      }
    }
    if (topNumber < 15_000)
      throw new Error(`paging down never passed line 15000: ${JSON.stringify(progress)}`)
    const deepRail = await state()

    // 5. Drag from a row to past the top edge and hold: the view autoscrolls
    // into older pages and the copy is the whole consecutive run.
    await resetClipboard()
    const anchorY = og.top + og.cellH * 10.5
    await mouse('mousePressed', og.right - 2, anchorY, { clickCount: 1, buttons: 1 })
    await mouse('mouseMoved', og.left + 1, og.top - og.cellH * 12, { buttons: 1 })
    await sleep(3000)
    await mouse('mouseReleased', og.left + 1, og.top - og.cellH * 12, { clickCount: 1, buttons: 0 })
    const autoscrollCopy = copiedRun(await readClipboard())
    if (!autoscrollCopy.consecutive || autoscrollCopy.fixtureLines < og.rows * 5) {
      throw new Error(
        `autoscroll drag copy is not a long consecutive run: ${JSON.stringify(autoscrollCopy)}`,
      )
    }
    if (autoscrollCopy.last !== topNumber + 10) {
      throw new Error(
        `autoscroll copy ends at ${autoscrollCopy.last}, anchor was ${topNumber + 10}`,
      )
    }
    await dismissOverlay()

    // 6. A drag that starts on the live view and runs off its top edge is
    // continued into history by the overlay.
    await resetClipboard()
    const liveAnchorY = live.top + live.cellH * 2.5
    await mouse('mousePressed', live.right - 2, liveAnchorY, { clickCount: 1, buttons: 1 })
    await mouse('mouseMoved', live.right - 2, live.top + live.cellH * 1.5, { buttons: 1 })
    await mouse('mouseMoved', live.left + 1, live.top - live.cellH * 12, { buttons: 1 })
    await until('live drag past the top did not open the overlay', (s) => s.overlay, 40)
    await sleep(1500)
    await mouse('mouseReleased', live.left + 1, live.top - live.cellH * 12, {
      clickCount: 1,
      buttons: 0,
    })
    const continuedCopy = copiedRun(await readClipboard())
    if (!continuedCopy.consecutive || continuedCopy.fixtureLines < live.rows * 2) {
      throw new Error(`live drag continuation copy is wrong: ${JSON.stringify(continuedCopy)}`)
    }
    await dismissOverlay()

    // 7. Pressing the rail's top seeks the overlay to the oldest history.
    await mouse('mouseMoved', center.x, center.y)
    const railNow = await until('rail missing before seek', (s) => s.rail && s.railRect)
    const railX = Math.round((railNow.railRect.left + railNow.railRect.right) / 2)
    await mouse('mousePressed', railX, railNow.railRect.top + 1, { clickCount: 1, buttons: 1 })
    await mouse('mouseReleased', railX, railNow.railRect.top + 1, { clickCount: 1, buttons: 0 })
    await until('rail press did not open the overlay', (s) => s.overlay)
    await sleep(500)
    const railSeekTop = await topLineText()
    if (railSeekTop !== firstLine) {
      throw new Error(
        `rail seek top line ${JSON.stringify(railSeekTop)} != oldest ${JSON.stringify(firstLine)}`,
      )
    }
    await dismissOverlay()

    console.log(
      JSON.stringify({
        action,
        totalLines: tail.totalLines,
        rows: live.rows,
        liveRail,
        afterWheel,
        atOldest,
        oldestRail,
        pagingProgress: progress,
        deepRail,
        autoscrollCopy,
        continuedCopy,
        railSeekTop,
      }),
    )
  } else if (action === 'mouse-program') {
    // Stand-in for Claude Code's fullscreen renderer: a program in the
    // alternate screen with SGR mouse reporting on. Plain drags and the wheel
    // must reach it; Shift-drag must still select locally.
    const runDir = sidecarPortText
    if (!runDir?.startsWith('/tmp/ar.')) throw new Error('mouse-program needs the smoke run dir')
    const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const program = `${runDir}/mouse-program.py`
    const log = `${runDir}/mouse-program.log`
    writeFileSync(
      program,
      [
        'import os, sys, termios, tty',
        'fd = 0',
        'old = termios.tcgetattr(fd)',
        'tty.setraw(fd)',
        'out = sys.stdout',
        "out.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h\\x1b[2J\\x1b[H')",
        "out.write('MOUSEPROG first row\\r\\nMOUSEPROG second row\\r\\n')",
        'out.flush()',
        `log = open(${JSON.stringify(log)}, 'ab')`,
        'while True:',
        '    data = os.read(fd, 1024)',
        '    log.write(data)',
        '    log.flush()',
        "    if b'q' in data:",
        '        break',
        "out.write('\\x1b[?1006l\\x1b[?1002l\\x1b[?1000l\\x1b[?1049l')",
        'out.flush()',
        'termios.tcsetattr(fd, termios.TCSADRAIN, old)',
        '',
      ].join('\n'),
    )
    const logText = () => (existsSync(log) ? readFileSync(log, 'latin1') : '')
    // Keystrokes are not under test here; send them on the PTY path directly.
    await evaluate(`(window.aico.pty.input(${JSON.stringify(`python3 ${program}\r`)}), true)`)
    let mode
    for (let i = 0; i < 50; i++) {
      mode = await evaluate('window.aico.scrollback.paneMode()')
      if (mode?.alternateScreen && mode.mouseReporting) break
      await sleep(100)
    }
    if (!mode?.alternateScreen || !mode.mouseReporting) {
      throw new Error(`mouse program did not take the mouse: ${JSON.stringify(mode)}`)
    }
    await sleep(1600) // let the renderer's cached pane mode refresh
    const g = await evaluate(`(() => {
      // The live screen, not the (hidden) scrollback overlay's.
      const overlay = document.querySelector('#scrollback-overlay');
      const screen = [...document.querySelectorAll('#terminal .xterm-screen')]
        .find((el) => !overlay?.contains(el));
      const measure = screen?.parentElement?.querySelector('.xterm-char-measure-element');
      const r = screen.getBoundingClientRect();
      const rows = Math.max(1, Math.round(r.height / measure.getBoundingClientRect().height));
      const m = measure.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, cellH: r.height / rows,
        cellW: m.width / Math.max(1, measure.textContent.length) };
    })()`)
    const mouse = (type, x, y, extra = {}) =>
      command('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra })
    const sentinel = 'AICO_CLIPBOARD_SENTINEL'
    await evaluate(`(window.aico.clipboard.write(${JSON.stringify(sentinel)}), true)`)
    await evaluate(`(() => {
      window.__aicoMouse = [];
      for (const type of ['mousedown', 'mouseup']) window.addEventListener(type, (e) => {
        window.__aicoMouse.push([type, e.isTrusted, e.shiftKey, e.target?.className ?? '', e.clientX, e.clientY]);
      }, true);
      return true;
    })()`)
    const diag = () =>
      evaluate(`({ g: ${JSON.stringify(g)}, events: window.__aicoMouse.slice(0, 12),
        railHidden: document.querySelector('.scroll-rail')?.hidden ?? null })`)
    const y0 = g.top + g.cellH * 0.5
    // Plain drag: the program gets press, motion and release.
    await mouse('mousePressed', g.left + 2, y0, { clickCount: 1, buttons: 1 })
    await mouse('mouseMoved', g.left + g.cellW * 9.5, y0, { buttons: 1 })
    await mouse('mouseReleased', g.left + g.cellW * 9.5, y0, { clickCount: 1, buttons: 0 })
    await sleep(400)
    const afterDrag = logText()
    const plainClipboard = await evaluate('window.aico.clipboard.read()')
    // Wheel: forwarded to the program as SGR wheel-up, no overlay.
    await wheel((g.left + g.right) / 2, (g.top + g.bottom) / 2, -120)
    await sleep(400)
    const afterWheel = logText()
    const overlayOpen = await evaluate(`(() => {
      const el = document.querySelector('#scrollback-overlay');
      return !!el && getComputedStyle(el).display !== 'none';
    })()`)
    // Shift-drag: local selection copies the program's text.
    const before = logText().length
    await mouse('mousePressed', g.left + 2, y0, { clickCount: 1, buttons: 1, modifiers: 8 })
    await mouse('mouseMoved', g.left + g.cellW * 9.5, y0, { buttons: 1, modifiers: 8 })
    await mouse('mouseReleased', g.left + g.cellW * 9.5, y0, {
      clickCount: 1,
      buttons: 0,
      modifiers: 8,
    })
    await sleep(400)
    const shiftClipboard = await evaluate('window.aico.clipboard.read()')
    const shiftReachedProgram = logText().length > before
    await evaluate("(window.aico.pty.input('q'), true)")
    for (let i = 0; i < 30; i++) {
      mode = await evaluate('window.aico.scrollback.paneMode()')
      if (!mode?.alternateScreen) break
      await sleep(100)
    }
    // SGR mouse reports: ESC [ < button ; col ; row M (press/motion) or m (release).
    const sgr = (button, final) => new RegExp(`\u001b\\[<${button};\\d+;\\d+${final}`)
    const result = {
      action,
      programGotPress: sgr(0, 'M').test(afterDrag),
      programGotMotion: sgr(32, 'M').test(afterDrag),
      programGotRelease: sgr(0, 'm').test(afterDrag),
      plainDragLeftClipboard: plainClipboard === sentinel,
      programGotWheel: sgr(64, 'M').test(afterWheel),
      overlayOpen,
      shiftClipboard,
      shiftReachedProgram,
      exited: !mode?.alternateScreen,
    }
    console.log(JSON.stringify(result))
    if (
      !result.programGotPress ||
      !result.programGotMotion ||
      !result.programGotRelease ||
      !result.plainDragLeftClipboard ||
      !result.programGotWheel ||
      result.overlayOpen ||
      !shiftClipboard.startsWith('MOUSEPROG') ||
      result.shiftReachedProgram ||
      !result.exited
    ) {
      throw new Error(
        `fullscreen mouse program did not get the expected mouse routing: ${JSON.stringify(await diag())}`,
      )
    }
  } else if (action === 'agent-routing') {
    // Stand-ins for agent TUIs, so the non-shell wheel route (tmux pane mode
    // -> forward/open/consume) runs without agent credentials. One fixture is
    // linked as `claude`, `codex` and `agy`; the process name is what the
    // widget's live TUI detection keys on, and the name picks the screen mode
    // each agent was observed in. `start` launches it; the caller then closes
    // and reopens the widget, whose attach reconciles the TUI; `check` routes.
    const runDir = sidecarPortText
    const [name, phase] = process.argv.slice(5)
    if (!runDir?.startsWith('/tmp/ar.')) throw new Error('agent-routing needs the smoke run dir')
    const agents = {
      claude: { tuiName: 'Claude Code', alternateScreen: true, mouseReporting: true },
      codex: { tuiName: 'Codex', alternateScreen: false, mouseReporting: false },
      agy: { tuiName: 'Antigravity', alternateScreen: true, mouseReporting: false },
    }
    const agent = agents[name]
    if (!agent || !['start', 'check'].includes(phase))
      throw new Error('usage: agent-routing <run-dir> <agent> start|check')
    const { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, chmodSync } =
      await import('node:fs')
    const bin = `${runDir}/agent-bin`
    const fixture = `${bin}/agent-fixture.py`
    const log = `${runDir}/agent-${name}.log`
    const logText = () => (existsSync(log) ? readFileSync(log, 'latin1') : '')
    const overlayOpen = () =>
      evaluate(`(() => {
      const el = document.querySelector('#scrollback-overlay');
      return !!el && getComputedStyle(el).display !== 'none';
    })()`)
    if (phase === 'start') {
      if (!existsSync(fixture)) {
        mkdirSync(bin, { recursive: true })
        writeFileSync(
          fixture,
          [
            '#!/usr/bin/python3', // not `env`: a second exec would rename the process python3
            'import os, sys, termios, tty',
            'name = os.path.basename(sys.argv[0])',
            "log = open(sys.argv[1], 'ab')",
            'fd = 0',
            'old = termios.tcgetattr(fd)',
            'tty.setraw(fd)',
            'out = sys.stdout',
            "if name == 'codex':",
            "    out.write(''.join('AGENTFIX_%d\\r\\n' % i for i in range(300)))",
            "elif name == 'claude':",
            "    out.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h\\x1b[2J\\x1b[HFAKE CLAUDE\\r\\n')",
            'else:',
            "    out.write('\\x1b[?1049h\\x1b[2J\\x1b[HTrust this folder?\\r\\n')",
            'out.flush()',
            'while True:',
            '    data = os.read(fd, 1024)',
            "    if b'q' in data:",
            '        break',
            '    log.write(data)',
            '    log.flush()',
            "out.write('\\x1b[?1006l\\x1b[?1002l\\x1b[?1000l\\x1b[?1049l')",
            'out.flush()',
            'termios.tcsetattr(fd, termios.TCSADRAIN, old)',
            '',
          ].join('\n'),
        )
        chmodSync(fixture, 0o755)
        for (const link of Object.keys(agents)) symlinkSync(fixture, `${bin}/${link}`)
      }
      writeFileSync(log, '')
      // Ctrl-U first: the context-send step leaves its refs on the prompt line.
      await evaluate(
        `(window.aico.pty.input(${JSON.stringify(`\u0015${bin}/${name} ${log}\r`)}), true)`,
      )
      let mode
      for (let i = 0; i < 50; i++) {
        mode = await evaluate('window.aico.scrollback.paneMode()')
        if (
          mode?.alternateScreen === agent.alternateScreen &&
          mode.mouseReporting === agent.mouseReporting &&
          (agent.alternateScreen || mode.historySize >= 300)
        )
          break
        await sleep(100)
      }
      console.log(JSON.stringify({ action, name, phase, mode }))
      if (
        mode?.alternateScreen !== agent.alternateScreen ||
        mode.mouseReporting !== agent.mouseReporting
      )
        throw new Error(`${name} fixture is not in its pane mode: ${JSON.stringify(mode)}`)
    } else {
      let title = ''
      for (let i = 0; i < 50 && !title.includes(agent.tuiName); i++) {
        title = await evaluate('document.title')
        if (!title.includes(agent.tuiName)) await sleep(100)
      }
      if (!title.includes(agent.tuiName))
        throw new Error(`widget was not reconciled to ${agent.tuiName}: ${JSON.stringify(title)}`)
      await sleep(1600) // let the renderer's cached pane mode refresh
      const g = await evaluate(`(() => {
        const overlay = document.querySelector('#scrollback-overlay');
        const screen = [...document.querySelectorAll('#terminal .xterm-screen')]
          .find((el) => !overlay?.contains(el));
        const r = screen.getBoundingClientRect();
        return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
      })()`)
      await command('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: g.x,
        y: g.y,
        button: 'none',
      })
      await sleep(400)
      const rail = await evaluate(`(() => {
        const rail = document.querySelector('.scroll-rail');
        return !!rail && !rail.hidden;
      })()`)
      await wheel(g.x, g.y, -120)
      let openedByWheelUp = false
      for (let i = 0; i < 20 && !openedByWheelUp; i++) {
        openedByWheelUp = await overlayOpen()
        if (!openedByWheelUp) await sleep(100)
      }
      if (openedByWheelUp) {
        await key('keyDown', 'Escape', 'Escape', 27)
        await key('keyUp', 'Escape', 'Escape', 27)
        for (let i = 0; i < 20 && (await overlayOpen()); i++) await sleep(100)
      }
      const afterUp = logText()
      await wheel(g.x, g.y, 120)
      await sleep(400)
      const openedByWheelDown = await overlayOpen()
      const afterDown = logText()
      const sgrWheel = (button) => new RegExp(`\u001b\\[<${button};\\d+;\\d+M`)
      const result = {
        action,
        name,
        title,
        rail,
        openedByWheelUp,
        openedByWheelDown,
        overlayClosed: !(await overlayOpen()),
        programGotWheelUp: sgrWheel(64).test(afterUp),
        programGotWheelDown: sgrWheel(65).test(afterDown),
        programInput: JSON.stringify(afterDown),
      }
      await evaluate("(window.aico.pty.input('q'), true)")
      for (let i = 0; i < 30; i++) {
        const mode = await evaluate('window.aico.scrollback.paneMode()')
        if (!mode?.alternateScreen) break
        await sleep(100)
      }
      console.log(JSON.stringify(result))
      // Claude Code fullscreen owns its transcript: both wheel directions are
      // forwarded and the overlay stays shut. Codex keeps history in tmux: the
      // rail shows, wheel-up opens the overlay, nothing reaches the program
      // (not the wheel-down, not the Escape that closed the overlay). agy's
      // folder-trust prompt has neither, so the wheel goes nowhere.
      const expected =
        name === 'claude'
          ? {
              rail: false,
              openedByWheelUp: false,
              programGotWheelUp: true,
              programGotWheelDown: true,
            }
          : name === 'codex'
            ? { rail: true, openedByWheelUp: true, programInput: '""' }
            : { rail: false, openedByWheelUp: false, programInput: '""' }
      const wrong = Object.entries({
        openedByWheelDown: false,
        overlayClosed: true,
        ...expected,
      }).filter(([k, v]) => result[k] !== v)
      if (wrong.length) throw new Error(`${name} wheel routing is wrong: ${JSON.stringify(wrong)}`)
    }
  } else if (action === 'context-send') {
    const sidecarPort = Number(sidecarPortText)
    if (!Number.isInteger(sidecarPort) || sidecarPort < 1 || sidecarPort > 65535) {
      throw new Error('invalid sidecar port')
    }
    await evaluate(`(() => {
      window.__aicoSmokeToasts = [];
      window.aico.selection.onToast((toast) => {
        const el = document.querySelector('.selection-toast');
        window.__aicoSmokeToasts.push({
          kind: toast.kind, snippet: toast.snippet,
          renderedText: el?.textContent?.trim() ?? '',
          visible: !!el && getComputedStyle(el).display !== 'none' && el.classList.contains('show')
        });
      });
      return true;
    })()`)
    const marker = `AICO_SMOKE_CONTEXT_${Date.now()}`
    const send = async (snippet) => {
      const res = await fetch(`http://127.0.0.1:${sidecarPort}/selection/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ kind: 'dom', snippet }] }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`selection send HTTP ${res.status}`)
      return res.json()
    }
    const start = Date.now()
    await send(marker)
    let context
    const deadline = Date.now() + 10_000
    do {
      context = await evaluate(`window.aico.scrollback.capture().then((text) => ({
        inserted: text.includes(${JSON.stringify(marker)}),
        toasts: window.__aicoSmokeToasts,
        renderedText: document.querySelector('.selection-toast')?.textContent?.trim() ?? '',
        visible: document.querySelector('.selection-toast')?.classList.contains('show') ?? false
      }))`)
      if (
        context?.inserted &&
        context.toasts?.length &&
        context.visible &&
        context.renderedText.includes(marker)
      )
        break
      await sleep(150)
    } while (Date.now() < deadline)
    if (
      !context?.inserted ||
      !context.toasts?.length ||
      !context.visible ||
      !context.renderedText.includes(marker)
    ) {
      throw new Error(`context send missing insertion/toast: ${JSON.stringify(context)}`)
    }
    const singleLatencyMs = Date.now() - start
    // Probe overlap after the proven single send. It is diagnostic: scheduling
    // may serialize both events before tmux becomes busy on a fast host.
    const overlap = await Promise.all([send(`${marker}_A`), send(`${marker}_B`)])
    await sleep(500)
    const overlapUi = await evaluate(`({
      toasts: window.__aicoSmokeToasts,
      renderedText: document.querySelector('.selection-toast')?.textContent?.trim() ?? '',
      visible: document.querySelector('.selection-toast')?.classList.contains('show') ?? false
    })`)
    console.log(
      JSON.stringify({
        action,
        singleLatencyMs,
        marker,
        single: context,
        overlapAccepted: overlap.length,
        overlapUi,
      }),
    )
  } else if (action === 'close') {
    const clicked = await evaluate(`(() => {
      const button = document.querySelector('.ctl.close');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (!clicked) throw new Error('topbar Close button missing')
    console.log(JSON.stringify({ action, clicked }))
  } else if (action === 'retire') {
    const first = await evaluate(`(() => {
      document.querySelector('#lantern-menu-btn')?.click();
      const row = document.querySelector('#aico-menu .aico-row[data-id="retire-widget"]');
      if (!row) return { row: false };
      row.click();
      return { row: true, armed: row.classList.contains('armed') };
    })()`)
    if (!first?.row || !first.armed)
      throw new Error(`first retire click did not arm: ${JSON.stringify(first)}`)
    const second = await evaluate(`(() => {
      const row = document.querySelector('#aico-menu .aico-row[data-id="retire-widget"]');
      row?.click();
      return !!row && !row.classList.contains('armed');
    })()`)
    if (!second) throw new Error('second retire click did not confirm')
    console.log(JSON.stringify({ action, first, second, confirmedAtMs: Date.now() }))
  } else {
    throw new Error(`unknown CDP action: ${action}`)
  }
} finally {
  socket.close()
  // Chromium can leave the CDP close handshake pending after a renderer is
  // restored. Give it a short grace period, then let this one-shot probe exit.
  setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref()
}
