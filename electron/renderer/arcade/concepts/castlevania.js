;(() => {
  // Castlevania (Konami, 1986), big. Simon Belmont works the bar with the
  // stiff walk and the three-frame whip (leather, then chain once he finds the
  // morning star). Candles on iron stands, and one on a stone ledge reached by
  // stairs, drop hearts, the chain and the dagger, axe and holy water. Medusa
  // heads, zombies and the bat roosting under the title come at him. Busy:
  // Dracula (or Death) holds court; done: the boss burns away and the orb drops.

  // capture-only: keep the bar lively in long headless runs (?t=…&awake)
  const KEEP_AWAKE = (() => {
    try {
      const q = new URLSearchParams(location.search)
      return q.has('t') && q.has('awake')
    } catch {
      return false
    }
  })()
  const live = (s, now) => s.lively(now) || (KEEP_AWAKE && !s.napping)
  // someone is playing: a click or drag in the last 9 s, or the cursor moving over the bar
  const engaged = (s, now) => now - s.keyAt < 9000 || now - (s.data.clickAt || -1e9) < 9000 || now - (s.data.grabAt || -1e9) < 9000 || (s.cursor && now - s.cursor.since < 2500)
  const clicked = (s) => (s.data.clickAt = performance.now())

  // ---- pixel painter ---------------------------------------------------------
  const grid = (w, h) => Array.from({ length: h }, () => Array(w).fill('.'))
  const put = (g, x, y, ch) => {
    x = Math.round(x)
    y = Math.round(y)
    if (ch && ch !== '.' && y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = ch
  }
  const stamp = (g, x, y, art) => art.forEach((r, j) => [...r].forEach((ch, i) => put(g, x + i, y + j, ch)))
  function line(g, x0, y0, x1, y1, ch, th = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n)
      const y = Math.round(y0 + ((y1 - y0) * i) / n)
      for (let a = 0; a < th; a++) for (let b = 0; b < th; b++) put(g, x + a, y + b, ch)
    }
  }
  // scanline polygon fill; a vertex at y = n closes the fill above row n
  function poly(g, pts, ch) {
    const ys = pts.map((p) => p[1])
    for (let y = Math.floor(Math.min(...ys)); y < Math.ceil(Math.max(...ys)); y++) {
      const yc = y + 0.5
      const xs = []
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]
        const [bx, by] = pts[(i + 1) % pts.length]
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) put(g, x, y, ch)
    }
  }
  const rowsOf = (g) => g.map((r) => r.join(''))
  function rot(c, q) {
    const o = document.createElement('canvas')
    o.width = c.width
    o.height = c.height
    const x = o.getContext('2d')
    x.imageSmoothingEnabled = false
    x.translate(c.width / 2, c.height / 2)
    x.rotate((q * Math.PI) / 2)
    x.drawImage(c, -c.width / 2, -c.height / 2)
    return o
  }
  const whiteOf = (pal) => Object.fromEntries(Object.keys(pal).map((k) => [k, '#ffffff']))
  const ov = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0

  // ---- Simon Belmont ---------------------------------------------------------
  const PS = {
    H: '#4a1e0a', h: '#8a4418', j: '#c4702c', R: '#e02818', r: '#8c1208',
    S: '#fcb488', s: '#c47448', E: '#240c04',
    T: '#a8541c', t: '#68280a', l: '#dc8c3c', B: '#2e1206', G: '#f8c838',
    p: '#8a4418', q: '#5a260a', K: '#2e1408', k: '#7a4420',
  }
  const GW = 26 // frame canvas, feet on the last row, body centre on CX
  const GH = 28
  const CX = 11
  // profile head, facing right: shaggy hair, red headband with the knot behind
  const HEAD = [
    '...hhhh..',
    '.hhjjjhh.',
    'hhRRRRRR.',
    'rhhhSSES.',
    'rhhSSSSSS',
    '.hhSSSSS.',
    '.hhhsSSs.',
    '..h.sSS..',
  ]
  // sleeveless leather armour, belt with a gold buckle, tunic skirt
  const TORSO = [
    '..tTTTTt..',
    '.tTlTTTTTt',
    '.tTlTTTTTt',
    '.tTTlTTTTt',
    '..tTTTTTt.',
    '..tTTTTTt.',
    '..BBBBGBB.',
    '..tTTTTTTt',
    '.tTTtTTtTt',
  ]
  // front arm: [elbow dx, dy, hand dx, dy] from the shoulder (CX + 1, 13)
  const ARMS = {
    down: [2, 3, 3, 6],
    wind: [-3, -5, -4, -10],
    swing: [2, -5, 4, -10],
    strike: [4, 0, 8, 0],
    throw: [3, -1, 7, -3],
    hurt: [2, -2, 3, -6],
    raise: [2, -5, 3, -11],
    knee: [3, 3, 4, 6],
  }
  function leg(g, hx, hy, fx, fy, pants, lift) {
    const kx = Math.round((hx + fx) / 2) + (lift ? 1 : 0)
    const ky = Math.round((hy + fy) / 2) - (lift ? 1 : 0)
    line(g, hx, hy, kx, ky, pants, 2)
    line(g, kx, ky + 1, fx, fy - 1, 'K', 2)
    put(g, kx, ky + 1, 'k')
    put(g, kx + 1, ky + 1, 'k')
    for (let i = 0; i < 3; i++) put(g, fx + i, fy, 'K')
  }
  const LEGS = {
    stand(g, [[bdx, bl], [fdx, fl]]) {
      leg(g, CX - 1, 21, CX + bdx, 27 - bl, 'q', bl)
      leg(g, CX + 1, 21, CX + fdx, 27 - fl, 'p', fl)
    },
    crouch(g) {
      line(g, CX - 1, 24, CX - 3, 25, 'q', 2)
      line(g, CX - 4, 26, CX - 4, 26, 'K', 2)
      put(g, CX - 2, 27, 'K')
      line(g, CX + 1, 24, CX + 4, 23, 'p', 2)
      line(g, CX + 4, 25, CX + 4, 26, 'K', 2)
      put(g, CX + 4, 25, 'k')
      put(g, CX + 5, 25, 'k')
      put(g, CX + 6, 27, 'K')
    },
    tuck(g) {
      line(g, CX - 1, 21, CX + 2, 23, 'q', 2)
      line(g, CX + 1, 24, CX - 1, 25, 'K', 2)
      put(g, CX - 2, 26, 'K')
      line(g, CX + 1, 21, CX + 5, 20, 'p', 2)
      line(g, CX + 5, 22, CX + 4, 24, 'K', 2)
      put(g, CX + 5, 22, 'k')
      put(g, CX + 6, 22, 'k')
      put(g, CX + 6, 25, 'K')
    },
    kneel(g) {
      line(g, CX - 1, 23, CX - 1, 25, 'q', 2)
      line(g, CX - 2, 26, CX - 6, 26, 'K', 2)
      put(g, CX - 1, 26, 'k')
      line(g, CX + 1, 23, CX + 5, 23, 'p', 2)
      line(g, CX + 5, 25, CX + 5, 26, 'K', 2)
      put(g, CX + 5, 25, 'k')
      put(g, CX + 6, 25, 'k')
      put(g, CX + 7, 27, 'K')
    },
  }
  function frontArm(g, pose, dy) {
    const [ex, ey, hx, hy] = ARMS[pose]
    const sx = CX + 1
    const sy = 13 + dy
    line(g, sx, sy, sx + ex, sy + ey, 's', 2)
    line(g, sx + ex, sy + ey, sx + hx, sy + hy, 's', 2)
    line(g, sx, sy, sx + ex, sy + ey, 'S')
    line(g, sx + ex, sy + ey, sx + hx, sy + hy, 'S')
    const bx = Math.round(sx + ex + (hx - ex) * 0.55)
    const by = Math.round(sy + ey + (hy - ey) * 0.55)
    put(g, bx, by, 't')
    put(g, bx + 1, by, 't')
    put(g, bx, by + 1, 't')
    put(g, bx + 1, by + 1, 't')
    return [sx + hx + (pose === 'strike' || pose === 'throw' ? 1 : 0), sy + hy]
  }
  function simonFig(o) {
    const g = grid(GW, GH)
    const dy = o.dy || 0
    const lean = o.lean || 0
    // back arm, mostly hidden
    const bs = [CX - 2, 13 + dy]
    const ba = o.back || [-1, 5]
    line(g, bs[0], bs[1], bs[0] + ba[0], bs[1] + ba[1], 's', 2)
    LEGS[o.legs](g, o.l)
    stamp(g, CX - 4 + lean, 12 + dy, o.legs === 'stand' ? TORSO : TORSO.slice(0, 8))
    let hand = null
    if (o.arm === 'wind') hand = frontArm(g, o.arm, dy)
    stamp(g, CX - 4 + lean, 4 + dy, HEAD)
    if (o.arm !== 'wind') hand = frontArm(g, o.arm, dy)
    return { rows: rowsOf(g), hand }
  }
  const ST = [[-4, 0], [4, 0]] // whip stance
  const SPOSES = {
    stand: { legs: 'stand', l: [[-3, 0], [1, 0]], arm: 'down' },
    walk0: { legs: 'stand', l: [[-4, 0], [3, 0]], arm: 'down', back: [-2, 5] },
    walk1: { legs: 'stand', l: [[-1, 0], [1, 2]], arm: 'down' },
    walk2: { legs: 'stand', l: [[3, 0], [-4, 0]], arm: 'down', back: [0, 5] },
    walk3: { legs: 'stand', l: [[1, 2], [-1, 0]], arm: 'down' },
    wind: { legs: 'stand', l: ST, arm: 'wind' },
    swing: { legs: 'stand', l: ST, arm: 'swing' },
    strike: { legs: 'stand', l: ST, arm: 'strike', back: [-3, 4] },
    cwind: { legs: 'crouch', dy: 6, arm: 'wind' },
    cswing: { legs: 'crouch', dy: 6, arm: 'swing' },
    cstrike: { legs: 'crouch', dy: 6, arm: 'strike', back: [-3, 4] },
    jwind: { legs: 'tuck', dy: 3, arm: 'wind' },
    jswing: { legs: 'tuck', dy: 3, arm: 'swing' },
    jstrike: { legs: 'tuck', dy: 3, arm: 'strike', back: [-3, 4] },
    crouch: { legs: 'crouch', dy: 6, arm: 'knee' },
    tuck: { legs: 'tuck', dy: 3, arm: 'knee' },
    hurt: { legs: 'stand', l: [[-6, 1], [3, 0]], arm: 'hurt', lean: -1, back: [-4, -2] },
    kneel: { legs: 'kneel', dy: 5, arm: 'knee' },
    throw: { legs: 'stand', l: ST, arm: 'throw', back: [-3, 4] },
    raise: { legs: 'stand', l: [[-2, 0], [2, 0]], arm: 'raise' },
  }
  const SIM = {}
  for (const k in SPOSES) {
    const f = simonFig(SPOSES[k])
    SIM[k] = { sp: pairOutlined(f.rows, PS), hand: f.hand }
  }

  // ---- the whip --------------------------------------------------------------
  const PW = { w: '#9a5a24', W: '#d4924c', h: '#3a1a08', c: '#7c8698', C: '#e4e8f0', x: '#b4bccb' }
  const WHIPS = {
    leather: {
      reach: 19,
      wind: [[0, 0], [-3, 1], [-6, 3], [-8, 6], [-9, 9]],
      swing: [[0, 0], [-3, -2], [-7, -3], [-11, -3], [-14, -2]],
      strike: [[1, 0], [19, 0]],
    },
    chain: {
      reach: 27,
      wind: [[0, 0], [-3, 1], [-7, 4], [-9, 8], [-10, 12]],
      swing: [[0, 0], [-4, -2], [-9, -4], [-14, -4], [-19, -3]],
      strike: [[1, 0], [25, 0]],
    },
  }
  function whipSprite(kind, pts) {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x0 = Math.min(...xs) - 2
    const y0 = Math.min(...ys) - 2
    const g = grid(Math.max(...xs) - x0 + 3, Math.max(...ys) - y0 + 3)
    let n = 0
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]
      const [bx, by] = pts[i + 1]
      const m = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1)
      for (let k = i ? 1 : 0; k <= m; k++) {
        const x = Math.round(ax + ((bx - ax) * k) / m) - x0
        const y = Math.round(ay + ((by - ay) * k) / m) - y0
        n++
        if (n <= 2) put(g, x, y, 'h')
        else if (kind === 'leather') put(g, x, y, n % 4 === 0 ? 'W' : 'w')
        else put(g, x, y, n % 2 ? 'C' : 'c')
      }
    }
    const [tx, ty] = pts[pts.length - 1]
    if (kind === 'chain') {
      // the morning star's spiked ball
      stamp(g, tx - x0 - 1, ty - y0 - 1, ['xCx', 'CcC', 'xCx'])
      put(g, tx - x0 + 2, ty - y0, 'x')
    } else put(g, tx - x0, ty - y0, 'W')
    return { sp: pairOutlined(rowsOf(g), PW), ax: -x0, ay: -y0, w: g[0].length }
  }
  const WHIP = {}
  for (const k in WHIPS) {
    WHIP[k] = {}
    for (const ph of ['wind', 'swing', 'strike']) WHIP[k][ph] = whipSprite(k, WHIPS[k][ph])
  }

  // ---- candles, stairs, items, effects ----------------------------------------
  const PC = {
    y: '#fff2a0', O: '#f08a2c', r: '#d83020', w: '#ffffff', c: '#f4ecd0', C: '#c8b48a',
    k: '#a87018', K: '#f0c040', n: '#4a4e58', N: '#8a909c',
  }
  const FLAMES = [
    ['...y...', '..yOy..', '..OwO..', '...O...'],
    ['..y....', '..Oy...', '..OwO..', '...O...'],
  ]
  const CANDLE_H = { low: 13, mid: 20, tall: 29 }
  function candleRows(h, lit, f) {
    const rows = []
    for (let y = 0; y < h; y++) {
      if (y < 4) rows.push(lit ? FLAMES[f][y] : '.......')
      else if (y < 9) rows.push(lit ? (y === 5 ? '..cCcc.' : '..ccC..') : y === 8 ? '..cC...' : '.......')
      else if (y === 9) rows.push('.kKKKk.')
      else if (y === 10) rows.push('..kKk..')
      else if (y >= h - 2) rows.push(y === h - 1 ? '.nnNnn.' : '..nNn..')
      else rows.push('...N...')
    }
    return rows
  }
  const CANDLE = {}
  for (const k in CANDLE_H) {
    CANDLE[k] = [0, 1].map((f) => outline(sprite(candleRows(CANDLE_H[k], true, f), PC)))
    CANDLE[k].out = outline(sprite(candleRows(CANDLE_H[k], false, 0), PC))
  }

  // stone stairs up to a ledge (ascending to the right; mirrored for the left)
  const PB = { a: '#4a5262', A: '#7c8496', L: '#aab2c2', m: '#22262e' }
  const STAIR_W = 30
  const STAIR_H = 12
  const STAIR = (() => {
    const g = grid(STAIR_W, STAIR_H)
    for (let k = 0; k < 4; k++) {
      const x = 3 * k
      const top = STAIR_H - 3 * (k + 1)
      for (let y = top; y < STAIR_H; y++)
        for (let i = 0; i < 3; i++) put(g, x + i, y, y === top ? 'L' : y === top + 1 ? 'A' : y < top + 3 ? 'a' : 'm')
    }
    for (let y = 0; y < STAIR_H; y++)
      for (let x = 12; x < STAIR_W; x++) {
        const row = Math.floor(y / 6)
        const bx = (x - 12 + (row ? 4 : 0)) % 9
        const by = y % 6
        put(g, x, y, by === 5 || bx === 8 ? 'm' : by === 0 || bx === 0 ? 'L' : by === 4 || bx === 7 ? 'a' : 'A')
      }
    return pair(rowsOf(g), PB)
  })()

  const PI = {
    r: '#e8203c', R: '#ff9aa8', A: '#e0e4ec', a: '#8890a0', n: '#9a6a32', N: '#5a3a14', Y: '#f8c838',
    b: '#3a78e8', B: '#a8d0ff', w: '#ffffff', c: '#9aa4b4', W: '#e8e8f0', o: '#a8481c', O: '#d8783a',
  }
  const ITEM = {
    heart: ['rr.rr', 'rRrrr', '.rrr.', '..r..'],
    bigheart: ['.rr.rr.', 'rRRrrrr', 'rRrrrrr', '.rrrrr.', '..rrr..', '...r...'],
    chain: ['....aAa', '...aAwA', '...cAAa', '..c.aa.', '.c.....', 'n......', 'N......'],
    dagger: ['..Y......', 'NnYAAAAAa', '..Y......'],
    axe: ['....aAa.', '...aAAAa', '..naAAAA', '..n.aAAa', '.n...aa.', '.n......', 'n.......'],
    holy: ['.aa.', '.bw.', 'bbbb', 'bBbb', 'bBbb', '.bb.'],
    bag: ['..Y.Y..', '...Y...', '.rrrrr.', 'rrRrrrr', 'rRrWrrr', 'rrrrrrr', '.rrrrr.'],
    // the pot roast hidden in the castle wall
    roast: ['...w....', '..oOOo..', '.oOYOOo.', 'oOOOOOOo', 'WWWWWWWW', '.aAAAAa.'],
  }
  const ITEMS = {}
  for (const k in ITEM) ITEMS[k] = pairOutlined(ITEM[k], PI)
  const AXE_SPIN = [0, 1, 2, 3].map((q) => outline(rot(sprite(ITEM.axe, PI), q)))
  const HUD_HEART = sprite(ITEM.heart, PI)
  const HUD_ICON = { dagger: sprite(ITEM.dagger, PI), axe: sprite(ITEM.axe, PI), holy: sprite(ITEM.holy, PI) }

  const PF = { y: '#fff2a0', O: '#f08a2c', r: '#d83020', w: '#ffffff', b: '#3a78e8', B: '#a8d0ff', c: '#e8f4ff' }
  const HIT_FLAME = [
    ['...O...', '..OyO..', '.OOyOO.', '.OywyO.', 'OOywyOO', 'OyywyyO', '.OyyyO.', '..OOO..'],
    ['..O..O.', '..OO.O.', '.OyOOO.', '.OyyyO.', 'OOywyO.', '.OywyOO', '.OyyyO.', '..OOO..'],
    ['.......', '.......', '...O...', '..OyO..', '..OyO..', '.OyyyO.', '..OOO..', '.......'],
  ].map((r) => outline(sprite(r, PF)))
  const HOLY_FIRE = [
    ['..b.....', '..bB..b.', '.bBcb.bB', '.bccBbBc', 'bBccccBb', 'bbBBBBbb'],
    ['.....b..', '.b..Bb..', 'bB.bcBb.', 'cBbBccb.', 'bBccccBb', 'bbBBBBbb'],
  ].map((r) => outline(sprite(r, PF)))
  const FIREBALL = [
    ['.rOr.', 'rOyOr', 'OywyO', 'rOyOr', '.rOr.'],
    ['.OrO.', 'OyOyO', 'rywyr', 'OyOyO', '.OrO.'],
  ].map((r) => outline(sprite(r, PF)))
  const ORB = ['#e83040', '#f08a2c', '#f8d838', '#58a8f8'].map((col, i, all) =>
    outline(
      sprite(['..ooo..', '.oOOOo.', 'oOwOOOo', 'oOOOOOo', 'oOOOOOo', '.oOOOo.', '..ooo..'], {
        o: all[(i + 2) % all.length],
        O: col,
        w: '#ffffff',
      }),
    ),
  )

  // ---- enemies ---------------------------------------------------------------
  const PE = {
    G: '#58b840', g: '#2a6a1c', F: '#b8d870', f: '#7aa048', w: '#ffffff', E: '#1a1010', r: '#e02020',
    v: '#262650', V: '#5a5ab0', b: '#141428', k: '#a0a0b0',
    z: '#8aa878', Z: '#5a7850', d: '#2a2018', u: '#4a5a8a', U: '#2e3a62', n: '#5a4630', N: '#3a2c1c', m: '#3a1010',
  }
  const MEDUSA = [
    ['...g..g.g...', '..gGg.GgGg..', '.gGGGgGGGGg.', 'gGgGGGGGGGGg', '.gGGGFFFFGg.', 'gGGFFFFwEFF.', '.gGFFFFFFFF.', 'gGGfFFFFFF..', '.gGgfFrrFF..', '..gGgfFFF...', '...g.g.g....'],
    ['..g..g...g..', '.gGg.GgGgG..', '.gGGGgGGGGg.', 'gGgGGGGGGGGg', 'gGGGGFFFFGg.', '.gGFFFFwEFF.', 'gGGFFFFFFFF.', '.gGfFFFFFF..', 'gGgGfFrrFF..', '.gGgfFFFF...', '..g.g...g...'],
  ].map((r) => pairOutlined(r, PE))
  const BAT_ROWS = [
    ['VV...........VV', '.VV.........VV.', '.vVV..b.b..VVv.', '..vVVvbbbvVVv..', '....vvrbrvv....', '......bbb......', '.......b.......'],
    ['...............', '......b.b......', '.vvVVvbbbvVVvv.', 'VVVVVvrbrvVVVVV', 'V..vv.bbb.vv..V', '.......b.......', '...............'],
    ['......b.b......', '.....vbbbv.....', '....vVrbrVv....', '...vVVbbbVVv...', '..vVV..b..VVv..', '.vVV.......VVv.', 'VV...........VV'],
  ]
  const BAT = BAT_ROWS.map((r) => outline(sprite(r, PE)))
  const BAT_HANG = outline(sprite(['..k.k..', '..bbb..', '.vVbVv.', 'vVVbVVv', 'vVVbVVv', '.vVbVv.', '..rbr..', '..bbb..', '...b...'], PE))
  // a shambling zombie, arms out, facing right
  const ZOMBIE = [0, 1].map((f) => {
    const g = grid(12, 22)
    stamp(g, 0, 0, [
      '...dddd.....',
      '..dddzzd....',
      '..ddzzzz....',
      '..dzzzrzZ...',
      '...zzzzzz...',
      '...ZzzmZ....',
      '....zZz.....',
      '..uuuuuzzzz.',
      '.uUuuuuZzzzz',
      '.uUuuuu.....',
      '.uUuuUuzzzz.',
      '.uuUuuuZzzzz',
      '..uuuuu.....',
      '..uUuUu.....',
    ])
    const [b, fr] = f ? [[4, 1], [6, 0]] : [[6, 0], [3, 1]]
    line(g, 3, 14, b[0] - 1 + 3, 20 - b[1], 'N', 2)
    put(g, b[0] + 1, 21 - b[1], 'Z')
    put(g, b[0] + 2, 21 - b[1], 'Z')
    line(g, 5, 14, fr[0] + 1, 20 - fr[1], 'n', 2)
    put(g, fr[0] + 2, 21 - fr[1], 'z')
    put(g, fr[0] + 3, 21 - fr[1], 'z')
    return pairOutlined(rowsOf(g), PE)
  })

  // the white skeleton: bony, jittery, lobs bones in an arc (frames: walk0, walk1, throw, heap)
  const PSK = { X: '#ece8d8', x: '#a49c88', E: '#140c10', r: '#ff3a3a' }
  const SKULL = ['.XXXXX.', 'XXXXXXX', 'XXXXEEX', 'XxXXErX', '.XXXXXX', '..XxXxX', '..xXXX.']
  function skelFig(f) {
    const g = grid(13, 23)
    if (f === 3) {
      stamp(g, 0, 16, ['.......', '....XXXXX', '...XXXXXXX', '...XXXXEEX', '..XXXXXErXX', 'XXxXXXxXXxX.', 'xXXxXXXxXXXx'])
      return rowsOf(g)
    }
    stamp(g, 3, 0, SKULL)
    line(g, 5, 7, 5, 15, 'x')
    for (const y of [8, 10, 12]) line(g, y === 12 ? 4 : 3, y, y === 12 ? 7 : 8, y, 'X')
    for (const y of [9, 11]) {
      put(g, 3, y, 'X')
      put(g, 8, y, 'X')
    }
    stamp(g, 3, 14, ['.XXXX.', 'XX..XX'])
    // back arm
    line(g, 3, 8, 2, 12, 'x')
    line(g, 2, 12, 3, 15, 'x')
    // front arm: swinging, or raised with a bone
    if (f === 2) {
      line(g, 8, 8, 10, 5, 'X')
      line(g, 10, 5, 10, 2, 'X')
      stamp(g, 9, 0, ['X.X', '.X.', 'X.X'])
    } else {
      line(g, 8, 8, 9, 11, 'X')
      line(g, 9, 11, 10, 14, 'X')
    }
    const L = f === 1 ? [[4, 5, 4], [7, 7, 7]] : [[4, 3, 2], [7, 8, 9]]
    for (const [hx, kx, fx] of L) {
      line(g, hx, 16, kx, 19, 'X')
      line(g, kx, 19, fx, 22, 'X')
      put(g, fx + 1, 22, 'X')
    }
    return rowsOf(g)
  }
  const SKEL = [0, 1, 2, 3].map((f) => pairOutlined(skelFig(f), PSK))
  const BONE = (() => {
    const c = sprite(['.....', 'X...X', '.XXX.', 'X...X', '.....'], PSK)
    return [0, 1, 2, 3].map((q) => outline(rot(c, q)))
  })()
  // the fishman (merman): leaps out of the floor in a spray, spits fire
  const PFM = { G: '#3a9a58', g: '#1e5a32', F: '#9ad8a8', f: '#5aa070', E: '#101010', Y: '#f0d040', r: '#e03030', c: '#bfe8ff', b: '#3a78e8' }
  const FISH = [0, 1, 2].map((f) => {
    const g = grid(14, 24)
    stamp(g, 0, 0, [
      '....g.g.g.....',
      '...gGgGgGg....',
      '..gGGGGGGGG...',
      '.g.GGGGGGYEG..',
      'g..GGGGGGGGGG.',
      '...gGGGG' + (f === 2 ? 'rrrrr' : 'GrrrG') + '.',
      '....gGGGGGGG..',
      '.....GGGGGG...',
      '...gGGFFFFGGg.',
      '..gGGFFFFFFGGg',
      '..G.GFfFFfFG.G',
      '..G.GFFFFFFG.G',
      '..g.GFfFFfFG.g',
      '.gg.GGFFFFGG.gg',
      '....gGGGGGGg..',
      '....gGGGGGGg..',
    ])
    const [b, fr] = f === 1 ? [[6, 0], [8, 0]] : f === 2 ? [[4, 0], [10, 0]] : [[4, 0], [9, 0]]
    line(g, 6, 16, b[0], 22, 'g', 2)
    line(g, 8, 16, fr[0], 22, 'G', 2)
    stamp(g, b[0] - 1, 23, ['gg.'])
    stamp(g, fr[0], 23, ['GGg'])
    return pairOutlined(rowsOf(g), PFM)
  })

  // ---- bosses ----------------------------------------------------------------
  const PD = {
    K: '#1a1024', k: '#4a3266', r: '#c81830', R: '#ff5a5a', u: '#24243a', W: '#e8e4f0', G: '#f0c040',
    a: '#8a90a0', A: '#d4d8e2', F: '#f0dcc8', f: '#b49c88', e: '#ff2020', m: '#701020',
  }
  const DW = 32
  const DH = 30
  const DX = 15
  const DRAC_HEAD = ['..aaa..', '.aAAAa.', 'aAAaFFa', 'aAFFFeF', 'aaFFFFF', '.aFFFF.', '..fmmF.', '..fFF..']
  function dracFig(open) {
    const g = grid(DW, DH)
    if (open) {
      // cape thrown wide: red lining, black rim, hands at the tips
      poly(g, [[13, 7], [1, 10], [3, DH], [14, DH]], 'r')
      poly(g, [[17, 7], [30, 10], [28, DH], [16, DH]], 'r')
      line(g, 13, 7, 1, 10, 'K', 2)
      line(g, 1, 10, 3, DH - 1, 'K', 2)
      line(g, 17, 7, 30, 10, 'K', 2)
      line(g, 30, 10, 28, DH - 1, 'K', 2)
      line(g, 2, 12, 4, 27, 'k')
      line(g, 29, 12, 27, 27, 'k')
      stamp(g, 0, 9, ['FF', 'FF'])
      stamp(g, 30, 9, ['FF', 'FF'])
    } else {
      poly(g, [[10, 7], [21, 7], [24, DH], [7, DH]], 'K')
      line(g, 20, 8, 23, DH - 1, 'k')
      line(g, 10, 8, 8, DH - 1, 'k')
    }
    poly(g, [[13, 9], [18, 9], [19, DH], [12, DH]], 'u')
    line(g, 15, 9, 15, 12, 'W', 2)
    put(g, 15, 13, 'G')
    put(g, 16, 13, 'G')
    put(g, 15, 14, 'R')
    // the high collar, lined red
    poly(g, [[9, 2], [13, 6], [13, 10], [9, 9]], 'K')
    poly(g, [[22, 2], [18, 6], [18, 10], [22, 9]], 'K')
    line(g, 10, 4, 12, 7, 'r')
    line(g, 21, 4, 19, 7, 'r')
    stamp(g, 12, 0, DRAC_HEAD)
    return rowsOf(g)
  }
  const DRAC = {}
  for (const k of ['closed', 'open']) {
    const rows = dracFig(k === 'open')
    DRAC[k] = pairOutlined(rows, PD)
    DRAC[k + 'W'] = pairOutlined(rows, whiteOf(PD))
  }
  const PDE = {
    v: '#3a2a5a', V: '#6a52a0', X: '#f0ece0', x: '#a8a090', E: '#120a18', r: '#ff3030', n: '#7a5a30',
    A: '#e0e4ec', a: '#8890a0',
  }
  const EW = 30
  const EH = 30
  const EX = 13
  function deathFig(f) {
    const g = grid(EW, EH)
    // scythe behind the robe
    line(g, 22, 3, 22, 29, 'n')
    line(g, 22, 3, 26, 2, 'a', 1)
    line(g, 22, 2, 27, 1, 'A')
    line(g, 27, 1, 29, 4, 'A')
    line(g, 28, 3, 29, 6, 'a')
    // robe, ragged hem that never touches the floor
    poly(g, [[7, 9], [19, 9], [23, 25], [3, 25]], 'v')
    for (let x = 3; x < 23; x++) if ((x + f) % 3 !== 0) put(g, x, 25 + ((x + f) % 2), 'v')
    for (let x = 5; x < 21; x += 2) put(g, x, 27, (x + f) % 4 ? '.' : 'v')
    line(g, 18, 10, 21, 24, 'V')
    line(g, 12, 12, 10, 24, 'V')
    // hood with the skull inside
    poly(g, [[8, 0], [17, 0], [21, 6], [20, 12], [6, 12], [5, 6]], 'v')
    line(g, 9, 0, 16, 0, 'V')
    line(g, 17, 1, 20, 6, 'V')
    stamp(g, 10, 3, ['.XXXXx.', 'XXXXXXx', 'XEEXEEx', 'XrEXrEx', 'XXX.XXx', '.XXXXx.', '.X.X.x.'])
    // the bony hand on the shaft
    stamp(g, 19, 13, ['XX..', 'xXXX', '..XX'])
    return rowsOf(g)
  }
  const DEATH = [0, 1].map((f) => pairOutlined(deathFig(f), PDE))
  const DEATH_W = pairOutlined(deathFig(0), whiteOf(PDE))
  const SICKLE = (() => {
    const c = sprite(['..AAA..', '.A...A.', 'A.....A', '......A', '.....a.', '....n..', '...n...'], PDE)
    return [0, 1, 2, 3].map((q) => outline(rot(c, q)))
  })()

  // ---- layout helpers ----------------------------------------------------------
  // spans the furniture covers, padded
  const blocks = (s, pad = 4) => s.fix.map((f) => [f.x - pad, f.x + f.w + pad])
  // nearest x whose [x-hw, x+hw] keeps clear of the furniture
  function openSpot(s, x, hw) {
    const bl = blocks(s, 3)
    const ok = (c) => c - hw >= 4 && c + hw <= s.W - 4 && bl.every(([a, b]) => c + hw <= a || c - hw >= b)
    for (let d = 0; d < s.W; d += 2) {
      if (ok(x - d)) return x - d
      if (ok(x + d)) return x + d
    }
    return clamp(x, hw + 4, s.W - hw - 4)
  }
  function gaps(s) {
    const bl = blocks(s, 6).sort((a, b) => a[0] - b[0])
    const out = []
    let prev = 4
    for (const [a, b] of bl) {
      if (a - prev > 0) out.push([prev, a])
      prev = Math.max(prev, b)
    }
    if (s.W - 4 - prev > 0) out.push([prev, s.W - 4])
    return out
  }
  // candles in the open stretches, and the stairs in the widest one
  function placeScenery(s) {
    const gs = gaps(s)
    let stair = null
    let widest = null
    for (const gp of gs) if (!widest || gp[1] - gp[0] > widest[1] - widest[0]) widest = gp
    if (widest && widest[1] - widest[0] >= 110) {
      const right = (widest[0] + widest[1]) / 2 > s.W / 2
      // a quarter of the way in from the gap's outer end, ledge to the outside
      const gw = widest[1] - widest[0]
      const x0 = right ? Math.round(widest[1] - STAIR_W - Math.min(gw * 0.25, 120)) : Math.round(widest[0] + Math.min(gw * 0.25, 120))
      // stairs face the open side of the gap
      stair = { x0, dir: right ? 1 : -1 }
      stair.foot = right ? x0 - 1 : x0 + STAIR_W
      stair.top = right ? x0 + 13 : x0 + STAIR_W - 14
      stair.candleX = right ? x0 + 25 : x0 + 4
      stair.span = [x0 - 6, x0 + STAIR_W + 6]
    }
    const cands = []
    const kinds = ['mid', 'low', 'tall', 'mid', 'tall', 'low']
    let i = 0
    for (let [a, b] of gs) {
      // the stairs split their gap in two
      const parts = stair && a <= stair.x0 && b >= stair.x0 + STAIR_W ? [[a, stair.span[0] - 4], [stair.span[1] + 4, b]] : [[a, b]]
      for (const [p0, p1] of parts) {
        const w = p1 - p0
        const n = w < 30 ? 0 : clamp(Math.floor((w - 10) / 60), 1, 4)
        for (let k = 1; k <= n; k++) cands.push({ x: Math.round(p0 + (w * k) / (n + 1)), kind: kinds[i++ % kinds.length] })
      }
    }
    if (stair) cands.push({ x: stair.candleX, kind: 'mid', ledge: true })
    return { stair, cands }
  }

  // ---- actors ----------------------------------------------------------------
  class Flame {
    constructor(x, y) {
      this.x = x
      this.y = y
      this.t = 0
      this.z = 8
      this.prop = true
    }
    update(dt) {
      this.t += dt
      if (this.t > 0.42) this.dead = true
      return FAST
    }
    draw(c) {
      c.drawImage(HIT_FLAME[Math.min(2, Math.floor(this.t / 0.14))], Math.round(this.x - 4), Math.round(this.y - 9))
    }
  }

  class Stairs {
    constructor(st) {
      this.st = st
      this.prop = true
      this.z = -2
    }
    update() {
      return Infinity
    }
    draw(c) {
      c.drawImage(STAIR[this.st.dir], this.st.x0, FLOOR - STAIR_H)
    }
  }

  class Candle {
    constructor(s, spec) {
      this.s = s
      this.prop = true
      this.z = -1
      this.lit = true
      this.relightAt = 0
      this.set(spec)
    }
    set(spec) {
      this.x = spec.x
      this.kind = spec.kind
      this.ledge = !!spec.ledge
      this.base = this.ledge ? FLOOR - STAIR_H : FLOOR
      this.top = this.base - CANDLE_H[this.kind]
    }
    // the wax candle itself (the whip has to hit this, not the flame)
    get box() {
      return { x0: this.x - 2, x1: this.x + 3, y0: this.top + 3, y1: this.top + 9 }
    }
    hit(x, y) {
      return Math.abs(x - this.x) <= 6 && y >= this.top - 3 && y <= this.top + 13
    }
    onClick() {
      const s = this.s
      clicked(s)
      if (this.lit) return s.data.bel.order({ candle: this })
      // poke a snuffed candle and it catches again
      this.lit = true
      s.burst(this.x, this.top + 2, 6, ['y', 'w', 'O'])
    }
    snuff(s, now) {
      this.lit = false
      this.relightAt = now + rand(18000, 32000)
      s.spawn(new Flame(this.x, this.top + 9))
      s.spawn(new Item(s, dropFor(s), this.x, this.top + 6, this.base))
    }
    update(dt, now, s) {
      if (!live(s, now)) return Infinity
      if (!this.lit && !s.busy && now > this.relightAt) {
        this.lit = true
        s.burst(this.x, this.top + 2, 5, ['y', 'w'])
      }
      return this.lit ? Infinity : Math.max(SLOW, this.relightAt - now)
    }
    draw(c, s) {
      const img = this.lit ? CANDLE[this.kind][s.data.flick & 1] : CANDLE[this.kind].out
      c.drawImage(img, Math.round(this.x - 4), Math.round(this.top - 1))
    }
  }

  function dropFor(s) {
    const d = s.data
    const r = Math.random()
    if (d.hp < 12 && r < 0.14) return 'roast'
    if (d.whip === 'leather' && r < 0.3) return 'chain'
    if (r < 0.55) return 'heart'
    if (r < 0.72) return 'bigheart'
    if (r < 0.9) return pick(['dagger', 'axe', 'holy'].filter((k) => k !== d.sub))
    return 'bag'
  }

  class Item {
    constructor(s, kind, x, y, floorY) {
      this.s = s
      this.kind = kind
      this.x = x
      this.x0 = x
      this.y = y
      this.floorY = floorY
      this.vy = kind === 'heart' ? 16 : -40
      this.landed = false
      this.t = 0
      this.z = 1
      this.prop = true
      this.blink = false
      this.grabbable = true
      this.held = false
    }
    hit(x, y) {
      return Math.abs(x - this.x) <= 7 && y >= this.y - 10 && y <= this.y + 2
    }
    onClick() {
      clicked(this.s)
      this.s.data.bel.order({ item: this })
    }
    // carry a drop over to Simon (or anywhere: it falls where you let go)
    grab(p) {
      this.s.data.grabAt = performance.now()
      this.held = true
      this.blink = false
      this.drag(p)
    }
    drag(p) {
      this.s.data.grabAt = performance.now()
      this.x = clamp(p.x, 4, this.s.W - 4)
      this.y = clamp(p.y + 4, 8, FLOOR)
    }
    drop() {
      const s = this.s
      const bel = s.data.bel
      s.data.grabAt = performance.now()
      this.held = false
      if (Math.abs(this.x - bel.x) < 14 && this.y > bel.y - 30 && bel.state !== 'rest') {
        bel.collect(s, this)
        return
      }
      const st = s.data.stair
      const ledge = st && this.y <= FLOOR - STAIR_H && (st.dir === 1 ? this.x >= st.top && this.x <= st.x0 + STAIR_W : this.x <= st.top && this.x >= st.x0)
      this.floorY = ledge ? FLOOR - STAIR_H : FLOOR
      this.landed = false
      this.vy = this.kind === 'heart' ? 16 : 0
      this.x0 = this.x
      this.t = 0
    }
    update(dt, now, s) {
      this.t += dt
      if (this.held) return FAST
      if (!this.landed) {
        if (this.kind === 'heart') this.x = this.x0 + Math.sin(this.t * 5) * 3 // the little heart flutters down
        else this.vy += 300 * dt
        this.y += this.vy * dt
        if (this.y >= this.floorY) {
          this.y = this.floorY
          this.landed = now
        }
        return FAST
      }
      if (!live(s, now)) return Infinity
      const age = now - this.landed
      if (age > 9000) this.dead = true
      if (age > 7000) {
        this.blink = !this.blink
        return SLOW
      }
      return 7000 - age + 10
    }
    draw(c) {
      if (this.blink) return
      const sp = ITEMS[this.kind]
      c.drawImage(sp[1], Math.round(this.x - sp.w / 2), Math.round(this.y - sp.h + 1))
    }
  }

  // sub-weapons in flight
  class Shot {
    constructor(s, kind, x, y, dir) {
      this.s = s
      this.kind = kind
      this.x = x
      this.y = y
      this.dir = dir
      this.t = 0
      this.z = 6
      this.moving = true
      this.hits = new Set()
      this.fire = 0
      if (kind === 'dagger') [this.vx, this.vy, this.g] = [dir * 150, 0, 0]
      if (kind === 'axe') [this.vx, this.vy, this.g] = [dir * 62, -128, 260]
      if (kind === 'holy') [this.vx, this.vy, this.g] = [dir * 58, -50, 260]
    }
    get box() {
      if (this.fire) return { x0: this.x - 7, x1: this.x + 7, y0: FLOOR - 9, y1: FLOOR }
      return { x0: this.x - 4, x1: this.x + 4, y0: this.y - 4, y1: this.y + 4 }
    }
    update(dt, now, s) {
      this.t += dt
      if (this.fire) {
        if (this.t > this.fire) this.dead = true
      } else {
        this.x += this.vx * dt
        this.y += this.vy * dt
        this.vy += this.g * dt
        if (this.kind === 'holy' && this.y >= FLOOR - 3) {
          // the bottle breaks into a short-lived wall of blue fire
          this.y = FLOOR
          this.fire = this.t + 1.3
        }
        if (this.x < -10 || this.x > s.W + 10 || this.y > FLOOR + 10) this.dead = true
      }
      for (const a of s.actors) {
        if (a.dead || !a.foe || this.hits.has(a) || !a.box || !ov(this.box, a.box)) continue
        this.hits.add(a)
        a.struck(s, this.kind)
        if (this.kind === 'dagger') this.dead = true
      }
      const b = s.data.boss
      if (b && b.vulnerable && !this.hits.has(b) && ov(this.box, b.headBox)) {
        this.hits.add(b)
        b.struck(s)
        if (this.kind === 'dagger') this.dead = true
      }
      return FAST
    }
    draw(c) {
      const x = Math.round(this.x)
      const y = Math.round(this.y)
      if (this.fire) c.drawImage(HOLY_FIRE[Math.floor(this.t * 10) & 1], x - 5, FLOOR - 7)
      else if (this.kind === 'axe') c.drawImage(AXE_SPIN[(Math.floor(this.t * 14) * (this.dir === 1 ? 1 : 3)) & 3], x - 5, y - 5)
      else {
        const sp = ITEMS[this.kind]
        c.drawImage(sp[this.dir], x - (sp.w >> 1), y - (sp.h >> 1))
      }
    }
  }

  // Medusa heads come in from an edge in the familiar sine wave
  class Medusa {
    constructor(s, side) {
      this.s = s
      this.foe = true
      this.dir = side === 1 ? -1 : 1
      this.x = side === 1 ? s.W + 8 : -8
      this.base = FLOOR - rand(13, 21)
      this.y = this.base
      this.ph = Math.random() * 6
      this.moving = true
      this.z = 5
      this.f = 0
    }
    get box() {
      return { x0: this.x - 5, x1: this.x + 5, y0: this.y - 5, y1: this.y + 5 }
    }
    hit(x, y) {
      return Math.abs(x - this.x) <= 9 && Math.abs(y - this.y) <= 8
    }
    onClick() {
      clicked(this.s)
      this.s.data.bel.order({ foe: this })
    }
    struck(s) {
      this.dead = true
      s.spawn(new Flame(this.x, this.y + 4))
      s.particle({ digits: '300', x: this.x - 6, y: this.y - 12, vy: -10, life: 0.9, fade: true })
    }
    update(dt, now, s) {
      if (!live(s, now)) {
        this.dead = true
        s.spawn(new Flame(this.x, this.y + 4))
        return FAST
      }
      this.x += this.dir * 30 * dt
      this.ph += dt * 3.4
      this.y = clamp(this.base + Math.sin(this.ph) * 8, 6, FLOOR - 6)
      this.f++
      if (this.x < -12 || this.x > s.W + 12) this.dead = true
      return FAST
    }
    draw(c) {
      const sp = MEDUSA[(this.f >> 2) & 1]
      c.drawImage(sp[this.dir], Math.round(this.x - 7), Math.round(this.y - 6))
    }
  }

  // a zombie claws up out of the floor and shuffles at him
  class Zombie {
    constructor(s, x, dir) {
      this.s = s
      this.foe = true
      this.x = x
      this.y = FLOOR
      this.dir = dir
      this.state = 'rise'
      this.t = 0
      this.walked = 0
      this.z = 2
      this.moving = true
      this.y = FLOOR
      this.vy = 0
      this.turnAt = 0
    }
    get box() {
      if (this.state !== 'walk') return null
      return { x0: this.x - 4, x1: this.x + 5, y0: FLOOR - 21, y1: FLOOR }
    }
    get grabbable() {
      return this.state === 'walk'
    }
    hit(x, y) {
      return (this.state === 'walk' || this.state === 'held' || this.state === 'rise') && Math.abs(x - this.x) <= 8 && y >= this.y - 23 && y <= this.y + 1
    }
    onClick() {
      clicked(this.s)
      this.s.data.bel.order({ foe: this })
    }
    // pull one out of the floor by the scruff; let go and it comes apart on landing
    grab(p) {
      this.s.data.grabAt = performance.now()
      this.state = 'held'
      this.drag(p)
    }
    drag(p) {
      this.s.data.grabAt = performance.now()
      if (this.state !== 'held') return
      const nx = clamp(p.x, 6, this.s.W - 6)
      if (Math.abs(nx - this.x) > 1) this.dir = nx > this.x ? 1 : -1
      this.x = nx
      this.y = clamp(p.y + 21, 22, FLOOR)
    }
    drop() {
      this.s.data.grabAt = performance.now()
      if (this.state !== 'held') return
      this.state = 'drop'
      this.vy = 0
    }
    struck(s) {
      this.dead = true
      s.spawn(new Flame(this.x, this.y - 6))
      s.spawn(new Flame(this.x + 1, this.y - 14))
      s.particle({ digits: '100', x: this.x - 6, y: this.y - 28, vy: -10, life: 0.9, fade: true })
    }
    update(dt, now, s) {
      this.t += dt
      if (this.state === 'held') return FAST
      if (this.state === 'drop') {
        this.vy += GRAV * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR) {
          this.y = FLOOR
          s.burst(this.x, FLOOR - 2, 6, ['n', 'z'])
          this.struck(s)
        }
        return FAST
      }
      if (!live(s, now) && this.state !== 'sink') {
        this.state = 'sink'
        this.t = 0
      }
      // they lurch toward a cursor that comes close: the living smell good
      const cur = s.cursor
      if (this.state === 'walk' && cur && Math.abs(cur.x - this.x) < 36 && now > this.turnAt) {
        const want = cur.x > this.x ? 1 : -1
        if (want !== this.dir) {
          this.dir = want
          this.turnAt = now + 1200
        }
      }
      if (this.state === 'rise') {
        if (Math.random() < 0.3) s.particle({ img: pix('n'), x: this.x + rand(-5, 5), y: FLOOR - 1, vy: -rand(10, 30), g: 90, life: 0.5 })
        if (this.t > 0.9) {
          this.state = 'walk'
          this.t = 0
        }
      } else if (this.state === 'walk') {
        this.x += this.dir * 13 * dt
        this.walked += dt
        if (this.x < 6 || this.x > s.W - 6 || this.walked > 16) {
          this.state = 'sink'
          this.t = 0
        }
      } else if (this.t > 0.7) this.dead = true
      return FAST
    }
    draw(c) {
      const sp = ZOMBIE[Math.floor(this.walked * 4) & 1]
      const vis = this.state === 'rise' ? Math.min(1, this.t / 0.9) : this.state === 'sink' ? Math.max(0, 1 - this.t / 0.7) : 1
      const h = Math.round(sp.h * vis)
      if (h <= 0) return
      if (this.state === 'held' || this.state === 'drop') {
        // dangling: the legs kick
        c.drawImage(ZOMBIE[Math.floor(this.t * 6) & 1][this.dir], Math.round(this.x - 6), Math.round(this.y - sp.h + 1))
        return
      }
      c.drawImage(sp[this.dir], 0, 0, sp.w, h, Math.round(this.x - 6), FLOOR - h + 1, sp.w, h)
    }
  }

  // A white skeleton walks in, keeps its distance with that jittery back-and-forth
  // step and lobs bones at Simon; one crack of the whip and it collapses.
  class Skeleton {
    constructor(s, side) {
      this.s = s
      this.foe = true
      this.x = side === 1 ? s.W + 8 : -8
      this.dir = side === 1 ? -1 : 1
      this.state = 'enter'
      this.t = 0
      this.f = 0
      this.z = 2
      this.moving = true
      this.throws = 0
      this.throwAt = performance.now() + rand(1600, 2600)
      this.jig = 0
      this.life = 0
    }
    get box() {
      if (this.state === 'heap') return null
      return { x0: this.x - 4, x1: this.x + 4, y0: FLOOR - 21, y1: FLOOR }
    }
    hit(x, y) {
      return this.state !== 'heap' && Math.abs(x - this.x) <= 8 && y >= FLOOR - 24 && y <= FLOOR
    }
    onClick() {
      clicked(this.s)
      this.s.data.bel.order({ foe: this })
    }
    struck(s) {
      if (this.state === 'heap') return
      this.state = 'heap'
      this.t = 0
      this.foe = false
      s.burst(this.x, FLOOR - 12, 8, ['w', 'A'])
      s.particle({ digits: '300', x: this.x - 6, y: FLOOR - 28, vy: -10, life: 0.9, fade: true })
    }
    update(dt, now, s) {
      this.t += dt
      this.life += dt
      if (this.state === 'heap') {
        if (this.t > 1.1) this.dead = true
        return FAST
      }
      const bel = s.data.bel
      const toward = bel.x > this.x ? 1 : -1
      if (!live(s, now) || (this.state !== 'leave' && (this.throws >= 4 || this.life > 16))) this.state = 'leave'
      if (this.state === 'leave') {
        this.dir = this.x < s.W / 2 ? -1 : 1
        this.x += this.dir * 30 * dt
        this.f++
        if (this.x < -10 || this.x > s.W + 10) this.dead = true
        return FAST
      }
      const gap = Math.abs(bel.x - this.x)
      if (this.state === 'enter') {
        this.dir = toward
        this.x += this.dir * 24 * dt
        this.f++
        if (gap < rand(60, 85) || (this.x > 12 && this.x < s.W - 12 && this.life > 6)) this.state = 'jig'
        return FAST
      }
      // the jig: a couple of steps back and forth, always facing him
      this.dir = toward
      this.jig += dt
      const back = gap < 46 ? -1 : gap > 90 ? 1 : Math.sin(this.jig * 2.2) > 0 ? 1 : -1
      this.x = clamp(this.x + toward * back * 14 * dt, 8, s.W - 8)
      if (Math.floor(this.jig * 6) !== Math.floor((this.jig - dt) * 6)) this.f++
      if (this.state === 'jig' && now > this.throwAt) {
        this.state = 'throw'
        this.t = 0
      }
      if (this.state === 'throw' && this.t > 0.3) {
        this.state = 'jig'
        this.throws++
        this.throwAt = now + rand(1400, 2600)
        const v = clamp(gap * 1.15, 40, 95)
        s.spawn(new Bone(this.x + this.dir * 4, FLOOR - 22, this.dir * v, -rand(85, 110)))
      }
      return FAST
    }
    draw(c) {
      const sp = this.state === 'heap' ? SKEL[3] : this.state === 'throw' ? SKEL[2] : SKEL[(this.f >> 2) & 1]
      if (this.state === 'heap' && this.t > 0.8 && Math.floor(this.t * 12) & 1) return
      c.drawImage(sp[this.dir], Math.round(this.x - 6) - 1, FLOOR - 24)
    }
  }
  class Bone {
    constructor(x, y, vx, vy) {
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.t = 0
      this.z = 6
      this.foe = true
      this.hazard = true
      this.moving = true
    }
    get box() {
      return { x0: this.x - 3, x1: this.x + 3, y0: this.y - 3, y1: this.y + 3 }
    }
    struck(s) {
      this.dead = true
      s.burst(this.x, this.y, 4, ['w', 'A'])
    }
    update(dt, now, s) {
      this.t += dt
      this.vy += 200 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.y > FLOOR - 2) {
        s.burst(this.x, FLOOR - 2, 3, ['w', 'A'])
        this.dead = true
      }
      if (this.x < -8 || this.x > s.W + 8 || !live(s, now)) this.dead = true
      return FAST
    }
    draw(c) {
      c.drawImage(BONE[Math.floor(this.t * 12) & 3], Math.round(this.x - 3), Math.round(this.y - 3))
    }
  }

  // The fishman bursts up out of the floor in a spray of water, plods at Simon,
  // spits a fireball (duck it) and dives back down.
  class Fishman {
    constructor(s, x) {
      this.s = s
      this.foe = true
      this.x = x
      this.y = FLOOR + 24
      this.vy = -158 // big enough to break the top of the bar
      this.dir = s.data.bel.x > x ? 1 : -1
      this.state = 'leap'
      this.t = 0
      this.f = 0
      this.z = 2
      this.moving = true
      this.spits = 0
      this.spitAt = performance.now() + rand(1800, 2800)
      splash(s, x)
    }
    get box() {
      if (this.y > FLOOR + 4) return null
      return { x0: this.x - 5, x1: this.x + 5, y0: this.y - 22, y1: this.y }
    }
    hit(x, y) {
      return this.y < FLOOR + 10 && Math.abs(x - this.x) <= 9 && y >= this.y - 25 && y <= this.y + 1
    }
    onClick() {
      clicked(this.s)
      this.s.data.bel.order({ foe: this })
    }
    struck(s) {
      this.dead = true
      s.spawn(new Flame(this.x, this.y - 6))
      s.spawn(new Flame(this.x, this.y - 16))
      s.particle({ digits: '300', x: this.x - 6, y: Math.max(2, this.y - 30), vy: -10, life: 0.9, fade: true })
    }
    update(dt, now, s) {
      this.t += dt
      this.f++
      const bel = s.data.bel
      if (this.state === 'leap' || this.state === 'dive') {
        this.vy += 320 * dt
        this.y += this.vy * dt
        if (this.state === 'leap' && this.vy > 0 && this.y >= FLOOR) {
          this.y = FLOOR
          this.state = 'walk'
          this.t = 0
        }
        if (this.state === 'dive' && this.y > FLOOR + 26) this.dead = true
        return FAST
      }
      if (!live(s, now) || this.spits >= 2 || this.t > 11) {
        if (this.state !== 'dive') {
          this.state = 'dive'
          this.vy = -60
          splash(s, this.x)
        }
        return FAST
      }
      this.dir = bel.x > this.x ? 1 : -1
      if (this.state === 'walk') {
        if (Math.abs(bel.x - this.x) > 26) this.x = clamp(this.x + this.dir * 12 * dt, 8, s.W - 8)
        if (now > this.spitAt) {
          this.state = 'spit'
          this.st = 0
        }
      } else if (this.state === 'spit') {
        this.st += dt
        if (this.st > 0.45) {
          this.state = 'walk'
          this.spits++
          this.spitAt = now + rand(2200, 3400)
          s.spawn(new Fireball(this.x + this.dir * 7, FLOOR - 19, this.dir * 66, 0))
        }
      }
      return FAST
    }
    draw(c) {
      const fr = this.state === 'spit' ? 2 : this.state === 'walk' ? (this.f >> 2) & 1 : 0
      const sp = FISH[fr][this.dir]
      const top = Math.round(this.y) - 25
      const h = Math.min(sp.height, FLOOR + 1 - top)
      if (h > 0) c.drawImage(sp, 0, 0, sp.width, h, Math.round(this.x - 7) - 1, top, sp.width, h)
    }
  }
  function splash(s, x) {
    for (let i = 0; i < 12; i++) s.particle({ img: pix(pick(['c', 'b', 'w'])), x: x + rand(-6, 6), y: FLOOR - 1, vx: rand(-25, 25), vy: -rand(40, 95), g: 220, life: rand(0.5, 0.9), fade: true })
  }

  // The bat roosts upside down under the title. It flutters around the cursor
  // and, now and then, dives at Simon; the whip sends it back to roost.
  class Bat {
    constructor(s) {
      this.s = s
      this.state = 'hang'
      this.f = 0
      this.t = 0
      this.calmUntil = 0
      this.nextDive = performance.now() + rand(7000, 14000)
      this.place()
      this.x = this.rx
      this.y = this.ry
      this.z = 5
    }
    place() {
      const t = this.s.fixture('title')
      this.rx = clamp(t.x + Math.round(t.w * 0.72), 8, this.s.W - 8)
      this.ry = t.y + t.h + 1
    }
    get foe() {
      return this.state === 'dive'
    }
    get asleep() {
      return this.state === 'hang'
    }
    get moving() {
      return this.state !== 'hang' && this.state !== 'cameo'
    }
    get box() {
      return { x0: this.x - 6, x1: this.x + 6, y0: this.y - 3, y1: this.y + 3 }
    }
    get grabbable() {
      return this.state !== 'cameo'
    }
    hit(x, y) {
      if (this.state === 'cameo') return false
      return this.state === 'hang' ? Math.abs(x - this.x) <= 6 && y >= this.y - 2 && y <= this.y + 11 : Math.abs(x - this.x) <= 10 && Math.abs(y - this.y) <= 7
    }
    onClick() {
      clicked(this.s)
      if (this.state === 'held') return
      if (this.state === 'hang') {
        this.state = 'fly'
        this.s.say('!', this.x, this.y - 8, { life: 0.7, color: '#ff7a7a' })
      }
      this.s.data.bel.order({ foe: this })
    }
    // double-click the sleeping bat: it was never just a bat
    onDblClick() {
      const s = this.s
      const d = s.data
      clicked(s)
      if (d.boss || d.orb || s.busy || this.state === 'held') return
      this.state = 'cameo'
      s.burst(this.x, this.y + 2, 10, ['v', 'r', 'w'])
      d.boss = s.spawn(new Boss(s, 'dracula', { x: this.x }))
    }
    grab(p) {
      this.s.data.grabAt = performance.now()
      this.state = 'held'
      this.s.say('!', this.x, Math.max(0, this.y - 10), { life: 0.6, color: '#ff7a7a' })
      this.drag(p)
    }
    drag(p) {
      this.s.data.grabAt = performance.now()
      if (this.state !== 'held') return
      this.x = clamp(p.x, 8, this.s.W - 8)
      this.y = clamp(p.y, 4, FLOOR - 4)
    }
    drop() {
      this.s.data.grabAt = performance.now()
      if (this.state !== 'held') return
      this.s.burst(this.x, this.y, 5, ['v', 'w'])
      this.scare(performance.now())
    }
    struck(s) {
      s.burst(this.x, this.y, 6, ['v', 'w'])
      this.scare(performance.now())
    }
    scare(now) {
      this.state = 'home'
      this.calmUntil = now + 4000
      this.nextDive = now + rand(10000, 18000)
    }
    update(dt, now, s) {
      this.f++
      const cur = s.cursor
      const bel = s.data.bel
      const lv = live(s, now)
      if (this.state === 'held') return FAST
      if (this.state === 'cameo') {
        // Dracula is using the bat's body; it comes back when he leaves
        const b = s.data.boss
        if (b && b.cameo && !b.dead) return lv ? SLOW : Infinity
        this.state = 'home'
        this.x = clamp(this.x, 8, s.W - 8)
      }
      if (this.state === 'hang') {
        if (!lv) return Infinity
        if (now < this.calmUntil) return this.calmUntil - now + 50
        if (cur && cur.y < H + 4 && Math.abs(cur.x - this.x) < 90) this.state = 'fly'
        else if (now > this.nextDive && bel.free && !s.data.boss) {
          this.state = 'dive'
          this.t = 0
        } else return cur || s.busy ? SLOW : Math.max(SLOW, this.nextDive - now + 20)
      }
      let tx = this.rx
      let ty = this.ry + 4
      let sp = 60
      if (this.state === 'fly') {
        if (!lv) this.state = 'home'
        else if (cur && cur.y < H + 10) {
          this.lost = 0
          this.t += dt
          tx = cur.x + Math.cos(this.t * 2.4) * 12
          ty = cur.y + Math.sin(this.t * 4.8) * 4 - 4
        } else if ((this.lost = (this.lost || 0) + dt) > 1.5) this.state = 'home'
        else {
          tx = this.x
          ty = this.y
        }
      } else if (this.state === 'dive') {
        // the swooping wave at Simon's head
        this.t += dt
        tx = bel.x + Math.cos(this.t * 2.6) * 22
        ty = bel.y - 22 + Math.sin(this.t * 5.2) * 5
        sp = 48
        if (this.t > 7 || !lv || s.data.boss) this.scare(now)
      }
      const dx = tx - this.x
      const dy = clamp(ty, 4, FLOOR - 4) - this.y
      const d = Math.hypot(dx, dy)
      const step = Math.min(d, sp * dt)
      if (d > 0.01) {
        this.x += (dx / d) * step
        this.y += (dy / d) * step
      }
      this.x = clamp(this.x, 8, s.W - 8)
      if (this.state === 'home' && d < 1) {
        this.state = 'hang'
        this.x = this.rx
        this.y = this.ry
        this.t = 0
        return lv ? 400 : Infinity
      }
      return FAST
    }
    draw(c) {
      if (this.state === 'cameo') return
      if (this.state === 'hang') c.drawImage(BAT_HANG, Math.round(this.x - 4), Math.round(this.y - 1))
      else c.drawImage(BAT[[0, 1, 2, 1][(this.f >> 1) & 3]], Math.round(this.x - 8), Math.round(this.y - 4))
    }
  }

  class Fireball {
    constructor(x, y, vx, vy) {
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.z = 6
      this.f = 0
      this.hazard = true
      this.moving = true
    }
    get box() {
      return { x0: this.x - 2, x1: this.x + 3, y0: this.y - 2, y1: this.y + 3 }
    }
    update(dt, now, s) {
      this.f++
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.x < -8 || this.x > s.W + 8 || this.y > FLOOR - 2 || this.y < -6) {
        if (this.y > FLOOR - 2) s.burst(this.x, FLOOR - 2, 4, ['O', 'y'])
        this.dead = true
      }
      return FAST
    }
    draw(c) {
      c.drawImage(FIREBALL[(this.f >> 1) & 1], Math.round(this.x - 3), Math.round(this.y - 3))
    }
  }

  // Death's sickles fan out, then home in on Simon; the whip breaks them
  class Sickle {
    constructor(x, y, vx, vy) {
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.t = 0
      this.z = 6
      this.foe = true
      this.hazard = true
      this.moving = true
    }
    get box() {
      return { x0: this.x - 3, x1: this.x + 4, y0: this.y - 3, y1: this.y + 4 }
    }
    struck(s) {
      this.dead = true
      s.spawn(new Flame(this.x, this.y + 4))
    }
    update(dt, now, s) {
      this.t += dt
      const b = s.data.bel
      if (this.t > 0.7) {
        const dx = b.x - this.x
        const dy = b.y - 14 - this.y
        const d = Math.hypot(dx, dy) || 1
        this.vx += ((dx / d) * 30 - this.vx) * Math.min(1, dt * 1.6)
        this.vy += ((dy / d) * 30 - this.vy) * Math.min(1, dt * 1.6)
      } else {
        this.vx *= 1 - dt * 1.5
        this.vy *= 1 - dt * 1.5
      }
      this.x += this.vx * dt
      this.y = clamp(this.y + this.vy * dt, 4, FLOOR - 4)
      if (this.t > 5 || !live(s, now)) this.struck(s)
      return FAST
    }
    draw(c) {
      c.drawImage(SICKLE[Math.floor(this.t * 12) & 3], Math.round(this.x - 4), Math.round(this.y - 4))
    }
  }

  class Orb {
    constructor(x, y) {
      this.x = x
      this.y = y
      this.vy = -30
      this.f = 0
      this.z = 4
      this.landed = false
      this.moving = true
    }
    update(dt) {
      this.f++
      if (!this.landed) {
        this.vy += 240 * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR) {
          this.y = FLOOR
          if (this.vy > 40) this.vy *= -0.35
          else this.landed = true
        }
      }
      return FAST
    }
    draw(c) {
      c.drawImage(ORB[(this.f >> 1) & 3], Math.round(this.x - 4), Math.round(this.y - 8))
    }
  }

  // Dracula teleports in, fires his three fireballs and vanishes again; Death
  // drifts above the floor and sends sickles. Only the head can be hurt.
  class Boss {
    constructor(s, kind, cameo = null) {
      this.s = s
      this.kind = kind
      this.cameo = !!cameo
      this.hp = 16
      this.z = 2
      this.dir = -1
      this.flash = 0
      this.x = s.W / 2
      this.y = FLOOR
      this.f = 0
      this.go(kind === 'dracula' ? 'gone' : 'appear', 0.3)
      if (kind === 'death') this.pickSpot()
      this.spoke = false
      if (cameo) {
        // straight out of the bat, on the floor below the roost
        this.x = clamp(cameo.x, 20, s.W - 20)
        this.dir = s.data.bel.x < this.x ? -1 : 1
        this.go('appear')
      }
    }
    go(state, wait = 0) {
      this.state = state
      this.t = 0
      this.wait = wait
    }
    get moving() {
      return this.state !== 'gone'
    }
    get vulnerable() {
      return ['stand', 'open', 'float', 'cast', 'near'].includes(this.state)
    }
    get top() {
      return this.kind === 'dracula' ? this.y - DH : this.y - EH - 2
    }
    get headBox() {
      const t = this.top
      return this.kind === 'dracula' ? { x0: this.x - 4, x1: this.x + 4, y0: t, y1: t + 9 } : { x0: this.x - 5, x1: this.x + 5, y0: t + 1, y1: t + 12 }
    }
    get body() {
      return { x0: this.x - 6, x1: this.x + 6, y0: this.top + 9, y1: this.y }
    }
    hit(x, y) {
      return this.state !== 'gone' && Math.abs(x - this.x) <= 8 && y >= this.top && y <= this.y
    }
    onClick() {
      this.s.data.bel.order({ boss: this })
    }
    pickSpot() {
      const s = this.s
      const b = s.data.bel
      const side = b.x < s.W / 2 ? 1 : -1
      const far = this.kind === 'dracula' ? rand(28, 48) : rand(46, 80)
      let x = b.x + (Math.random() < 0.7 ? side : -side) * far
      if (x < 20 || x > s.W - 20) x = b.x - (x < 20 ? -1 : 1) * far
      this.x = clamp(x, this.kind === 'death' ? 30 : 20, s.W - 20)
      this.dir = b.x < this.x ? -1 : 1
      if (this.kind === 'death') this.y = FLOOR - 1
    }
    struck(s) {
      if (!this.vulnerable || this.flash > 0) return
      this.hp = Math.max(s.busy ? 2 : 1, this.hp - 1)
      this.flash = 0.25
      const h = this.headBox
      s.burst((h.x0 + h.x1) / 2, (h.y0 + h.y1) / 2, 5, ['w', 'y'])
    }
    clink(s) {
      const b = this.body
      s.burst(this.x - this.dir * 2, b.y0 + 6, 3, ['w', 'A'])
    }
    crumble() {
      if (this.state === 'crumble') return
      if (this.state === 'gone' || this.state === 'appear' || this.state === 'vanish') {
        if (this.state === 'gone') this.pickSpot()
      }
      this.go('crumble')
      this.flash = 0
    }
    update(dt, now, s) {
      this.t += dt
      this.f++
      if (this.flash > 0) this.flash -= dt
      const bel = s.data.bel
      if (this.state !== 'crumble' && this.state !== 'gone' && this.state !== 'vanish') this.dir = bel.x < this.x ? -1 : 1
      if (this.state === 'crumble') {
        // the boss burns away from the top down, then the orb drops
        const h = this.kind === 'dracula' ? DH : EH
        const cut = this.top + (this.t / 1.6) * h
        if (this.t < 1.6) s.spawn(new Flame(this.x + rand(-8, 8), cut + rand(6, 12)))
        if (Math.random() < 0.6 && this.t < 1.6) s.particle({ img: pix(pick(['a', 'k', 'v', 'r'])), x: this.x + rand(-8, 8), y: cut, vx: rand(-20, 20), vy: rand(-30, 0), g: 160, life: 0.8, fade: true })
        if (this.t > 1.7) {
          this.dead = true
          s.data.boss = null
          s.spawn((s.data.orb = new Orb(this.x, this.y - 18)))
        }
        return FAST
      }
      if (this.kind === 'death') return this.deathUpdate(dt, now, s)
      switch (this.state) {
        case 'gone':
          if (this.t > this.wait) {
            this.pickSpot()
            this.go('appear')
          }
          return Math.max(FAST, (this.wait - this.t) * 1000)
        case 'appear':
          if (this.t > 0.45) {
            this.f0 = this.f
            this.go('stand')
            if (this.cameo && !this.spoke) {
              this.spoke = true
              this.wait = 2.6 // he has a speech to make first
              s.say(pick(['What is a man? A miserable little pile of secrets!', 'Die monster! You don’t belong in this world!', 'Have at you!']), this.x, 0, { color: '#ff7a7a', life: 3.2 })
            } else if (!this.spoke && Math.random() < 0.6) {
              this.spoke = true
              s.say(pick(['What is a man?', 'Welcome to my castle.', 'Fool!']), this.x, 0, { color: '#ff7a7a', life: 2.6 })
            }
          }
          return FAST
        case 'stand':
          if (this.t > 1.3 + (this.cameo ? this.wait : 0)) this.go('open')
          return FAST
        case 'open':
          if (!this.fired && this.t > 0.18) {
            this.fired = true
            // a fan aimed at a standing man's head: duck and it passes over
            const y = this.y - 22
            for (const vy of [-26, -12, 0]) s.spawn(new Fireball(this.x + this.dir * 6, y, this.dir * 72, vy))
          }
          if (this.t > 0.7) {
            this.fired = false
            this.go('close')
          }
          return FAST
        case 'close':
          if (this.t > 0.6) this.go('vanish')
          return FAST
        case 'vanish':
          if (this.t > 0.4) {
            if (this.cameo) {
              // back into the bat, and back to sleep
              this.dead = true
              s.data.boss = null
              const bat = s.data.bat
              bat.x = this.x
              bat.y = this.y - 20
              s.burst(this.x, this.y - 20, 8, ['v', 'r'])
              return FAST
            }
            this.go('gone', rand(0.6, 1.4))
          }
          return FAST
      }
      return FAST
    }
    deathUpdate(dt, now, s) {
      if (this.state === 'appear') {
        if (this.t > 0.6) this.go('float')
        return FAST
      }
      const bel = s.data.bel
      // hover at sickle range, then glide in close and linger: his opening
      const near = this.state === 'near'
      const want = clamp(bel.x + (this.x >= bel.x ? 1 : -1) * (near ? 24 : 58), 30, s.W - 20)
      this.x += clamp(want - this.x, -(near ? 26 : 16) * dt, (near ? 26 : 16) * dt)
      this.y = FLOOR - 1 + Math.round(Math.sin(this.t * 2.2))
      if (this.state === 'float' && this.t > 2.6) this.go('cast')
      if (this.state === 'near' && this.t > 3) this.go('float')
      if (this.state === 'cast' && this.t > 0.5) {
        const n = s.actors.filter((a) => a instanceof Sickle).length
        for (let i = 0; i < Math.min(3, 6 - n); i++) {
          const a = -Math.PI / 2 + (i - 1) * 0.9
          s.spawn(new Sickle(this.x + this.dir * 6, this.top + 14, Math.cos(a) * 40 + this.dir * 20, Math.sin(a) * 40))
        }
        this.go('near')
      }
      return FAST
    }
    draw(c) {
      const d = this.dir
      const x = Math.round(this.x)
      let sp
      let w
      let h
      let ox
      if (this.kind === 'dracula') {
        if (this.state === 'gone') return
        const open = this.state === 'open'
        sp = (this.flash > 0 && this.f & 1) || (this.state === 'crumble' && this.t < 0.3 && this.f & 1) ? DRAC[open ? 'openW' : 'closedW'] : DRAC[open ? 'open' : 'closed']
        ;[w, h, ox] = [DW, DH, d === 1 ? DX : DW - 1 - DX]
      } else {
        sp = (this.flash > 0 && this.f & 1) || (this.state === 'crumble' && this.t < 0.3 && this.f & 1) ? DEATH_W : DEATH[(this.f >> 2) & 1]
        ;[w, h, ox] = [EW, EH, d === 1 ? EX : EW - 1 - EX]
      }
      const img = sp[d]
      const dx = x - ox - 1
      const dy = Math.round(this.top) - 1
      if (this.state === 'appear' || this.state === 'vanish') {
        // materialise from a thin column of light outward
        const k = this.state === 'appear' ? clamp(this.t / (this.kind === 'death' ? 0.6 : 0.45), 0, 1) : clamp(1 - this.t / 0.4, 0, 1)
        const vw = Math.max(2, Math.round(img.width * k))
        const sx = Math.round((img.width - vw) / 2)
        if (this.f & 1) c.globalAlpha = 0.6
        c.drawImage(img, sx, 0, vw, img.height, dx + sx, dy, vw, img.height)
        c.globalAlpha = 1
        return
      }
      if (this.state === 'crumble') {
        const cut = Math.round((Math.min(1, this.t / 1.6) * (h + 2)))
        if (cut >= img.height) return
        c.drawImage(img, 0, cut, img.width, img.height - cut, dx, dy + cut, img.width, img.height - cut)
        return
      }
      c.drawImage(img, dx, dy)
    }
  }

  // ---- Simon -------------------------------------------------------------------
  const WALK = 30 // px/s, the steady Castlevania plod
  const JUMP_V = 85
  const GRAV = 240
  const WHIP_T = { wind: 0.12, swing: 0.22, end: 0.5 }

  class Belmont {
    constructor(s) {
      this.s = s
      this.x = openSpot(s, 60, 8)
      this.y = FLOOR
      this.floorY = FLOOR
      this.dir = 1
      this.state = 'idle'
      this.t = 0
      this.vx = 0
      this.vy = 0
      this.stance = 'stand'
      this.inv = 0
      this.task = null
      this.next = 0
      this.turnAt = 0
      this.throwAt = 0
      this.lingerAt = 0
      this.stride = 0
      this.f = 0
      this.z = 3
    }
    get moving() {
      return this.state !== 'idle' && this.state !== 'rest'
    }
    get asleep() {
      return this.state === 'rest'
    }
    get free() {
      return (this.state === 'idle' || this.state === 'walk' || this.state === 'kwalk') && this.floorY === FLOOR
    }
    // ---- keyboard: A/D walk, W jumps (or takes the stairs), S crouches, Space whips, W+Space throws ----
    keyDir() {
      const k = this.s.keys
      return (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0)
    }
    key(k) {
      const s = this.s
      const d = s.data
      const st = d.stair
      const ground = this.state === 'idle' || this.state === 'walk' || this.state === 'kwalk' || this.state === 'crouch' || this.state === 'land' || this.state === 'rest'
      if (this.state === 'rest') this.go('idle')
      if (k === 'fire') {
        if (this.state === 'jump') {
          // a whip crack at the top of the jump, arc unchanged
          this.go('whip')
          this.stance = 'jump'
          this.struck = false
          return
        }
        if (!ground) return
        this.task = null
        if (s.keys.has('up') && this.throwSub(true)) return
        const crouch = s.keys.has('down')
        this.startWhip(crouch ? 'crouch' : 'stand')
        return
      }
      if (k === 'up') {
        if (!ground) return
        this.task = null
        // at the foot of the stairs (or on the ledge by the top) W climbs
        if (st && this.floorY === FLOOR && Math.abs(this.x - st.foot) < 7) {
          this.x = st.foot
          this.go('stairs')
          this.task = { dir: 'up' }
          return
        }
        if (st && this.floorY < FLOOR) {
          this.walkTo(st.top, { stairs: 'down' })
          return
        }
        // the committed Castlevania jump, high enough to leave the top of the bar
        this.go('jump')
        this.vy = -94
        this.vx = this.keyDir() * WALK * 1.4
        return
      }
      if (k === 'down') {
        if (st && this.floorY < FLOOR) return this.walkTo(st.top, { stairs: 'down' })
        if (!ground) return
        this.task = null
        this.go('crouch')
        this.hold = Infinity
      }
    }
    get onStairs() {
      return this.state === 'stairs' || this.floorY < FLOOR
    }
    go(state) {
      this.state = state
      this.t = 0
    }
    get bodyBox() {
      const tall = this.state === 'whip' && this.stance !== 'stand' ? 16 : this.state === 'crouch' || this.state === 'land' ? 16 : this.state === 'jump' ? 19 : 23
      return { x0: this.x - 4, x1: this.x + 4, y0: this.y - tall, y1: this.y }
    }
    hit(x, y) {
      const b = this.bodyBox
      return x >= b.x0 - 1 && x <= b.x1 + 1 && y >= b.y0 - 1 && y <= b.y1
    }
    // a click: the jumping whip crack the owner liked
    onClick() {
      const s = this.s
      const now = clicked(s)
      this.clicks = (this.clicks || []).filter((t) => now - t < 2600)
      this.clicks.push(now)
      if (this.clicks.length >= 6 && !s.data.triple) {
        // easter egg: the Konami code. Thirty hearts and the triple shot.
        this.clicks.length = 0
        const d = s.data
        d.hearts = Math.min(99, d.hearts + 30)
        d.triple = 3
        if (!d.sub) d.sub = 'dagger'
        s.say('↑↑↓↓←→←→BA', this.x, 0, { color: '#f8c838', life: 2.6 })
        s.burst(this.x, this.y - 30, 14, ['r', 'y', 'w'])
        if (this.state === 'rest') this.go('idle')
        if (this.free) this.go('cheer')
        return
      }
      if (this.state === 'rest') return this.wake()
      if (this.free) this.startWhip('jump')
    }
    onDblClick() {
      const s = this.s
      clicked(s)
      if (s.cursor && Math.abs(s.cursor.x - this.x) > 4) this.dir = s.cursor.x > this.x ? 1 : -1
      if (this.free) {
        if (!this.throwSub(true)) this.startWhip('crouch')
      }
    }
    wake() {
      this.go('idle')
      this.next = performance.now() + 400
    }
    // an order from a click on something: go and whip it (or pick it up)
    order(o) {
      clicked(this.s)
      if (!this.free && this.state !== 'rest') return
      if (this.state === 'rest') this.go('idle')
      if (o.candle) return this.planCandle(o.candle)
      if (o.item) return this.walkTo(o.item.x, { item: o.item })
      const t = o.foe || o.boss
      if (o.boss && this.throwSub(true)) return
      if (t) {
        const box = t.headBox || t.box
        if (!box) return
        this.engage({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }, true)
      }
      if (o.x !== undefined) this.engage({ x: o.x, y: o.y }, true)
    }
    hurt(fromX) {
      if (this.inv > 0 || this.state === 'hurt') return
      const d = this.s.data
      d.hp = Math.max(3, d.hp - 2)
      d.hpShow = performance.now() + 5000
      this.dir = fromX > this.x ? 1 : -1
      this.vx = -this.dir * 34
      this.vy = -72
      this.floorY = FLOOR
      this.task = null
      this.inv = 1.8
      this.go('hurt')
    }
    startWhip(stance) {
      this.go('whip')
      this.stance = stance
      this.struck = false
      this.task = null
      if (stance === 'jump') {
        this.vy = -JUMP_V
        this.vx = 0
      }
    }
    stanceFor(ty) {
      const rel = this.floorY - ty
      return rel < 11 ? 'crouch' : rel > 20 ? 'jump' : 'stand'
    }
    handY(stance) {
      return this.floorY - (stance === 'crouch' ? 8 : stance === 'jump' ? 24 : 14)
    }
    // the reach of the whip, measured from his centre
    get reach() {
      return 10 + WHIPS[this.s.data.whip].reach - 2
    }
    throwSub(force) {
      const d = this.s.data
      const now = performance.now()
      if (!d.sub || d.hearts < 1 || (!force && now < this.throwAt)) return false
      d.hearts--
      this.throwAt = now + rand(2500, 4500)
      this.go('throw')
      this.thrown = false
      return true
    }
    walkTo(x, task) {
      this.task = { x: clamp(Math.round(x), 6, this.s.W - 6), ...task }
      this.go('walk')
      return FAST
    }
    planCandle(c) {
      const s = this.s
      if (c.ledge) {
        const st = s.data.stair
        if (!st) return FAST
        return this.walkTo(st.foot, { stairs: 'up', candle: c })
      }
      const reachX = 10 + WHIPS[s.data.whip].reach * 0.55
      const left = c.x - reachX
      const right = c.x + reachX
      let dir = Math.abs(left - this.x) <= Math.abs(right - this.x) ? 1 : -1
      if (dir === 1 && left < 6) dir = -1
      if (dir === -1 && right > s.W - 6) dir = 1
      const stance = c.kind === 'low' ? 'crouch' : c.kind === 'tall' ? 'jump' : 'stand'
      return this.walkTo(dir === 1 ? left : right, { whip: stance, face: dir })
    }
    // face a target and whip it when it's in reach, or close in
    engage(tg, ordered) {
      const dx = tg.x - this.x
      const dist = Math.abs(dx)
      const want = Math.sign(dx) || this.dir
      if (want !== this.dir) this.dir = want
      if (dist <= this.reach && dist >= 3) {
        this.startWhip(this.stanceFor(tg.y))
        return FAST
      }
      if (dist < 3) return FAST
      if (ordered) return this.walkTo(tg.x - want * (this.reach - 6), { whip: this.stanceFor(tg.y), face: want })
      return null
    }
    threat(s) {
      let best = null
      let bd = 1e9
      for (const a of s.actors) {
        if (a.dead || !a.foe || !a.box) continue
        const b = a.box
        const cx = (b.x0 + b.x1) / 2
        const d = Math.abs(cx - this.x)
        if (d > 70 || d >= bd) continue
        bd = d
        best = { a, x: cx, y: (b.y0 + b.y1) / 2 }
      }
      return best
    }
    // jump or duck the boss's fireballs (not always in time)
    dodge(s) {
      for (const a of s.actors) {
        if (!(a instanceof Fireball) || a.judged) continue
        const ahead = (a.x - this.x) * Math.sign(-a.vx)
        if (ahead < 0 || ahead > 40) continue
        a.judged = true
        if (this.floorY - a.y < 26 && Math.random() < 0.75) {
          this.go('crouch')
          this.hold = 0.75
          return true
        }
      }
      return false
    }
    strike(s) {
      const d = this.dir
      const hy = this.y - 28 + SIM[(this.stance === 'stand' ? '' : this.stance[0]) + 'strike'].hand[1]
      const r = WHIPS[s.data.whip].reach
      const box = { x0: d === 1 ? this.x + 3 : this.x - 10 - r, x1: d === 1 ? this.x + 10 + r : this.x - 3, y0: hy - 3, y1: hy + 3 }
      const now = performance.now()
      for (const a of s.actors) {
        if (a.dead) continue
        if (a instanceof Candle && a.lit && ov(box, a.box)) a.snuff(s, now)
        else if (a.foe && a.box && ov(box, a.box)) a.struck(s, 'whip')
      }
      const b = s.data.boss
      if (b && b.vulnerable) {
        if (ov(box, b.headBox)) b.struck(s)
        else if (ov(box, b.body)) b.clink(s)
      }
    }
    collect(s, it) {
      const d = s.data
      it.dead = true
      if (it.kind === 'heart') d.hearts = Math.min(99, d.hearts + 1)
      else if (it.kind === 'bigheart') d.hearts = Math.min(99, d.hearts + 5)
      else if (it.kind === 'chain') {
        d.whip = 'chain'
        s.burst(this.x, this.y - 14, 12, ['w', 'A', 'y'])
      } else if (it.kind === 'bag') s.particle({ digits: '1000', x: this.x - 8, y: this.y - 32, vy: -10, life: 1.1, fade: true })
      else if (it.kind === 'roast') {
        // wall meat: full health
        d.hp = 16
        d.hpShow = performance.now() + 4000
        s.burst(this.x, this.y - 20, 10, ['r', 'O', 'y'])
      }
      else d.sub = it.kind
    }
    think(now, s) {
      const d = s.data
      // up on the ledge: pick up what fell there, then take the stairs down
      if (this.floorY < FLOOR) {
        for (const a of s.actors) if (a instanceof Item && a.landed && !a.held && a.floorY < FLOOR) return this.walkTo(a.x, { item: a })
        return this.walkTo(d.stair.top, { stairs: 'down' })
      }
      if (d.orb && d.orb.landed) return this.walkTo(d.orb.x, { orb: d.orb })
      const user = engaged(s, now)
      const th = this.threat(s)
      if (th) {
        const r = this.engage(th)
        if (r) return r
        if (user) return FAST // you call the shots: he only cracks what comes into reach
        // out of reach: a sub-weapon, or wait for it to come
        if (Math.abs(th.x - this.x) > this.reach + 10 && Math.random() < (d.hearts > 20 ? 0.6 : 0.3) && this.throwSub()) return FAST
        if (th.a instanceof Zombie && Math.abs(th.x - this.x) > this.reach) return this.walkTo(th.x - Math.sign(th.x - this.x) * (this.reach - 4), {})
        return FAST
      }
      const b = d.boss
      if (b && b.kind === 'dracula' && (b.state === 'open' || (b.state === 'stand' && b.t > 1.05 + (b.cameo ? b.wait : 0)))) {
        // he knows the cape is about to open: duck the volley (usually)
        if (b.volley !== b.f0) {
          b.volley = b.f0
          if (Math.random() < 0.8) {
            this.dir = b.x < this.x ? -1 : 1
            this.go('crouch')
            this.hold = 0.9
            return FAST
          }
        }
        return FAST
      }
      for (const a of s.actors) if (a instanceof Fireball && !a.dead && Math.abs(a.x - this.x) < 60) return FAST
      if (user) return this.watchCursor(now, s, 350)
      if (b && b.vulnerable) {
        const h = b.headBox
        const hx = (h.x0 + h.x1) / 2
        const dist = Math.abs(hx - this.x)
        if (dist < 10) return this.walkTo(this.x + (this.x < b.x ? -1 : 1) * 16, {})
        if (dist > this.reach + 6 && Math.random() < (d.hearts > 20 ? 0.7 : 0.4) && this.throwSub()) return FAST
        return this.engage({ x: hx, y: (h.y0 + h.y1) / 2 }, true)
      }
      let best = null
      let bd = 1e9
      for (const a of s.actors) {
        if (!(a instanceof Item) || !a.landed || a.held || a.floorY < FLOOR) continue
        const dd = Math.abs(a.x - this.x)
        if (dd < bd) {
          bd = dd
          best = a
        }
      }
      if (best) return this.walkTo(best.x, { item: best })
      if (b) {
        // the boss is between teleports: face where he was
        this.dir = b.x < this.x ? -1 : 1
        return FAST
      }
      if (!s.busy) {
        let cb = null
        bd = 1e9
        for (const a of s.actors) {
          if (!(a instanceof Candle) || !a.lit) continue
          const dd = Math.abs(a.x - this.x) + (a.ledge ? 30 : 0)
          if (dd < bd) {
            bd = dd
            cb = a
          }
        }
        if (cb && now > this.next) return this.planCandle(cb)
      }
      return this.watchCursor(now, s, 900)
    }
    // nothing to do: face the cursor (with a cooldown); whip it if it lingers
    watchCursor(now, s, cool) {
      const cur = s.cursor
      if (cur) {
        const cx = cur.x - this.x
        if (now > this.turnAt && Math.abs(cx) > 10) {
          const want = cx > 0 ? 1 : -1
          if (want !== this.dir) {
            this.dir = want
            this.turnAt = now + cool
          }
        }
        const inReach = Math.abs(cx) <= this.reach && Math.abs(cx) > 6 && Math.sign(cx) === this.dir && cur.y > 2 && cur.y < FLOOR
        if (inReach && (cur.speed || 0) < 40) {
          if (!this.lingerAt) this.lingerAt = now
          else if (now - this.lingerAt > 1200) {
            this.lingerAt = now + 2500
            this.startWhip(this.stanceFor(cur.y))
            return FAST
          }
        } else this.lingerAt = 0
        return SLOW
      }
      this.lingerAt = 0
      return Math.max(SLOW, Math.min(this.next - now, rand(2500, 4000)))
    }
    update(dt, now, s) {
      this.f++
      if (this.inv > 0) this.inv -= dt
      this.t += dt
      const d = s.data
      const lv = live(s, now)
      // anything touching him knocks him back
      if (this.inv <= 0 && this.state !== 'hurt' && this.state !== 'rest' && this.state !== 'orb') {
        const me = this.bodyBox
        for (const a of s.actors) {
          if (a.dead || !(a.foe || a.hazard) || !a.box || !ov(me, a.box)) continue
          if (a instanceof Fireball) a.dead = true
          this.hurt(a.box.x0 + (a.box.x1 - a.box.x0) / 2)
          break
        }
      }
      switch (this.state) {
        case 'rest':
          if (lv) this.wake()
          else return Infinity
        // falls through
        case 'idle': {
          if (!lv && !this.onStairs) {
            if (d.restX === undefined) d.restX = openSpot(s, this.x, 9)
            if (Math.abs(d.restX - this.x) > 1) return this.walkTo(d.restX, { rest: true })
            this.dir = this.x < s.W / 2 ? 1 : -1
            this.go('rest')
            return Infinity
          }
          if (lv) d.restX = undefined
          if (this.keyDir()) {
            this.task = null
            this.go('kwalk')
            return FAST
          }
          if (s.keys.size) return FAST
          if (this.dodge(s)) return FAST
          if (now < this.next && !this.threat(s) && !d.boss && !(d.orb && d.orb.landed)) return Math.min(this.next - now, s.cursor ? SLOW : 1e9)
          return this.think(now, s)
        }
        case 'walk': {
          const t = this.task
          if (!t) {
            this.go('idle')
            return FAST
          }
          if (!this.onStairs && !t.stairs && !t.rest && !t.orb) {
            if (!lv) {
              this.go('idle')
              return FAST
            }
            if (this.dodge(s)) return FAST
            const th = this.threat(s)
            if (th && Math.abs(th.x - this.x) <= this.reach && Math.sign(th.x - this.x) === Math.sign(t.x - this.x || this.dir)) {
              this.dir = Math.sign(th.x - this.x) || this.dir
              this.startWhip(this.stanceFor(th.y))
              return FAST
            }
          }
          if ((t.item && t.item.dead) || (d.orb && d.orb.landed && !t.orb && !t.stairs && !this.onStairs)) {
            this.task = null
            this.go('idle')
            return FAST
          }
          const dx = t.x - this.x
          if (Math.abs(dx) > 0.5) this.dir = dx > 0 ? 1 : -1
          const step = WALK * dt
          if (Math.abs(dx) <= step) {
            this.x = t.x
            this.task = null
            this.go('idle')
            if (t.item) {
              if (!t.item.dead) this.collect(s, t.item)
              this.next = now + rand(300, 700)
            } else if (t.orb) {
              t.orb.dead = true
              d.orb = null
              d.hp = 16
              d.hearts = Math.min(99, d.hearts + 10)
              this.dir = 1
              this.go('orb')
              s.burst(this.x, this.y - 30, 18, ['r', 'y', 'O', 'w'])
            } else if (t.stairs) {
              this.go('stairs')
              this.task = { dir: t.stairs, candle: t.candle }
            } else if (t.whip) {
              this.dir = t.face || this.dir
              this.startWhip(t.whip)
            }
            return FAST
          }
          this.x += Math.sign(dx) * step
          this.stride += step
          return FAST
        }
        case 'stairs': {
          // diagonal along the steps, one stride per step
          const st = d.stair
          if (!st) {
            this.floorY = FLOOR
            this.y = FLOOR
            this.go('idle')
            return FAST
          }
          const up = this.task.dir === 'up'
          const target = up ? st.top : st.foot
          const dx = target - this.x
          this.dir = Math.sign(dx) || this.dir
          const step = 16 * dt
          this.x += clamp(dx, -step, step)
          this.stride += step
          const k = clamp(((this.x - st.foot) * st.dir) / Math.abs(st.top - st.foot), 0, 1)
          this.y = FLOOR - Math.round(k * STAIR_H)
          if (Math.abs(target - this.x) < 0.5) {
            this.x = target
            this.floorY = up ? FLOOR - STAIR_H : FLOOR
            this.y = this.floorY
            const c = this.task.candle
            this.task = null
            if (up && c && c.lit) {
              this.dir = st.dir
              this.startWhip('stand')
            } else this.go('idle')
            this.next = now + 300
          }
          return FAST
        }
        case 'whip': {
          if (this.stance === 'jump') {
            if (this.vx) this.x = clamp(this.x + this.vx * dt, 6, s.W - 6)
            this.fall(dt)
          }
          if (!this.struck && this.t >= WHIP_T.swing) {
            this.struck = true
            this.strike(s)
          }
          if (this.t > WHIP_T.end && this.y >= this.floorY) {
            this.vx = 0
            this.go(this.stance === 'jump' ? 'land' : 'idle')
            this.next = now + (s.busy || d.boss ? rand(150, 400) : rand(900, 2200))
          }
          return FAST
        }
        case 'jump':
          if (this.vx) this.x = clamp(this.x + this.vx * dt, 6, s.W - 6)
          if (this.fall(dt)) {
            this.vx = 0
            this.go('land')
          }
          return FAST
        case 'kwalk': {
          const dir = this.keyDir()
          if (!dir || !lv) {
            this.go('idle')
            this.next = now + 600
            return FAST
          }
          if (s.keys.has('down')) {
            this.go('crouch')
            this.hold = Infinity
            return FAST
          }
          this.dir = dir
          const step = WALK * 1.3 * dt
          this.x = clamp(this.x + dir * step, 6, s.W - 6)
          this.stride += step
          // walking over a drop picks it up
          for (const a of s.actors) if (a instanceof Item && a.landed && !a.held && a.floorY === this.floorY && Math.abs(a.x - this.x) < 5) this.collect(s, a)
          return FAST
        }
        case 'crouch':
          if (this.hold === Infinity ? !s.keys.has('down') : this.t > this.hold) this.go('idle')
          return FAST
        case 'land':
          if (this.t > 0.18) this.go('idle')
          return FAST
        case 'hurt':
          this.x = clamp(this.x + this.vx * dt, 6, s.W - 6)
          if (this.fall(dt)) {
            this.go('land')
            this.t = -0.15
          }
          return FAST
        case 'throw':
          if (!this.thrown && this.t > 0.1) {
            this.thrown = true
            const h = SIM.throw.hand
            const hx = this.x + (h[0] - CX) * this.dir
            const hy = this.y - 28 + h[1]
            s.spawn(new Shot(s, d.sub, hx, hy, this.dir))
            if (d.triple > 0) {
              // the III: two more in a fan
              d.triple--
              for (const k of [-1, 1]) {
                const sh = s.spawn(new Shot(s, d.sub, hx, hy + k * 4, this.dir))
                if (d.sub === 'dagger') sh.vy = k * 14
                else sh.vx *= 1 + k * 0.3
              }
            }
          }
          if (this.t > 0.35) {
            this.go('idle')
            this.next = now + 300
          }
          return FAST
        case 'cheer':
          if (this.t > 0.9) this.go('idle')
          return FAST
        case 'orb':
          if (this.t > 1.8) {
            this.go('idle')
            this.next = now + 800
          }
          return this.t < 0.6 ? FAST : SLOW
      }
      return FAST
    }
    // committed arc: no steering once he's off the ground
    fall(dt) {
      this.vy += GRAV * dt
      this.y += this.vy * dt
      if (this.y >= this.floorY && this.vy > 0) {
        this.y = this.floorY
        this.vy = 0
        return true
      }
      return false
    }
    frame() {
      switch (this.state) {
        case 'walk':
        case 'kwalk':
        case 'stairs':
          return 'walk' + (Math.floor(this.stride / 4) & 3)
        case 'whip': {
          const ph = this.t < WHIP_T.wind ? 'wind' : this.t < WHIP_T.swing ? 'swing' : 'strike'
          return this.stance === 'stand' ? ph : this.stance[0] + ph
        }
        case 'jump':
          return 'tuck'
        case 'crouch':
        case 'land':
          return 'crouch'
        case 'hurt':
          return 'hurt'
        case 'rest':
          return 'kneel'
        case 'throw':
          return this.t < 0.1 ? 'wind' : 'throw'
        case 'orb':
        case 'cheer':
          return 'raise'
      }
      return 'stand'
    }
    draw(c, s) {
      if (this.inv > 0 && this.state !== 'hurt' && this.f & 1) return
      const fr = this.frame()
      const S = SIM[fr]
      const d = this.dir
      const x = Math.round(this.x)
      const y = Math.round(this.y)
      const ox = d === 1 ? CX : GW - 1 - CX
      let w = null
      if (this.state === 'whip') {
        const ph = fr.replace(/^[cj]/, '')
        w = WHIP[s.data.whip][ph]
        w.front = ph === 'strike'
      }
      const hx = x + (S.hand[0] - CX) * d
      const hy = y - GH + S.hand[1]
      const drawWhip = () => c.drawImage(w.sp[d], (d === 1 ? hx - w.ax : hx - (w.w - 1 - w.ax)) - 1, hy - w.ay - 1)
      if (w && !w.front) drawWhip()
      c.drawImage(S.sp[d], x - ox - 1, y - GH - 1)
      if (w && w.front) drawWhip()
      if (this.state === 'orb') c.drawImage(ORB[(this.f >> 1) & 3], hx - 3, hy - 8)
    }
  }

  // ---- concept -------------------------------------------------------------------
  function layout(s) {
    const d = s.data
    const { stair, cands } = placeScenery(s)
    d.stair = stair
    if (stair) {
      if (d.stairActor) d.stairActor.st = stair
      else s.actors.push((d.stairActor = new Stairs(stair)))
    } else if (d.stairActor) {
      d.stairActor.dead = true
      d.stairActor = null
    }
    const old = s.actors.filter((a) => a instanceof Candle && !a.dead)
    cands.forEach((spec, i) => {
      if (old[i]) old[i].set(spec)
      else s.actors.push(new Candle(s, spec))
    })
    for (let i = cands.length; i < old.length; i++) old[i].dead = true
  }

  const FOES = [Medusa, Zombie, Skeleton, Fishman]
  const foeCount = (s) => s.actors.filter((a) => !a.dead && FOES.some((K) => a instanceof K)).length
  // a spot on the floor some way off from Simon, inside the bar
  function nearSpot(s, lo, hi) {
    const bel = s.data.bel
    const side = Math.random() < 0.5 ? 1 : -1
    let x = bel.x + side * rand(lo, hi)
    if (x < 14 || x > s.W - 14) x = bel.x - side * rand(lo, hi)
    return clamp(x, 14, s.W - 14)
  }
  function spawnFoe(s, now, kind) {
    const d = s.data
    const bel = d.bel
    if (foeCount(s) >= (s.busy ? 3 : 4) || bel.onStairs) return
    kind ??= pick(['medusa', 'medusa', 'zombie', 'zombie', 'skeleton', 'fishman'])
    // from the edge he has room to face
    const side = bel.x < s.W / 2 ? 1 : -1
    if (kind === 'medusa') s.spawn(new Medusa(s, Math.random() < 0.75 ? side : -side))
    else if (kind === 'skeleton') s.spawn(new Skeleton(s, Math.random() < 0.75 ? side : -side))
    else if (kind === 'fishman') s.spawn(new Fishman(s, nearSpot(s, 50, 95)))
    else {
      const x = nearSpot(s, 55, 110)
      s.spawn(new Zombie(s, x, x < bel.x ? 1 : -1))
    }
  }

  // Watch mode: one little episode at a time, shuffled so a day of it doesn't repeat.
  const EPISODES = ['zombies', 'medusas', 'skeleton', 'fishman', 'bat', 'secret', 'candles', 'mixed']
  function runEpisode(s, now, only) {
    const d = s.data
    if (!d.bag.length) d.bag = EPISODES.slice().sort(() => Math.random() - 0.5)
    const ep = only || d.bag.pop()
    const later = (ms, fn) => d.queue.length < 8 && d.queue.push({ at: now + ms, fn })
    switch (ep) {
      case 'zombies': {
        // the graveyard stirs: three of them, one after another
        const n = s.W < 500 ? 2 : 3
        for (let i = 0; i < n; i++) later(i * 1700, () => spawnFoe(s, performance.now(), 'zombie'))
        break
      }
      case 'medusas': {
        const side = d.bel.x < s.W / 2 ? 1 : -1
        for (let i = 0; i < 3; i++) later(i * 1500, () => foeCount(s) < 4 && s.spawn(new Medusa(s, side)))
        break
      }
      case 'skeleton':
        spawnFoe(s, now, 'skeleton')
        break
      case 'fishman':
        spawnFoe(s, now, 'fishman')
        if (s.W > 600) later(3500, () => spawnFoe(s, performance.now(), 'fishman'))
        break
      case 'bat':
        if (d.bat.state === 'hang') {
          d.bat.state = 'dive'
          d.bat.t = 0
        } else spawnFoe(s, now, 'medusa')
        break
      case 'secret': {
        // a hidden money bag rises out of the floor in a sparkle
        const x = openSpot(s, nearSpot(s, 30, 70), 5)
        s.burst(x, FLOOR - 3, 8, ['y', 'w'])
        s.spawn(new Item(s, Math.random() < 0.3 ? 'roast' : 'bag', x, FLOOR, FLOOR)).vy = -85
        break
      }
      case 'mixed':
        spawnFoe(s, now, 'zombie')
        later(2200, () => spawnFoe(s, performance.now(), 'medusa'))
        break
      // 'candles': a breather; he goes about the candles
    }
  }

  function bossEnd(s, crumble) {
    const d = s.data
    for (const a of s.actors) if ((a instanceof Fireball || a instanceof Sickle) && !a.dead) a instanceof Sickle ? a.struck(s) : (a.dead = true)
    if (!d.boss) return
    if (crumble) d.boss.crumble()
    else {
      d.boss.dead = true
      d.boss = null
    }
  }

  registerConcept({
    key: 'castlevania',
    title: 'Castlevania',
    sub: 'Konami, 1986',
    blurb:
      'Simon Belmont plods along the bar with the stiff walk and the three-frame whip: standing, crouched or in a committed jump, depending on how high the candle stands. One candle sits on a stone ledge, so he takes the stairs up and back down. Candles drop hearts, the chain whip, a dagger, axe or holy water, and now and then the pot roast. Left alone the castle plays itself in shuffled episodes: zombies claw up from the floor in threes, a stream of Medusa heads, a white skeleton that jigs and lobs bones, fishmen bursting from the floor to spit fire, the bat diving from its roost under the title, a secret money bag rising from the floor. While you play he waits on you and faces your <b>cursor</b>: click him to jump and whip, double-click for the sub-weapon, click a candle, item or enemy to send him at it, poke a snuffed candle to relight it, and leave the cursor in reach for a crack of the whip. Drag hearts and weapons to him, pull a zombie out of the floor and drop it, or grab the bat. Zombies lurch toward a cursor that comes near. Easter eggs: click Simon six times fast for the Konami code (thirty hearts and the triple shot), and double-click the sleeping bat. Busy: Dracula teleports in and out firing three fireballs (or Death sends sickles) while the castle throws everything at him; only head hits count. Done: the boss burns away and Simon lifts the orb. When it is quiet he kneels in an open stretch and the candles burn still.',
    setup(s) {
      s.data = {
        W: s.W, hearts: 5, sub: null, whip: 'leather', hp: 16, hpShow: 0, flick: 0,
        boss: null, bossN: 0, bossAt: 0, orb: null, nextFoe: performance.now() + rand(6000, 12000),
        queue: [], bag: [], epAt: performance.now() + rand(5000, 9000), triple: 0, clickAt: -1e9, grabAt: -1e9,
      }
      layout(s)
      s.data.bel = new Belmont(s)
      s.data.bat = new Bat(s)
      s.actors.push(s.data.bel, s.data.bat)
    },
    relayout(s) {
      const d = s.data
      d.W = s.W
      layout(s)
      const b = d.bel
      if (b.onStairs) {
        b.floorY = FLOOR
        b.y = FLOOR
        b.go('idle')
        b.task = null
      }
      b.x = clamp(b.x, 8, s.W - 8)
      if (b.task) b.task.x = clamp(b.task.x, 6, s.W - 6)
      if (b.state === 'rest') {
        b.x = openSpot(s, b.x, 9)
        d.restX = b.x
      } else d.restX = undefined
      d.bat.place()
      if (d.bat.state === 'hang') {
        d.bat.x = d.bat.rx
        d.bat.y = d.bat.ry
      }
      if (d.boss) d.boss.x = clamp(d.boss.x, 20, s.W - 20)
      if (d.orb) d.orb.x = clamp(d.orb.x, 8, s.W - 8)
      for (const a of s.actors) if (a instanceof Item || a instanceof Zombie || a instanceof Skeleton || a instanceof Fishman) a.x = clamp(a.x, 6, s.W - 6)
    },
    update(s, dt, now) {
      const d = s.data
      const lv = live(s, now)
      if (!lv) {
        d.queue.length = 0
        return Infinity
      }
      d.flick++
      let wait = SLOW
      while (d.queue.length && d.queue[0].at <= now) d.queue.shift().fn()
      d.queue.sort((a, b) => a.at - b.at)
      if (s.busy) {
        // the agent is working: the boss holds court and the castle throws everything at him
        if (!d.boss && !d.orb && now > d.bossAt) d.boss = s.spawn(new Boss(s, d.bossN++ % 2 ? 'death' : 'dracula'))
        if (now > d.nextFoe) {
          if (!d.boss || Math.random() < 0.45) spawnFoe(s, now)
          d.nextFoe = now + (d.boss ? rand(7000, 12000) : rand(3500, 7000))
        }
        return wait
      }
      const quiet = !foeCount(s) && !d.queue.length && !d.boss && !d.orb && d.bat.state === 'hang'
      if (engaged(s, now)) d.epAt = Math.max(d.epAt, now + 3000) // you are playing: no new episodes
      else if (quiet && now > d.epAt) {
        runEpisode(s, now)
        d.epAt = now + rand(7000, 13000)
      } else if (!quiet) d.epAt = Math.max(d.epAt, now + 2500)
      return wait
    },
    onBusy(s) {
      const d = s.data
      d.bossAt = performance.now() + 1200
    },
    onDone(s) {
      const d = s.data
      const now = performance.now()
      if (!d.boss && !d.orb) {
        d.boss = s.spawn(new Boss(s, d.bossN++ % 2 ? 'death' : 'dracula'))
        d.boss.pickSpot()
      }
      bossEnd(s, true)
      for (const a of s.actors) {
        if (a instanceof Candle && !a.lit) a.relightAt = now + 2500
      }
      d.nextFoe = now + rand(12000, 20000)
    },
    onNap(s) {
      const d = s.data
      d.queue.length = 0
      bossEnd(s, false)
      if (d.orb) {
        d.orb.dead = true
        d.orb = null
      }
      for (const a of s.actors) if (a instanceof Shot) a.dead = true
      // a new stage next time: the whip goes back to leather
      d.whip = 'leather'
    },
    onBonk(s) {
      // a window dot rattles the bat out of its roost
      const bat = s.data.bat
      if (bat.state === 'hang' && !s.data.boss) {
        bat.state = 'dive'
        bat.t = 0
      }
    },
    onBarClick(s, p) {
      s.data.bel.order({ x: p.x, y: p.y })
    },
    onKey(s, k, down) {
      if (down && s.data.bel) s.data.bel.key(k)
    },
    drawFront(s, c) {
      const d = s.data
      // the status bar: hearts, sub-weapon, and the PLAYER / ENEMY meters in a fight
      let x = 2
      if (d.hearts > 0 || d.sub) {
        c.drawImage(HUD_HEART, x, 1)
        drawDigits(c, String(Math.min(99, d.hearts)).padStart(2, '0'), x + 6, 1)
        x += 15
      }
      if (d.sub) {
        c.fillStyle = '#c81830'
        c.fillRect(x, 0, 13, 1)
        c.fillRect(x, 7, 13, 1)
        c.fillRect(x, 0, 1, 8)
        c.fillRect(x + 12, 0, 1, 8)
        const ic = HUD_ICON[d.sub]
        c.drawImage(ic, x + 7 - (ic.width >> 1), 4 - (ic.height >> 1))
        x += 16
      }
      if (d.boss || performance.now() < d.hpShow) {
        for (let i = 0; i < 16; i++) {
          c.fillStyle = i < d.hp ? '#f8a048' : '#3a2a2a'
          c.fillRect(x + i * 2, 1, 1, 2)
          if (d.boss) {
            c.fillStyle = i < d.boss.hp ? '#e83040' : '#3a2a2a'
            c.fillRect(x + i * 2, 4, 1, 2)
          }
        }
      }
    },
  })

})()
