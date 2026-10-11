;(() => {
  // Duck Hunt (Nintendo, 1984). Tall grass, a tree and a bush along the floor
  // of the bar; ducks burst out of the grass and zigzag across the full bar
  // height in front of the furniture. An invisible hunter plays on its own; the
  // dog sniffs in each round, retrieves the hits and laughs at the misses.
  // Clicking a duck shoots it like the zapper, and the hunter yields to you.

  // capture-only: keep the bar lively in headless long runs (?t=…&awake)
  const KEEP_AWAKE = (() => {
    try {
      const q = new URLSearchParams(location.search)
      return q.has('t') && q.has('awake')
    } catch {
      return false
    }
  })()

  // ---- palettes ---------------------------------------------------------------
  const DOGP = {
    D: '#c47a36', b: '#8a5020', d: '#5e3412', T: '#f6cc94', E: '#141010', w: '#fcfcfc',
    M: '#e8506c', m: '#7c1426', k: '#3c2410',
  }
  const DUCKS = {
    green: { H: '#14903a', h: '#58d458', B: '#7a6a5a', b: '#463a30', C: '#b4582c', T: '#dcc08a', t: '#9c7a52', O: '#f8b800', o: '#b87400', F: '#f8901c', w: '#fcfcfc', E: '#101010', pts: 500, speed: 1 },
    blue: { H: '#3424c4', h: '#8070fc', B: '#2c6ce0', b: '#1a3c98', C: '#80acfc', T: '#bcdcfc', t: '#6894dc', O: '#f8b800', o: '#b87400', F: '#f8901c', w: '#fcfcfc', E: '#101010', pts: 1000, speed: 1.15 },
    red: { H: '#8c1414', h: '#dc4848', B: '#cc4020', b: '#7c2010', C: '#fc8c5c', T: '#fcc4a4', t: '#d07858', O: '#f8b800', o: '#b87400', F: '#f8901c', w: '#fcfcfc', E: '#101010', pts: 1500, speed: 1.3 },
    gold: { H: '#c89000', h: '#fce060', B: '#e0a800', b: '#8c6400', C: '#fcd858', T: '#fff4b0', t: '#d8b040', O: '#fc7400', o: '#a84800', F: '#fc7400', w: '#fcfcfc', E: '#101010', pts: 5000, speed: 1.45 },
  }

  /** Overlay rows onto a base (non-'.' wins), with an offset; grows as needed. */
  function stamp(base, rows, dx = 0, dy = 0) {
    const out = base.slice()
    rows.forEach((r, j) => {
      const y = j + dy
      while (out.length <= y) out.push('')
      let line = out[y]
      for (let i = 0; i < r.length; i++) {
        const ch = r[i]
        if (ch === '.' || ch === ' ') continue
        const x = i + dx
        if (x < 0) continue
        if (line.length <= x) line = line.padEnd(x + 1, '.')
        line = line.slice(0, x) + ch + line.slice(x + 1)
      }
      out[y] = line
    })
    const w = Math.max(...out.map((r) => r.length))
    return out.map((r) => r.padEnd(w, '.'))
  }
  const blank = (w, h) => Array.from({ length: h }, () => '.'.repeat(w))

  // ---- ducks (facing right, 23 × 17) ---------------------------------------------
  const DUCK_BASE = [
    '.......................',
    '.......................',
    '.......................',
    '..............hHHH.....',
    '.............hHHHHH....',
    '.............HHHwEHH...',
    '.............HHHHHHHOOO',
    '.............HHHHHHHooo',
    'BB...........wwwwHH....',
    'bBBB.....BBBBCCCww.....',
    '.bBBBBBBBBBBCCCCCC.....',
    '..bBBBBBBBBBCCCCCC.....',
    '...bBBBBBBBBBCCCCC.....',
    '....bbBBBBBBBBBCC......',
    '......bbbbbbbbbb.......',
    '.........FF..F.........',
    '........F...F..........',
  ]
  const WING_UP = [
    '..TT...................',
    '..TtT..................',
    '...TtT.................',
    '...TttT................',
    '....TttT...............',
    '....TtttT..............',
    '.....TtttT.............',
    '.....TttttT............',
    '......TttttT...........',
    '.......TTTTT...........',
  ]
  const WING_MID = [
    'TTTTTTTT...............',
    '.TttttttTTT............',
    '..TTtttttTTT...........',
  ]
  const WING_DN = [
    '......TTTTTT...........',
    '......TttttT...........',
    '.......TtttT...........',
    '.......TttT............',
    '........TtT............',
    '........TT.............',
  ]
  const DUCK_UP = stamp(DUCK_BASE, WING_UP)
  const DUCK_MID = stamp(DUCK_BASE, WING_MID, 0, 7)
  const DUCK_DN = stamp(DUCK_BASE, WING_DN, 0, 11)
  // shot: wings flung up, eye wide, beak open
  const DUCK_HIT = stamp(
    stamp(DUCK_BASE, ['..TT....TT.............', '..TtT..TtT.............', '...TtTTttT.............', '...TttttT..............', '....TtttT..............', '.....TttT..............', '......TT...............']),
    ['.............HHwwwH....', '.............HHwEwHOOO.', '.............HHHHHH....', '.............HHHHHHHOO.'],
    0,
    4,
  )
  // falling / held by the feet: head down, wings folded
  const DUCK_FALL = [
    '...F...F....',
    '...FF..FF...',
    '..bBBBBBBb..',
    '.bBBBBBBBBb.',
    '.bBBTTTBBCC.',
    '.bBTtttTBCC.',
    '.bBTtttTCCC.',
    '.bBTtttTCCC.',
    '..bBTttTCCC.',
    '..bBBTTCCCC.',
    '...bBBCCCC..',
    '....wwwww...',
    '...hHHHHHH..',
    '...HHHHHHH..',
    '...HwEHHHH..',
    '...HHHHHHH..',
    '....HHHHH...',
    '.....OoO....',
    '.....OO.....',
    '......O.....',
  ]
  const DUCK = {}
  for (const [k, p] of Object.entries(DUCKS)) {
    DUCK[k] = {
      fly: [DUCK_UP, DUCK_MID, DUCK_DN, DUCK_MID].map((r) => pairOutlined(r, p)),
      hit: pairOutlined(DUCK_HIT, p),
      fall: pairOutlined(DUCK_FALL, p),
      icon: null,
    }
  }
  const DW = DUCK_BASE[0].length // 23
  const DH = DUCK_BASE.length // 17

  // ---- the dog --------------------------------------------------------------------
  // side view, facing right: body, procedural legs, head (low = sniffing), tail
  const DOG_BODY = [
    '....DDDDDDDDDDDDDD....',
    '..DDDDDDDDDDDDDDDDDD..',
    '.DDDDDDDDDDDDDDDDDDDD.',
    'DDDDDDDDDDDDDDDDDDDDDD',
    'DDDDDDDDDDDDDDDDDDDDDD',
    'DDDDDDDDDDDDDDDDDDDTTD',
    '.DDDDTTTTTTTTTTTTTTTT.',
    '..DDD.TTTTTTTTTTTTTT..',
  ]
  const DOG_HEAD = [
    '....DDDDD......',
    '..dDDDDDDDD....',
    '.ddDDDDDwwDD...',
    'dddDDDDDwEDDD..',
    'dddDDDDDDDDDDDD',
    'dddDDDDDDDTTTEE',
    'dddDDDDDTTTTTEE',
    '.dddDDDTTTTTTT.',
    '..ddd.TTTTTTT..',
    '...dd..........',
  ]
  const DOG_HEAD_ALERT = DOG_HEAD.map((r, i) => (i === 2 ? '.ddDDDDwwwDD...' : i === 3 ? 'dddDDDDwEEDDD..' : r))
  const DOG_HEAD_SHUT = DOG_HEAD.map((r, i) => (i === 2 ? '.ddDDDDDDDDD...' : i === 3 ? 'dddDDDDEEEDDD..' : r))
  const TAIL = [
    ['.D...', 'DD...', 'DD...', '.DD..', '.DD..', '..DD.', '..DDD'],
    ['..D..', '.DD..', '.DD..', '.DD..', '..DD.', '..DD.', '..DDD'],
  ]
  /** Four legs as diagonal strips: [rear near, rear far, front near, front far] foot offsets. */
  function legs(off, lift = [0, 0, 0, 0]) {
    const rows = blank(26, 7)
    const tops = [3, 6, 17, 20]
    const shade = ['D', 'b', 'D', 'b']
    let out = rows
    ;[1, 0, 3, 2].forEach((i) => {
      const strip = []
      for (let j = 0; j < 6 - lift[i]; j++) {
        const x = Math.round(tops[i] + (off[i] * j) / 5)
        strip.push({ x, y: j })
      }
      for (const p of strip) out = stamp(out, [shade[i] + shade[i]], p.x, p.y)
      const last = strip[strip.length - 1]
      out = stamp(out, ['kkk'], last.x - (off[i] < 0 ? 1 : 0), last.y + 1)
    })
    return out
  }
  const STRIDE = [
    [3, -3, -3, 3],
    [1, -1, -1, 1],
    [-3, 3, 3, -3],
    [-1, 1, 1, -1],
  ]
  function dogSide(head, headY, legRows, tail = 0) {
    let r = blank(36, 22)
    r = stamp(r, TAIL[tail], 0, 3)
    r = stamp(r, legRows, 1, 15)
    r = stamp(r, DOG_BODY, 3, 8)
    r = stamp(r, head, 20, headY)
    return r.slice(0, 22)
  }
  const DOG_WALK = STRIDE.map((o, i) => pairOutlined(dogSide(DOG_HEAD, 10, legs(o), i % 2), DOGP))
  const DOG_SNIFF = [pairOutlined(dogSide(DOG_HEAD_SHUT, 11, legs([0, 0, 0, 0]), 0), DOGP), pairOutlined(dogSide(DOG_HEAD_SHUT, 12, legs([0, 0, 0, 0]), 1), DOGP)]
  const DOG_ALERT = [pairOutlined(dogSide(DOG_HEAD_ALERT, 2, legs([0, 0, 0, 0]), 0), DOGP), pairOutlined(dogSide(DOG_HEAD_ALERT, 2, legs([0, 0, 0, 0]), 1), DOGP)]
  const DOG_LEAP = pairOutlined(dogSide(DOG_HEAD_ALERT, 3, legs([-5, -5, 5, 5], [2, 2, 2, 2]), 0), DOGP)

  // front view, rising out of the grass (36 wide; body centred on cols 7-28)
  const FRONT_HEAD = [
    '.......DDDDDDDD.......',
    '.....DDDDDDDDDDDD.....',
    '....DDDDDDDDDDDDDD....',
    '..ddDDDDDDDDDDDDDDdd..',
    '.dddDDwwwDDDDwwwDDddd.',
    'ddddDwwwEDDDDEwwwDdddd',
    'ddddDwwwEDDDDEwwwDdddd',
    'ddddDDwwwDDDDwwwDDdddd',
    'ddddDDDDDTTTTDDDDDdddd',
    'dddddDDTTTTTTTTDDddddd',
    'dddd.DTTTTEEEETTTD.ddd',
    'ddd..TTTTTEEEETTTT..dd',
    'ddd..TTTTTTTTTTTTT...d',
    '.d...TTEwwwwwwwETT....',
    '......TTEMMMMMETT.....',
    '.......TTEEEEETT......',
    '........TTTTTT........',
  ]
  const FRONT_BODY = [
    '........DDDDDD........',
    '......DDDTTTTDDD......',
    '.....DDDTTTTTTDDD.....',
    '.....DDTTTTTTTTDD.....',
    '.....DDTTTTTTTTDD.....',
    '.....DDTTTTTTTTDD.....',
    '.....DDDTTTTTTDDD.....',
    '.....DDDDTTTTDDDD.....',
    '.....DDDDDDDDDDDD.....',
  ]
  const ARM_UP_R = ['....TTT', '....TTT', '...DDT.', '...DD..', '..DD...', '..DD...', '.DD....', '.DD....', 'DD.....', 'DD.....']
  const ARM_UP_L = ARM_UP_R.map((r) => [...r].reverse().join(''))
  const LAUGH_HEAD = FRONT_HEAD.map((r, i) =>
    i === 4 ? '.dddDDDDDDDDDDDDDDddd.'
    : i === 5 ? 'ddddDEEEDDDDDDEEEDdddd'
    : i === 6 ? 'ddddEDDDEDDDDEDDDEdddd'
    : i === 7 ? 'ddddDDDDDDDDDDDDDDdddd'
    : i === 12 ? 'ddd..TEEEEEEEEEEET...d'
    : i === 13 ? '.d...TEwwwwwwwwwET....'
    : i === 14 ? '.....TEmmmmmmmmmET....'
    : i === 15 ? '......TEmMMMMMmET.....'
    : i === 16 ? '.......TEEEEEEET......'
    : r,
  )
  const LAUGH_HEAD2 = LAUGH_HEAD.map((r, i) => (i === 15 ? '......TEmmMMMmmET.....' : r))
  const PAWS_BELLY = ['TT................TT', 'TTD..............DTT', '.DDD............DDD.']
  function front(head, armL, armR, bob = 0) {
    let r = blank(36, 27)
    r = stamp(r, FRONT_BODY, 7, 17 + bob)
    r = stamp(r, head, 7, bob)
    if (armR === 'up') r = stamp(r, ARM_UP_R, 26, 8 + bob)
    if (armL === 'up') r = stamp(r, ARM_UP_L, 3, 8 + bob)
    if (armR === 'belly') r = stamp(r, PAWS_BELLY, 8, 19 + bob)
    return r
  }
  const DOG_HOLD1 = pairOutlined(front(FRONT_HEAD, null, 'up'), DOGP)
  const DOG_HOLD2 = pairOutlined(front(FRONT_HEAD, 'up', 'up'), DOGP)
  const DOG_LAUGH = [pairOutlined(front(LAUGH_HEAD, null, 'belly', 1), DOGP), pairOutlined(front(LAUGH_HEAD2, null, 'belly', 0), DOGP)]
  const FW = 36
  const FH = 27
  // lying down in the grass, chin on paws, asleep
  const DOG_LIE = pairOutlined(
    [
      '.......................DDDDD....',
      '.....................DDDDDDDDD..',
      '....................dDDDDDDDDD..',
      'DD.................ddDDEEEDDDDD.',
      '.DD.....DDDDDDDDDdddDDDDDDDTTEE.',
      '..DD..DDDDDDDDDDDdddDDDDDDTTTEE.',
      '..DDDDDDDDDDDDDDDdddDDDDTTTTTT..',
      '...DDDDDDDDDDDDDDDdddDTTTTTTTT..',
      '...DDDDDDDDDDDDDDDDddTTTTTTTTkk.',
      '..kDDDDDTTTTTTTTTTTTTTTTTkkkkk..',
      '.kkkDDDTTTTTTTTTTTTTTT..........',
    ],
    DOGP,
  )

  // ---- scenery ------------------------------------------------------------------------
  const SCN = { G: '#78c818', g: '#2e8c12', e: '#14560c', l: '#b8f018', K: '#7c4c1c', k: '#4c2c0c', L: '#2a7c1c', M: '#1a5a14', N: '#46a02a', y: '#d8f070' }
  function blobRows(w, h, circles, light, mid, dark) {
    const rows = []
    for (let y = 0; y < h; y++) {
      let r = ''
      for (let x = 0; x < w; x++) {
        let inside = false
        let edge = 9
        for (const [cx, cy, rr] of circles) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
          if (d < rr) inside = true
          edge = Math.min(edge, rr - d)
        }
        if (!inside) {
          r += '.'
          continue
        }
        // light from the top-left, a dithered middle, shade at the bottom right
        const t = (x / w) * 0.45 + (y / h) * 0.85
        const dith = (x + y) % 2
        r += edge < 1.1 && t > 0.7 ? dark : t < 0.45 ? light : t < 0.62 ? (dith ? light : mid) : t < 0.95 ? mid : dith ? mid : dark
      }
      rows.push(r)
    }
    return rows
  }
  const CANOPY = blobRows(26, 21, [[13, 11, 9.5], [7, 9, 6], [19, 9, 6.5], [9, 15, 5.5], [18, 15, 5.5], [13, 5, 5.5]], 'N', 'L', 'M')
  const TRUNK = ['....kK...Kk...', '.....kK.Kk....', '......kKKk....', '......kKKk....', '......kKKk....', '......kKKk....', '.....kKKKkk...', '.....kKKKKk...', '....kkKKKKkk..']
  const TREE = outline(sprite(stamp(stamp(blank(26, 33), CANOPY, 0, 0), TRUNK, 6, 21).slice(0, 30), SCN))
  const BUSH = outline(sprite(blobRows(28, 13, [[7, 8, 5.5], [14, 6, 6.5], [21, 8, 5.5], [14, 10, 5]], 'N', 'L', 'M'), SCN))

  // ---- HUD, reticle, clay --------------------------------------------------------------
  const HP = { w: '#fcfcfc', r: '#fc5c3c', a: '#5c6068', y: '#fcd84c', k: '#b07c1c', g: '#80d010' }
  const ICON = { 0: sprite(['..ww', 'wwww', '.ww.'], HP), 1: sprite(['..rr', 'rrrr', '.rr.'], HP), 2: sprite(['..aa', 'aaaa', '.aa.'], HP) }
  const SHELL = sprite(['yy', 'yy', 'kk', 'kk'], HP)
  const SPENT = sprite(['aa', 'aa', 'aa', 'aa'], HP)
  const R_GLYPH = sprite(['ww.', 'w.w', 'ww.', 'w.w', 'w.w'], HP)
  const RET_ROWS = [
    '....xxxxx....',
    '..xx.....xx..',
    '.x....x....x.',
    '.x....x....x.',
    'x...........x',
    'x...........x',
    'x.xxx...xxx.x',
    'x...........x',
    'x...........x',
    '.x....x....x.',
    '.x....x....x.',
    '..xx.....xx..',
    '....xxxxx....',
  ]
  const RET_USER = outline(sprite(RET_ROWS, { x: '#ff5a3c' }))
  const RET_AUTO = outline(sprite(RET_ROWS, { x: '#e8e4dc' }))
  const CLAY = outline(sprite(['..OOOOO..', '.OOyyyOO.', 'OOOOOOOOO', '.ooooooo.'], { O: '#f08a2c', o: '#a8501c', y: '#fcc078' }))
  const LEAF = [sprite(['G'], SCN), sprite(['L'], SCN), sprite(['l'], SCN)]

  // ---- helpers ------------------------------------------------------------------------
  const ducksOf = (s) => s.actors.filter((a) => a instanceof Duck && !a.dead)
  const clays = (s) => s.actors.filter((a) => a instanceof Clay && !a.dead)
  const GRASS_TOP = 9 // tallest blade above the floor

  /** Open stretches of floor between furniture, widest first. */
  function gaps(s) {
    const fx = s.fix.slice().sort((a, b) => a.x - b.x)
    const out = []
    let x = 4
    for (const f of fx) {
      if (f.x - 4 > x) out.push({ x0: x, x1: f.x - 4 })
      x = Math.max(x, f.x + f.w + 4)
    }
    if (s.W - 4 > x) out.push({ x0: x, x1: s.W - 4 })
    for (const g of out) g.w = g.x1 - g.x0
    return out.sort((a, b) => b.w - a.w)
  }

  function layoutScene(s) {
    const g = s.data
    const gs = gaps(s)
    g.tree = null
    g.bush = null
    g.bed = null
    const a = gs[0]
    const b = gs[1]
    if (a && a.w >= 64) g.tree = { x: Math.round(a.x0 + Math.min(a.w * 0.22, 40)), y: FLOOR - TREE.height + 1 }
    const bg = b && b.w >= 40 ? b : a && a.w >= 120 ? a : null
    if (bg) g.bush = { x: Math.round(bg === a ? a.x1 - 34 : bg.x0 + bg.w * 0.55 - 14), y: FLOOR - BUSH.height + 1 }
    // the dog's bed: an open stretch clear of the tree and bush
    if (a && a.w >= 44) {
      let x = a === bg ? a.x0 + a.w * 0.5 - 16 : a.x1 - 40
      if (g.tree && Math.abs(x - g.tree.x) < 34) x = g.tree.x + 30
      g.bed = clamp(Math.round(x), a.x0, a.x1 - 34)
    } else g.bed = clamp(Math.round(s.W * 0.25), 4, s.W - 40)
    g.grass = buildGrass(s.W)
    const t = s.fixture('title')
    g.hudX = Math.round(t.x + t.w / 2)
  }

  // tall grass along the floor, stable for a given x
  function hash(x) {
    let h = Math.imul(x ^ 0x5bd1e995, 0x27d4eb2d)
    h ^= h >>> 15
    return ((Math.imul(h, 0x165667b1) >>> 0) % 1000) / 1000
  }
  function buildGrass(W) {
    const h = GRASS_TOP + 1
    const cols = new Array(W).fill(0)
    const col = new Array(W).fill('g')
    // clumps of blades, each blade leaning a little
    let x = -4
    let n = 0
    while (x < W + 4) {
      const cw = 6 + Math.floor(hash(n * 7 + 1) * 6)
      const ch = 5 + Math.floor(hash(n * 13 + 5) * (GRASS_TOP - 4))
      for (let i = 0; i < cw; i++) {
        const xx = x + i
        if (xx < 0 || xx >= W) continue
        const c = 1 - Math.abs(i - cw / 2) / (cw / 2)
        const bh = Math.round(3 + (ch - 3) * (0.35 + 0.65 * c) * (0.75 + 0.25 * hash(xx * 3 + n)))
        if (bh > cols[xx]) {
          cols[xx] = bh
          col[xx] = (i + n) % 3 === 0 ? 'l' : (i + n) % 3 === 1 ? 'G' : 'g'
        }
      }
      x += cw - 2 - Math.floor(hash(n * 31) * 3)
      n++
    }
    const rows = []
    for (let y = 0; y < h; y++) {
      let r = ''
      for (let i = 0; i < W; i++) {
        const top = h - Math.max(3, cols[i])
        if (y < top) r += '.'
        else if (y === top) r += col[i] === 'g' ? 'G' : col[i]
        else if (y >= h - 2) r += 'e'
        else r += y - top < 3 ? (col[i] === 'l' ? 'G' : col[i]) : 'g'
      }
      rows.push(r)
    }
    return sprite(rows, SCN)
  }

  function banner(s, text, ms, color = '#fcfcfc') {
    s.data.banner = { text, until: performance.now() + ms, color }
  }

  // ---- ducks --------------------------------------------------------------------------
  class Duck {
    constructor(s, x, kind, speed, slot) {
      this.s = s
      this.kind = kind
      this.sp = DUCK[kind]
      this.x = x
      this.y = FLOOR - 8
      this.speed = speed * DUCKS[kind].speed
      this.slot = slot
      this.st = 'rise'
      this.t = 0
      this.anim = Math.random()
      this.dir = Math.random() < 0.5 ? 1 : -1
      this.vx = this.dir * this.speed * 0.5
      this.vy = -this.speed * 0.9
      this.turnAt = 0
      this.dodgeAt = 0
      this.z = 3
    }
    get moving() {
      return true
    }
    get alive() {
      return this.st === 'rise' || this.st === 'fly'
    }
    hit(px, py) {
      if (!(this.alive || this.st === 'away')) return false
      return px >= this.x - 5 && px <= this.x + DW + 5 && py >= this.y - 5 && py <= this.y + DH + 5
    }
    onClick() {
      userShot(this.s, this)
    }
    steer(now) {
      // a new heading: mostly diagonal zigzags, sometimes a level dash
      const a = pick([0.35, 0.55, 0.8, 0.1, 0.55])
      const up = this.y > 8 ? -1 : this.y < 3 ? 1 : Math.random() < 0.5 ? -1 : 1
      let d = this.dir
      if (Math.random() < 0.3 || this.x < 30 || this.x > this.s.W - DW - 30) d = this.x < this.s.W / 2 ? 1 : -1
      this.vx = d * this.speed * Math.cos(a)
      this.vy = up * this.speed * Math.sin(a) * 0.8
      this.turnAt = now + rand(900, 2200)
    }
    flyAway() {
      if (!this.alive) return
      this.st = 'away'
      this.vx *= 0.25
      this.vy = -this.speed * 1.1
      this.z = 10
    }
    shoot(now) {
      if (!(this.alive || this.st === 'away')) return false
      this.st = 'hit'
      this.t = 0
      this.z = 10
      const g = this.s.data
      const pts = DUCKS[this.kind].pts * (g.round > 10 ? 2 : g.round > 5 ? 1.6 : 1)
      g.score = Math.min(999999, g.score + pts)
      if (this.slot >= 0) g.tally[this.slot] = 1
      this.s.particle({ digits: String(pts), x: this.x + 4, y: clamp(this.y + DH + 1, 2, FLOOR - 14), life: 1.1, vy: -3 })
      const p = DUCKS[this.kind]
      for (let i = 0; i < 4; i++) this.s.particle({ img: pix(i % 2 ? 'w' : 'N'), x: this.x + 10, y: this.y + 9, vx: rand(-22, 22), vy: rand(-20, 4), g: 30, life: rand(0.6, 1.1), fade: true })
      void p
      return true
    }
    update(dt, now, s) {
      this.t += dt
      this.anim += dt
      const W = s.W
      if (this.st === 'hit') {
        if (this.t > 0.55) {
          this.st = 'fall'
          this.t = 0
        }
        return FAST
      }
      if (this.st === 'fall') {
        this.y += 46 * dt
        if (this.y > FLOOR - 26) this.z = 3
        if (this.y > FLOOR - 6) {
          this.dead = true
          s.data.landed.push({ x: this.x + 6, kind: this.kind })
          s.particle({ img: pix('l'), x: this.x + 4, y: FLOOR - 7, vx: -10, vy: -14, g: 60, life: 0.4 })
          s.particle({ img: pix('G'), x: this.x + 8, y: FLOOR - 7, vx: 10, vy: -16, g: 60, life: 0.4 })
        }
        return FAST
      }
      if (this.st === 'away') {
        this.x += this.vx * dt
        this.y += this.vy * dt
        if (Math.abs(this.vx) > 3) this.dir = Math.sign(this.vx)
        if (this.y < -DH - 4) {
          this.dead = true
          if (this.slot >= 0 && s.data.tally[this.slot] === 0) s.data.tally[this.slot] = 2
          s.data.escaped++
        }
        return FAST
      }
      if (this.st === 'rise') {
        this.x += this.vx * dt
        this.y += this.vy * dt
        if (this.y < FLOOR - DH - 10) this.z = 10
        if (this.y < FLOOR - DH - 14) {
          this.st = 'fly'
          this.steer(now)
        }
      } else {
        // dodge a crosshair hovering close by (cooldown so it doesn't thrash)
        const u = s.data.user
        if (u.on && now > this.dodgeAt) {
          const dx = this.x + DW / 2 - u.x
          const dy = this.y + DH / 2 - u.y
          if (Math.abs(dx) < 22 && Math.abs(dy) < 16 && !s.data.engagedShotRecently) {
            this.dodgeAt = now + rand(1400, 2400)
            const d = Math.sign(dx) || this.dir
            this.vx = d * this.speed * 1.5
            this.vy = (dy > 0 ? 1 : -1) * this.speed * 0.5
            this.turnAt = now + 700
            if (Math.random() < 0.35) s.say(pick(['QUACK!', 'quack', 'QUAK!']), this.x + DW / 2, Math.max(0, this.y - 8), { color: '#fcd84c', life: 0.9 })
          }
        }
        if (now > this.turnAt) this.steer(now)
        this.x += this.vx * dt
        this.y += this.vy * dt
        if (this.x < 2) {
          this.x = 2
          this.vx = Math.abs(this.vx)
        } else if (this.x > W - DW - 2) {
          this.x = W - DW - 2
          this.vx = -Math.abs(this.vx)
        }
        if (this.y < 0) {
          this.y = 0
          this.vy = Math.abs(this.vy)
        } else if (this.y > FLOOR - DH - 7) {
          this.y = FLOOR - DH - 7
          this.vy = -Math.abs(this.vy)
        }
        // decay a dodge burst back to cruising speed
        const sp = Math.hypot(this.vx, this.vy)
        if (sp > this.speed * 1.05) {
          const k = 1 - Math.min(1, dt * 1.5) * (1 - this.speed / sp)
          this.vx *= k
          this.vy *= k
        }
      }
      if (Math.abs(this.vx) > 4) this.dir = Math.sign(this.vx)
      return FAST
    }
    draw(c) {
      const X = Math.round(this.x) - 1
      const Y = Math.round(this.y) - 1
      if (this.st === 'hit') c.drawImage(this.sp.hit[this.dir], X, Y)
      else if (this.st === 'fall') c.drawImage(this.sp.fall[Math.floor(this.t * 8) % 2 ? 1 : -1], X + 5, Y)
      else c.drawImage(this.sp.fly[Math.floor(this.anim * (this.st === 'away' ? 13 : 10)) % 4][this.dir], X, Y)
      if (this.kind === 'gold' && this.alive && Math.floor(this.anim * 6) % 3 === 0) c.drawImage(STAR, X + 2 + ((this.anim * 37) % 18), Y + 3)
    }
  }

  // ---- clay pigeons (the bonus "Game C" interlude) ---------------------------------------
  class Clay {
    constructor(s, x, vx) {
      this.s = s
      this.x = x
      this.y = FLOOR - 6
      this.vx = vx
      this.vy = -rand(44, 52)
      this.z = 9
    }
    get moving() {
      return true
    }
    get alive() {
      return !this.dead
    }
    hit(px, py) {
      return px >= this.x - 6 && px <= this.x + 15 && py >= this.y - 6 && py <= this.y + 10
    }
    onClick() {
      userShot(this.s, this)
    }
    shoot() {
      const s = this.s
      this.dead = true
      s.burst(this.x + 4, this.y + 2, 10, ['O', 'O', 'y', 'k'])
      s.data.score = Math.min(999999, s.data.score + 800)
      s.particle({ digits: '800', x: this.x, y: clamp(this.y + 6, 2, FLOOR - 12), life: 1, vy: -3 })
      s.data.clayHits++
      return true
    }
    update(dt) {
      this.x += this.vx * dt
      this.y += this.vy * dt
      this.vy += 34 * dt
      if (this.y > FLOOR + 2 || this.x < -12 || this.x > this.s.W + 4) this.dead = true
      return FAST
    }
    draw(c) {
      c.drawImage(CLAY, Math.round(this.x) - 1, Math.round(this.y) - 1)
    }
  }

  // ---- the dog --------------------------------------------------------------------------
  class Dog {
    constructor(s) {
      this.s = s
      this.st = 'off'
      this.x = -40
      this.y = FLOOR
      this.dir = 1
      this.t = 0
      this.anim = 0
      this.z = 6
      this.grabbable = false
      this.pokes = 0
    }
    get moving() {
      return this.st === 'walk' || this.st === 'jump' || this.st === 'hop'
    }
    get asleep() {
      return this.st === 'lie' && this.t > 2
    }
    /** Visible box in bar coords, for hit(). */
    box() {
      if (this.st === 'walk' || this.st === 'sniff' || this.st === 'alert' || this.st === 'hands' || this.st === 'held')
        return [this.x + 1, this.y - 21, 34, 21]
      if (this.st === 'lie') return [this.x, this.y - 11, 32, 11]
      if (this.st === 'pop') return [this.x + 4, this.popY(), 28, FLOOR - this.popY()]
      return null
    }
    hit(px, py) {
      const b = this.box()
      return !!b && px >= b[0] - 1 && px <= b[0] + b[2] + 1 && py >= b[1] - 1 && py <= b[1] + b[3] + 1
    }
    popY() {
      // top of the front sprite: rises out of the grass, holds, sinks
      const up = this.hold
      const rise = 0.35
      const k = this.t < rise ? this.t / rise : this.t > up - rise ? Math.max(0, (up - this.t) / rise) : 1
      return Math.round(FLOOR - (FH - 1) * k)
    }
    // -- commands from the round controller
    intro(fromX, toX) {
      this.st = 'walk'
      this.x = fromX
      this.tx = toX
      this.dir = toX >= fromX ? 1 : -1
      this.z = 6
      this.y = FLOOR
      this.stops = Math.floor(rand(1, 3))
      this.nextStop = this.x + this.dir * rand(20, 50)
      this.t = 0
    }
    skip() {
      if (this.st === 'walk' || this.st === 'sniff' || this.st === 'alert' || this.st === 'hands' || this.st === 'lie') this.startJump()
      else if (this.st === 'pop' && this.t < this.hold - 0.35) this.t = this.hold - 0.35
    }
    startJump() {
      this.st = 'jump'
      this.t = 0
      this.jx = this.x
    }
    show(x, kinds, ms) {
      this.st = 'pop'
      this.kinds = kinds
      this.laughing = !kinds.length
      this.x = clamp(Math.round(x - FW / 2), 2, this.s.W - FW - 2)
      this.t = 0
      this.hold = ms / 1000
      this.z = 3
      this.y = FLOOR
    }
    rest() {
      const bed = this.s.data.bed
      if (this.st === 'walk' || this.st === 'sniff' || this.st === 'alert' || this.st === 'hands') {
        this.startJump()
        this.then = 'bed'
      } else if (this.st === 'pop') {
        this.t = Math.max(this.t, this.hold - 0.35)
        this.then = 'bed'
      } else if (this.st === 'jump') this.then = 'bed'
      else if (this.st !== 'lie') this.hopOut(bed)
    }
    hopOut(x) {
      this.st = 'hop'
      this.x = x
      this.t = 0
      this.dir = x < this.s.W / 2 ? 1 : -1
      this.z = 3
    }
    wake() {
      if (this.st === 'lie') {
        this.st = 'stretch'
        this.t = 0
        this.z = 6
      }
    }
    // -- clicks and drags
    onClick() {
      const s = this.s
      const g = s.data
      g.user.lastPoke = performance.now()
      if (this.st === 'pop' && this.laughing) {
        // "you can't shoot the dog": he ducks, then pops up somewhere else, still laughing
        this.pokes++
        if (this.pokes >= 3 && g.bush) {
          this.pokes = 0
          this.show(g.bush.x + 14, [], 2600)
          g.rustle = performance.now()
        } else this.show(clamp(this.x + FW / 2 + pick([-60, 60, -90, 90]), 20, s.W - 20), [], 2200)
        this.t = -0.25
        s.say(pick(['heh heh', 'HAHA!', 'snrk']), this.x + FW / 2, 1, { color: '#f6cc94', life: 1.2 })
        return
      }
      if (this.st === 'pop') {
        // poked while showing off: back down into the grass, quick
        if (this.t < this.hold - 0.35) this.t = this.hold - 0.35
        return
      }
      if (this.st === 'walk' || this.st === 'sniff' || this.st === 'alert' || this.st === 'hands') {
        // he turns to you and snickers
        this.prev = { st: this.st === 'hands' ? 'walk' : this.st, t: this.t }
        this.st = 'snicker'
        this.t = 0
        this.z = 3
        s.say('heh heh', this.x + 18, 1, { color: '#f6cc94', life: 1.4 })
        return
      }
      if (this.st === 'lie') {
        s.particle({ img: BUBBLE['?'], x: this.x + 24, y: this.y - 20, life: 1, vy: 0 })
        this.wake()
      }
    }
    onDblClick() {
      // a pat on the head: the tail goes
      const s = this.s
      if (this.st === 'walk' || this.st === 'sniff' || this.st === 'alert') s.particle({ img: BUBBLE['♥'], x: this.x + 26, y: Math.max(0, this.y - 30), life: 1.2, vy: -3 })
    }
    update(dt, now, s) {
      this.t += dt
      this.anim += dt
      const g = s.data
      switch (this.st) {
        case 'off':
          return Infinity
        case 'walk': {
          // the crosshair hovering on him: he puts his paws up
          const u = g.user
          if (u.on && u.x > this.x && u.x < this.x + 36 && u.y > this.y - 24 && now - u.since > 500 && !this.handsDone) {
            this.handsDone = true
            this.st = 'hands'
            this.t = 0
            this.z = 3
            return FAST
          }
          // notice the cursor nearby: look up at it
          if (u.on && Math.abs(u.x - this.x - 18) < 50 && now > (this.lookAt || 0)) {
            this.lookAt = now + 6000
            this.st = 'alert'
            this.t = -0.6
            this.dir = u.x > this.x + 18 ? 1 : -1
            s.particle({ img: BUBBLE['?'], x: this.x + (this.dir > 0 ? 28 : 4), y: this.y - 32, life: 0.9 })
            this.resumeWalk = true
            return FAST
          }
          this.x += this.dir * 24 * dt
          if (this.stops > 0 && (this.x - this.nextStop) * this.dir > 0) {
            this.stops--
            this.st = 'sniff'
            this.t = 0
            this.sniffFor = rand(0.9, 1.8)
            this.nextStop = this.x + this.dir * rand(25, 55)
          }
          if ((this.x - this.tx) * this.dir >= 0) {
            this.st = 'alert'
            this.t = 0
            this.resumeWalk = false
            s.particle({ img: BUBBLE['!'], x: this.x + (this.dir > 0 ? 30 : 2), y: this.y - 31, life: 0.8 })
          }
          return FAST
        }
        case 'sniff':
          if (this.t > this.sniffFor) this.st = 'walk'
          return FAST
        case 'alert':
          if (this.t > 0.85) {
            if (this.resumeWalk) {
              this.resumeWalk = false
              this.dir = this.tx >= this.x ? 1 : -1
              this.st = 'walk'
            } else this.startJump()
          }
          return this.t < 0 ? FAST : SLOW
        case 'hands':
          // paws up until the crosshair moves off him
          if (!g.user.on || Math.abs(g.user.x - this.x - 18) > 26 || this.t > 4) {
            if (this.t > 0.8) {
              this.st = 'walk'
              this.z = 6
            }
          }
          return FAST
        case 'snicker':
          if (this.t > 1.5) {
            this.st = this.prev.st
            this.t = 0
            this.z = 6
            if (this.st !== 'walk' && this.st !== 'sniff') this.st = 'alert'
          }
          return FAST
        case 'jump': {
          const T = this.t
          this.x = this.jx + this.dir * 34 * Math.min(T, 0.9)
          if (T < 0.45) this.y = FLOOR - 15 * Math.sin((Math.PI / 2) * (T / 0.45))
          else {
            this.z = 3
            this.y = FLOOR - 15 + 95 * (T - 0.45) ** 1.3 * 1.6
          }
          if (this.y - 21 > FLOOR - 4) {
            this.st = 'off'
            this.y = FLOOR
            s.particle({ img: LEAF[0], x: this.x + 18, y: FLOOR - 8, vx: -8, vy: -18, g: 50, life: 0.5 })
            s.particle({ img: LEAF[2], x: this.x + 22, y: FLOOR - 8, vx: 9, vy: -20, g: 50, life: 0.5 })
            if (this.then === 'bed') {
              this.then = null
              this.hopOut(g.bed)
            }
          }
          return FAST
        }
        case 'pop':
          if (this.t >= this.hold) {
            this.st = 'off'
            if (this.then === 'bed') {
              this.then = null
              this.hopOut(g.bed)
            }
            return FAST
          }
          if (this.laughing && Math.random() < 0.02) s.say(pick(['heh', 'hehe']), this.x + FW / 2, 1, { color: '#f6cc94', life: 0.8 })
          return this.t < 0.4 || this.t > this.hold - 0.4 || this.laughing ? FAST : Math.min(SLOW, (this.hold - 0.4 - this.t) * 1000)
        case 'hop': {
          // springs up out of the grass and flops down on his bed
          const T = this.t / 0.7
          this.y = FLOOR + 18 - 22 * Math.sin(Math.PI * Math.min(1, T) * 0.75)
          if (T > 0.5) this.z = 6
          if (T >= 1) {
            this.st = 'lie'
            this.t = 0
            this.y = FLOOR - 1
            this.z = 6
            this.lastZ = 0
          }
          return FAST
        }
        case 'stretch':
          if (this.t > 0.9) {
            this.st = 'alert'
            this.t = 0.4
            this.resumeWalk = false
            this.ready = true
          }
          return FAST
        case 'lie':
          if (this.t < 9) {
            if (now - this.lastZ > 1800 && this.t > 1.2) {
              this.lastZ = now
              s.particle({ img: ZZ, x: this.x + 26, y: this.y - 16, vy: -4, life: 1.6, fade: true })
            }
            return 600
          }
          return Infinity
      }
      return Infinity
    }
    draw(c) {
      const X = Math.round(this.x) - 1
      const Y = Math.round(this.y) - 1
      switch (this.st) {
        case 'walk':
          c.drawImage(DOG_WALK[Math.floor(this.anim * 7) % 4][this.dir], X, Y - 22)
          break
        case 'sniff':
          c.drawImage(DOG_SNIFF[Math.floor(this.anim * 6) % 2][this.dir], X, Y - 22)
          break
        case 'alert':
        case 'stretch':
          c.drawImage(DOG_ALERT[Math.floor(this.anim * 5) % 2][this.dir], X, Y - 22)
          break
        case 'jump':
          c.drawImage(DOG_LEAP[this.dir], X, Y - 22)
          break
        case 'hop':
          c.drawImage((this.t < 0.45 ? DOG_LEAP : DOG_ALERT[0])[this.dir], X, Y - 22)
          break
        case 'lie':
          c.drawImage(DOG_LIE[this.dir], X, Y - 11)
          break
        case 'hands':
          c.drawImage(DOG_HOLD2[1], X, FLOOR - FH + 2)
          break
        case 'snicker':
          c.drawImage(DOG_LAUGH[Math.floor(this.anim * 7) % 2][1], X, FLOOR - FH + 2)
          break
        case 'pop': {
          if (this.t < 0) break
          const top = this.popY() - 1
          if (this.laughing) {
            c.drawImage(DOG_LAUGH[Math.floor(this.anim * 7) % 2][1], X, top)
            break
          }
          const two = this.kinds.length > 1
          c.drawImage((two ? DOG_HOLD2 : DOG_HOLD1)[1], X, top)
          // ducks hang by the feet from his raised paws
          c.drawImage(DUCK[this.kinds[0]].fall[1], X + 26, top + 1)
          if (two) c.drawImage(DUCK[this.kinds[1]].fall[-1], X - 3, top + 1)
          break
        }
      }
    }
  }

  // ---- the grass (in front of the dog, behind flying ducks) --------------------------------
  class Grass {
    constructor(s) {
      this.s = s
      this.prop = true
      this.z = 5
    }
    update() {
      return Infinity
    }
    draw(c, s) {
      const g = s.data
      if (g.grass) c.drawImage(g.grass, 0, FLOOR - g.grass.height)
      if (g.bush) {
        const sh = g.rustle && performance.now() - g.rustle < 500 ? (Math.floor(performance.now() / 60) % 2) * 2 - 1 : 0
        c.drawImage(BUSH, g.bush.x + sh, g.bush.y)
      }
    }
  }

  // ---- shooting -------------------------------------------------------------------------
  function fire(s, now, target, hits) {
    const g = s.data
    g.flashAt = now
    g.flashBox = hits && target ? { x: target.x - 1, y: target.y - 1, w: target instanceof Duck ? DW + 2 : 11, h: target instanceof Duck ? DH + 2 : 6 } : null
    g.shots = Math.max(0, g.shots - 1)
    g.lastShot = now
    if (hits && target) target.shoot(now)
  }
  function userShot(s, target) {
    const now = performance.now()
    const g = s.data
    g.user.lastShot = now
    if (g.phase === 'rest') return
    fire(s, now, target, true)
    // a user who is out of shells still gets the duck, but the counter stays honest
  }

  // ---- the auto-hunter ----------------------------------------------------------------------
  function engaged(s, now) {
    const u = s.data.user
    return now - (s.keyAt ?? -1e9) < 9000 || now - u.lastShot < 9000 || now - u.lastPoke < 6000 || (s.cursor && now - (s.cursor.t ?? now) < 2500)
  }
  // ---- keyboard: WASD moves the crosshair, Space pulls the trigger --------------------------
  const SPILL = typeof SPILL_UP === 'number' ? SPILL_UP : 0
  function keyAim(s, dt, now) {
    const u = s.data.user
    const k = s.keys
    if (!k || !k.size) return false
    if (!u.on) {
      u.on = true
      u.x = clamp(s.data.hudX ?? s.W / 2, 8, s.W - 8)
      u.y = FLOOR - 16
    }
    u.kb = now
    u.since = now
    const dx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0)
    const dy = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0)
    u.x = clamp(u.x + dx * 150 * dt, 0, s.W)
    u.y = clamp(u.y + dy * 80 * dt, -SPILL, H)
    return dx !== 0 || dy !== 0
  }
  function keyFire(s) {
    const g = s.data
    const u = g.user
    if (!u.on) keyAim(s, 0, performance.now())
    let target = null
    for (let i = s.actors.length - 1; i >= 0 && !target; i--) {
      const a = s.actors[i]
      if (!a.dead && a.onClick && a.hit?.(u.x, u.y)) target = a
    }
    if (target) return target.onClick({ x: u.x, y: u.y })
    // a miss: the flash, a spent shell
    g.user.lastShot = performance.now()
    if (g.phase !== 'rest') fire(s, performance.now(), null, false)
  }
  function hunter(s, dt, now, targets) {
    const g = s.data
    const a = g.auto
    if (engaged(s, now) || !targets.length) {
      a.on = false
      return
    }
    if (!a.on) {
      a.on = true
      a.x = clamp(g.hudX + rand(-60, 60), 8, s.W - 8)
      a.y = FLOOR - 6
      a.nextShot = Math.max(a.nextShot, now + rand(500, 900))
    }
    if (!a.target || !targets.includes(a.target)) {
      a.target = targets.reduce((b, d) => (Math.abs(d.x - a.x) < Math.abs(b.x - a.x) ? d : b))
      a.aimFrom = now
    }
    const d = a.target
    const isDuck = d instanceof Duck
    const tx = d.x + (isDuck ? DW / 2 : 4) + d.vx * 0.12 + a.wobX
    const ty = d.y + (isDuck ? DH / 2 : 2) + d.vy * 0.12 + a.wobY
    const k = 1 - Math.exp(-dt * (g.perfect ? 14 : 5.5))
    a.x += (tx - a.x) * k
    a.y += (ty - a.y) * k
    a.wobX *= 0.9
    a.wobY *= 0.9
    const close = Math.hypot(tx - a.x, ty - a.y) < 4
    if (now >= a.nextShot && close && (g.shots > 0 || g.perfect)) {
      const speed = Math.hypot(d.vx, d.vy)
      const p = g.perfect ? 1 : clamp(g.skill - speed / 400 - (d.kind === 'gold' ? 0.2 : 0), 0.3, 0.92)
      const hits = Math.random() < p
      fire(s, now, d, hits)
      if (!hits) {
        // the shot sails past: the reticle jerks, the duck flinches away
        a.wobX = rand(-14, 14)
        a.wobY = rand(-6, 6)
        if (isDuck) {
          d.vx = -d.vx
          d.turnAt = now + 800
        }
      }
      a.target = null
      a.nextShot = now + (g.perfect ? 260 : rand(550, 1100))
    }
  }

  // ---- the round controller ----------------------------------------------------------------
  const KINDS = ['green', 'green', 'green', 'blue', 'blue', 'red']
  function newRound(s, now) {
    const g = s.data
    g.tally = new Array(10).fill(0)
    g.ti = 0
    g.double = s.busy || Math.random() < 0.3
    g.skill = rand(0.55, 0.85)
    startIntro(s, now)
  }
  function startIntro(s, now) {
    const g = s.data
    const dog = g.dog
    banner(s, `ROUND ${g.round}`, 2200)
    g.phase = 'intro'
    if (dog.st === 'off') {
      dog.intro(-30, clamp(rand(50, 100), 40, Math.max(60, s.W * 0.5)))
    } else if (dog.st === 'alert' || dog.st === 'lie' || dog.st === 'stretch') {
      // waking from his bed: he sniffs on from there
      const to = clamp(dog.x + (dog.x < s.W / 2 ? 1 : -1) * rand(40, 80), 20, s.W - 50)
      dog.intro(dog.x, to)
    }
    void now
  }
  function startSet(s, now) {
    const g = s.data
    const n = Math.min(g.double || s.busy ? 2 : 1, 10 - g.ti)
    const speedBase = (24 + g.round * 2.5) * (s.busy ? 1.3 : 1)
    g.landed = []
    g.escaped = 0
    g.shots = 3
    for (let i = 0; i < n; i++) {
      let kind = pick(KINDS.slice(0, g.round > 3 ? 6 : 5))
      if (Math.random() < 0.035) kind = 'gold'
      const x = clamp(rand(30, s.W - 50) + i * 40, 20, s.W - DW - 20)
      const d = new Duck(s, x, kind, Math.min(70, speedBase), g.ti++)
      s.spawn(d)
    }
    g.flyUntil = now + (n > 1 ? 8000 : 6500) - Math.min(2000, g.round * 120)
    g.phase = 'flight'
    g.auto.nextShot = now + rand(900, 1500)
  }
  function finishSet(s, now) {
    const g = s.data
    g.phase = 'dogshow'
    if (g.perfect) return perfect(s, now)
    if (g.landed.length) {
      const L = g.landed
      g.dog.show(L[0].x, L.slice(0, 2).map((l) => l.kind), L.length > 1 ? 2400 : 2000)
    } else {
      g.dog.show(clamp(g.hudX + pick([-70, 70]), 30, s.W - 30), [], 2400)
    }
  }
  function perfect(s, now) {
    const g = s.data
    g.perfect = false
    const L = g.landed || []
    const kinds = [L[0]?.kind || pick(KINDS), L[1]?.kind || pick(KINDS)]
    const gp = gaps(s)[0]
    const x = gp ? clamp(g.hudX, gp.x0 + 22, gp.x1 - 22) : s.W / 2
    g.dog.show(x, kinds, 3800)
    g.score = Math.min(999999, g.score + 10000)
    banner(s, 'PERFECT!!', 3200, '#fcd84c')
    s.particle({ digits: '10000', x: x - 10, y: 1, life: 2.4, vy: -1 })
    for (let i = 0; i < 10; i++) s.particle({ img: CONFETTI[i % CONFETTI.length], x: x + rand(-20, 20), y: rand(0, 6), vx: rand(-10, 10), vy: rand(4, 14), life: rand(1.2, 2), fade: true })
    g.phase = 'dogshow'
    void now
  }
  function enterRest(s) {
    const g = s.data
    g.phase = 'rest'
    g.banner = null
    g.auto.on = false
    for (const d of ducksOf(s)) d.flyAway()
    for (const c of clays(s)) c.dead = true
    g.dog.rest()
  }

  function control(s, dt, now) {
    const g = s.data
    const lively = s.lively(now) || KEEP_AWAKE
    if (!lively && g.phase !== 'rest') enterRest(s)
    const dog = g.dog
    g.engagedShotRecently = now - g.user.lastShot < 9000
    switch (g.phase) {
      case 'rest':
        if (!lively) {
          // ducks still leaving, the dog settling: their own updates decide
          return Infinity
        }
        if (dog.st === 'lie') dog.wake()
        if (dog.ready || dog.st === 'off') {
          dog.ready = false
          g.perfect ? perfect(s, now) : startIntro(s, now)
        }
        return FAST
      case 'intro':
        if (g.perfect) dog.skip()
        if (dog.st === 'off') {
          g.phase = 'gap'
          g.at = now + (s.busy ? 300 : 700)
        }
        return SLOW
      case 'gap':
        if (now < g.at && !g.perfect) return g.at - now
        if (dog.st !== 'off') return SLOW
        if (g.perfect) {
          g.landed = []
          perfect(s, now)
          return FAST
        }
        if (g.ti >= 10) {
          g.phase = 'tally'
          g.at = now + 2400
          const hits = g.tally.filter((v) => v === 1).length
          g.need = g.round <= 10 ? 6 : g.round <= 12 ? 7 : 8
          if (hits === 10) {
            banner(s, 'PERFECT!!', 2600, '#fcd84c')
            g.score = Math.min(999999, g.score + 10000)
            s.particle({ digits: '10000', x: g.hudX - 10, y: 11, life: 2, vy: -2 })
          } else if (hits < g.need) {
            banner(s, 'GAME OVER', 3000, '#fc5c3c')
            g.gameOver = true
            dog.show(clamp(g.hudX + pick([-80, 80]), 30, s.W - 30), [], 3000)
          }
          return SLOW
        }
        startSet(s, now)
        return FAST
      case 'flight': {
        const ds = ducksOf(s)
        const live = ds.filter((d) => d.alive)
        if (!ds.length) {
          finishSet(s, now)
          return FAST
        }
        if (live.length && !g.perfect && (now > g.flyUntil || (g.shots <= 0 && now - g.lastShot > 700 && !engaged(s, now)))) {
          for (const d of live) d.flyAway()
          banner(s, 'FLY AWAY', 1600)
        }
        hunter(s, dt, now, live)
        return FAST
      }
      case 'dogshow':
        if (dog.st === 'off') {
          g.phase = 'gap'
          g.at = now + (s.busy ? 250 : 600)
        }
        return SLOW
      case 'tally':
        if (now < g.at || dog.st !== 'off') return Math.max(SLOW, g.at - now)
        if (g.gameOver) {
          g.gameOver = false
          g.round = 1
          g.score = 0
        } else g.round = g.round >= 99 ? 1 : g.round + 1
        if (g.round % 3 === 0 && !g.clayDone) {
          g.clayDone = true
          g.phase = 'clay'
          g.volleys = 3
          g.clayHits = 0
          g.at = now + 1200
          g.shots = 3
          banner(s, 'BONUS: CLAY', 1800, '#f08a2c')
          return FAST
        }
        g.clayDone = false
        newRound(s, now)
        return FAST
      case 'clay': {
        const cs = clays(s)
        hunter(s, dt, now, cs)
        if (!cs.length && now >= g.at) {
          if (g.volleys-- > 0) {
            g.shots = 3
            const left = Math.random() < 0.5
            const x0 = left ? rand(10, s.W * 0.3) : rand(s.W * 0.7, s.W - 20)
            const v = (left ? 1 : -1) * rand(38, 62)
            s.spawn(new Clay(s, x0, v))
            s.spawn(new Clay(s, x0 + (left ? -8 : 8), v * rand(0.8, 1.2)))
            g.at = now + 900
          } else {
            g.phase = 'tally'
            g.at = now + 300
            g.ti = 10
          }
        }
        return FAST
      }
    }
    return Infinity
  }

  registerConcept({
    key: 'duckhunt',
    title: 'Duck Hunt',
    sub: 'Nintendo, 1984',
    blurb:
      'Tall grass, a tree and a bush along the bottom of the bar. Each round the dog sniffs his way in and leaps into the grass, then ducks burst out and zigzag across the bar while an unseen hunter takes three shots at them: hits freeze and fall, and the dog pops up holding them; when they get away it says FLY AWAY and he laughs at you. <b>Click a duck to shoot it</b>; the hunter holds fire while you play. Ducks dodge a crosshair hovering near them, the dog looks up at your cursor, puts his paws up if you aim at him, and snickers if you click him. Working brings double-duck rounds with faster birds, done is a PERFECT!! with the dog holding up two ducks, and when it goes quiet he lies down in the grass.',
    setup(s) {
      s.data = {
        round: 1, score: 0, tally: new Array(10).fill(0), ti: 0, shots: 3, landed: [], escaped: 0,
        phase: 'start', at: 0, banner: null, flashAt: -1e9, flashBox: null, lastShot: 0, skill: 0.7,
        user: { on: false, x: 0, y: 0, since: 0, lastShot: -1e9, lastPoke: -1e9 },
        auto: { on: false, x: 0, y: 0, target: null, nextShot: 0, wobX: 0, wobY: 0 },
        perfect: false, double: false,
      }
      layoutScene(s)
      s.actors.push(new Grass(s))
      s.data.dog = new Dog(s)
      s.actors.push(s.data.dog)
    },
    relayout(s) {
      layoutScene(s)
      const g = s.data
      for (const a of s.actors) {
        if (a instanceof Duck) a.x = clamp(a.x, 2, s.W - DW - 2)
        if (a instanceof Clay && a.x > s.W) a.dead = true
      }
      const dog = g.dog
      if (dog.st === 'lie') dog.x = g.bed
      else dog.x = clamp(dog.x, -40, s.W - 30)
      if (dog.tx !== undefined) dog.tx = clamp(dog.tx, 20, s.W - 50)
    },
    update(s, dt, now) {
      const g = s.data
      // the player's crosshair follows the (coarse) cursor smoothly
      const u = g.user
      let want = Infinity
      const keyed = keyAim(s, dt, now)
      if (keyed || (s.keys && s.keys.size)) want = FAST
      // the keyboard owns the crosshair until the mouse moves again
      const kbOwns = u.kb && (!s.cursor || s.cursor.t <= u.kb)
      if (kbOwns && (now - u.kb < 9000)) {
        // keep it where the keys left it
      } else if (s.cursor && s.cursor.y > -6 && s.cursor.y < H + 6) {
        u.kb = 0
        if (!u.on) {
          u.on = true
          u.x = s.cursor.x
          u.y = s.cursor.y
          u.since = now
        }
        const k = 1 - Math.exp(-dt * 14)
        const dx = s.cursor.x - u.x
        const dy = s.cursor.y - u.y
        if (Math.hypot(dx, dy) > 6) u.since = now
        u.x += dx * k
        u.y += dy * k
        if (Math.abs(dx) + Math.abs(dy) > 0.5) want = FAST
      } else if (u.on) u.on = false
      if (g.phase === 'start') {
        g.phase = 'intro'
        newRound(s, now)
      }
      return Math.min(want, control(s, dt, now))
    },
    onBusy(s) {
      s.data.double = true
    },
    onKey(s, key, down) {
      if (!down) return
      if (key === 'fire') keyFire(s)
      else keyAim(s, 1 / 30, performance.now()) // the first nudge happens now
      s.poke()
    },
    onDone(s) {
      s.data.perfect = true
      s.poke()
    },
    onNap(s) {
      if (s.data.phase !== 'rest') enterRest(s)
    },
    // mockup only (Aico never delivers clicks on empty bar): a shot that misses
    onBarClick(s, p) {
      const g = s.data
      if (g.phase === 'rest') return
      g.user.lastShot = performance.now()
      fire(s, performance.now(), null, false)
      void p
    },
    drawBehind(s, c) {
      const g = s.data
      if (g.tree) c.drawImage(TREE, g.tree.x, g.tree.y)
    },
    drawFront(s, c) {
      const g = s.data
      const now = performance.now()
      // the zapper flash: a pale frame, the target a white box
      if (now - g.flashAt < 90) {
        c.fillStyle = 'rgba(255,255,255,.16)'
        c.fillRect(0, 0, s.W, H)
        if (g.flashBox) {
          c.fillStyle = '#fcfcfc'
          c.fillRect(Math.round(g.flashBox.x), Math.round(g.flashBox.y), g.flashBox.w, g.flashBox.h)
        }
      }
      if (g.phase !== 'rest') drawHud(s, c, now)
      const b = g.banner
      if (b && now < b.until && g.phase !== 'rest') {
        c.font = 'bold 7px "DejaVu Sans Mono", Menlo, monospace'
        c.textBaseline = 'top'
        const w = Math.ceil(c.measureText(b.text).width) + 8
        const x = Math.round(clamp(g.hudX - w / 2, 1, s.W - w - 1))
        c.fillStyle = '#000'
        c.fillRect(x, 0, w, 10)
        c.strokeStyle = '#fcfcfc'
        c.lineWidth = 1
        c.strokeRect(x + 0.5, 0.5, w - 1, 9)
        c.fillStyle = b.color
        c.fillText(b.text, x + 4, 2)
      } else if (b) g.banner = null
      if (g.auto.on && (g.phase === 'flight' || g.phase === 'clay')) c.drawImage(RET_AUTO, Math.round(g.auto.x) - 7, Math.round(g.auto.y) - 7)
      if (g.user.on) c.drawImage(RET_USER, Math.round(g.user.x) - 7, Math.round(g.user.y) - 7)
    },
  })

  function drawHud(s, c, now) {
    const g = s.data
    const w = 4 + 8 + 4 + 10 + 4 + 50 + 4 + 24
    const x0 = Math.round(clamp(g.hudX - w / 2, 2, s.W - w - 2))
    const y0 = FLOOR - 8
    c.fillStyle = 'rgba(0,0,0,.82)'
    c.fillRect(x0, y0, w, 8)
    c.fillStyle = '#80d010'
    c.fillRect(x0, y0, w, 1)
    let x = x0 + 3
    c.drawImage(R_GLYPH, x, y0 + 2)
    x += 5
    x += drawDigits(c, String(g.round), x, y0 + 2) + 3
    for (let i = 0; i < 3; i++) c.drawImage(i < g.shots ? SHELL : SPENT, x + i * 3, y0 + 2)
    x += 13
    const blink = Math.floor(now / 220) % 2
    for (let i = 0; i < 10; i++) {
      const v = g.tally[i]
      const live = g.phase === 'flight' && v === 0 && i < g.ti
      if (!(live && blink)) c.drawImage(ICON[v], x + i * 5, y0 + 3)
    }
    x += 52
    const sc = String(g.score).padStart(6, '0')
    drawDigits(c, sc, x, y0 + 2)
  }
})()
