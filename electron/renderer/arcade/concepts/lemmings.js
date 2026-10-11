;(() => {
  // Lemmings (DMA Design / Psygnosis, 1991). A level plays itself: the hatch
  // opens ("Let's go!"), lemmings drop out and walk, and an invisible player
  // hands out jobs (Builder, Basher, Digger, Blocker, Floater) so little rescues
  // and disasters play out. The title and the window dots are terrain here;
  // builders' bricks, dirt and holes are our own pixel terrain.

  const LP = {
    G: '#62d64c', g: '#2c8a28', S: '#f2c29a', s: '#c98e6a', B: '#4567e6', b: '#7b97ff', D: '#25368c',
    E: '#151515', W: '#f4f1e8', R: '#e0483e', r: '#9e2a24', K: '#e7b56c', k: '#9c6a32', a: '#6f7380',
    A: '#a9aeb9', X: '#120d0a', y: '#ffe066', O: '#f08a2c', o: '#c0461c', h: '#5a3418', H: '#8a5a2c',
  }
  /** Pad rows so body column cx sits at the sprite's centre, then outline. */
  function mk(rows, cx = 4) {
    const w0 = Math.max(...rows.map((r) => r.length))
    const pad = Math.max(cx, w0 - 1 - cx)
    const rr = rows.map((r) => '.'.repeat(pad - cx) + r.padEnd(w0, '.') + '.'.repeat(pad - (w0 - 1 - cx)))
    const p = pairOutlined(rr, LP)
    p.cw = rr[0].length
    p.ch = rr.length
    return p
  }
  /** Draw a sprite with its body centre at fx and its bottom row on y - 1. */
  function put(c, sp, fx, y, dir, dy = 0) {
    c.drawImage(sp[dir], Math.round(fx) - (sp.cw >> 1) - 1, Math.round(y) - sp.ch - 1 + dy)
  }

  // ---- lemming art (right-facing, body centre column 4) -------------------
  const HEAD = ['...GGG...', '..GGGGGG.', '.gGGGGGG.', '.ggGGSES.', '..gSSSSS.']
  const L = {
    walk: [
      mk([...HEAD, '...BBB...', '..DBBBB..', '.SDBBBB..', '..DBBBS..', '...BBB...', '..BB.BB..', '.DB...BB.', '.SS...SS.']),
      mk([...HEAD, '...BBB...', '..DBBBB..', '..DBBBB..', '..DBSBB..', '...BBB...', '...BBB...', '...DBB...', '...SSS...']),
      mk([...HEAD, '...BBB...', '..DBBBB..', '..DBBBBS.', '.SDBBB...', '...BBB...', '..DB.BB..', '.DD...BB.', '.SS...SS.']),
      mk([...HEAD, '...BBB...', '..DBBBB..', '..DBBBB..', '..DSBBB..', '...BBB...', '...BBD...', '...BBD...', '...SSS...']),
    ],
    stand: mk([...HEAD, '...BBB...', '..DBBBB..', '..DBBBB..', '..DBSBB..', '...BBB...', '...BBB...', '...B.B...', '..SS.SS..']),
    fall: [
      mk(['S.......S', '.S.GGG.S.', '..GGGGG..', '.gGGGGGG.', '.ggGGSES.', '..gSSSSS.', '...BBB...', '..DBBBB..', '..DBBBB..', '...BBB...', '..BB.BB..', '..B...B..', '.SS...SS.']),
      mk(['.S.....S.', '..SGGGS..', '..GGGGG..', '.gGGGGGG.', '.ggGGSES.', '..gSSSSS.', '...BBB...', '..DBBBB..', '..DBBBB..', '...BBB...', '...BBB...', '..BB.BB..', '..SS.SS..']),
    ],
    hold: mk(['....S....', '...GSG...', '..GGSGGG.', '.gGGGGGG.', '.ggGGSES.', '..gSSSSS.', '...BBB...', '..DBBBB..', '..DBBBB..', '...BBB...', '...BBB...', '...B.B...', '..SS.SS..']),
    build: [
      mk(['...GGG...', '..GGGGGG.', '.gGGGGGG.', '.ggGGSES.', '..gSSSSS.', '..DBBBB..', '..DBBBBSK', '..DBBB.KK', '...BBB...', '..BB.BB..', '..SS.SS..']),
      mk(['...GGG...', '..GGGGGG.', '.gGGGGGG.', '.ggGGSES.', '..gSSSSS.', '..DBBBB..', '..DBBBB..', '..DBBBBSK', '...BBB.KK', '..BB.BB..', '..SS.SS..']),
    ],
    shrug: mk(['...GGG...', '..GGGGG..', '.GGGGGGG.', '.GSEGESG.', '..SSSSS..', 'S..BBB..S', '.SDBBBBS.', '..DBBBB..', '..DBBBB..', '...BBB...', '...BBB...', '...B.B...', '..SS.SS..']),
    block: [
      mk(['.....GGG.....', '....GGGGG....', '...GGGGGGG...', '...GSEGESG...', '....SSSSS....', 'SS...BBB...SS', '.SBBBBBBBBBS.', '....BBBBB....', '....DBBBD....', '....BBBBB....', '....BB.BB....', '...BB...BB...', '..SS.....SS..'], 6),
      mk(['.....GGG.....', '....GGGGG....', '...GGGGGGG...', '...GSEGESG...', '....SSSSS....', 'SS...BBB...SS', '.SBBBBBBBBBS.', '....BBBBB....', '....DBBBD....', '....BBBBB....', '....BB.BB....', '....BB..BB...', '...SS....SS..'], 6),
    ],
    dig: [
      mk(['...GGG...', '..GGGGG..', '.GGGGGGG.', '.GSEGESG.', '..SSSSS..', '.SBBBBBS.', '.SBBBBBS.', '..BBBBB..', '..DBBBD..', '..BB.BB..', '.BB...BB.', '.SS...SS.']),
      mk(['...GGG...', '..GGGGG..', '.GGGGGGG.', '.GSEGESG.', '..SSSSS..', '..BBBBB..', '.BBBBBBB.', '.DBBBBBD.', '.BB.S.BB.', '.B..S..B.', 'SS.....SS']),
    ],
    bash: [
      mk(['...GGG...', '..GGGGGG.', '.gGGGGGG.', '.ggGGSES.', '..gSSSSS.', '.SDBBB...', '.SDBBBB..', '..DBBBB..', '...BBB...', '...BBB...', '..BB.BB..', '.BB...BB.', '.SS...SS.']),
      mk(['...GGG.....', '..GGGGGG...', '.gGGGGGG...', '.ggGGSES...', '..gSSSSS...', '..DBBBBBBSS', '..DBBBB..SS', '..DBBBB....', '...BBB.....', '...BBB.....', '..BB.BB....', '.BB...BB...', '.SS...SS...']),
    ],
    climb: [
      mk(['......S..', '...GGGS..', '..GGGGB..', '.gGGGGB..', '.ggGGGB..', '..gGGBB..', '...BBBB..', '..DBBB...', '..DBBB...', '...BBB...', '...BBBB..', '...B..BS.', '..SS.....']),
      mk(['.........', '...GGG...', '..GGGGBS.', '.gGGGGBS.', '.ggGGGB..', '..gGGBB..', '...BBBB..', '..DBBB...', '..DBBBB..', '...BBBS..', '...BB....', '...BS....', '.........']),
    ],
    hoist: mk(['...GGG...', '..GGGGGG.', '.gGGGGGG.', '.ggGGSES.', '..gSSSSSS', '..DBBBBSS', '..DBBBB..', '...BBB...', '..BB.BB..', '..SS.SS..']),
    ohno: [
      mk(['..S...S..', '..SGGGS..', '.GGGGGGG.', '.GSEGESG.', '..SSESS..', '...BBB...', '..BBBBB..', '..BBBBB..', '..DBBBD..', '...BBB...', '..BB.BB..', '..B...B..', '.SS...SS.']),
      mk(['.S...S...', '.SGGGS...', 'GGGGGGG..', 'GSEGESG...', '.SSESS...', '..BBB....', '.BBBBB...', '.BBBBB...', '.DBBBD...', '..BBB....', '.BB.BB...', '.B...B...', 'SS...SS..'], 3),
    ],
    splat: mk(['..G.GG.G..', '.GGBBBGG..', 'SBBBBBBBS.'], 4),
    cheer: [
      mk(['S.......S', '.S.GGG.S.', '..GGGGG..', '.GGGGGGG.', '.GSEGESG.', '..SSESS..', '...BBB...', '..BBBBB..', '..DBBBD..', '...BBB...', '..BB.BB..', '.BB...BB.', '.SS...SS.']),
      mk(['.S.....S.', '..SGGGS..', '..GGGGG..', '.GGGGGGG.', '.GSEGESG.', '..SSSSS..', '...BBB...', '..BBBBB..', '..DBBBD..', '...BBB...', '...BBB...', '..BB.BB..', '..SS.SS..']),
    ],
    wave: [
      mk(['.......S.', '...GGG.S.', '..GGGGGS.', '.gGGGGGS.', '.ggGGSES.', '..gSSSSS.', '...BBBB..', '..DBBB...', '..DBBB...', '...BBB...', '...BBB...', '...B.B...', '..SS.SS..']),
      mk(['........S', '...GGG.S.', '..GGGGGS.', '.gGGGGGS.', '.ggGGSES.', '..gSSSSS.', '...BBBB..', '..DBBB...', '..DBBB...', '...BBB...', '...BBB...', '...B.B...', '..SS.SS..']),
    ],
    sit: mk([...HEAD, '...BBB...', '..DBBBS..', '..DBBBB..', '..DBBBBBS']),
    sleep: [
      mk(['.GGG.........', 'GGGGSBBBBBB..', 'GgGSSBBBBBDSS'], 6),
      mk(['.............', 'GGGGSBBBBBB..', 'GgGSSBBBBBDSS'], 6),
    ],
    exit: mk(['S.......S', '.S.GGG.S.', '..GGGGG..', '.GGGGGGG.', '.GSEGESG.', '..SSESS..', '...BBB...', '..BBBBB..', '..DBBBD..', '...BBB...', '..B...B..', '.SS...SS.']),
  }
  const UMBRELLA = [
    mk(['....R....', '...RWR...', '..RWRWR..', '..RWRWR..', '....k....', '....k....']),
    mk(['....RRR....', '..RRWWWRR..', '.RWWRRRWWR.', 'RWRRWRWRRWR', 'R..R.k.R..R', '.....k.....'], 5),
  ]
  const EXIT = mk([
    '...aAAAAAAAa...', '..aAAAAAAAAAa..', '.aAAaXXXXXaAAa.', '.aAaXXXXXXXaAa.', '.aAaXXXXXXXaAa.', '.aAaXXXXXXXaAa.',
    '.aAaXXXXXXXaAa.', '.aAaXXXXXXXaAa.', '.aAaXoXXXoXaAa.', 'aaAaXXOOOXXaAaa', 'aAAaXOOyOOXaAAa',
  ], 7)
  const FLAME = [sprite(['.y.', 'yOy', '.o.'], LP), sprite(['y..', 'Oy.', '.o.'], LP), sprite(['..y', '.yO', '.o.'], LP)]
  const HATCH = [
    sprite(['hhhhhhhhhhhhhhhhh', 'hHHHHHHHHHHHHHHHh', 'hHKHHHHHHHHHHHKHh', 'hhhhhhhhhhhhhhhhh', 'hHHHHHHHHHHHHHHHh', 'hhhhhhhhhhhhhhhhh'], LP),
    sprite(['hhhhhhhhhhhhhhhhh', 'hHHHHHHHHHHHHHHHh', 'hHKHHHHHHHHHHHKHh', 'hhhhhhhhhhhhhhhhh', 'hHHHHHH...HHHHHHh', 'hhhhh.......hhhhh', '..HH.........HH..'], LP),
    sprite(['hhhhhhhhhhhhhhhhh', 'hHHHHHHHHHHHHHHHh', 'hHKHHHHHHHHHHHKHh', 'hhhhhhhhhhhhhhhhh', 'hHh...........hHh', '.H.............H.', '.H.............H.', '.h.............h.'], LP),
  ]
  const IN = sprite(['w.w..w', 'w.ww.w', 'w.w.ww', 'w.w..w', 'w.w..w'])
  const BOOM = ['G', 'B', 'S', 'y', 'O', 'w', 'r', 'c']
  // terrain colours by index
  const TC = [null, '#ecbd77', '#a8743c', '#8a5a3c', '#6b4228', '#a9714a', '#5cbb46', '#3b8a30', '#7d7f86']

  const SPLAT = 20 // px of fall a lemming survives
  const FALLV = 48
  const FLOATV = 13
  const STEP_UP = 3
  const TALL = 13

  // ---- terrain: our own pixels, plus the title and the window dots ----------
  class Terrain {
    constructor(W) {
      this.W = Math.max(1, Math.ceil(W))
      this.g = new Uint8Array(this.W * H)
      this.cv = document.createElement('canvas')
      this.cv.width = this.W
      this.cv.height = H
      this.cx = this.cv.getContext('2d')
      this.ver = 0
      this.count = 0
    }
    at(x, y) {
      return x >= 0 && x < this.W && y >= 0 && y < H ? this.g[y * this.W + x] : 0
    }
    set(x, y, k) {
      if (x < 0 || x >= this.W || y < 0 || y >= FLOOR) return
      const i = y * this.W + x
      if (!this.g[i]) this.count++
      this.g[i] = k
      this.cx.fillStyle = TC[k]
      this.cx.fillRect(x, y, 1, 1)
      this.ver++
    }
    clear(x, y) {
      if (x < 0 || x >= this.W || y < 0 || y >= H) return 0
      const i = y * this.W + x
      const k = this.g[i]
      if (!k) return 0
      this.g[i] = 0
      this.count--
      this.cx.clearRect(x, y, 1, 1)
      this.ver++
      return k
    }
    wipe() {
      this.g.fill(0)
      this.count = 0
      this.cx.clearRect(0, 0, this.W, H)
      this.ver++
    }
  }

  function solid(s, x, y) {
    x = Math.round(x)
    if (x < 0 || x >= s.W) return true
    if (y >= FLOOR) return true
    if (y < 0) return false
    const D = s.data
    if (D.T.at(x, y)) return true
    for (const f of D.rects) if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h) return true
    return false
  }
  function groundBelow(s, x, y) {
    let yy = Math.max(0, y)
    while (yy < FLOOR && !solid(s, x, yy)) yy++
    return yy
  }
  /** Would a plain walker get from (x, y) to x1, ending at height ty? */
  function walkable(s, x, y, x1, ty) {
    const d = x1 > x ? 1 : -1
    for (let i = 0; i < 400 && x !== x1; i++) {
      const nx = x + d
      if (solid(s, nx, y - 1)) {
        let up = 1
        while (up <= STEP_UP && solid(s, nx, y - 1 - up)) up++
        if (up > STEP_UP) return false
        y -= up
      } else if (!solid(s, nx, y)) {
        let dn = 1
        while (dn <= 3 && !solid(s, nx, y + dn)) dn++
        if (dn > 3) return false
        y += dn
      }
      x = nx
    }
    return Math.abs(y - ty) <= 1
  }
  function dirt(T, x0, y0, w, h, grass = true) {
    for (let x = x0; x < x0 + w; x++)
      for (let y = y0; y < y0 + h; y++) {
        let k = 3
        const n = (x * 7 + y * 13 + ((x * y) % 5)) % 11
        if (n === 0 || n === 5) k = 4
        else if (n === 3) k = 5
        if (grass && y - y0 < 2) k = y === y0 ? 6 : (x + y) % 3 ? 7 : 3
        T.set(x, y, k)
      }
  }

  // ---- levels --------------------------------------------------------------
  // Each level names its job in the classic way and places hatch, exit and
  // terrain around the furniture. fit() returns a layout or null.
  function stretches(s) {
    const e = s.fixture('eyes')
    const t = s.fixture('title')
    const g = s.fixture('glyph')
    return { e, t, g, L0: Math.round(e.x + e.w + 3), L1: Math.round(t.x - 3), R0: Math.round(t.x + t.w + 3), R1: Math.round(g.x - 3) }
  }
  const LEVELS = [
    {
      key: 'build',
      name: 'Builders will help you here',
      fit(s, g) {
        const t = g.t
        if (t.w < 16) return null
        const s0 = Math.round(t.x) - 36
        if (s0 < 12) return null
        return { hatch: { x: clamp(s0 - 64, 4, s0 - 14), y: 0 }, exit: { x: Math.round(t.x + t.w - (t.w >= 30 ? 9 : t.w / 2)), y: Math.round(t.y) }, s0, ty: Math.round(t.y), tx: Math.round(t.x) }
      },
    },
    {
      key: 'bash',
      name: 'You need bashers this time',
      fit(s, g) {
        // a compact scene in whichever open stretch has room
        const room = (a, b) => b - a >= 100
        let a, b
        if (room(g.R0, g.R1)) [a, b] = [g.R0, g.R1]
        else if (room(g.L0, g.L1)) [a, b] = [g.L0, g.L1]
        else return null
        const span = Math.min(150, b - a)
        const px = Math.round(a + span * 0.45)
        return { hatch: { x: Math.round(a + 2), y: 0 }, exit: { x: Math.round(a + span - 10), y: FLOOR }, pillar: { x: px, y: FLOOR - 19, w: 9, h: 19 } }
      },
    },
    {
      key: 'float',
      name: 'Only floaters can survive this',
      fit(s, g) {
        const c = s.fixture('controls')
        const useDots = c && c.w >= 30 && Math.random() < 0.45 && g.R1 - g.R0 >= 24
        const ledge = useDots ? c : g.t
        if (ledge.w < 22) return null
        let ex
        if (g.R1 - g.R0 >= 24) ex = Math.round(useDots ? g.R0 + (g.R1 - g.R0) * 0.6 : (g.R0 + g.R1) / 2)
        else if (g.L1 - g.L0 >= 24) ex = Math.round((g.L0 + g.L1) / 2)
        else return null
        return { hatch: { x: Math.round(ledge.x + ledge.w / 2 - 8), y: 0 }, exit: { x: ex, y: FLOOR }, ledge: { x: Math.round(ledge.x), y: Math.round(ledge.y), w: Math.round(ledge.w) } }
      },
    },
    {
      key: 'dig',
      name: 'Just dig!',
      fit(s, g) {
        // a walled-in dirt pit: dig down, then bash out towards the exit
        const room = g.L1 - g.L0
        const w = 56
        if (room >= w + 44) {
          const bx = Math.round(g.L1 - w - 34)
          return { hatch: { x: bx + 14, y: 0 }, exit: { x: Math.round(g.L1 - 12), y: FLOOR }, basin: { x: bx, w, top: FLOOR - 10 } }
        }
        if (room < w + 6 || g.R1 - g.R0 < 24) return null
        const bx = Math.round(g.L1 - w - 3)
        return { hatch: { x: bx + 14, y: 0 }, exit: { x: Math.round(g.R0 + 14), y: FLOOR }, basin: { x: bx, w, top: FLOOR - 10 } }
      },
    },
    {
      key: 'walk',
      name: "Let's go!",
      fallback: true,
      fit(s, g) {
        return { hatch: { x: clamp(g.L0, 4, s.W - 40), y: 0 }, exit: { x: Math.round(Math.max(g.R0 + 10, s.W - 30)), y: FLOOR } }
      },
    },
  ]

  function geomKey(s) {
    const t = s.fixture('title')
    const c = s.fixture('controls')
    return [s.W, t.x, t.w, t.y, c && c.x, s.fixture('glyph').x, s.fixture('eyes').x].map(Math.round).join(',')
  }
  function buildTerrain(s) {
    const D = s.data
    const lay = D.lay
    D.T.wipe()
    if (!lay) return
    if (lay.pillar) dirt(D.T, lay.pillar.x, lay.pillar.y, lay.pillar.w, lay.pillar.h)
    if (lay.basin) {
      const b = lay.basin
      dirt(D.T, b.x, b.top, b.w, FLOOR - b.top)
      dirt(D.T, b.x, b.top - 6, 4, 6, true)
      dirt(D.T, b.x + b.w - 4, b.top - 6, 4, 6, true)
    }
    D.terrainVer = -1
  }
  function startLevel(s, now) {
    const D = s.data
    const g = stretches(s)
    if (!D.bag.length) D.bag = LEVELS.filter((l) => !l.fallback).map((l) => l.key).sort(() => Math.random() - 0.5)
    let lay = null
    let lvl = null
    for (let i = 0; i < D.bag.length && !lay; i++) {
      const k = D.bag[i]
      if (k === D.lastKey && D.bag.length > 1) continue
      const l = LEVELS.find((x) => x.key === k)
      lay = l.fit(s, g)
      if (lay) {
        lvl = l
        D.bag.splice(i, 1)
      }
    }
    if (!lay) {
      lvl = LEVELS.find((l) => l.fallback)
      lay = lvl.fit(s, g)
    }
    D.lastKey = lvl.key
    D.lvl = lvl
    D.lay = lay
    D.serial++
    D.phase = 'open'
    D.hatchOpen = 0
    D.released = 0
    D.total = s.busy ? 10 : 8
    D.saved = 0
    D.lost = 0
    D.playMs = 0
    D.nextRelease = now + 900
    D.accident = Math.random() < (s.busy ? 0.75 : 0.5) ? rand(35000, 80000) : Infinity
    D.nuked = false
    D.blockFreed = false
    D.routeOK = false
    D.geom = geomKey(s)
    buildTerrain(s)
    s.say(lvl.name, lay.hatch.x + 8, 1, { life: 3.2, color: '#9fe08f' })
  }

  // ---- a lemming -----------------------------------------------------------
  class Lem {
    constructor(s, fx, y) {
      this.s = s
      this.fx = fx
      this.y = y
      this.dir = 1
      this.state = 'fall'
      this.vy = FALLV
      this.vx = 0
      this.fallFrom = y
      this.t = 0
      this.anim = Math.random() * 4
      this.acc = 0
      this.climber = Math.random() < 0.25
      this.floater = false
      this.willFloat = Math.random() < 0.85
      this.fuse = 0
      this.lvl = s.data.serial
      this.grabbable = true
      this.chatCool = rand(6, 14)
      this.waveCool = rand(3, 8)
    }
    get x() {
      return this.fx - 3
    }
    get moving() {
      return !['block', 'sit', 'sleep', 'held'].includes(this.state)
    }
    get asleep() {
      return this.state === 'sit' || this.state === 'sleep'
    }
    hit(px, py) {
      const wide = this.state === 'block' ? 8 : 6
      const top = this.state === 'sleep' ? 6 : this.state === 'sit' ? 11 : TALL + 3
      return px >= this.fx - wide && px <= this.fx + wide && py >= this.y - top && py <= this.y + 2
    }
    set(st, t = 0) {
      this.state = st
      this.t = t
      this.acc = 0
    }
    bubble(k) {
      this.s.particle({ img: BUBBLE[k], x: this.fx - 2, y: Math.max(0, this.y - 21), life: 1.1, vy: -2 })
    }
    startFall(vy = FALLV, vx = 0) {
      this.set('fall')
      this.vy = vy
      this.vx = vx
      this.fallFrom = this.y
      this.judged = false
      this.umbrella = 0
    }
    // ---- input ----
    grab() {
      this.s.data.touchAt = performance.now()
      this.s.data.sel = this
      if (['ohno', 'exit', 'splat'].includes(this.state)) return
      this.set('held')
      this.bubble('!')
    }
    drag(p) {
      if (this.state !== 'held') return
      this.fx = clamp(Math.round(p.x), 2, this.s.W - 3)
      this.y = clamp(Math.round(p.y + 7), TALL, FLOOR)
    }
    drop() {
      if (this.state !== 'held') return
      this.y = Math.min(this.y, groundBelow(this.s, this.fx, this.y - 2))
      this.startFall()
    }
    /** Skills this lemming could take right now, the level's own first. */
    skills() {
      const s = this.s
      const T = s.data.T
      const lvl = { build: 'build', bash: 'bash', dig: 'dig', float: 'float' }[s.data.lvl?.key] || 'build'
      const out = [lvl, 'build', 'bash', 'dig', 'block', 'climb', 'float', 'bomb'].filter((k, i, a) => a.indexOf(k) === i)
      return out.filter((k) => {
        if (k === 'dig') return !!T.at(this.fx, this.y)
        if (k === 'bash') {
          for (let i = 2; i <= 8; i++) if (T.at(this.fx + this.dir * i, this.y - 5)) return true
          return false
        }
        if (k === 'climb') return !this.climber
        if (k === 'float') return !this.floater
        return true
      })
    }
    label(text) {
      this.s.say(text, this.fx, Math.max(0, this.y - TALL - 9), { life: 1, color: '#9fe08f', size: 6 })
    }
    onClick() {
      const s = this.s
      const now = performance.now()
      s.data.touchAt = now
      s.data.sel = this
      if (this.asleep) {
        this.set('walk')
        this.bubble('!')
        return
      }
      if (this.state === 'block') {
        this.label('Bomber')
        return this.arm()
      }
      if (this.state === 'fall' || this.state === 'climb') {
        if (!this.floater) {
          this.floater = true
          this.label('Floater')
        }
        return
      }
      if (!['walk', 'wave', 'five', 'cheer', 'build', 'bash', 'dig', 'shrug'].includes(this.state)) return
      // like clicking with a skill selected; clicking again moves along the panel
      const list = this.skills()
      if (now - (this.lastClick || 0) > 2500) this.sk = -1
      this.lastClick = now
      this.sk = (this.sk + 1) % list.length
      const k = list[this.sk]
      this.label({ build: 'Builder', bash: 'Basher', dig: 'Digger', block: 'Blocker', climb: 'Climber', float: 'Floater', bomb: 'Bomber' }[k])
      if (k === 'climb') this.climber = true
      else if (k === 'float') this.floater = true
      else if (k === 'bomb') this.arm()
      else {
        this.set('walk')
        this.job(k)
      }
    }
    onDblClick() {
      this.s.data.touchAt = performance.now()
      if (!this.fuse) this.label('Bomber')
      this.arm()
    }
    arm(delay = 0) {
      if (this.fuse || this.dead || ['exit', 'splat', 'ohno'].includes(this.state)) return
      this.fuse = 5 + delay
      if (this.asleep) this.set('walk')
    }
    job(k) {
      const s = this.s
      if (k === 'build') {
        this.bricks = 0
        this.set('build', s.busy ? 0.45 : 0.6)
      } else if (k === 'bash') {
        this.set('bash', 0.5)
        this.strokes = 0
      } else if (k === 'dig') {
        if (!s.data.T.at(this.fx, this.y)) return this.set('shrug', 1)
        this.set('dig', 0.5)
      } else if (k === 'block') this.set('block')
    }
    onDone(ran) {
      if (ran < 1500 || !['walk', 'sit', 'sleep', 'wave'].includes(this.state)) return
      this.set('cheer', rand(1.2, 2))
    }
    onNap() {
      if (['walk', 'wave', 'cheer', 'shrug'].includes(this.state)) this.rest()
    }
    bonked(r) {
      // a click on a window dot shakes off anyone standing on the dots
      if (this.y <= r.y + 1 && this.fx >= r.x - 6 && this.fx <= r.x + r.w + 6 && ['walk', 'sit', 'sleep', 'wave', 'block'].includes(this.state)) {
        this.y -= 1
        this.startFall(-30, rand(-14, 14))
        this.bubble('!')
      }
    }
    rest() {
      this.set('sit')
      this.restAt = performance.now()
      this.wakeAt = 0
    }

    // ---- per tick ----
    update(dt, now, s) {
      this.anim += dt
      this.t -= dt
      this.chatCool -= dt
      this.waveCool -= dt
      const D = s.data
      const lively = s.lively(now)

      if (this.fuse > 0 && this.state !== 'ohno') {
        this.fuse -= dt
        if (this.fuse <= 0 && !['fall', 'held', 'exit', 'splat'].includes(this.state)) {
          this.fuse = -1
          this.set('ohno', 1.3)
          s.say('Oh no!', this.fx, Math.max(0, this.y - 22), { life: 1.2 })
        }
      }
      // lost the ground under our feet (a blast, a dig, a resize)
      if (!['fall', 'held', 'climb', 'hoist', 'exit', 'splat'].includes(this.state) && !solid(s, this.fx, this.y)) {
        const g = groundBelow(s, this.fx, this.y)
        if (g - this.y <= 3) this.y = g
        else this.startFall()
      }

      switch (this.state) {
        case 'held':
          return FAST
        case 'ohno':
          if (this.t <= 0) this.explode()
          return FAST
        case 'splat':
        case 'exit':
          if (this.t <= 0) {
            this.dead = true
            if (this.state === 'exit') {
              D.saved++
              if (this.lvl === D.serial) D.levelSaved++
            } else D.lost++
          }
          return FAST
        case 'fall':
          return this.fall(dt, s, lively)
        case 'climb':
          return this.climb(dt, s)
        case 'hoist':
          if (this.t <= 0) {
            this.fx += this.dir * 2
            this.y = groundBelow(s, this.fx, this.y - 2)
            this.set('walk')
          }
          return FAST
        case 'build':
          return this.build(s, lively)
        case 'bash':
          return this.bash(s, lively)
        case 'dig':
          return this.dig(s, lively)
        case 'shrug':
        case 'wave':
        case 'cheer':
        case 'five':
          if (this.t <= 0) this.set('walk')
          return FAST
        case 'block':
          return this.fuse ? FAST : Infinity
        case 'sit':
        case 'sleep': {
          if (lively) {
            if (!this.wakeAt) this.wakeAt = now + rand(300, 2600)
            if (now >= this.wakeAt) {
              this.wakeAt = 0
              this.set('walk')
              return FAST
            }
            return Math.max(FAST, this.wakeAt - now)
          }
          if (this.fuse > 0) return FAST
          if (this.state === 'sit') {
            if (now - this.restAt > 6000 && this.y === FLOOR) {
              this.set('sleep')
              this.restAt = now
              this.lastZ = 0
              return FAST
            }
            return now - this.restAt > 6000 ? Infinity : Math.max(FAST, this.restAt + 6000 - now)
          }
          if (now - this.restAt < 9000) {
            if (now - (this.lastZ || 0) > 1800) {
              this.lastZ = now
              s.particle({ img: ZZ, x: this.fx - 4, y: this.y - 8, vx: 2, vy: -4, life: 2.4, fade: true })
            }
            return 1800
          }
          return Infinity
        }
      }

      // ---- walking ----
      if (!lively && !this.fuse) {
        this.rest()
        return FAST
      }
      const cur = s.cursor
      if (cur && this.waveCool <= 0 && !(s.armed && s.data.sel === this) && cur.speed < 80 && Math.abs(cur.x - this.fx) < 14 && Math.abs(cur.y - (this.y - 7)) < 14) {
        this.waveCool = rand(8, 14)
        this.dir = cur.x > this.fx ? 1 : -1
        this.set('wave', 1.2)
        return FAST
      }
      // the lemming on the keys hurries while its way is held
      const hurry = s.data.sel === this && s.keys && s.keys.has(this.dir > 0 ? 'right' : 'left') ? 1.6 : 1
      const sp = (s.busy ? 14 : 11) * (this.fuse > 0 && this.fuse < 2 ? 1.3 : 1) * hurry
      this.acc += sp * dt
      while (this.acc >= 1 && this.state === 'walk') {
        this.acc -= 1
        this.step(s)
      }
      return FAST
    }

    step(s) {
      const D = s.data
      const d = this.dir
      const nx = this.fx + d
      // a Blocker is a wall to everyone else
      for (const o of s.actors) {
        if (o === this || o.state !== 'block' || Math.abs(o.y - this.y) > 8) continue
        if ((o.fx - this.fx) * d > 0 && Math.abs(nx - o.fx) <= 4) {
          this.dir = -d
          return
        }
      }
      if (solid(s, nx, this.y - 1)) {
        let up = 1
        while (up <= 7 && solid(s, nx, this.y - 1 - up)) up++
        if (up <= STEP_UP) {
          this.fx = nx
          this.y -= up
        } else if (this.climber && this.y - TALL > 1) {
          this.set('climb')
        } else this.dir = -d
        return
      }
      if (solid(s, nx, this.y)) this.fx = nx
      else {
        let dn = 1
        while (dn <= 3 && !solid(s, nx, this.y + dn)) dn++
        this.fx = nx
        if (dn <= 3) this.y += dn
        else {
          this.startFall()
          return
        }
      }
      // reached the exit
      const ex = D.lay?.exit
      if (ex && Math.abs(this.fx - ex.x) <= 1 && Math.abs(this.y - ex.y) <= 1) {
        this.fx = ex.x
        this.set('exit', 0.55)
        if (Math.random() < 0.35) s.say('Yippee!', ex.x, Math.max(0, ex.y - 24), { life: 0.9, color: '#ffe066', vy: -4 })
        return
      }
      // passing someone: a high five now and then, never a turn-around
      if (this.chatCool <= 0) {
        for (const o of s.actors) {
          if (o === this || !(o instanceof Lem) || o.state !== 'walk' || o.dir === d || o.chatCool > 0 || o.y !== this.y) continue
          if (Math.abs(o.fx - this.fx) !== 4 || (o.fx - this.fx) * d < 0) continue
          this.chatCool = o.chatCool = rand(14, 28)
          if (Math.random() < 0.35) {
            this.set('five', 0.4)
            o.set('five', 0.4)
            s.particle({ img: STAR, x: (this.fx + o.fx) / 2 - 1, y: this.y - 12, life: 0.4 })
          }
          break
        }
      }
    }

    fall(dt, s, lively) {
      const D = s.data
      if (this.vy < FALLV) this.vy = Math.min(FALLV, this.vy + 170 * dt)
      if (this.vy <= 0) this.fallFrom = this.y
      // the invisible player spots a long drop and pops an umbrella, mostly
      if (!this.judged && this.vy > 0 && !this.floater) {
        this.judged = true
        const g = groundBelow(s, this.fx, this.y)
        if (g - this.fallFrom > SPLAT && lively && D.phase !== 'gap' && !engaged(s, performance.now()) && Math.random() < (D.lvl?.key === 'float' ? (this.willFloat ? 1 : 0) : 0.65)) this.floater = true
      }
      if (this.floater && this.y - this.fallFrom > 4 && this.vy > 0) {
        this.umbrella = Math.min(2, (this.umbrella || 0) + dt * 5)
        if (this.umbrella >= 1) this.vy = Math.min(this.vy, FLOATV)
      }
      if (this.vx) {
        const nx = this.fx + this.vx * dt
        if (solid(s, nx, this.y - 4)) this.vx = 0
        else this.fx = clamp(nx, 1, s.W - 2)
      }
      let move = this.vy * dt
      if (move < 0) {
        this.y = Math.max(TALL, this.y + move)
        return FAST
      }
      while (move > 0) {
        const st = Math.min(1, move)
        move -= st
        if (solid(s, this.fx, Math.floor(this.y + st))) {
          this.y = Math.floor(this.y + st)
          return this.land(s)
        }
        this.y += st
      }
      if (this.y >= FLOOR) {
        this.y = FLOOR
        return this.land(s)
      }
      return FAST
    }
    land(s) {
      this.y = Math.round(this.y)
      while (this.y > 0 && solid(s, this.fx, this.y - 1)) this.y--
      const drop = this.y - this.fallFrom
      this.vx = 0
      if (drop > SPLAT && !(this.umbrella >= 1)) {
        this.set('splat', 0.9)
        this.fuse = 0
        s.burst(this.fx, this.y - 2, 8, ['G', 'B', 'S'])
        return FAST
      }
      this.umbrella = 0
      this.set('walk')
      return FAST
    }
    climb(dt, s) {
      this.acc += 8 * dt
      while (this.acc >= 1) {
        this.acc -= 1
        if (this.y - TALL <= 0 || solid(s, this.fx, this.y - TALL - 1)) {
          // the ceiling knocks a climber off backwards
          this.dir = -this.dir
          this.fx = clamp(this.fx + this.dir * 2, 1, s.W - 2)
          this.startFall()
          return FAST
        }
        this.y -= 1
        if (!solid(s, this.fx + this.dir, this.y - 1)) {
          this.set('hoist', 0.45)
          return FAST
        }
      }
      return FAST
    }
    build(s, lively) {
      if (this.t > 0) return FAST
      if (!lively) {
        this.rest()
        return FAST
      }
      const d = this.dir
      // stairs already join up with the ground ahead
      if (this.y < FLOOR && this.bricks > 0 && solid(s, this.fx + d * 3, this.y) && !solid(s, this.fx + d * 3, this.y - 1)) {
        this.set('walk')
        return FAST
      }
      if (this.bricks >= 12) {
        this.set('shrug', 1.1)
        return FAST
      }
      const T = s.data.T
      const x0 = d > 0 ? this.fx + 1 : this.fx - 5
      for (let x = x0; x < x0 + 5; x++) for (let y = this.y - 2; y < this.y; y++) if (solid(s, x, y)) {
        this.set('walk')
        return FAST
      }
      for (let x = x0; x < x0 + 5; x++) {
        T.set(x, this.y - 2, 1)
        T.set(x, this.y - 1, 2)
      }
      this.bricks++
      this.fx += d * 3
      this.y -= 2
      if (this.bricks >= 10) s.particle({ img: pix('w'), x: this.fx + d * 3, y: this.y - 2, vy: -6, life: 0.3 })
      this.t = s.busy ? 0.45 : 0.6
      return FAST
    }
    bash(s, lively) {
      if (this.t > 0) return FAST
      if (!lively) {
        this.rest()
        return FAST
      }
      const T = s.data.T
      const d = this.dir
      // furniture can't be bashed
      if (solid(s, this.fx + d * 2, this.y - 5) && !T.at(this.fx + d * 2, this.y - 5)) {
        this.set('shrug', 1)
        return FAST
      }
      let any = 0
      for (let i = 1; i <= 5; i++) for (let y = this.y - 11; y < this.y; y++) if (T.clear(this.fx + d * i, y)) any++
      if (any) s.particle({ img: pix(pick(['H', 'h'].map(() => 'K'))), x: this.fx + d * 5, y: this.y - 6, vx: d * rand(10, 25), vy: rand(-25, -10), g: 90, life: 0.6 })
      this.fx += d * 2
      this.strokes++
      let ahead = false
      for (let i = 1; i <= 7 && !ahead; i++) for (let y = this.y - 11; y < this.y; y++) if (T.at(this.fx + d * i, y)) ahead = true
      if (!ahead || this.strokes > 40) this.set('walk')
      else this.t = s.busy ? 0.4 : 0.5
      return FAST
    }
    dig(s, lively) {
      if (this.t > 0) return FAST
      if (!lively) {
        this.rest()
        return FAST
      }
      const T = s.data.T
      if (!T.at(this.fx, this.y)) {
        this.set('walk')
        return FAST
      }
      for (let x = this.fx - 4; x <= this.fx + 4; x++) for (let y = this.y; y < this.y + 2; y++) T.clear(x, y)
      s.particle({ img: pix('K'), x: this.fx + rand(-5, 5), y: this.y - 2, vx: rand(-20, 20), vy: rand(-28, -12), g: 90, life: 0.6 })
      const g = groundBelow(s, this.fx, this.y)
      if (g - this.y > 3) this.startFall()
      else {
        this.y = g
        this.t = s.busy ? 0.4 : 0.5
        if (!T.at(this.fx, this.y)) this.set('walk')
      }
      return FAST
    }
    explode() {
      const s = this.s
      const T = s.data.T
      const cx = this.fx
      const cy = this.y - 5
      for (let x = cx - 8; x <= cx + 8; x++) for (let y = cy - 8; y <= cy + 8; y++) if ((x - cx) ** 2 + (y - cy) ** 2 <= 60) T.clear(x, y)
      for (const o of s.actors) {
        if (o === this || !(o instanceof Lem) || o.dead || ['held', 'exit', 'splat', 'ohno'].includes(o.state)) continue
        const dx = o.fx - cx
        if (Math.abs(dx) < 14 && Math.abs(o.y - this.y) < 12 && o.state !== 'block') {
          o.y -= 1
          o.startFall(-38, Math.sign(dx || 1) * rand(14, 24))
          o.bubble('!')
        }
      }
      s.burst(cx, cy, 30, BOOM)
      s.particle({ img: STAR, x: cx - 1, y: cy - 1, life: 0.25 })
      this.dead = true
      s.data.lost++
      s.poke()
    }

    draw(c) {
      const d = this.dir
      const f = Math.floor(this.anim * 8)
      const x = this.fx
      const y = this.y
      switch (this.state) {
        case 'held': put(c, L.fall[f % 2], x, y, d); break
        case 'fall':
          if (this.umbrella >= 1) {
            put(c, L.hold, x, y, d)
            put(c, UMBRELLA[1], x, y - 13, d)
          } else if (this.umbrella > 0) {
            put(c, L.hold, x, y, d)
            put(c, UMBRELLA[0], x, y - 13, d)
          } else put(c, L.fall[f % 2], x, y, d)
          break
        case 'climb': put(c, L.climb[Math.floor(this.anim * 4) % 2], x + d, y, d); break
        case 'hoist': put(c, L.hoist, x + d, y, d); break
        case 'build': put(c, L.build[this.t > 0.25 ? 0 : 1], x, y, d); break
        case 'bash': put(c, L.bash[this.t > 0.3 ? 1 : 0], x, y, d); break
        case 'dig': put(c, L.dig[this.t > 0.25 ? 1 : 0], x, y, d); break
        case 'block': put(c, L.block[Math.floor(this.anim * 1.5) % 2], x, y, 1); break
        case 'shrug': put(c, L.shrug, x, y, d); break
        case 'ohno': put(c, L.ohno[f % 2], x, y, 1); break
        case 'splat': put(c, L.splat, x, y, d); break
        case 'exit': put(c, L.exit, x, y, 1, -Math.round(Math.sin(Math.min(1, (0.55 - this.t) / 0.55) * Math.PI) * 4)); break
        case 'cheer': put(c, L.cheer[Math.floor(this.anim * 5) % 2], x, y, 1, Math.floor(this.anim * 5) % 2 ? -2 : 0); break
        case 'wave': put(c, L.wave[Math.floor(this.anim * 5) % 2], x, y, d); break
        case 'five': put(c, L.wave[0], x, y, d); break
        case 'sit': put(c, L.sit, x, y, d); break
        case 'sleep': put(c, L.sleep[Math.floor(this.anim / 1.8) % 2], x, y, d); break
        default: put(c, L.walk[Math.floor(this.acc + this.fx) % 4] || L.walk[0], x, y, d)
      }
      if (this.fuse > 0 && this.state !== 'ohno') drawDigits(c, Math.ceil(this.fuse), Math.round(x) - 1, Math.max(0, y - TALL - 7))
    }
  }

  /** The trapdoor is clickable: it lets one more lemming out. */
  class Hatch {
    constructor(s) {
      this.s = s
      this.prop = true
      this.z = -1
    }
    hit(px, py) {
      const lay = this.s.data.lay
      return !!lay && px >= lay.hatch.x - 2 && px <= lay.hatch.x + 19 && py <= 11
    }
    onClick() {
      const s = this.s
      const D = s.data
      D.touchAt = performance.now()
      if (!D.lay || !['open', 'play'].includes(D.phase) || lems(s).length >= 16) return
      D.hatchOpen = Math.max(D.hatchOpen, 1)
      D.total++
      D.released++
      const h = D.lay.hatch
      s.spawn(new Lem(s, h.x + 8, D.lay.ledge ? D.lay.ledge.y - 5 : h.y + 6 + TALL))
      s.say("Let's go!", h.x + 8, 1, { life: 1, size: 6 })
    }
    update() {
      return Infinity
    }
    draw() {}
  }

  // ---- the invisible player ------------------------------------------------
  function lems(s) {
    return s.actors.filter((a) => a instanceof Lem && !a.dead)
  }
  /** The user is playing: the unseen player keeps its hands off. */
  function engaged(s, now) {
    const c = s.cursor
    return now - (s.keyAt ?? -1e9) < 9000 || now - (s.data.touchAt || -1e9) < 9000 || (!!c && now - c.since < 2500 && now - (c.t ?? now) < 1500)
  }
  // ---- the keys: steer the selected lemming and hand it skills ----
  const steerable = (a) => a && !a.dead && !['exit', 'splat', 'ohno'].includes(a.state)
  /** The lemming on the keys: the last one clicked, else the walker nearest the hatch's way out. */
  function selected(s) {
    const D = s.data
    if (steerable(D.sel)) return D.sel
    const all = lems(s).filter((a) => steerable(a) && a.state !== 'held')
    const from = D.selX ?? (D.lay ? D.lay.hatch.x + 8 : s.W / 2)
    let best = null
    for (const a of all) {
      const k = Math.abs(a.fx - from) + (a.state === 'walk' ? 0 : 40)
      if (!best || k < best.k) best = { a, k }
    }
    D.sel = best ? best.a : null
    return D.sel
  }
  /** The next lemming along in direction d (a double tap of A or D). */
  function selectNext(s, d) {
    const D = s.data
    const cur = selected(s)
    if (!cur) return null
    let best = null
    for (const a of lems(s)) if (a !== cur && steerable(a) && a.state !== 'held' && (a.fx - cur.fx) * d > 0 && (!best || Math.abs(a.fx - cur.fx) < Math.abs(best.fx - cur.fx))) best = a
    if (best) {
      D.sel = best
      best.bubble('!')
    }
    return D.sel
  }
  function onKey(s, key, down) {
    const D = s.data
    const now = performance.now()
    if (!down || D.phase === 'gap') return
    if (key === 'left' || key === 'right') {
      const d = key === 'right' ? 1 : -1
      if (D.tapKey === key && now - D.tapAt < 320) {
        D.tapKey = null
        selectNext(s, d)
        return
      }
      D.tapKey = key
      D.tapAt = now
    }
    const a = selected(s)
    if (!a) return
    D.selX = a.fx
    if (key === 'left' || key === 'right') {
      const d = key === 'right' ? 1 : -1
      if (a.asleep) a.set('walk')
      else if (['build', 'bash', 'dig', 'shrug', 'wave', 'five', 'cheer'].includes(a.state)) a.set('walk')
      if (a.state !== 'block') a.dir = d
      return
    }
    if (a.asleep) {
      a.set('walk')
      a.bubble('!')
      return
    }
    if (a.state === 'fall' || a.state === 'climb') {
      // anything in the air: the umbrella
      if (!a.floater) {
        a.floater = true
        a.label('Floater')
      }
      return
    }
    if (a.state === 'block') {
      // only one way out for a Blocker
      if (key === 'fire') {
        a.label('Oh no!')
        a.arm()
      }
      return
    }
    if (!['walk', 'wave', 'five', 'cheer', 'build', 'bash', 'dig', 'shrug'].includes(a.state)) return
    const k = key === 'up' ? 'build' : key === 'down' ? 'dig' : a.skills()[0]
    a.label({ build: 'Builder', bash: 'Basher', dig: 'Digger', block: 'Blocker', climb: 'Climber', float: 'Floater', bomb: 'Bomber' }[k])
    if (k === 'float') a.floater = true
    else if (k === 'climb') a.climber = true
    else if (k === 'bomb') a.arm()
    else {
      a.set('walk')
      a.job(k)
    }
  }

  function direct(s, now) {
    const D = s.data
    if (engaged(s, now)) return
    const lay = D.lay
    const k = D.lvl.key
    const all = lems(s)
    const busyJob = (st) => all.some((a) => a.state === st)
    if (D.T.ver !== D.terrainVer) {
      D.terrainVer = D.T.ver
      if (k === 'build') D.routeOK = walkable(s, lay.s0 - 2, FLOOR, lay.tx + 2, lay.ty)
      else if (k === 'bash') D.routeOK = walkable(s, lay.pillar.x - 4, FLOOR, lay.pillar.x + lay.pillar.w + 4, FLOOR)
      else if (k === 'dig') {
        const b = lay.basin
        D.holeOK = false
        for (let x = b.x + 6; x < b.x + b.w - 6 && !D.holeOK; x++) if (groundBelow(s, x, b.top - 1) >= FLOOR && groundBelow(s, x + 1, b.top - 1) >= FLOOR) D.holeOK = true
        D.routeOK = walkable(s, b.x + b.w - 8, FLOOR, b.x + b.w + 3, FLOOR)
      }
    }
    const ex = lay.exit
    for (const a of all) {
      if (a.state !== 'walk' || a.fuse || a.lvl !== D.serial) continue
      // a stray heading off past the exit, away from the hatch: wall it off
      if (ex.y === FLOOR && a.y === FLOOR && (a.fx - ex.x) * a.dir > 0 && (a.fx - ex.x) * (lay.hatch.x + 8 - ex.x) < 0 && Math.abs(a.fx - ex.x - Math.sign(a.fx - ex.x) * 26) <= 1 && !all.some((o) => o.state === 'block' && o.y === FLOOR && (o.fx - ex.x) * (a.fx - ex.x) > 0)) {
        a.job('block')
        continue
      }
      if (k === 'build' && !D.routeOK && !busyJob('build')) {
        const onFloor = a.y === FLOOR
        if (a.dir > 0 && ((onFloor && Math.abs(a.fx - lay.s0) <= 1 && !D.T.at(lay.s0 + 3, FLOOR - 1)) || (!onFloor && a.fx > lay.s0 && a.fx < lay.tx - 2 && a.y > lay.ty + 1 && !solid(s, a.fx + 2, a.y - 1) && !solid(s, a.fx + 3, a.y)))) {
          if (onFloor) a.fx = lay.s0
          a.job('build')
          continue
        }
      }
      if (k === 'build' && !busyJob('block') && a.y === FLOOR && a.dir > 0 && a.fx > lay.tx + 8 && a.fx < lay.tx + 14 && all.filter((o) => o.y === FLOOR).length >= 3) {
        a.job('block')
        continue
      }
      if (k === 'bash' && !D.routeOK && !busyJob('bash') && a.y === FLOOR && a.dir > 0 && Math.abs(a.fx + 2 - lay.pillar.x) <= 1) {
        a.job('bash')
        continue
      }
      if (k === 'dig' && D.holeOK && !D.routeOK && !busyJob('bash') && a.y === FLOOR && a.fx > lay.basin.x && a.fx < lay.basin.x + lay.basin.w && a.dir > 0 && solid(s, a.fx + 2, a.y - 5)) {
        a.job('bash')
        continue
      }
      if (k === 'dig' && !D.holeOK && !busyJob('dig') && a.y === lay.basin.top && Math.abs(a.fx - (lay.basin.x + lay.basin.w / 2)) <= 3 && Math.random() < 0.3) {
        a.job('dig')
        continue
      }
      if (k === 'float') {
        const l = lay.ledge
        if (a.y !== l.y) continue
        const exitRight = lay.exit.x > l.x + l.w / 2
        const awayEnd = exitRight ? l.x + 4 : l.x + l.w - 5
        const nearAway = Math.abs(a.fx - awayEnd) <= 1 && (exitRight ? a.dir < 0 : a.dir > 0)
        if (nearAway && !busyJob('block') && all.filter((o) => o.y === l.y).length > 1) {
          a.job('block')
          continue
        }
        const edge = exitRight ? l.x + l.w : l.x
        if (Math.abs(a.fx - edge) < 8 && a.willFloat && !a.floater) a.floater = true
      }
    }
  }

  registerConcept({
    key: 'lemmings',
    title: 'Lemmings',
    sub: 'DMA Design, 1991',
    chosen: true,
    blurb:
      'A level plays itself. The trapdoor opens ("Let\'s go!"), lemmings drop out and walk past each other, and an unseen player hands out jobs: a Builder lays a staircase up onto the title so the rest can reach the exit on top, a Basher punches a tunnel through a dirt wall, a Digger digs them out of a pit, a Blocker holds his arms out to turn the crowd, and floaters open umbrellas to drop off the title or the window dots. Climbers scale walls; a long fall without an umbrella goes splat. Now and then a fuse is lit by mistake: 5…1, "Oh no!", pop, and a hole in the stairs that someone has to rebuild. The exit counts who got home; at the end the Blocker is set off and the next level starts. <b>Click a lemming</b> to give it the level\'s job (Builder, Basher, Digger, umbrella; a Blocker gets a fuse), <b>double-click</b> for a bomb, or drag one somewhere. Work speeds everything up, done makes them cheer, and when it\'s quiet they sit down and doze.',
    setup(s) {
      const now = performance.now()
      s.data = { T: new Terrain(s.W), rects: [], bag: [], serial: 0, saved: 0, lost: 0, levelSaved: 0, phase: 'gap', nextAt: now + 600, lay: null, lvl: null, hatchOpen: 0 }
      s.actors.push(new Hatch(s))
      this.relayout(s)
    },
    onNuke(s) {
      s.lastTouch = performance.now()
      lems(s).forEach((a, i) => a.arm(i * 0.3))
      s.poke()
    },
    relayout(s) {
      const D = s.data
      if (!D.T) return
      const t = s.fixture('title')
      const c = s.fixture('controls')
      D.rects = [t, c].filter((f) => f && f.w > 0).map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) }))
      if (D.T.W !== Math.ceil(s.W)) {
        D.T = new Terrain(s.W)
        D.geom = null
      }
      for (const a of lems(s)) a.fx = clamp(a.fx, 2, s.W - 3)
      if (D.lay && D.geom !== geomKey(s)) {
        // furniture moved: re-place this level; built terrain is lost
        const g = stretches(s)
        const lay = D.lvl.fit(s, g)
        if (lay) {
          D.lay = lay
          D.geom = geomKey(s)
          buildTerrain(s)
        } else {
          D.phase = 'gap'
          D.nextAt = performance.now() + 1500
          D.lay = null
          D.T.wipe()
        }
        for (const a of lems(s)) if (['build', 'bash', 'dig', 'climb', 'hoist'].includes(a.state)) a.set('walk')
      }
      s.poke()
    },
    update(s, dt, now) {
      const D = s.data
      const lively = s.lively(now)
      if (!lively) {
        // finish the hatch flap animation, then hold everything as it is
        if (D.phase === 'open' && D.hatchOpen > 0 && D.hatchOpen < 2) {
          D.hatchOpen = Math.min(2, D.hatchOpen + dt * 4)
          return FAST
        }
        return Infinity
      }
      if (D.phase === 'gap') {
        if (now < D.nextAt) return D.nextAt - now
        startLevel(s, now)
        D.levelSaved = 0
        return FAST
      }
      D.playMs += dt * 1000
      const all = lems(s)
      if (D.phase === 'open') {
        D.hatchOpen = Math.min(2, D.hatchOpen + dt * 3)
        if (D.hatchOpen >= 2) {
          D.phase = 'play'
          s.say("Let's go!", D.lay.hatch.x + 8, 1, { life: 1.4, color: '#ffffff' })
        }
        return FAST
      }
      if (D.phase === 'play') {
        if (D.released < D.total && now >= D.nextRelease && all.length < 14) {
          const h = D.lay.hatch
          s.spawn(new Lem(s, h.x + 8 + (D.released % 2), D.lay.ledge ? D.lay.ledge.y - 5 : h.y + 6 + TALL))
          D.released++
          D.nextRelease = now + (s.busy ? rand(1300, 2100) : rand(2300, 3600))
        }
        if (s.keys && s.keys.size) D.touchAt = now
        direct(s, now)
        // a fuse lit by mistake
        if (D.playMs > D.accident && !engaged(s, now)) {
          D.accident = Infinity
          const w = all.filter((a) => a.state === 'walk' && !a.fuse && a.lvl === D.serial)
          if (w.length > 2) pick(w).arm()
        }
        const mine = all.filter((a) => a.lvl === D.serial)
        const loose = mine.filter((a) => a.state !== 'block')
        if (D.released >= D.total && !loose.length) {
          // only Blockers left: set them off, as you have to
          const bl = mine.filter((a) => a.state === 'block')
          if (bl.length && !D.blockFreed) {
            D.blockFreed = true
            bl.forEach((a, i) => a.arm(i * 0.5))
          }
          if (!mine.length) {
            const pct = Math.round((100 * D.levelSaved) / D.total)
            s.say(`You rescued ${pct}%`, (D.lay.exit.x + D.lay.hatch.x) / 2, 1, { life: 3, color: pct >= 75 ? '#9fe08f' : '#ffb35a' })
            D.phase = 'outro'
            D.nextAt = now + 3200
          }
        }
        if (D.playMs > 170000 && !D.nuked) {
          // out of time: armageddon
          D.nuked = true
          D.released = D.total
          s.say('Out of time!', s.W / 2, 1, { life: 2, color: '#ff8a7a' })
          mine.forEach((a, i) => a.arm(i * 0.25))
        }
        return FAST
      }
      if (D.phase === 'outro') {
        D.hatchOpen = Math.max(0, D.hatchOpen - dt * 3)
        if (now >= D.nextAt) {
          // the level crumbles away
          const T = D.T
          let n = 0
          for (let i = 0; i < T.g.length && n < 40; i += 7) if (T.g[i]) {
            n++
            s.particle({ img: pix('K'), x: i % T.W, y: Math.floor(i / T.W), vx: rand(-10, 10), vy: rand(-25, -5), g: 90, life: 1, fade: true })
          }
          T.wipe()
          D.lay = null
          D.phase = 'gap'
          D.nextAt = now + rand(2000, 4000)
        }
        return FAST
      }
      return Infinity
    },
    drawBehind(s, c) {
      const D = s.data
      if (D.T.count) c.drawImage(D.T.cv, 0, 0)
      const lay = D.lay
      if (!lay) return
      const h = lay.hatch
      c.drawImage(HATCH[Math.min(2, Math.floor(D.hatchOpen))], h.x, h.y)
      const ex = lay.exit
      put(c, EXIT, ex.x, ex.y, 1)
      const f = Math.floor(performance.now() / 120)
      c.drawImage(FLAME[f % 3], ex.x - 7, ex.y - 13)
      c.drawImage(FLAME[(f + 1) % 3], ex.x + 5, ex.y - 13)
    },
    onKey,
    drawFront(s, c) {
      const lay = s.data.lay
      if (!lay) return
      // the Lemmings cursor: a square around the lemming on the keys
      if (s.armed) {
        const a = selected(s)
        if (a) {
          const x = Math.round(a.fx) - 6
          const y = Math.round(a.y) - TALL - 3
          const w = 12
          const h = TALL + 5
          c.fillStyle = '#ffffff'
          for (const [px, py] of [[x, y], [x + w - 3, y], [x, y + h - 1], [x + w - 3, y + h - 1]]) c.fillRect(px, py, 3, 1)
          for (const [px, py] of [[x, y], [x + w - 1, y], [x, y + h - 3], [x + w - 1, y + h - 3]]) c.fillRect(px, py, 1, 3)
        }
      }
      // the save counter beside the exit
      const ex = lay.exit
      const n = String(s.data.levelSaved)
      const right = ex.x + 10 + 7 + n.length * 4 < s.W
      const x0 = right ? ex.x + 10 : ex.x - 10 - 7 - n.length * 4
      const y0 = ex.y - 8
      c.globalAlpha = 0.9
      c.drawImage(IN, x0, y0)
      drawDigits(c, n, x0 + 8, y0)
      c.globalAlpha = 1
    },
    onDone(s, ran) {
      const lay = s.data.lay
      if (ran > 1500 && lay) s.burst(lay.exit.x, lay.exit.y - 12, 14, ['y', 'O', 'w'])
    },
  })
})()
