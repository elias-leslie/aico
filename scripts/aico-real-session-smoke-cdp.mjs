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
    const fixture = 'python3 -c \'for i in range(6000): print("AICO_SCROLL_"+str(i))\''
    const focused = await evaluate(`(() => {
      const input = document.querySelector('#terminal .xterm-helper-textarea');
      input?.focus();
      return document.activeElement === input;
    })()`)
    if (!focused) throw new Error('xterm keyboard input is not focused for scrollback fixture')
    await command('Input.insertText', { text: fixture })
    await key('keyDown', 'Enter', 'Enter', 13)
    await key('keyUp', 'Enter', 'Enter', 13)
    let page
    for (let i = 0; i < 80; i++) {
      page =
        await evaluate(`window.aico.scrollback.page({ count: 100 }).then(({ fromLine, totalLines, text }) => ({
        fromLine, totalLines, fixtureDone: text.includes('AICO_SCROLL_5999')
      }))`)
      if (page.fixtureDone) break
      await sleep(100)
    }
    if (!page?.fixtureDone || page.totalLines < 10_000) {
      throw new Error(`scrollback fixture incomplete: ${JSON.stringify(page)}`)
    }
    page = await evaluate(
      'window.aico.scrollback.page({ count: 5000 }).then(({ fromLine, totalLines }) => ({ fromLine, totalLines }))',
    )
    const center = await evaluate(`(() => {
      const r = document.querySelector('#terminal').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    const overlay = () =>
      evaluate(`(() => {
      const el = document.querySelector('#scrollback-overlay');
      const bar = el?.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
      const slider = bar?.querySelector('.slider');
      const barRect = bar?.getBoundingClientRect();
      const sliderRect = slider?.getBoundingClientRect();
      return { visible: !!el && getComputedStyle(el).display !== 'none',
        barHeight: barRect?.height ?? 0, sliderHeight: sliderRect?.height ?? 0,
        sliderTop: sliderRect && barRect ? Math.round(sliderRect.top - barRect.top) : null };
    })()`)
    await wheel(center.x, center.y, -500)
    let opened
    for (let i = 0; i < 40; i++) {
      opened = await overlay()
      if (opened.visible) break
      await sleep(100)
    }
    if (!opened?.visible) throw new Error('wheel-up did not open scrollback overlay')
    let populated
    for (let i = 0; i < 60; i++) {
      populated = await overlay()
      if (
        populated.barHeight > 0 &&
        populated.sliderHeight > 0 &&
        populated.sliderHeight < populated.barHeight
      )
        break
      await sleep(100)
    }
    await wheel(center.x, center.y, -100000)
    let atTop
    for (let i = 0; i < 40; i++) {
      atTop = await overlay()
      if (atTop.sliderTop !== null && atTop.sliderTop <= 2) break
      await sleep(100)
    }
    await wheel(center.x, center.y, -500)
    let afterOlderWheel
    for (let i = 0; i < 40; i++) {
      afterOlderWheel = await overlay()
      if (
        afterOlderWheel.sliderTop !== null &&
        atTop.sliderTop !== null &&
        afterOlderWheel.sliderTop > atTop.sliderTop + 3
      )
        break
      await sleep(100)
    }
    console.log(
      JSON.stringify({
        action: 'scrollback_probe',
        fixture,
        page,
        opened,
        populated,
        atTop,
        afterOlderWheel,
      }),
    )
    await key('keyDown', 'Escape', 'Escape', 27)
    await key('keyUp', 'Escape', 'Escape', 27)
    const dismissed = await overlay()
    if (dismissed.visible) throw new Error('Escape did not dismiss scrollback overlay')
    await wheel(center.x, center.y, -500)
    let reopened
    for (let i = 0; i < 40; i++) {
      reopened = await overlay()
      if (reopened.visible) break
      await sleep(100)
    }
    if (!reopened?.visible) throw new Error('second wheel-up did not reopen scrollback overlay')
    await key('keyDown', 'Escape', 'Escape', 27)
    await key('keyUp', 'Escape', 'Escape', 27)
    console.log(
      JSON.stringify({
        action,
        page,
        opened,
        populated,
        atTop,
        afterOlderWheel,
        dismissed,
        reopened,
      }),
    )
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
