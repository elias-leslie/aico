// Probe only the release smoke's loopback DevTools endpoint (Node 24 WebSocket).
// The packaged renderer has its own process; an X window does not prove that
// its preload, module graph, terminal, or control surface initialized.
const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('expected a loopback DevTools port')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + 30_000

async function pageTarget() {
  let lastError = 'no packaged renderer target'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      })
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`)
      const targets = await response.json()
      const page = targets.find(
        (target) =>
          target.type === 'page' &&
          typeof target.url === 'string' &&
          target.url.includes('/renderer/index.html') &&
          typeof target.webSocketDebuggerUrl === 'string',
      )
      if (page) return page
    } catch (error) {
      lastError = String(error)
    }
    await sleep(250)
  }
  throw new Error(`packaged renderer DevTools target unavailable: ${lastError}`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('DevTools WebSocket handshake timed out')),
      5000,
    )
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
        reject(new Error('DevTools WebSocket handshake failed'))
      },
      { once: true },
    )
  })
  return socket
}

const expression = `(() => {
  const missing = [];
  const api = window.aico;
  if (typeof api?.pty?.start !== 'function') missing.push('preload pty.start');
  if (typeof api?.win?.minimize !== 'function') missing.push('preload win.minimize');
  if (typeof api?.actions?.listTuis !== 'function') missing.push('preload actions.listTuis');
  if (typeof api?.settings?.getTerminalFont !== 'function') missing.push('preload settings.getTerminalFont');
  if (!document.querySelector('#terminal .xterm-screen')) missing.push('xterm screen');
  if (!document.querySelector('#terminal .xterm-helper-textarea')) missing.push('xterm input');
  const glyph = document.querySelector('#lantern-menu-btn');
  const menu = document.querySelector('#aico-menu');
  if (!glyph || glyph.getClientRects().length === 0) missing.push('visible menu button');
  if (!menu?.querySelector('.aico-row')) missing.push('populated control menu');
  if (!document.querySelector('#aico-palette .aico-palette-text')) missing.push('command palette');
  if (missing.length) return { ready: false, missing };
  const initiallyClosed = menu.hidden;
  glyph.click();
  const opened = !menu.hidden;
  glyph.click();
  const closed = menu.hidden;
  if (!initiallyClosed || !opened || !closed) missing.push('menu click interaction');
  return { ready: missing.length === 0, missing };
})()`

let socket
try {
  const target = await pageTarget()
  socket = await connect(target.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  const rendererErrors = []
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      rendererErrors.push('invalid DevTools response')
      return
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      rendererErrors.push(message.params?.exceptionDetails?.text ?? 'renderer exception')
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      rendererErrors.push('renderer console.error')
    }
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('DevTools WebSocket closed'))
    }
    pending.clear()
  })
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`DevTools ${method} timed out`))
      }, 5000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  await command('Runtime.enable')
  let lastMissing = ['renderer still initializing']
  while (Date.now() < deadline) {
    if (rendererErrors.length) throw new Error(rendererErrors.join('; '))
    const evaluation = await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (evaluation.exceptionDetails) {
      throw new Error(`renderer probe threw: ${evaluation.exceptionDetails.text}`)
    }
    const result = evaluation.result?.value
    if (result?.ready) {
      await sleep(1000)
      if (rendererErrors.length) throw new Error(rendererErrors.join('; '))
      console.log('Packaged renderer preload, xterm, control menu, and menu interaction are ready.')
      process.exitCode = 0
      break
    }
    lastMissing = result?.missing ?? ['invalid renderer probe response']
    await sleep(250)
  }
  if (process.exitCode !== 0) {
    throw new Error(`renderer readiness timed out: ${lastMissing.join(', ')}`)
  }
} catch (error) {
  console.error(`Packaged renderer smoke failed: ${error.message}`)
  process.exitCode = 1
} finally {
  socket?.close()
}
