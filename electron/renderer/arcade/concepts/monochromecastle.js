;(() => {
  // Monochrome castle, big version, in a 1-bit black-and-white look: the
  // hero works his way through the castle
  // throwing rocks overhand at rats, bats, whip-cracking mutants, the mace
  // henchman and the gargoyle, stumbling and grumbling when he gets hit.
  // Busy is the knight on his throne hurling beer mugs; done is the
  // lever that topples the throne; rest is the hero sitting, catching his breath.

  const live = (s, now) => s.lively(now)
  const NOW = () => performance.now()
  const engaged = (s, now) => now - s.keyAt < 9000 || now < (s.data.userUntil || 0) || (s.cursor && now - s.cursor.t < 1600)
  const keyDir = (s) => (s.keys.has('right') ? 1 : 0) - (s.keys.has('left') ? 1 : 0)
  const touched = (s) => {
    s.data.userUntil = NOW() + 9000
  }

  // ---- 1-bit sprites: w white, k black, g 50% dither, G dark dither ----------
  const PAL1 = { w: '#f4f2ea', k: '#000000', a: '#e5a647' }
  function dith(rows) {
    return rows.map((r, y) =>
      [...r]
        .map((ch, x) => (ch === 'g' ? ((x + y) % 2 ? 'k' : 'w') : ch === 'G' ? (x % 2 === 0 && y % 2 === 0 ? 'w' : 'k') : ch))
        .join(''),
    )
  }
  const invert = (rows) => rows.map((r) => r.replace(/[wk]/g, (c) => (c === 'w' ? 'k' : 'w')))
  const compose = (...parts) => [].concat(...parts)
  function overlay(base, top, ox, oy) {
    const out = base.slice()
    top.forEach((r, j) => {
      const y = oy + j
      const row = [...(out[y] || '').padEnd(ox + r.length, '.')]
      ;[...r].forEach((ch, i) => {
        if (ch !== '.') row[ox + i] = ch
      })
      out[y] = row.join('')
    })
    return out
  }
  function frame(rows, ax, inv = false) {
    const w = Math.max(...rows.map((r) => r.length))
    let r = dith(rows.map((x) => x.padEnd(w, '.')))
    if (inv) r = invert(r)
    return { sp: pairOutlined(r, PAL1, '#000'), ax, w, h: rows.length }
  }
  function blit(c, f, cx, dir, foot = FLOOR) {
    const left = dir > 0 ? cx - f.ax : cx - (f.w - 1 - f.ax)
    c.drawImage(f.sp[dir], Math.round(left) - 1, Math.round(foot - f.h) - 1)
  }
  function blitRot(c, f, px, py, ox, oy, dir, ang) {
    c.save()
    c.translate(Math.round(px), Math.round(py))
    c.rotate(ang)
    c.drawImage(f.sp[dir], -ox - 1, -oy - 1)
    c.restore()
  }

  // ---- the hero (24 px, facing right, centre column 7) -----------------------
  const HEAD = [
    '.....gggg.......',
    '....gggggg......',
    '...gggggggg.....',
    '...gggwwwww.....',
    '...ggwwwkww.....',
    '....gwwwwwww....',
    '.....wwwkkw.....',
    '......wwww......',
  ]
  const HEAD_TIRED = HEAD.map((r, i) => (i === 4 ? '...ggwwwwww.....' : i === 3 ? '...gggwkkkw.....' : i === 6 ? '.....wwkkkw.....' : r))
  const HEAD_OW = HEAD.map((r, i) => (i === 4 ? '...ggwwkwkw.....' : i === 6 ? '.....wwkkkk.....' : r))
  const TORSO = {
    stand: [
      '.....wwkww......',
      '....wwwwwww.....',
      '...wwwwwwwww....',
      '..gwwkwwwwww....',
      '..ggwkwwwwww....',
      '..ggwkwwwwww....',
      '...gwwkwwww.....',
      '....kkkkkkk.....',
    ],
    a: [
      '.....wwkww......',
      '....wwwwwww.....',
      '...wwwwwwwww....',
      '..gwwwwkwwww....',
      '..ggwwwwkwww....',
      '..ggwwwwwkww....',
      '...gwwwwwwkww...',
      '....kkkkkkk.ww..',
    ],
    b: [
      '.....wwkww......',
      '....wwwwwww.....',
      '...wwwwwwwww....',
      '..gwwkwwwwww....',
      '..gwkwwwwwww....',
      '..gkwwwwwwww....',
      '.wwgwwwwwww.....',
      '.ww.kkkkkkk.....',
    ],
    plain: [
      '.....wwkww......',
      '....wwwwwww.....',
      '...wwwwwwwww....',
      '..gwwwwwwwww....',
      '..ggwwwwwwww....',
      '..ggwwwwwwww....',
      '...gwwwwwww.....',
      '....kkkkkkk.....',
    ],
    throw: [
      '.....wwkww......',
      '....wwwwwwwkwww.',
      '...wwwwwwwwwwww.',
      '..gwwwwwwwww....',
      '..ggwwwwwwww....',
      '..ggwwwwwwww....',
      '...gwwwwwww.....',
      '....kkkkkkk.....',
    ],
  }
  const LEGS = {
    stand: [
      '....gggggggg....',
      '....gggg.ggg....',
      '....ggg..ggg....',
      '....ggg..ggg....',
      '....ggg..ggg....',
      '....www..www....',
      '....www..wwww...',
      '...kkkk..kkkkk..',
    ],
    w0: [
      '....gggggggg....',
      '...gggg..gggg...',
      '...ggg....ggg...',
      '..ggg......ggg..',
      '..ggg.......ggg.',
      '.www........www.',
      '.www........wwww',
      'kkkk........kkkk',
    ],
    w1: [
      '....gggggggg....',
      '.....gggggg.....',
      '.....ggg.ggg....',
      '....ggg..ggg....',
      '...www...ggg....',
      '..www....www....',
      '.........wwww...',
      '.........kkkkk..',
    ],
    w3: [
      '....gggggggg....',
      '.....gggggg.....',
      '....ggg.ggg.....',
      '....ggg..ggg....',
      '....ggg...www...',
      '....www....www..',
      '...wwww.........',
      '..kkkkk.........',
    ],
  }
  const WINDUP_ARM = ['gw...', 'ww...', '.ww..', '.ww..', '..ww.', '..ww.', '...ww', '...ww', '....w']
  const ARMS_UP = ['ww.......ww', 'ww.......ww', 'ww.......ww', '.ww.....ww.', '.ww.....ww.', '..w.....w..', '..ww...ww..']
  const SIT_LEGS = ['...gggggggggggg.', '...gggggggggwwww', '..kkkkkkkkk.kkkk']
  const REST_LEGS = ['....kkkkkkkggg..', '...gggggggggggg.', '..ggg......wwww.', '.kkkk......kkkkk']
  const CROUCH = ['...gggggggggg...', '..www....gggww..', '.kkkk....kkkkk..']
  const DUN = {}
  function dun(key, rows) {
    DUN[key] = frame(rows, 7)
    DUN[key + '!'] = frame(rows, 7, true)
  }
  dun('stand', compose(HEAD, TORSO.stand, LEGS.stand))
  dun('w0', compose(HEAD, TORSO.a, LEGS.w0))
  dun('w1', compose(HEAD, TORSO.stand, LEGS.w1))
  dun('w2', compose(HEAD, TORSO.b, LEGS.w0))
  dun('w3', compose(HEAD, TORSO.stand, LEGS.w3))
  dun('windup', overlay(compose(HEAD, TORSO.plain, LEGS.w0), WINDUP_ARM, 0, 0))
  dun('throw', compose(HEAD, TORSO.throw, LEGS.w0))
  dun('duck', compose(HEAD, TORSO.stand.slice(0, 6), ['....kkkkkkk.....'], CROUCH))
  dun('hurt', overlay(compose(HEAD_OW, TORSO.plain, LEGS.w3), ARMS_UP, 2, 2))
  dun('dizzy', compose(HEAD_OW, TORSO.stand.slice(0, 7), ['....kkkkkkk.....'], SIT_LEGS))
  dun('rest', compose(HEAD_TIRED, TORSO.stand.slice(0, 7), REST_LEGS))
  dun('rest2', compose(HEAD_TIRED, TORSO.stand.slice(0, 6), ['...gwwkwwww.....'], REST_LEGS))
  dun('cheer', overlay(compose(HEAD, TORSO.plain, LEGS.stand), ARMS_UP, 2, 1))
  dun('pullup', compose(HEAD, TORSO.throw, LEGS.stand))
  dun('pulldown', compose(HEAD, TORSO.a, LEGS.w0))
  dun('carried', overlay(compose(HEAD_OW, TORSO.plain, LEGS.w1), ARMS_UP, 2, 1))
  dun('jump', overlay(compose(HEAD, TORSO.plain, LEGS.w3), ARMS_UP, 2, 3))

  // ---- the castle's residents -----------------------------------------------------
  const RAT = [
    frame(['..........ww...', '.....wwwwwwwww..', '...wwwwwwwwwkww.', '..wwwwwwwwwwwwwk', '.wwwwwwwwwwwww..', 'ww.w.w...w.w....'], 8),
    frame(['..........ww...', '.....wwwwwwwww..', '...wwwwwwwwwkww.', '..wwwwwwwwwwwwwk', 'wwwwwwwwwwwwww..', '...w.w..w.w.....'], 8),
  ]
  const RAT_DEAD = frame(['ww.w.w...w.w....', '.wwwwwwwwwwwww..', '..wwwwwwwwwwwwwk', '...wwwwwwwwwkww.', '.....wwwwwwwww..'], 8)
  const BAT = [
    frame(['w.............w', 'gw...........wg', 'ggw..w...w..wgg', '.gggwwwwwwwggg.', '..ggwwkwkwwgg..', '.....wwwww.....', '......w.w......'], 7),
    frame(['.....w...w.....', '.....wwwww.....', '..gggwkwkwggg..', '.ggggwwwwwgggg.', 'ggg..wwwww..ggg', 'gg....w.w....gg', 'w.............w'], 7),
  ]
  const MUTANT_ROWS = [
    '......wwww......',
    '.....wwwwww.....',
    '.....wwwkwww....',
    '.....wwwwwwk....',
    '......wkkww.....',
    '...wwwwwwww.....',
    '..wwwwwwwwwww...',
    '.wwwwkwwwwwwww..',
    '.wwwwkwwwwwwwww.',
    '.wwwkwwwwwwkwww.',
    '.ww.kwwwwwwk.ww.',
    '.ww..wwwwww..ww.',
    '.ww..wwwwww..ww.',
    '.ww..wwwwww..www',
    'www..gggggg..www',
    'ww...gggggg...k.',
    '.....gggggg.....',
    '.....ww..ww.....',
    '.....ww..ww.....',
    '....www..www....',
    '....ww....ww....',
    '....ww....ww....',
    '...www....www...',
    '..kkkk....kkkk..',
  ]
  const MUTANT_STEP = MUTANT_ROWS.slice(0, 17).concat(['.....ww...ww....', '....ww....ww....', '...www.....ww...', '...ww......ww...', '..ww.......ww...', '..www......www..', '.kkkk......kkkk.'])
  const MUTANT_CRACK = overlay(MUTANT_ROWS.map((r, i) => (i >= 9 && i <= 15 ? r.slice(0, 13) + '...' : r)), ['www', '.www', '..wwk', '...ww'], 12, 6)
  const MUTANT = {
    stand: frame(MUTANT_ROWS, 7),
    step: frame(MUTANT_STEP, 7),
    crack: frame(MUTANT_CRACK, 7),
    stun: frame(MUTANT_ROWS.map((r, i) => (i === 2 ? '.....wwkwkww....' : i === 4 ? '......wwkww.....' : r)), 7),
  }
  const HENCH_ROWS = [
    '...........ww...',
    '.....wwww..ww...',
    '....wwwwww.ww...',
    '...wwwwwwwwwww..',
    '...wkkkkkkw.w...',
    '....wwwwkww.w...',
    '....wwwwwwkw....',
    '.....wkkkw......',
    '...wwwwwwwww....',
    '..wGGGGGGGGGw...',
    '..wGGGGGGGGw....',
    '..wwGGGGGGGw....',
    '..wwGGGGGGGw....',
    '....kkkkkkkk....',
    '....wGGGGGGw....',
    '....gggg.ggg....',
    '....ggg..ggg....',
    '....ggg..ggg....',
    '....ggg..ggg....',
    '....ggg..ggg....',
    '....www..www....',
    '....www..www....',
    '....www..wwww...',
    '...kkkk..kkkkk..',
  ]
  const HENCH = {
    stand: frame(HENCH_ROWS, 7),
    step: frame(HENCH_ROWS.slice(0, 15).concat(['...gggg..gggg...', '...ggg....ggg...', '..ggg......ggg..', '..ggg.......ggg.', '.ggg........ggg.', '.www........www.', '.www........wwww', 'kkkk........kkkk']), 7),
  }
  const MACE = frame(['.w.w.', 'wgggw', '.ggg.', 'wgggw', '.w.w.'], 2)
  const GARG_PERCH = frame([
    '.......w..w.....',
    '.......wwww.....',
    '......wwwwww....',
    '..w...wwkwwkw...',
    '.ww...wwwwwwww..',
    'www..wwwkkkww...',
    'wgw.wwwwwww.....',
    'wggwwwwwwww.....',
    'wgggwwwwwwwww...',
    'wggggwwwwwwwww..',
    '.wgggwwwwwww.ww.',
    '..wggwwwwwww.w..',
    '...wwwwwwwww....',
    '...ww.www.ww....',
    '..www.www.www...',
    '..kkk.kkk.kkk...',
  ], 8)
  const GARG_FLY = [
    frame([
      'gg................gg',
      'ggg..............ggg',
      'gggg....w..w....gggg',
      '.gggg...wwww...gggg.',
      '..ggggwwwwwwwwgggg..',
      '...gggwwkwwkwwggg...',
      '....wwwwwwwwwwww....',
      '.....wwwkkkkwww.....',
      '......wwwwwwww......',
      '.......ww..ww.......',
      '......www..www......',
    ], 10),
    frame([
      '........w..w........',
      '........wwww........',
      '......wwwwwwww......',
      '....ggwwkwwkwwgg....',
      '..ggggwwwwwwwwgggg..',
      '.gggggwwkkkkwwggggg.',
      'gggg...wwwwww...gggg',
      'ggg....wwwwww....ggg',
      'gg.....ww..ww.....gg',
      'g.....www..www.....g',
      '....................',
    ], 10),
  ]

  const PEDESTAL = frame(['wwwwwwwwwwww', 'gggggggggggg', '.wgggggggggw', '..wgggggggw.', '..wGGGGGGGw.', '..wgggggggw.', '..wGGGGGGGw.', '..wgggggggw.', '.wwwwwwwwwww', 'wggggggggggggw'.slice(0, 12)], 6)
  const RUBBLE = [sprite(['w'], PAL1), sprite(['ww', 'wk'], PAL1), sprite(['.w', 'ww'], PAL1)]

  // ---- the knight, throne, lever, mugs -----------------------------------------
  const THRONE_ROWS = [
    '.wwww.................',
    'wwkkww................',
    'wkwwkw................',
    'wwkkww................',
    'wwwwww................',
    'wkkkkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkwwkw................',
    'wkkkkw................',
    'wwwwwwwwwwwwwwwwwwwww.',
    'wkkkkkkkkkkkkkkkkkkkkw',
    'wwwwwwwwwwwwwwwwwwwwww',
    'wkgkgkgkgkgkgkgkgkgkw.',
    'wwwwwwwwwwwwwwwwwwwww.',
    '.ww..............ww...',
    '.ww..............ww...',
    '.ww..............ww...',
    '.ww..............ww...',
    '.ww..............ww...',
    '.ww..............ww...',
    'wwww.............wwww.',
  ]
  const THRONE = frame(THRONE_ROWS, 0)
  const KNIGHT_ROWS = [
    '.....ww...........',
    '....wwww..........',
    '...ww.www.........',
    '....wwwwww........',
    '...wwwwwwww.......',
    '...wwkkkkkww......',
    '...wwwkwkwww......',
    '....wwwwwww.......',
    '..wwwkwwwkwww.....',
    '.wwwwkgggkwwww....',
    '.wwk.kgggk.kww....',
    '.ww..kgggk..ww....',
    '.wwk.kgggk.kww....',
    '..ww.kkkkk.ww.....',
    '....wwwwwwwwwww...',
    '....wkwwwwwkwwww..',
    '...........wwww...',
    '...........wkww...',
    '...........wwww...',
    '...........wkww...',
    '...........wwww...',
    '...........wkww...',
    '...........wwww...',
    '...........wkww...',
    '...........wwww...',
    '..........kwwwww..',
  ]
  const MUG_ROWS = ['wwww..', 'wkkwww', 'wkkw.w', 'wkkwww', 'wwww..']
  const KNIGHT = {
    sit: frame(KNIGHT_ROWS, 0),
    drink: frame(overlay(KNIGHT_ROWS.map((r, i) => (i >= 10 && i <= 12 ? r.slice(0, 11) + '.......' : r)), ['..wwww', '..wkkwww', '..wkkw.w', '..wwww..', '.ww.....', '.ww.....', 'ww......'], 7, 3), 0),
    wind: frame(overlay(KNIGHT_ROWS.map((r, i) => (i >= 9 && i <= 12 ? '..' + r.slice(2) : r)), ['wwww', 'wkkw', 'wkkw', '.ww.', '.ww.', '..ww', '..ww', '...ww'], 0, 1), 0),
    throw: frame(overlay(KNIGHT_ROWS.map((r, i) => (i >= 10 && i <= 12 ? r.slice(0, 11) + '.......' : r)), ['wwwww', '....ww'], 11, 8), 0),
  }
  const KNIGHT_SEAT = 17 // (unused by drawing; kept for reference) // throne row the knight sits on (his thigh row 14)
  const LEVER = {
    up: frame(['ww......', 'ww......', '.w......', '..w.....', '...w....', '....w...', '..wwww..', '.wkkkkw.', '.wwwwww.', 'wwwwwwww'], 4),
    down: frame(['........', '........', '........', '........', '......ww', '....wwww', '..wwww..', '.wkkkkw.', '.wwwwww.', 'wwwwwwww'], 4),
  }
  const MUG = frame(MUG_ROWS, 3)
  const ROCK = sprite(['.w.', 'www', 'ww.'], PAL1)
  const STAR = sprite(['.w.', 'www', '.w.'], PAL1)
  const SHARD = sprite(['w'], PAL1)
  const FOAM = sprite(['w'], { w: '#e5a647' })

  // ---- the castle wall (faint, built per width) ----------------------------------------
  function buildWall(s) {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.ceil(s.W))
    c.height = H
    const x = c.getContext('2d')
    x.fillStyle = 'rgba(244,242,234,0.045)'
    for (let row = 0, y = H - 6; y > 0; row++, y -= 6) {
      x.fillRect(0, y, s.W, 1)
      for (let bx = (row % 2) * 9; bx < s.W; bx += 18) x.fillRect(bx, y - 5, 1, 5)
    }
    // floor: a dithered strip
    x.fillStyle = 'rgba(244,242,234,0.10)'
    for (let fx = 0; fx < s.W; fx += 2) x.fillRect(fx + ((fx / 2) % 2), H - 1, 1, 1)
    // a few torches in sconces
    for (let tx = 70; tx < s.W - 30; tx += 260) {
      x.fillStyle = 'rgba(244,242,234,0.22)'
      x.fillRect(tx, 12, 3, 1)
      x.fillRect(tx + 1, 13, 1, 4)
      x.fillStyle = 'rgba(229,166,71,0.55)'
      x.fillRect(tx + 1, 9, 1, 3)
      x.fillRect(tx, 10, 3, 1)
    }
    s.data.wall = c
  }

  function openSpot(s, x, hw) {
    const blocks = s.fix.map((f) => [f.x - 4, f.x + f.w + 4])
    const ok = (c) => c - hw >= 4 && c + hw <= s.W - 4 && blocks.every(([a, b]) => c + hw <= a || c - hw >= b)
    for (let d = 0; d < s.W; d += 3) {
      if (ok(x - d)) return x - d
      if (ok(x + d)) return x + d
    }
    return clamp(x, hw + 4, s.W - hw - 4)
  }
  /** Short lines and sound words; a second line nearby moves aside. */
  function say(s, text, x) {
    const d = s.data
    const now = NOW()
    const w = text.length * 4.3 + 6
    x = clamp(x, w / 2, s.W - w / 2)
    const prev = d.lastSay
    if (prev && now < prev.until && Math.abs(prev.x - x) < (prev.w + w) / 2) {
      const right = x >= prev.x ? 1 : -1
      let nx = prev.x + right * ((prev.w + w) / 2 + 2)
      if (nx + w / 2 > s.W || nx - w / 2 < 0) nx = prev.x - right * ((prev.w + w) / 2 + 2)
      x = nx
    }
    d.lastSay = { x, w, until: now + 1300 }
    s.say(text, clamp(x, 14, s.W - 14), 1, { color: '#f4f2ea', life: 1.4 })
  }

  // ---- projectiles ---------------------------------------------------------------
  class Rock {
    constructor(s, x, y, vx, vy) {
      Object.assign(this, { s, x, y, vx, vy })
      this.z = 7
    }
    update(dt, now, s) {
      this.vy += 260 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      for (const a of s.actors) {
        if (!a.foe || a.dead || !a.alive || !a.box) continue
        const b = a.box()
        if (this.x >= b[0] && this.x <= b[2] && this.y >= b[1] && this.y <= b[3]) {
          this.dead = true
          a.struck(this, now)
          return FAST
        }
      }
      if (this.y >= FLOOR - 1 || this.x < -6 || this.x > s.W + 6) {
        this.dead = true
        if (this.y >= FLOOR - 1) for (let i = 0; i < 3; i++) s.particle({ img: SHARD, x: this.x, y: FLOOR - 2, vx: rand(-25, 25), vy: rand(-40, -15), g: 200, life: 0.35 })
      }
      return FAST
    }
    draw(c) {
      c.drawImage(ROCK, Math.round(this.x) - 1, Math.round(this.y) - 1)
    }
  }
  class Mug {
    constructor(s, x, y, tx, ty, owner) {
      this.s = s
      this.x = x
      this.y = y
      const T = clamp(Math.abs(tx - x) / 110, 0.45, 1.2)
      this.vx = (tx - x) / T
      this.vy = (ty - y - 0.5 * 240 * T * T) / T
      this.dir = this.vx > 0 ? 1 : -1
      this.z = 7
      this.spin = 0
      this.owner = owner
    }
    update(dt, now, s) {
      this.vy += 240 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      this.spin += dt
      const dn = s.data.hero
      if (dn.hittable(now) && Math.abs(this.x - dn.x) < 6 && this.y > FLOOR - dn.height() && this.y < FLOOR) {
        this.dead = true
        dn.hurt(now, this.x, false)
        this.shatter(s)
        return FAST
      }
      if (this.y >= FLOOR - 3 || this.x < -8 || this.x > s.W + 8) {
        this.dead = true
        this.shatter(s)
      }
      return FAST
    }
    shatter(s) {
      for (let i = 0; i < 5; i++) s.particle({ img: i < 2 ? FOAM : SHARD, x: this.x, y: Math.min(this.y, FLOOR - 3), vx: rand(-40, 40), vy: rand(-60, -20), g: 220, life: 0.5 })
    }
    draw(c) {
      const k = Math.floor(this.spin * 10) % 4
      const f = MUG
      // tumbling: alternate mirrored and upside-down placements
      if (k < 2) blit(c, f, this.x, k ? -1 : 1, this.y + 3)
      else blitRot(c, f, this.x, this.y, 3, 2, 1, Math.PI * (k === 2 ? 0.5 : 1))
    }
  }

  // ---- the hero -----------------------------------------------------------------
  const OW = ['Ow!', 'Ouch!', 'Oof!', 'Ow!']
  const GRUMBLE = ['Hey!', 'Hey!', 'Grr...', 'Ow ow ow']
  class Hero {
    constructor(s, x) {
      this.s = s
      this.x = x
      this.y = FLOOR
      this.vy = 0
      this.dir = 1
      this.state = 'stand'
      this.st = NOW()
      this.ft = 0
      this.goal = null
      this.z = 5
      this.hits = 0
      this.invulUntil = 0
      this.coolUntil = 0
      this.thinkAt = 0
      this.rocks = 0
      this.grabbable = true
    }
    get moving() {
      return this.state !== 'stand' && this.state !== 'rest'
    }
    set(st, now) {
      this.state = st
      this.st = now
    }
    height() {
      return this.state === 'duck' ? 17 : this.state === 'dizzy' || this.state === 'rest' ? 17 : 24
    }
    hittable(now) {
      return now > this.invulUntil && !['dizzy', 'carried', 'pull', 'cheer', 'rest'].includes(this.state)
    }
    hit(x, y) {
      return Math.abs(x - this.x) <= 7 && y >= this.y - this.height() - 1 && y <= this.y + 1
    }
    busyState() {
      return ['windup', 'throw', 'hurt', 'dizzy', 'carried', 'fall', 'pull', 'cheer', 'jump'].includes(this.state)
    }
    /** Click the hero: he throws a rock the way he faces (at whatever is there). */
    onClick() {
      const s = this.s
      const now = NOW()
      touched(s)
      if (this.state === 'rest') this.set('stand', now)
      const t = nearestFoe(s, this.x, this.dir, 260) || nearestFoe(s, this.x, 0, 260)
      if (t) this.throwAt(t, now, true)
      else this.throwAtPoint(this.x + this.dir * 70, FLOOR - 20, now, true)
    }
    onDblClick() {
      touched(this.s)
      this.jump(NOW())
    }
    grab() {
      const s = this.s
      touched(s)
      this.set('carried', NOW())
      this.goal = null
      say(s, pick(['Hey!', 'Put me down!', 'Whoa!']), this.x)
    }
    drag(p) {
      touched(this.s)
      this.x = clamp(p.x, 6, this.s.W - 6)
      this.y = clamp(p.y + 12, FLOOR - 8, FLOOR)
    }
    drop() {
      touched(this.s)
      this.set('fall', NOW())
      this.vy = 0
    }
    jump(now) {
      if (this.busyState() || this.y < FLOOR) return
      this.set('jump', now)
      // peaks with his hat just past the top of the bar
      this.vy = -112
      this.jvx = keyDir(this.s) * 40
    }
    // ---- keyboard: A/D walk, W jumps, S ducks, Space throws (W+Space lobs high) ----
    key(k, now) {
      const s = this.s
      if (this.state === 'rest') this.set('stand', now)
      if (k === 'up') this.jump(now)
      else if (k === 'down') {
        if (this.busyState() || this.y < FLOOR) return
        this.goal = null
        this.keyDuck = true
        this.set('duck', now)
      } else if (k === 'fire') {
        if (s.keys.has('up')) return this.throwAtPoint(this.x + this.dir * 45, FLOOR - 34, now, true)
        const t = nearestFoe(s, this.x, this.dir, 260)
        if (t) this.throwAt(t, now, true)
        else this.throwAtPoint(this.x + this.dir * 70, FLOOR - 20, now, true)
      }
    }
    throwAt(t, now, user = false) {
      // aim with a little lead
      const T = clamp(Math.abs(t.x - this.x) / 150, 0.2, 0.8)
      const lead = (t.vx || 0) * T
      const b = t.box ? t.box() : [t.x - 2, FLOOR - 10, t.x + 2, FLOOR]
      return this.throwAtPoint(t.x + lead, (b[1] + b[3]) / 2, now, user)
    }
    throwAtPoint(tx, ty, now, user = false) {
      if (this.busyState() && !(user && (this.state === 'throw' || this.state === 'windup'))) return false
      if (!user && now < this.coolUntil) return false
      if (this.state === 'windup') return false
      this.dir = tx >= this.x ? 1 : -1
      this.aim = { x: tx, y: ty }
      this.set('windup', now)
      this.goal = null
      this.s.poke()
      return true
    }
    release(now) {
      const s = this.s
      const hx = this.x + this.dir * 4
      const hy = this.y - 25
      const dx = this.aim.x - hx
      const T = clamp(Math.abs(dx) / 150, 0.2, 0.8)
      const vx = dx / T
      const vy = (this.aim.y - hy - 0.5 * 260 * T * T) / T
      s.spawn(new Rock(s, hx, hy, vx, vy))
      this.rocks++
      this.coolUntil = now + (s.busy ? 450 : 700)
      // an easter egg every so often: out of rocks, pick up a new bag
      if (this.rocks % 15 === 0) this.outOfRocks = now + 900
    }
    hurt(now, fromX, big) {
      if (!this.hittable(now)) return
      const s = this.s
      this.hits++
      this.invulUntil = now + 1600
      this.dir = fromX > this.x ? 1 : -1
      this.goal = null
      if (big || this.hits % 3 === 0) {
        this.set('dizzy', now)
        say(s, pick(OW), this.x)
        this.grumbleAt = now + 1700
      } else {
        this.set('hurt', now)
        say(s, pick(OW), this.x)
      }
    }
    walkTo(x) {
      this.goal = clamp(Math.round(x), 8, this.s.W - 8)
    }
    update(dt, now, s) {
      const d = s.data
      const t = now - this.st
      switch (this.state) {
        case 'carried':
          return FAST
        case 'fall':
          this.vy += 300 * dt
          this.y += this.vy * dt
          if (this.y >= FLOOR) {
            this.y = FLOOR
            const hard = this.vy > 60
            this.vy = 0
            if (hard) {
              this.set('dizzy', now)
              say(s, pick(OW), this.x)
              this.grumbleAt = now + 1500
            } else this.set('stand', now)
          }
          return FAST
        case 'jump':
          this.vy += 300 * dt
          this.y += this.vy * dt
          if (this.jvx) this.x = clamp(this.x + this.jvx * dt, 8, s.W - 8)
          if (this.y >= FLOOR) {
            this.jvx = 0
            this.y = FLOOR
            this.vy = 0
            this.set('stand', now)
          }
          return FAST
        case 'windup':
          if (t > 230) {
            this.set('throw', now)
            this.release(now)
          }
          return FAST
        case 'throw':
          if (t > 220) this.set('stand', now)
          return FAST
        case 'hurt':
          if (t < 300) this.x = clamp(this.x - this.dir * 30 * dt, 8, s.W - 8)
          if (t > 600) this.set('stand', now)
          return FAST
        case 'dizzy':
          if (this.grumbleAt && now > this.grumbleAt) {
            this.grumbleAt = 0
            say(s, pick(GRUMBLE), this.x)
          }
          if (t > 2400) this.set('stand', now)
          return FAST
        case 'duck':
          if (t > 650 && !(this.keyDuck && s.keys.has('down'))) {
            this.keyDuck = false
            this.set('stand', now)
          }
          return FAST
        case 'pull':
          if (t > 900) {
            this.set('cheer', now)
            d.knightRef?.topple(now)
          }
          return FAST
        case 'cheer':
          if (t > 2200) this.set('stand', now)
          return FAST
        case 'rest':
          // pant for a few seconds, then hold still
          return t < 3200 ? SLOW : Infinity
      }
      if (this.outOfRocks) {
        if (now < this.outOfRocks) return FAST
        this.outOfRocks = 0
        say(s, 'Out of rocks!', this.x)
        this.set('duck', now)
        return FAST
      }
      // stand / walk
      const kd = live(s, now) ? keyDir(s) : 0
      if (kd) {
        // A/D: you walk him
        this.goal = null
        this.dir = kd
        this.x = clamp(this.x + kd * 40 * dt, 8, s.W - 8)
        this.ft += dt * 1.2
        this.state = 'walk'
        return FAST
      }
      const user = engaged(s, now)
      if (!live(s, now)) {
        if (this.restX === undefined) this.restX = openSpot(s, this.x, 10)
        this.goal = this.restX
      } else this.restX = undefined
      if (live(s, now) && !user && now >= this.thinkAt) {
        this.think(now, s)
        if (this.state !== 'stand' && this.state !== 'walk') return FAST
      }
      if (user && s.cursor && this.goal === null) {
        // face the cursor while someone is playing (with a little dead zone)
        if (s.cursor.x > this.x + 6) this.dir = 1
        else if (s.cursor.x < this.x - 6) this.dir = -1
      }
      if (this.goal !== null) {
        const dd = this.goal - this.x
        if (Math.abs(dd) <= 1) {
          this.x = this.goal
          this.goal = null
          this.ft = 0
          this.state = 'stand'
        } else {
          this.dir = dd > 0 ? 1 : -1
          this.x += this.dir * Math.min(Math.abs(dd), (this.run ? 72 : 30) * dt)
          this.ft += dt * (this.run ? 1.5 : 1)
          this.state = 'walk'
          return FAST
        }
      }
      this.state = 'stand'
      if (!live(s, now)) {
        this.set('rest', now)
        return SLOW
      }
      if (user) return SLOW
      return Math.max(FAST, Math.min(SLOW, this.thinkAt - now))
    }
    /** The autopilot: deal with what's near, else go where the episode wants. */
    think(now, s) {
      const d = s.data
      this.thinkAt = now + 250
      this.run = false
      // a mug coming at head height: duck
      for (const m of s.actors) {
        if (!(m instanceof Mug) || m.dead) continue
        const eta = (this.x - m.x) / m.vx
        if (eta > 0 && eta < 0.45 && Math.random() < 0.6) {
          this.set('duck', now)
          this.goal = null
          return
        }
      }
      const kn = d.knightRef
      if (d.mode === 'done' && kn && kn.state !== 'toppled' && kn.state !== 'gone') {
        // the payoff: straight for the lever
        const lx = kn.leverX()
        this.run = true
        if (Math.abs(this.x - (lx + kn.side * 7)) > 2) this.walkTo(lx + kn.side * 7)
        else {
          this.dir = -kn.side
          this.set('pull', now)
          kn.lever = 'down'
        }
        return
      }
      // a mutant winding up his whip within reach: duck under the lash
      for (const f of s.actors) {
        if (f instanceof Foe && f.alive && f.state === 'attack' && now - f.st < 420 && Math.abs(f.x - this.x) < 40 && Math.random() < 0.55) {
          this.set('duck', now)
          this.goal = null
          return
        }
      }
      const t = nearestFoe(s, this.x, 0, 170)
      if (t && t !== kn) {
        const dist = Math.abs(t.x - this.x)
        if (dist < 20 && t.kind !== 'bat') {
          this.walkTo(this.x - Math.sign(t.x - this.x) * 34)
          return
        }
        this.goal = null
        if (!this.throwAt(t, now)) this.dir = t.x > this.x ? 1 : -1
        return
      }
      if (kn && kn.state === 'sit') {
        const lx = kn.leverX()
        const ep = d.ep
        // the knight's room: hang back and throw, then make a dash for the lever
        if (ep && ep.dashAt && now > ep.dashAt && !s.busy) {
          this.run = true
          if (Math.abs(this.x - (lx + kn.side * 7)) > 2) this.walkTo(lx + kn.side * 7)
          else {
            this.dir = -kn.side
            this.set('pull', now)
            kn.lever = 'down'
            ep.dashAt = 0
          }
          return
        }
        const want = lx + kn.side * rand(40, 80)
        if (this.goal === null && Math.abs(this.x - want) > 30 && Math.random() < 0.3) this.walkTo(want)
        else if (this.goal === null && now > this.coolUntil && Math.random() < 0.5) this.throwAt(kn, now)
        return
      }
      if (this.goal === null && d.ep && d.ep.goal !== undefined && Math.abs(d.ep.goal - this.x) > 6) this.walkTo(d.ep.goal)
    }
    draw(c, s) {
      const now = NOW()
      const inv = now < this.invulUntil && Math.floor(now / 120) % 2 === 0 && this.state !== 'dizzy'
      let k
      switch (this.state) {
        case 'walk':
          k = ['w0', 'w1', 'w2', 'w3'][Math.floor(this.ft * 8) % 4]
          break
        case 'windup':
        case 'throw':
        case 'hurt':
        case 'dizzy':
        case 'duck':
        case 'cheer':
        case 'carried':
        case 'jump':
          k = this.state
          break
        case 'fall':
          k = 'carried'
          break
        case 'pull':
          k = now - this.st < 450 ? 'pullup' : 'pulldown'
          break
        case 'rest':
          k = now - this.st < 3200 && Math.floor(now / 400) % 2 ? 'rest2' : 'rest'
          break
        default:
          k = 'stand'
      }
      if (this.state === 'cheer' && Math.floor(now / 250) % 2) k = 'stand'
      const f = DUN[inv ? k + '!' : k]
      blit(c, f, this.x, this.dir, this.y)
      if (this.state === 'dizzy') {
        // stars circling his head
        const a = now / 180
        for (let i = 0; i < 3; i++) {
          const ang = a + (i * Math.PI * 2) / 3
          c.drawImage(STAR, Math.round(this.x + Math.cos(ang) * 7) - 1, Math.round(FLOOR - 21 + Math.sin(ang) * 2) - 1)
        }
      }
      if (this.outOfRocks && now < this.outOfRocks) {
        c.drawImage(BUBBLE['?'], Math.round(this.x) - 2, FLOOR - 33)
      }
    }
  }

  // ---- foes ----------------------------------------------------------------------
  class Foe {
    constructor(s, kind, x) {
      this.s = s
      this.kind = kind
      this.x = x
      this.dir = x < s.W / 2 ? 1 : -1
      this.foe = true
      this.alive = true
      this.z = 4
      this.vx = 0
      this.st = NOW()
      this.state = 'enter'
      this.hp = { rat: 1, bat: 1, mutant: 3, hench: 3, gargoyle: 3 }[kind]
      this.ft = 0
      this.y = kind === 'bat' ? rand(4, 10) : FLOOR
      this.cool = NOW() + rand(800, 1600)
    }
    get moving() {
      return this.alive && this.state !== 'perch'
    }
    box() {
      const k = this.kind
      if (k === 'rat') return [this.x - 8, FLOOR - 7, this.x + 8, FLOOR]
      if (k === 'bat') return [this.x - 8, this.y - 2, this.x + 8, this.y + 8]
      if (k === 'gargoyle') return this.state === 'perch' ? [this.x - 8, this.baseY - 16, this.x + 8, this.baseY] : [this.x - 10, this.y - 2, this.x + 10, this.y + 11]
      return [this.x - 7, FLOOR - 24, this.x + 7, FLOOR]
    }
    hit(x, y) {
      if (!this.alive) return false
      const b = this.box()
      return x >= b[0] - 3 && x <= b[2] + 3 && y >= b[1] - 3 && y <= b[3] + 2
    }
    /** Click a foe: the hero turns and lets fly at it. */
    onClick() {
      const s = this.s
      const now = NOW()
      touched(s)
      const dn = s.data.hero
      if (dn.state === 'rest') dn.set('stand', now)
      if (this.kind === 'gargoyle' && this.state === 'perch') this.wake(now)
      dn.throwAt(this, now, true)
    }
    struck(rock, now) {
      const s = this.s
      if (this.kind === 'mutant' && this.state === 'stun') {
        s.particle({ img: STAR, x: this.x, y: FLOOR - 26, vy: -20, life: 0.4 })
      }
      this.hp--
      for (let i = 0; i < 4; i++) s.particle({ img: SHARD, x: rock.x, y: rock.y, vx: rand(-40, 40), vy: rand(-50, -10), g: 200, life: 0.35 })
      if (this.hp <= 0) return this.die(now, rock.vx > 0 ? 1 : -1)
      this.flashUntil = now + 200
      if (this.kind === 'mutant' || this.kind === 'hench') {
        this.state = 'stun'
        this.st = now
        this.x += (rock.vx > 0 ? 1 : -1) * 3
      }
      if (this.kind === 'gargoyle' && this.state === 'perch') this.wake(now)
    }
    wake(now) {
      this.state = 'fly'
      this.st = now
      this.y = this.baseY - 14
      say(this.s, 'SCREECH', this.x)
    }
    die(now, k) {
      this.alive = false
      this.state = 'die'
      this.st = now
      this.vx = k * 30
      this.vy = -60
      const s = this.s
      if (this.kind === 'gargoyle') {
        for (let i = 0; i < 14; i++) s.particle({ img: pick(RUBBLE), x: this.x + rand(-6, 6), y: (this.y || FLOOR) - rand(0, 10), vx: rand(-40, 40), vy: rand(-60, 0), g: 220, life: rand(0.5, 1) })
        this.dead = true
        say(s, 'CRUMBLE', this.x)
      } else if (this.kind === 'rat') say(s, 'squeak!', this.x)
    }
    leave() {
      if (!this.alive) return
      this.state = 'leave'
      this.dir = this.x < this.s.W / 2 ? -1 : 1
    }
    update(dt, now, s) {
      const dn = s.data.hero
      const t = now - this.st
      const isLive = live(s, now)
      if (this.state === 'die') {
        this.vy += 240 * dt
        this.x += this.vx * dt
        if (this.kind === 'bat') this.y += this.vy * dt
        if (t > 700) this.dead = true
        return FAST
      }
      if (!isLive && this.state !== 'leave' && this.state !== 'perch') this.leave()
      if (this.state === 'perch') return this.perchUpdate(now, s)
      if (this.state === 'leave') {
        const sp = this.kind === 'bat' || this.kind === 'gargoyle' ? 70 : this.kind === 'rat' ? 80 : 30
        this.x += this.dir * sp * dt
        this.ft += dt
        if (this.kind === 'bat' || this.kind === 'gargoyle') this.y -= 20 * dt
        if (this.x < -20 || this.x > s.W + 20 || this.y < -20) this.dead = true
        return FAST
      }
      this.ft += dt
      switch (this.kind) {
        case 'rat':
          return this.ratUpdate(dt, now, s, dn)
        case 'bat':
          return this.batUpdate(dt, now, s, dn)
        case 'gargoyle':
          return this.gargUpdate(dt, now, s, dn)
        default:
          return this.guardUpdate(dt, now, s, dn, t)
      }
    }
    ratUpdate(dt, now, s, dn) {
      // scurry back and forth across the floor, biting the hero's ankles;
      // a low cursor scares them off
      const cur = s.cursor
      if (cur && cur.y > FLOOR - 14 && Math.abs(cur.x - this.x) < 26 && now > (this.fleeCool || 0)) {
        this.fleeCool = now + 1500
        this.dir = cur.x > this.x ? -1 : 1
        this.dash = now + 700
      }
      if (this.state === 'enter') this.state = 'run'
      const sp = now < (this.dash || 0) ? 90 : 55
      this.vx = this.dir * sp
      this.x += this.vx * dt
      if ((this.x < 10 && this.dir < 0) || (this.x > s.W - 10 && this.dir > 0)) {
        this.dir = -this.dir
        this.laps = (this.laps || 0) + 1
        if (this.laps > 4) this.leave()
      }
      if (dn.hittable(now) && dn.state !== 'jump' && Math.abs(dn.x - this.x) < 6 && now > (this.biteCool || 0)) {
        this.biteCool = now + 2000
        dn.hurt(now, this.x, false)
        this.dir = -this.dir
      }
      return FAST
    }
    batUpdate(dt, now, s, dn) {
      // flutter about up top, then swoop: at the hero, or at the cursor if
      // someone is waving it about
      if (this.state === 'enter') {
        this.state = 'flutter'
        this.home = this.y
      }
      const cur = s.cursor && engaged(s, now) ? s.cursor : null
      if (this.state === 'flutter') {
        this.x += this.dir * 34 * dt
        this.y = this.home + Math.sin(now / 160) * 2
        if ((this.x < 12 && this.dir < 0) || (this.x > s.W - 12 && this.dir > 0)) this.dir = -this.dir
        const tgt = cur || { x: dn.x, y: FLOOR - 20 }
        if (now > this.cool && Math.abs(tgt.x - this.x) < 90) {
          this.state = 'swoop'
          this.st = now
          this.sx = this.x
          this.sy = this.y
          this.tx = tgt.x
          this.ty = clamp(tgt.y - 4, 2, FLOOR - 10)
          this.dir = tgt.x > this.x ? 1 : -1
        }
      } else if (this.state === 'swoop') {
        const k = Math.min(1, (now - this.st) / 900)
        this.x = this.sx + (this.tx - this.sx) * k + this.dir * Math.sin(k * Math.PI) * 10
        this.y = this.sy + (this.ty - this.sy) * Math.sin(k * Math.PI)
        this.vx = this.dir * 40
        if (dn.hittable(now) && Math.abs(dn.x - this.x) < 7 && this.y > FLOOR - dn.height() - 4) {
          dn.hurt(now, this.x, false)
        }
        if (k >= 1) {
          this.state = 'flutter'
          this.cool = now + rand(1800, 3500)
          this.x = clamp(this.x, 12, s.W - 12)
          this.y = this.home
          this.passes = (this.passes || 0) + 1
          if (this.passes > 4) this.leave()
        }
      }
      return FAST
    }
    perchUpdate(now, s) {
      const dn = s.data.hero
      if (live(s, now) && !engaged(s, now) && Math.abs(dn.x - this.x) < 80 && now > this.st + 1200) this.wake(now)
      return live(s, now) ? SLOW : Infinity
    }
    gargUpdate(dt, now, s, dn) {
      // circle up high, then dive at the hero
      if (this.state === 'fly') {
        this.x += this.dir * 40 * dt
        this.y = 6 + Math.sin(now / 220) * 2
        if ((this.x < 16 && this.dir < 0) || (this.x > s.W - 16 && this.dir > 0)) this.dir = -this.dir
        if (now > this.cool && Math.abs(dn.x - this.x) < 100) {
          this.state = 'dive'
          this.st = now
          this.sx = this.x
          this.sy = this.y
          this.tx = dn.x + (dn.x > this.x ? 20 : -20)
          this.dir = dn.x > this.x ? 1 : -1
        }
      } else if (this.state === 'dive') {
        const k = Math.min(1, (now - this.st) / 1100)
        this.x = this.sx + (this.tx - this.sx) * k
        this.y = this.sy + (FLOOR - 16 - this.sy) * Math.sin(k * Math.PI)
        this.vx = this.dir * 50
        if (dn.hittable(now) && Math.abs(dn.x - this.x) < 8 && this.y > FLOOR - 30) dn.hurt(now, this.x, true)
        if (k >= 1) {
          this.state = 'fly'
          this.cool = now + rand(2000, 3500)
        }
      }
      return FAST
    }
    guardUpdate(dt, now, s, dn, t) {
      const reach = this.kind === 'mutant' ? 34 : 18
      if (this.state === 'stun') {
        if (t > 2200) {
          this.state = 'walk'
          this.st = now
        }
        return FAST
      }
      if (this.state === 'attack') {
        // mutant: whip back, crack; hench: mace whirls faster, then a step and swing
        if (t > 450 && !this.struckHero) {
          this.struckHero = true
          if (this.kind === 'mutant') say(s, 'CRACK!', this.x + this.dir * 20)
          if (dn.hittable(now) && Math.abs(dn.x - this.x) <= reach + 4 && (dn.x - this.x) * this.dir > 0 && dn.state !== 'duck') dn.hurt(now, this.x, this.kind === 'hench')
        }
        if (t > 900) {
          this.state = 'walk'
          this.st = now
          this.cool = now + rand(1500, 2600)
        }
        return FAST
      }
      if (this.state === 'enter') this.state = 'walk'
      const dx = dn.x - this.x
      const want = Math.abs(dx) > reach - 4
      if (Math.abs(dx) > 6) this.dir = dx > 0 ? 1 : -1
      if (want) {
        this.vx = this.dir * (this.kind === 'mutant' ? 18 : 22)
        this.x += this.vx * dt
      } else this.vx = 0
      if (!want && now > this.cool && dn.state !== 'dizzy') {
        this.state = 'attack'
        this.st = now
        this.struckHero = false
      }
      this.time = (this.time || 0) + dt
      if (this.time > 30) this.leave()
      return FAST
    }
    draw(c) {
      const now = NOW()
      const inv = this.flashUntil && now < this.flashUntil
      const k = this.kind
      const t = now - this.st
      if (k === 'rat') {
        if (this.state === 'die') blit(c, RAT_DEAD, this.x, this.dir, FLOOR - Math.max(0, 10 - t / 40))
        else blit(c, RAT[Math.floor(this.ft * 10) % 2], this.x, this.dir)
        return
      }
      if (k === 'bat') {
        if (this.state === 'die') blitRot(c, BAT[0], this.x, this.y + 3, 7, 3, 1, t / 80)
        else blit(c, BAT[Math.floor(now / 110) % 2], this.x, this.dir, this.y + 7)
        return
      }
      if (k === 'gargoyle') {
        if (this.state === 'perch') {
          blit(c, PEDESTAL, this.x, 1)
          blit(c, GARG_PERCH, this.x, this.dir, this.baseY)
          // eyes glint when the cursor is near
          if (this.s.cursor && Math.abs(this.s.cursor.x - this.x) < 50 && Math.floor(now / 300) % 2) {
            c.fillStyle = '#f4f2ea'
            c.fillRect(Math.round(this.x + this.dir * 1), this.baseY - 13, 1, 1)
          }
        } else {
          if (this.pedestal !== false) blit(c, PEDESTAL, this.px, 1)
          blit(c, GARG_FLY[Math.floor(now / 130) % 2], this.x, this.dir, this.y + 11)
        }
        return
      }
      const set = k === 'mutant' ? MUTANT : HENCH
      let f
      if (this.state === 'die') {
        blitRot(c, set.stand, this.x, FLOOR, 7, 24, this.dir, -this.dir * Math.min(1, t / 300) * Math.PI * 0.5)
        return
      }
      if (this.state === 'stun') f = set === MUTANT ? MUTANT.stun : HENCH.stand
      else if (this.state === 'attack' && k === 'mutant') f = t < 450 ? MUTANT.stand : MUTANT.crack
      else if (this.vx) f = Math.floor(this.ft * 5) % 2 ? set.step : set.stand
      else f = set.stand
      blit(c, f, this.x, this.dir)
      if (inv) {
        c.fillStyle = 'rgba(0,0,0,0.5)'
        c.fillRect(Math.round(this.x - 7), FLOOR - 24, 15, 24)
      }
      if (k === 'mutant') this.drawWhip(c, now, t)
      else this.drawMace(c, now, t)
      if (this.state === 'stun') {
        const a = now / 170
        for (let i = 0; i < 2; i++) c.drawImage(STAR, Math.round(this.x + Math.cos(a + i * Math.PI) * 6) - 1, FLOOR - 27 + Math.round(Math.sin(a + i * Math.PI)))
      }
    }
    drawWhip(c, now, t) {
      c.fillStyle = '#f4f2ea'
      const hx = Math.round(this.x + this.dir * 7)
      if (this.state === 'attack' && t >= 450 && t < 700) {
        // the crack: a long wavy lash with a snap at the end
        const len = 30
        for (let i = 0; i < len; i++) c.fillRect(hx + this.dir * i, FLOOR - 15 + Math.round(Math.sin(i * 0.5 + t / 40) * (i / 12)), 1, 1)
        const ex = hx + this.dir * len
        c.fillRect(ex - 1, FLOOR - 17, 3, 1)
        c.fillRect(ex, FLOOR - 18, 1, 3)
      } else if (this.state === 'attack') {
        // whip drawn back over the shoulder
        for (let i = 0; i < 12; i++) c.fillRect(hx - this.dir * i, FLOOR - 15 - Math.round(i * 0.9), 1, 1)
      } else {
        // coiled at his side
        for (let i = 0; i < 8; i++) c.fillRect(hx + (i % 2), FLOOR - 14 + i, 1, 1)
      }
    }
    drawMace(c, now, t) {
      // the mace whirls on its chain over the henchman's head
      const speed = this.state === 'attack' ? 70 : 140
      const a = now / speed
      const cx = this.x + this.dir * 5
      const cy = FLOOR - 26
      let mx
      let my
      if (this.state === 'attack' && t > 300 && t < 650) {
        mx = this.x + this.dir * 16
        my = FLOOR - 12
      } else {
        mx = cx + Math.cos(a) * 9
        my = cy + Math.sin(a) * 3
      }
      c.fillStyle = '#f4f2ea'
      for (let i = 1; i < 4; i++) c.fillRect(Math.round(cx + ((mx - cx) * i) / 4), Math.round(cy + 2 + ((my - cy - 2) * i) / 4), 1, 1)
      blit(c, MACE, mx, 1, my + 3)
    }
  }

  class Knight {
    constructor(s, side) {
      this.s = s
      this.side = side // which way he faces (toward the room)
      this.foe = true
      this.alive = true
      this.kind = 'knight'
      this.z = 2
      this.state = 'sit'
      this.st = NOW()
      this.lever = 'up'
      this.place()
      this.next = NOW() + rand(1200, 2200)
      this.fade = 0
    }
    place() {
      const s = this.s
      // the throne stands in an open stretch toward one end
      const want = this.side > 0 ? 30 : s.W - 30
      this.cx = openSpot(s, want, 22)
      this.x = this.cx
    }
    leverX() {
      return this.cx + this.side * 26
    }
    throneLeft() {
      // the throne's back is behind the knight
      return this.side > 0 ? this.cx - 11 : this.cx - 11
    }
    get moving() {
      return this.state !== 'sit' || this.fade < 1
    }
    box() {
      return [this.cx - 9, FLOOR - 32, this.cx + 9, FLOOR - 8]
    }
    hit(x, y) {
      if (this.state === 'gone') return false
      return Math.abs(x - this.cx) <= 12 && y >= FLOOR - 33 && y <= FLOOR
    }
    hitLever(x, y) {
      return Math.abs(x - this.leverX()) <= 6 && y >= FLOOR - 13
    }
    onClick(p) {
      const s = this.s
      const now = NOW()
      touched(s)
      const dn = s.data.hero
      if (dn.state === 'rest') dn.set('stand', now)
      if (p && this.hitLever(p.x, p.y)) {
        // the lever: the hero runs over and pulls it
        if (this.state === 'sit') {
          s.data.leverRun = true
          dn.run = true
          dn.walkTo(this.leverX() + this.side * 7)
        }
        return
      }
      if (this.state !== 'sit') return
      // poke the knight: he answers with a mug, or takes a long drink
      dn.throwAt(this, now, true)
      this.next = now + 600
    }
    struck(rock, now) {
      say(this.s, 'CLANK', this.cx)
      for (let i = 0; i < 4; i++) this.s.particle({ img: SHARD, x: rock.x, y: rock.y, vx: rand(-40, 40), vy: rand(-60, -20), g: 200, life: 0.4 })
      if (Math.random() < 0.5) this.taunt = now + 400
    }
    topple(now) {
      if (this.state !== 'sit') return
      this.state = 'topple'
      this.st = now
      this.lever = 'down'
      this.alive = false
      say(this.s, 'AAARGH!', this.cx)
    }
    update(dt, now, s) {
      const t = now - this.st
      if (this.fade < 1) {
        this.fade = Math.min(1, this.fade + dt * 1.6)
        return FAST
      }
      if (this.state === 'leaving') {
        this.fade2 = (this.fade2 || 0) + dt * 1.6
        if (this.fade2 >= 1) {
          this.dead = true
          if (s.data.knightRef === this) s.data.knightRef = null
        }
        return FAST
      }
      if (this.state === 'topple') {
        if (t > 2600) {
          this.state = 'toppled'
          this.st = now
        }
        return FAST
      }
      if (this.state === 'toppled') {
        if (!live(s, now)) return Infinity
        if (t > 7000 && s.data.mode !== 'done') {
          this.state = 'leaving'
          this.fade2 = 0
          return FAST
        }
        return Math.max(SLOW, 7000 - t)
      }
      if (this.state !== 'sit') return Infinity
      if (!live(s, now)) {
        this.act = null
        return Infinity
      }
      const dn = s.data.hero
      if (this.act && now > this.actUntil) {
        if (this.act === 'wind') {
          // hurl the mug at the hero (or at a lingering cursor)
          const cur = s.cursor && engaged(s, now) && Math.abs(s.cursor.x - this.cx) < 120 && Math.random() < 0.3 ? s.cursor : null
          const tx = cur ? cur.x : dn.x + (dn.vx || 0)
          const ty = cur ? cur.y : FLOOR - (dn.state === 'duck' ? 10 : 18)
          s.spawn(new Mug(s, this.cx + this.side * 4, FLOOR - 27, tx, ty, this))
          this.act = 'throw'
          this.actUntil = now + 300
        } else this.act = null
      }
      if (!this.act && now > this.next && s.data.mode !== 'done') {
        const busy = s.busy
        if (this.taunt && now > this.taunt) {
          this.taunt = 0
          say(s, pick(['Hah!', 'Ha ha ha!']), this.cx)
        }
        if (Math.random() < (busy ? 0.75 : 0.55) && Math.abs(dn.x - this.cx) < 220) {
          this.act = 'wind'
          this.actUntil = now + 450
          this.next = now + (busy ? rand(1300, 2200) : rand(2200, 3600))
        } else {
          this.act = 'drink'
          this.actUntil = now + 1400
          this.next = now + rand(2200, 3200)
          if (Math.random() < 0.4) say(s, pick(['*glug*', '*hic*', 'Ahh.']), this.cx)
        }
      }
      return this.act ? FAST : Math.max(FAST, Math.min(SLOW * 2, this.next - now))
    }
    draw(c) {
      const now = NOW()
      const t = now - this.st
      const alpha = this.state === 'leaving' ? 1 - (this.fade2 || 0) : this.fade
      if (alpha < 1) c.globalAlpha = Math.max(0, alpha)
      const d = this.side
      // throne: its back on the far side from the room
      const backX = this.cx - d * 10 // throne back column
      const thronePivotX = this.cx - d * 11
      let tilt = 0
      if (this.state === 'topple') tilt = Math.min(1, t / 700)
      if (this.state === 'toppled') tilt = 1
      const ang = -d * tilt * Math.PI * 0.5
      // the throne (drawn so its back is toward the end of the bar)
      const tf = THRONE
      if (tilt === 0) {
        if (d > 0) c.drawImage(tf.sp[1], Math.round(backX - 1) - 1, FLOOR - tf.h - 1)
        else c.drawImage(tf.sp[-1], Math.round(backX - tf.w + 2) - 1, FLOOR - tf.h - 1)
      } else {
        // tipping over backward about the bottom of its back
        if (d > 0) blitRot(c, tf, thronePivotX, FLOOR, 0, tf.h, 1, ang)
        else blitRot(c, tf, thronePivotX + 1, FLOOR, tf.w - 1, tf.h, -1, ang)
      }
      // the knight
      const seatY = FLOOR - tf.h + KNIGHT_SEAT
      const kx0 = d > 0 ? backX + 4 : backX - KNIGHT.sit.w - 3
      if (this.state === 'sit' || this.state === 'leaving') {
        let f = KNIGHT.sit
        if (this.act === 'drink') f = KNIGHT.drink
        else if (this.act === 'wind') f = KNIGHT.wind
        else if (this.act === 'throw') f = KNIGHT.throw
        c.drawImage(f.sp[d], Math.round(kx0) - 1, FLOOR - f.h - 1)
      } else if (this.state === 'topple' && t < 2600) {
        // he goes over backward, tumbling head over heels off the end
        const k = clamp((t - 250) / 2300, 0, 1)
        const px = this.cx - d * (6 + k * 60)
        const py = seatY - 6 - Math.sin(Math.min(1, k * 2.5) * Math.PI) * 10 + (k > 0.4 ? (k - 0.4) * 30 : 0)
        const f = KNIGHT.sit
        if (k > 0.75) c.globalAlpha = Math.max(0, alpha * (1 - k) * 4)
        blitRot(c, f, px, Math.min(py, FLOOR - 8), 8, 12, d, -d * (0.4 + k * 9))
        c.globalAlpha = alpha < 1 ? Math.max(0, alpha) : 1
      }
      // the lever
      if (this.state !== 'leaving' || alpha > 0) blit(c, this.lever === 'up' ? LEVER.up : LEVER.down, this.leverX(), d)
      c.globalAlpha = 1
    }
  }

  // the knight's lever is clickable on its own
  class LeverHandle {
    constructor(k) {
      this.k = k
      this.prop = true
      this.z = 3
    }
    hit(x, y) {
      return !this.k.dead && this.k.state === 'sit' && this.k.hitLever(x, y)
    }
    onClick(p) {
      this.k.onClick(p)
    }
    update() {
      if (this.k.dead) this.dead = true
      return Infinity
    }
    draw() {}
  }

  function nearestFoe(s, x, dir, range) {
    let best = null
    for (const a of s.actors) {
      if (!(a instanceof Foe) || !a.alive || a.dead || a.state === 'leave' || a.state === 'perch') continue
      if (a.x < 2 || a.x > s.W - 2) continue
      const dx = a.x - x
      if (dir && dx * dir < 0) continue
      if (Math.abs(dx) > range) continue
      if (!best || Math.abs(dx) < Math.abs(best.x - x)) best = a
    }
    return best
  }
  const foes = (s) => s.actors.filter((a) => a instanceof Foe && !a.dead)

  // ---- episodes ---------------------------------------------------------------------
  function spawnKnight(s) {
    const d = s.data
    if (d.knightRef && !d.knightRef.dead && d.knightRef.state === 'sit') return d.knightRef
    if (d.knightRef) d.knightRef.dead = true
    const side = d.hero.x < s.W / 2 ? -1 : 1
    const k = new Knight(s, side)
    // he faces the room: the throne goes on the far side from the hero
    s.spawn(k)
    s.spawn(new LeverHandle(k))
    d.knightRef = k
    return k
  }
  function clearKnight(s) {
    const k = s.data.knightRef
    if (k && !k.dead && k.state !== 'leaving') {
      k.state = 'leaving'
      k.fade2 = 0
    }
  }
  function nextEpisode(s, now) {
    const d = s.data
    if (!d.bag.length) {
      d.bag = ['rats', 'guards', 'gargoyle', 'knight', 'rats'].sort(() => Math.random() - 0.5)
      if (d.bag[0] === d.lastEp) d.bag.push(d.bag.shift())
    }
    const k = d.bag.shift()
    d.lastEp = k
    const ep = (d.ep = { k, t0: now, until: now + 32000, spawned: 0, nextAt: now + 600 })
    const dn = d.hero
    if (k === 'rats') ep.goal = openSpot(s, s.W * rand(0.3, 0.7), 8)
    if (k === 'guards') ep.goal = openSpot(s, dn.x < s.W / 2 ? s.W * 0.3 : s.W * 0.7, 8)
    if (k === 'gargoyle') {
      const side = dn.x < s.W / 2 ? 1 : -1
      const g = new Foe(s, 'gargoyle', openSpot(s, side > 0 ? s.W - 40 : 40, 8))
      g.state = 'perch'
      g.baseY = FLOOR - 9
      g.px = g.x
      g.dir = -side
      g.st = now
      s.spawn(g)
      ep.garg = g
      ep.goal = g.x - side * 60
    }
    if (k === 'knight') {
      const kn = spawnKnight(s)
      ep.goal = kn.leverX() + kn.side * 60
      ep.dashAt = Math.random() < 0.45 ? now + rand(9000, 14000) : 0
    }
  }
  function runEpisode(s, ep, now) {
    const d = s.data
    const fs = foes(s)
    const W = s.W
    if (ep.k === 'rats') {
      if (ep.spawned < 5 && now > ep.nextAt) {
        ep.nextAt = now + rand(1500, 3500)
        ep.spawned++
        const left = Math.random() < 0.5
        if (Math.random() < 0.55) s.spawn(new Foe(s, 'rat', left ? -8 : W + 8))
        else s.spawn(new Foe(s, 'bat', left ? -8 : W + 8))
      }
      if ((ep.spawned >= 5 && !fs.length) || now > ep.until) endEpisode(s, now)
    } else if (ep.k === 'guards') {
      if (ep.spawned === 0 || (ep.spawned === 1 && !fs.some((f) => f.alive && f.kind === 'mutant') && now > ep.nextAt) || (ep.spawned === 1 && now > ep.t0 + 14000)) {
        const side = d.hero.x < W / 2 ? 1 : -1
        s.spawn(new Foe(s, ep.spawned === 0 ? 'mutant' : 'hench', side > 0 ? W + 10 : -10))
        ep.spawned++
        ep.nextAt = now + 2000
      }
      if ((ep.spawned >= 2 && !fs.length) || now > ep.until) endEpisode(s, now)
    } else if (ep.k === 'gargoyle') {
      if (ep.garg.dead || now > ep.until) endEpisode(s, now)
    } else if (ep.k === 'knight') {
      const kn = d.knightRef
      if (!kn || kn.state === 'toppled' || now > ep.until) endEpisode(s, now)
    }
  }
  function endEpisode(s, now) {
    const d = s.data
    const ep = d.ep
    d.ep = null
    d.epAt = now + rand(2500, 5000)
    for (const f of foes(s)) if (f.alive) f.leave()
    if (ep && ep.k === 'knight') {
      const kn = d.knightRef
      if (kn && kn.state === 'sit') {
        // he wins this round: the hero beats a retreat
        say(s, pick(['I\'ll be back!', 'Hmph.']), d.hero.x)
      }
      clearKnight(s)
    }
    d.hero.walkTo(openSpot(s, rand(40, s.W - 40), 8))
  }

  // ---- concept -----------------------------------------------------------------------
  function setup(s) {
    const d = s.data
    d.W = s.W
    d.hero = new Hero(s, openSpot(s, Math.round(s.W * 0.35), 8))
    s.actors.push(d.hero)
    d.mode = 'live'
    d.ep = null
    d.bag = []
    d.epAt = NOW() + 1500
    d.userUntil = 0
    buildWall(s)
  }

  function update(s, dt, now) {
    const d = s.data
    const dn = d.hero
    let wait = Infinity
    if (s.cursor && engaged(s, now)) wait = SLOW
    if (!live(s, now)) {
      if (d.mode !== 'rest') {
        d.mode = 'rest'
        d.ep = null
        d.leverRun = false
        for (const f of foes(s)) f.leave()
        for (const a of s.actors) if (a instanceof Rock || a instanceof Mug) a.dead = true
        // a toppled throne is cleared away; a seated knight stays put
        const kn = d.knightRef
        if (kn && kn.state !== 'sit') clearKnight(s)
      }
      return wait
    }
    if (d.mode === 'rest') {
      d.mode = 'live'
      d.epAt = now + 1500
      if (dn.state === 'rest') dn.set('stand', now)
    }
    // the user sent the hero to the lever
    const kn = d.knightRef
    if (d.leverRun && kn && kn.state === 'sit' && dn.goal === null && !dn.busyState()) {
      d.leverRun = false
      if (Math.abs(dn.x - (kn.leverX() + kn.side * 7)) < 4) {
        dn.dir = -kn.side
        dn.set('pull', now)
        kn.lever = 'down'
      }
    }
    if (d.mode === 'done') {
      if (!kn || kn.state === 'toppled' || kn.state === 'gone' || now > d.doneUntil) {
        if (now > d.doneUntil) {
          d.mode = 'live'
          d.epAt = now + 4000
        }
      }
      return FAST
    }
    if (s.busy) {
      // the knight's hall, with the odd rat or bat for company
      if (!d.knightRef || d.knightRef.state === 'leaving' || d.knightRef.dead) {
        d.ep = null
        const k = spawnKnight(s)
        d.ep = { k: 'knight', t0: now, until: Infinity, goal: k.leverX() + k.side * 60, spawned: 0, nextAt: now + 5000 }
      }
      const ep = d.ep
      if (ep && now > ep.nextAt && foes(s).length < 2) {
        ep.nextAt = now + rand(6000, 11000)
        const left = d.knightRef.side < 0
        s.spawn(new Foe(s, Math.random() < 0.5 ? 'rat' : 'bat', left ? -8 : s.W + 8))
      }
      return FAST
    }
    if (!engaged(s, now)) {
      if (!d.ep && now > d.epAt) nextEpisode(s, now)
      else if (d.ep) runEpisode(s, d.ep, now)
    }
    return Math.min(wait, d.ep ? SLOW : Math.max(SLOW, d.epAt - now))
  }

  registerConcept({
    key: 'monochromecastle',
    title: 'Monochrome castle',
    blurb:
      'Black and white, in a 1-bit look. The hero works through the castle on his own, throwing rocks overhand: rats scurry along the floor and nip his ankles, bats flutter and swoop, a whip-cracking mutant and a henchman with a whirling mace come at him, and the gargoyle wakes on its pedestal and dives. When he is hit he says Ow! and stumbles; a bad one knocks him down with stars round his head, and he gets up grumbling. In the knight\'s hall the knight drinks and hurls beer mugs while the hero ducks and looks for a chance at the lever. <b>Click the hero</b> to throw the way he faces, <b>click an enemy</b> to throw at it, <b>click the lever</b> to send him to pull it, <b>drag the hero</b> to carry him (dropping him from a height hurts), double-click him to jump. While you play he faces your cursor, bats go for the cursor, and rats run from it. While the agent works it is the knight on his throne; on done the hero pulls the lever and the throne topples; at rest he sits and catches his breath.',
    setup,
    update,
    onBusy(s) {
      const d = s.data
      for (const f of foes(s)) if (f.kind !== 'rat' && f.kind !== 'bat') f.leave()
      d.ep = null
      clearKnight(s)
      d.knightRef = null
    },
    onDone(s) {
      const d = s.data
      const now = NOW()
      for (const f of foes(s)) f.leave()
      let kn = d.knightRef
      if (!kn || kn.state !== 'sit') kn = spawnKnight(s)
      d.ep = { k: 'knight', t0: now, until: now + 14000, goal: kn.leverX() }
      d.mode = 'done'
      d.doneUntil = now + 14000
      const dn = d.hero
      if (['rest', 'carried'].includes(dn.state)) dn.set('stand', now)
      dn.thinkAt = 0
    },
    onNap(s) {
      for (const a of s.actors) if (a instanceof Rock || a instanceof Mug) a.dead = true
    },
    relayout(s) {
      const d = s.data
      const k = d.W ? s.W / d.W : 1
      d.W = s.W
      buildWall(s)
      const dn = d.hero
      dn.x = Math.round(clamp(dn.x * k, 8, s.W - 8))
      dn.goal = null
      dn.restX = undefined
      for (const a of s.actors) {
        if (a instanceof Foe) {
          a.x = clamp(a.x * k, 4, s.W - 4)
          if (a.px !== undefined) a.px = a.x
        } else if (a instanceof Knight) a.place()
      }
      s.poke()
    },
    onKey(s, k, down) {
      if (down && s.data.hero) s.data.hero.key(k, NOW())
    },
    drawBehind(s, c) {
      if (s.data.wall) c.drawImage(s.data.wall, 0, 0)
    },
  })
})()
