;(() => {
  // Power-suit explorer, big version. An armoured bounty hunter patrols the
  // whole bar: crawlers creep along the floor (she curls into a ball and bombs
  // them, or spin-attacks through), flyers come in at chest height (ice beam,
  // then a missile shatters the block), divers hang from the top and swoop,
  // and a jellyfish-like leech drifts in to latch onto her helmet and drain
  // her until she curls up and bombs it off. While the agent works a winged
  // dragon swoops in for a boss fight; Done drops an energy tank with the item
  // fanfare and a helmet-off moment; when it is quiet she kneels.

  // ---- palette ------------------------------------------------------------------
  const P = {
    ...PAL,
    O: '#f08a24', o: '#a83218', a: '#c85818', Y: '#f8d040', y: '#c89420', G: '#60e060', w: '#ffffff', E: '#141414',
    h: '#f8e070', S: '#f8c8a0', r: '#e0304a',
    // leech
    M: '#a0f0a0', m: '#58c060', g: '#1e6a38', R: '#ff5070', A: '#ece4cc',
    // crawler / flyer / diver
    Z: '#f8b800', z: '#c84c0c', k: '#6a2a08', K: '#e8d088', q: '#40b0a0', Q: '#a0f0e0',
    // ice and beams
    c: '#a8f0ff', b: '#3890e0', I: '#e0fbff',
    // dragon
    v: '#6a2aa8', V: '#a868e8', u: '#3a1468', x: '#f8f058', f: '#f86818', F: '#f8c040',
    // missile
    n: '#f0f0f0', N: '#e04020',
  }
  const SPR = (rows) => sprite(rows, P)
  const SP = (rows) => pairOutlined(rows, P)
  const grid = (w, h) => Array.from({ length: h }, () => Array(w).fill('.'))
  function stamp(g, rows, x, y) {
    rows.forEach((r, j) => {
      const yy = y + j
      if (yy < 0 || yy >= g.length) return
      for (let i = 0; i < r.length; i++) {
        const ch = r[i]
        const xx = x + i
        if (ch !== '.' && ch !== ' ' && xx >= 0 && xx < g[0].length) g[yy][xx] = ch
      }
    })
    return g
  }
  const rowsOf = (g) => g.map((r) => r.join(''))
  const pad = (rows, w = Math.max(...rows.map((r) => r.length))) => rows.map((r) => r.padEnd(w, '.'))
  const rot90 = (rows) => {
    const pr = pad(rows)
    const out = []
    for (let c = 0; c < pr[0].length; c++) {
      let line = ''
      for (let r = pr.length - 1; r >= 0; r--) line += pr[r][c]
      out.push(line)
    }
    return out
  }
  const rots = (rows) => {
    const o = [pad(rows)]
    for (let i = 1; i < 4; i++) o.push(rot90(o[i - 1]))
    return o
  }
  const blit = (c, sp, dir, x, y) => c.drawImage(sp[dir], Math.round(x) - 1, Math.round(y) - 1)
  const ICE = { M: 'c', m: 'b', g: 'b', R: 'I', A: 'c', Z: 'c', z: 'b', k: 'b', K: 'I', q: 'b', Q: 'c', Y: 'c', y: 'b', E: 'b', r: 'I' }

  // ---- the hunter: 20 × 26, faces right --------------------------------------------
  const HELMET = [
    '...oooooo...',
    '..oOOOOOOo..',
    '.oOOOOOOOOo.',
    '.oOOOOOGGGGo',
    'oOOOOOGGGGGo',
    'oOOOOOGwGGGo',
    'oOOOOOOGGGo.',
    '.oOOOOOOOo..',
    '..ooooooo...',
  ]
  const T_FWD = [
    '...YYYYooOOo........',
    '..YYyyYYoOOOoo......',
    '.YYyyyyYoOOOOooooo..',
    '.YyyyyyYoOOOOaaaaaY.',
    '.YYyyyyYoOOOOooooo..',
    '..YYyyYYoOOOOo......',
    '...YYYYoOOOOOo......',
    '....oOOYYYYOo.......',
    '....ooYyyyYoo.......',
  ]
  const T_RAISED = [
    '...YYYYooOOo..oOo...',
    '..YYyyYYoOOOooOo....',
    '.YYyyyyYoOOOOOo.....',
    '.YyyyyyYoOOOOo......',
    '.YYyyyyYoOOOOo......',
    '..YYyyYYoOOOOo......',
    '...YYYYoOOOOOo......',
    '....oOOYYYYOo.......',
    '....ooYyyyYoo.......',
  ]
  const T_DOWN = [
    '...YYYYooOOo........',
    '..YYyyYYoOOOo.......',
    '.YYyyyyYoOOOOo......',
    '.YyyyyyYoOOOoOo.....',
    '.YYyyyyYoOOOooOo....',
    '..YYyyYYoOOOOoao....',
    '...YYYYoOOOOOoao....',
    '....oOOYYYYOooYo....',
    '....ooYyyyYoo.......',
  ]
  const CANNON_UP = ['.Y.', 'oYo', 'oao', 'oao', 'oao', 'oao', 'oOo', 'oOo']
  const CANNON_DIAG = ['.......Y', '......oY', '.....oao', '....oao.', '...oao..', '..oOo...', '.oOo....']
  const LEGS = {
    stand: ['....oOOooOOo........', '....oOOo.oOOo.......', '....oOOo..oOOo......', '....oYYo..oYYo......', '....oOOo..oOOo......', '....oOOo..oOOo......', '....oOOo..oOOo......', '...ooOOo.ooOOo......', '...ooooo.oooooo.....'],
    r1: ['....oOOOOOOo........', '...oOOOo.oOOo.......', '..oOOo....oOOo......', '.oYYo......oYYo.....', '.oOOo.......oOOo....', 'oOOo.........oOOo...', 'oOo..........oOOo...', 'ooo..........ooOOo..', 'oo...........oooooo.'],
    r2: ['....oOOOOOo.........', '....oOOOOOo.........', '...oOOoooOOo........', '..oYYo..oYYo........', '..oOOo..oOOo........', '..oOOoo.oOOo........', '...ooOo.oOOo........', '.....oo.ooOOo.......', '........oooooo......'],
    r3: ['....oOOOOOo.........', '...oOOo.oOOOo.......', '..oOOo...oOOOo......', '..oYYo....oYYYo.....', '.oOOo......oOOOo....', '.oOo........oOOo....', 'oOo..........oOo....', 'ooo..........ooOo...', '.............ooooo..'],
    kneel: ['....oOOOOOOo........', '...oOOOOoOOOo.......', '..oOOo..oOOOOOOo....', '.oYYo....oYYOOOOo...', 'ooooo....oooooooo...'],
    crouch: ['...oOOOOOOOOo.......', '..oOOooooooOOo......', '.oYYo.....oYYOo.....', 'ooooo.....ooooooo...'],
  }
  function hunterRows(torso, legs, opts = {}) {
    const top = opts.top ?? 0
    const g = grid(20, 17 + legs.length + top)
    stamp(g, legs, 0, 17 + top)
    stamp(g, torso, 0, 8 + top)
    stamp(g, opts.head || HELMET, 3, top)
    if (opts.up) stamp(g, CANNON_UP, 14, top)
    if (opts.diag) stamp(g, CANNON_DIAG, 12, 2 + top)
    return rowsOf(g)
  }
  const HELM_FRONT = ['...oooooooo...', '..oOOOOOOOOo..', '.oOOOOOOOOOOo.', '.oOGGGGGGGGOo.', '.oGGwGGGGGGGo.', '.oGGGGGGGGGGo.', '.oOGGGGGGGGOo.', '..oOOOOOOOOo..', '...oooooooo...']
  const FACE = ['...hhhhhhhh...', '..hhhhhhhhhh..', '.hhhSSSSSShhh.', '.hhSSSSSSSShh.', '.hhSESSSSESh..', 'hhhSSSSSSSShh.', 'hh.SSSrrSSS.hh', 'hh..SSSSSS..hh', 'h....SSSS....h']
  const T_FRONT = [
    '.YYYYYooooooYYYYY...',
    'YYyyyYYoOOoYYyyyYY..',
    'YyyyyyYoOOoYyyyyyY..',
    'YYyyyYYoOOoYYyyyYY..',
    '.oYYYooOOOOooYYYo...',
    '.oOOo.oOOOOo.oaao...',
    '.oOOo.oOOOOo.oaao...',
    '.oYYo.oYYYYo.oaao...',
    '.oSSo.oYyyYo..oYo...',
  ]
  const L_FRONT = ['......oOOOOo........', '.....oOOooOOo.......', '.....oOOooOOo.......', '.....oYYooYYo.......', '.....oOOooOOo.......', '.....oOOooOOo.......', '.....oOOooOOo.......', '....ooOOooOOoo......', '....oooo..oooo......']
  function front(head) {
    const g = grid(20, 26)
    stamp(g, L_FRONT, 0, 17)
    stamp(g, T_FRONT, 0, 8)
    stamp(g, head, 3, 0)
    return rowsOf(g)
  }
  const HERO = {
    stand: SP(hunterRows(T_FWD, LEGS.stand)),
    up: SP(hunterRows(T_RAISED, LEGS.stand, { up: true })),
    diag: SP(hunterRows(T_RAISED, LEGS.stand, { diag: true })),
    run: [SP(hunterRows(T_FWD, LEGS.r1)), SP(hunterRows(T_FWD, LEGS.r2)), SP(hunterRows(T_FWD, LEGS.r3)), SP(hunterRows(T_FWD, LEGS.r2))],
    runDiag: [SP(hunterRows(T_RAISED, LEGS.r1, { diag: true })), SP(hunterRows(T_RAISED, LEGS.r2, { diag: true })), SP(hunterRows(T_RAISED, LEGS.r3, { diag: true })), SP(hunterRows(T_RAISED, LEGS.r2, { diag: true }))],
    kneel: SP(hunterRows(T_DOWN, LEGS.kneel)),
    crouch: SP(hunterRows(T_FWD, LEGS.crouch)),
    front: SP(front(HELM_FRONT)),
    face: SP(front(FACE)),
  }
  HERO.flash = SP(hunterRows(T_FWD, LEGS.stand).map((r) => r.replace(/[OoYyaG]/g, 'w')))
  const SH = 26
  const SW = 20
  const SPIN_ROWS = [
    '.....oooooo.....',
    '...ooOOOOOOoo...',
    '..oOOOOOGGGOOo..',
    '.oOOOOOGGGGGOOo.',
    '.oOOOOOOGGGOOOo.',
    'oYYYYOOOOOOOOOOo',
    'oYyyyYoOOOOaaYYo',
    'oYyyyYoOOOOOOOOo',
    'oYYYYooOYYYOOOOo',
    '.ooooOOOOOOOOOo.',
    '.oOOOOOoooOOOOo.',
    '..oOOOo...oOOo..',
    '..oYYo.....oYo..',
    '...oOo....oOo...',
    '....ooo..ooo....',
    '................',
  ]
  const SPIN = rots(SPIN_ROWS).map((r) => outline(SPR(r)))
  const auraRows = (k) => {
    const out = []
    for (let y = 0; y < 22; y++) {
      let r = ''
      for (let x = 0; x < 22; x++) {
        const d = Math.hypot(x - 10.5, y - 10.5)
        const a = Math.atan2(y - 10.5, x - 10.5)
        const on = d > 9 && d < 11 && (Math.floor((a + Math.PI) * 3 + k) & 1)
        r += on ? (Math.floor(a * 5) & 1 ? 'G' : 'w') : '.'
      }
      out.push(r)
    }
    return out
  }
  const AURA = [SPR(auraRows(0)), SPR(auraRows(1))]
  const BALL_ROWS = ['...oooo...', '..oOOOOo..', '.oOYYOOOo.', 'oOYYOOOaOo', 'oOYOOOOaOo', 'oOOOOOaaOo', 'oOOOOaaOOo', '.oOOOOOOo.', '..oOOOOo..', '...oooo...']
  const BALL = rots(BALL_ROWS).map((r) => outline(SPR(r)))
  const BALL_GLOW = rots(BALL_ROWS.map((r) => r.replace(/O/g, 'Y'))).map((r) => outline(SPR(r)))
  const BOMB = [SPR(['.EE.', 'EwEE', 'EEEE', '.EE.']), SPR(['.YY.', 'YwYY', 'YYYY', '.YY.'])]
  const BEAM = SPR(['.c.', 'cIc', '.c.'])
  const MISSILE = { 1: SPR(['.nnnn...', 'NnnnnnN.', 'NnnnnnnN', 'NnnnnnN.', '.nnnn...']), '-1': SPR(['...nnnn.', '.NnnnnnN', 'NnnnnnnN', '.NnnnnnN', '...nnnn.']) }
  const MISSILE_V = SPR(['..n..', '.nnn.', 'NnnnN', 'NnnnN', 'NnnnN', '.N.N.'])

  // ---- enemies ------------------------------------------------------------------
  const ZOOM_ROWS = [
    ['.Z..Z..Z..Z.', '.ZZ.ZZ.ZZ.ZZ', '..zzzzzzzzz.', '.zZZZZZZZZZz', 'zZZwEZZZZZZz', 'zZZZZZZZZZZz', '.zzzzzzzzzz.', '.k..k..k..k.', 'k..k..k..k..'],
    ['.Z..Z..Z..Z.', 'ZZ.ZZ.ZZ.ZZ.', '..zzzzzzzzz.', '.zZZZZZZZZZz', 'zZZwEZZZZZZz', 'zZZZZZZZZZZz', '.zzzzzzzzzz.', '..k..k..k..k', '.k..k..k..k.'],
  ]
  const ZOOM = ZOOM_ROWS.map(SP)
  const ZOOM_ICE = SP(ZOOM_ROWS[0].map((r) => [...r].map((ch) => ICE[ch] ?? ch).join('')))
  const RIP_ROWS = [
    ['....kkkkkkkk....', '..kkKKKKKKKKkk..', '.kKKZZZZZZZZKKk.', 'kKZZzzzzzzzzZZEk', '.kkkkkkkkkkkkkk.', '..k.k.k.k.k.k...'],
    ['....kkkkkkkk....', '..kkKKKKKKKKkk..', '.kKKZZZZZZZZKKk.', 'kKZZzzzzzzzzZZEk', '.kkkkkkkkkkkkkk.', '...k.k.k.k.k.k..'],
  ]
  const RIP = RIP_ROWS.map(SP)
  const RIP_ICE = SP(RIP_ROWS[0].map((r) => [...r].map((ch) => ICE[ch] ?? ch).join('')))
  const DIVER_ROWS = ['qqqqqqqqqq', '.qQQQQQQq.', '.qQEQQEQq.', '..qQQQQq..', '..qQYYQq..', '...qQQq...', '...qYYq...', '....qq....', '....qY....', '....q.....']
  const DIVER = [SP(DIVER_ROWS), SP(DIVER_ROWS.map((r) => [...r].reverse().join('')))]
  const DIVER_ICE = SP(DIVER_ROWS.map((r) => [...r].map((ch) => ICE[ch] ?? ch).join('')))
  const SHARD = SPR(['qQ', 'Qq'])
  const MET_TOP = [
    '.....gggggggg.....',
    '...ggMMMMMMMMgg...',
    '..gMMwwMMMMMMMMg..',
    '.gMMwMMMMMMMMMMMg.',
    '.gMMMmmmMMMmmmMMg.',
    'gMMMmRRmMMmRRmMMMg',
    'gMMMmRRmMMmRRmMMMg',
    'gMMMMmmMMMMmmMMMMg',
    '.gMMMMMmmmmMMMMMg.',
    '..gggMmRRRRmMggg..',
    '....gggggggggg....',
  ]
  const MET_ROWS = [
    [...MET_TOP, '...A.A....A.A.....', '..A..A....A..A....', '..AA.......AAA....'].map((r) => r.replace(/R/g, 'r')),
    [...MET_TOP.map((r, i) => (i === 0 ? '....gggggggggg....' : r)), '....A.A..A.A.....', '...A..A..A..A....', '...AA.A..A.AA....'].map((r) => r.replace(/R/g, 'r')),
  ]
  const MET = MET_ROWS.map(SP)
  const MET_ICE = SP(MET_ROWS[0].map((r) => [...r].map((ch) => ICE[ch] ?? ch).join('')))
  const MET_HIT = SP(MET_ROWS[0].map((r) => r.replace(/[Mm]/g, 'w')))
  // the dragon, 32 × 24, faces left
  const RID_BODY = [
    '....vv..........................',
    '...vVVv.........................',
    '..vVVVVv....vv..................',
    '.vVxEVVVvvvVVv..................',
    'vVVVVVVVVVVVv...................',
    'wfwVVVVVVVv.....................',
    '.uuufVVVVVVv....................',
    '....uuvVVVVVv...................',
    '.......vVVVVVvv.................',
    '........vVVVVVVvv...............',
    '........vVuVVVVVVv..............',
    '.......vVuuVVVVVVVv.............',
    '......vVVuuuVVVVVVVv............',
    '......vVVVuuVVVVVVVVv...........',
    '.......vVVVVVVVVVVVVVvv.........',
    '........vvVVVVVVVVVVVVVvv.......',
    '..........vVVvvvvVVVVVVVVvv.....',
    '.........vVVv.....vvVVVVVVVv....',
    '........xVVx........vvVVVVVv....',
    '........x..x..........vVVVVv..v.',
    '.......................vVVVVvvVv',
    '........................vvVVVVv.',
    '..........................vvvv..',
  ]
  const WING_UP = [
    '..............vv..',
    '...........vvvVv..',
    '........vvvuuuVv..',
    '......vvuuuuuuVv..',
    '....vvuuuuuuuuVv..',
    '...vVuuuuuuuuVv...',
    '..vVuuuuuuuuVv....',
    '.vVuuuvuuuvVv.....',
    'vVVvvv.vvv.v......',
  ]
  const WING_DN = WING_UP.slice().reverse()
  function dragonRows(wing, wy) {
    const g = grid(32, 26)
    stamp(g, wing, 12, wy)
    stamp(g, RID_BODY, 0, 2)
    return rowsOf(g)
  }
  const DRAGON = [OUT2(dragonRows(WING_UP, 0)), OUT2(dragonRows(WING_DN, 12))]
  const DRAGON_HIT = OUT2(dragonRows(WING_UP, 0).map((r) => r.replace(/[vVu]/g, 'w')))
  function OUT2(rows) {
    const o = outline(SPR(rows))
    return { '-1': o, 1: mirror(o) }
  }
  const FIREBALL = [SPR(['.FF.', 'FffF', 'FffF', '.FF.']), SPR(['.ff.', 'fFFf', 'fFFf', '.ff.'])]
  const ORB = [SPR(['.rr.', 'rwRr', 'rRRr', '.rr.']), SPR(['.RR.', 'RwrR', 'RrrR', '.RR.'])]
  const TANK_ROWS = ['.oooooooo.', 'oYYYYYYYYo', 'oYrrrrrrYo', 'oYrwrrrrYo', 'oYrrrrrrYo', 'oYrrrrrrYo', 'oYYYYYYYYo', '.oooooooo.']
  const TANK = outline(SPR(TANK_ROWS))
  const TANK_GLOW = outline(SPR(TANK_ROWS.map((r) => r.replace(/r/g, 'w'))))
  const GLYPH = {
    E: SPR(['www', 'w..', 'ww.', 'w..', 'www']),
    N: SPR(['w.w', 'www', 'www', 'w.w', 'w.w']),
    '.': SPR(['...', '...', '...', '...', '.w.']),
    T: SPR(['ww', 'ww']),
    t: SPR(['w.', '.w']),
  }

  // ---- shared helpers -------------------------------------------------------------
  const enemies = (s) => s.actors.filter((a) => a.enemy && !a.dead)
  const overlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
  const keyed = (s, now) => now - s.keyAt < 9000
  const keyDir = (s) => (s.keys.has('right') ? 1 : 0) - (s.keys.has('left') ? 1 : 0)
  const engaged = (s, now) => keyed(s, now) || now < s.data.engagedUntil || (s.cursor && s.cursor.y < H + 4 && now - s.cursor.t < 1500 && s.cursor.speed > 10)
  function engage(s) {
    s.data.engagedUntil = performance.now() + 9000
  }
  function openSpot(s, x, w) {
    const bad = (xx) => s.fix.some((f) => xx + w > f.x - 4 && xx < f.x + f.w + 4)
    for (let r = 0; r < s.W; r += 4)
      for (const xx of [x - r, x + r]) if (xx >= 2 && xx <= s.W - w - 2 && !bad(xx)) return xx
    return clamp(x, 2, s.W - w - 2)
  }
  function boom(s, x, y, n = 14, cols = ['Y', 'O', 'w', 'r']) {
    s.burst(x, y, n, cols)
  }
  function shatter(s, x, y) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2
      const v = rand(20, 60)
      s.particle({ img: pix(pick(['c', 'w', 'b'])), x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20, g: 120, life: rand(0.5, 1), fade: true })
    }
  }
  function drop(s, x, y) {
    if (Math.random() < 0.6) s.spawn(new Orb(s, x, y))
  }

  // ---- the hunter -------------------------------------------------------------------
  class Hunter {
    constructor(s) {
      this.s = s
      this.x = Math.round(s.W * 0.3)
      this.dir = 1
      this.state = 'stand'
      this.t = 0
      this.jy = 0
      this.vx = 0
      this.leg = 0
      this.aim = 'fwd'
      this.aimT = 0
      this.fireCd = 0
      this.inv = 0
      this.goal = null
      this.pauseUntil = performance.now() + 1500
      this.task = null
      this.latched = null
      this.clicks = []
      this.z = 5
    }
    get small() {
      return this.state === 'ball' || this.state === 'morph' || this.state === 'unmorph'
    }
    get y() {
      return FLOOR - SH - this.jy
    }
    get moving() {
      return this.state === 'run' || this.state === 'spin' || (this.state === 'ball' && this.rolling)
    }
    get asleep() {
      return this.state === 'kneel'
    }
    get box() {
      if (this.state === 'gone') return { x0: -99, x1: -98, y0: -99, y1: -98 }
      if (this.state === 'spin') return { x0: this.x + 1, x1: this.x + 17, y0: FLOOR - 17 - this.jy, y1: FLOOR - 1 - this.jy }
      if (this.small) return { x0: this.x + 4, x1: this.x + 14, y0: FLOOR - 10, y1: FLOOR }
      return { x0: this.x + 4, x1: this.x + 14, y0: this.y + 1, y1: FLOOR }
    }
    get cx() {
      return this.x + 9
    }
    hit(px, py) {
      const b = this.box
      return px > b.x0 - 3 && px < b.x1 + 3 && py > b.y0 - 3 && py < b.y1 + 1
    }
    onClick() {
      const s = this.s
      const now = performance.now()
      engage(s)
      this.clicks = this.clicks.filter((t) => now - t < 2500)
      this.clicks.push(now)
      if (this.state === 'kneel') {
        // a poke at rest: she takes off the helmet for a moment
        this.state = 'face'
        this.t = 3
        return
      }
      if (this.clicks.length >= 5) {
        this.clicks = []
        this.state = 'face'
        this.t = 3
        s.say('...', this.cx, 0, { color: '#f8e070', life: 1.5 })
        return
      }
      if (this.state === 'ball') return this.bomb()
      this.screw(this.goal !== null && Math.abs(this.goal - this.x) > 10)
    }
    onDblClick() {
      engage(this.s)
      if (this.state === 'ball') this.unmorph()
      else this.morph()
    }
    get grabbable() {
      return this.state !== 'kneel'
    }
    grab() {
      engage(this.s)
    }
    drag(p) {
      engage(this.s)
      this.steer = clamp(p.x - SW / 2, 1, this.s.W - SW - 1)
    }
    drop(p) {
      engage(this.s)
      this.steer = clamp(p.x - SW / 2, 1, this.s.W - SW - 1)
      this.task = { kind: 'goto', x: this.steer, until: performance.now() + 8000 }
    }
    speed() {
      return this.s.busy ? 40 : 32
    }
    canAct() {
      return this.state === 'stand' || this.state === 'run' || this.state === 'shoot'
    }
    /** Fire at a point: the ice beam, or a missile. Turns and aims first. */
    fire(px, py, kind = 'beam') {
      const s = this.s
      if (!this.canAct() || this.fireCd > 0) return false
      const dx = px - this.cx
      if (Math.abs(dx) > 3) this.dir = Math.sign(dx)
      const adx = Math.abs(dx)
      const ady = this.y + 11 - py
      this.aim = ady > adx * 2.2 ? 'up' : ady > adx * 0.45 ? 'diag' : 'fwd'
      const ox = this.aim === 'up' ? this.x + (this.dir > 0 ? 15 : 4) : this.aim === 'diag' ? this.x + (this.dir > 0 ? 19 : 0) : this.x + (this.dir > 0 ? 19 : 0)
      const oy = this.aim === 'up' ? this.y - 1 : this.aim === 'diag' ? this.y + 2 : this.y + 11
      let vx = px - ox
      let vy = py - oy
      // straight lines only along the aim (NES: 0, 45 or 90 degrees, but loosened)
      if (this.aim === 'fwd') vy = clamp(vy, -Math.abs(vx) * 0.25, Math.abs(vx) * 0.25)
      const L = Math.hypot(vx, vy) || 1
      const sp = kind === 'missile' ? 130 : 170
      s.spawn(new Shot(s, kind, ox, oy, (vx / L) * sp, (vy / L) * sp))
      if (this.state !== 'run') this.state = 'shoot'
      this.aimT = 0.45
      this.fireCd = kind === 'missile' ? 0.55 : s.busy ? 0.35 : 0.45
      return true
    }
    morph() {
      if (!this.canAct() && this.state !== 'kneel') return
      this.state = 'morph'
      this.t = 0.15
      this.s.poke()
    }
    unmorph() {
      if (this.state !== 'ball') return
      this.state = 'unmorph'
      this.t = 0.15
    }
    bomb() {
      const s = this.s
      if (s.actors.filter((a) => a.isBomb).length >= 3) return
      s.spawn(new Bomb(s, this.x + 7, FLOOR - 7))
    }
    screw(travel = true) {
      if (!this.canAct()) return
      this.state = 'spin'
      this.jt = 0
      this.vx = travel ? this.dir * 48 : 0
      this.s.poke()
    }
    hurt(dmg, from) {
      const s = this.s
      if (this.inv > 0 || ['spin', 'face', 'fanfare', 'dying', 'gone'].includes(this.state)) return
      s.data.energy = Math.max(0, s.data.energy - dmg)
      if (s.data.energy <= 0) return this.die()
      this.inv = 1.5
      if (!this.small) {
        this.x = clamp(this.x + (from < this.cx ? 6 : -6), 1, s.W - SW - 1)
        this.state = 'stand'
      }
    }
    die() {
      // out of energy: the suit flashes and bursts apart, and she comes back in at the edge
      if (this.latched) {
        this.latched.state = 'stunned'
        this.latched.t = 1
        this.latched = null
      }
      this.task = null
      this.state = 'dying'
      this.t = 1.4
      this.jy = 0
    }
    update(dt, now, s) {
      const d = s.data
      const lively = s.lively(now)
      this.fireCd -= dt
      if (this.inv > 0) this.inv -= dt
      if (this.aimT > 0) {
        this.aimT -= dt
        if (this.aimT <= 0) this.aim = 'fwd'
      }
      // timed transitions
      if (this.t > 0) {
        this.t -= dt
        if (this.t > 0) return FAST
        if (this.state === 'morph') {
          this.state = 'ball'
          this.rolling = false
        } else if (this.state === 'unmorph' || this.state === 'shoot') this.state = 'stand'
        else if (this.state === 'fanfare') {
          this.state = 'face'
          this.t = 3
          return FAST
        } else if (this.state === 'face') this.state = lively ? 'stand' : 'kneel'
        else if (this.state === 'dying') {
          for (let i = 0; i < 3; i++) boom(s, this.cx + rand(-6, 6), FLOOR - rand(4, 22), 12, ['O', 'Y', 'G', 'w'])
          this.state = 'gone'
          this.t = 2.5
          return FAST
        } else if (this.state === 'gone') {
          this.state = 'stand'
          this.x = this.x + 9 < s.W / 2 ? 4 : s.W - SW - 4
          this.dir = this.x < s.W / 2 ? 1 : -1
          d.energy = 30
          this.inv = 2.5
          this.pauseUntil = now + 800
        }
      }
      if (this.state === 'dying' || this.state === 'gone') return FAST
      if (this.state === 'shoot' && this.aimT <= 0) this.state = 'stand'
      if (this.hop > 0) {
        this.hop -= dt
        this.hopY = this.hop > 0 && this.state === 'ball' ? Math.sin(((0.45 - this.hop) / 0.45) * Math.PI) * 9 : 0
        if (this.hop > 0) this.s.poke()
      }
      if (this.state === 'face' || this.state === 'fanfare') return FAST
      // a leech on the helmet: energy drains until she curls up and bombs it off
      if (this.latched) {
        if (this.latched.dead || this.latched.state !== 'latched') this.latched = null
        else {
          this.drainT = (this.drainT || 0) + dt
          if (this.drainT > 0.3) {
            this.drainT = 0
            d.energy = Math.max(0, d.energy - 1)
            if (d.energy <= 0) {
              this.die()
              return FAST
            }
          }
          this.latchT = (this.latchT || 0) + dt
          if (this.latchT > 1.4 && this.canAct()) this.morph()
          else if (this.state === 'ball' && !s.actors.some((a) => a.isBomb)) this.bomb()
          return FAST
        }
      }
      this.latchT = 0
      if (this.state === 'spin') {
        this.jt += dt
        // the screw attack arcs up out of the top of the bar
        this.jy = Math.max(0, 90 * this.jt - 75 * this.jt * this.jt)
        this.x = clamp(this.x + this.vx * dt, 1, s.W - SW - 1)
        // the screw attack tears through anything it touches
        const b = this.box
        for (const e of enemies(s)) if (e.box && overlap(b, e.box) && e.kind !== 'dragon') e.kill(true)
        if (this.jt > 0.2 && this.jy <= 0) {
          this.jy = 0
          this.state = 'stand'
        }
        return FAST
      }
      // touching enemies hurts
      if (!this.small || this.state === 'ball') {
        const b = this.box
        for (const e of enemies(s))
          if (e.box && !e.frozen && e.state !== 'latched' && e.harm && overlap(b, e.box)) {
            this.hurt(e.harm, e.x + e.w / 2)
            e.bump?.(this)
          }
      }
      // rest: kneel in an open spot
      if (!lively && !d.tank) {
        this.task = null
        if (this.state === 'ball') {
          this.unmorph()
          return FAST
        }
        const spot = this.restX ?? (this.restX = openSpot(s, this.x, SW))
        if (Math.abs(spot - this.x) > 1.5) {
          // act() isn't running, so count the turn cooldown down here or she can't turn to go
          this.turnCd = (this.turnCd || 0) - dt
          return this.walk(spot, dt, true)
        }
        if (this.state === 'kneel') return Infinity
        if (this.state === 'stand' || this.state === 'run') {
          this.state = 'kneel'
          this.dir = this.x < s.W / 2 ? 1 : -1
          return FAST
        }
        return FAST
      }
      this.restX = null
      if (this.state === 'kneel') this.state = 'stand'
      const kd = keyDir(s)
      if (kd && (this.canAct() || this.state === 'ball')) {
        // A/D: run (or roll), turning on the spot
        this.task = null
        this.dir = kd
        if (this.state === 'ball') this.rolling = true
        else if (this.state !== 'shoot') this.state = 'run'
        this.x = clamp(this.x + kd * (this.state === 'ball' ? 40 : this.speed() * 1.2) * dt, 1, s.W - SW - 1)
        this.leg += dt * (this.state === 'ball' ? 12 : 10)
        return FAST
      }
      if (s.keys.size) {
        this.task = null
        if (this.state === 'run') this.state = 'stand'
        this.rolling = false
        return FAST
      }
      this.think(now, s)
      return this.act(dt, now, s)
    }
    /** Choose what to do: the user's steering, the item, enemies, exploring. */
    think(now, s) {
      const d = s.data
      const t = this.task
      if (t && (t.until < now || (t.target && (t.target.dead || t.target.leaving)))) this.task = null
      if (d.tank && !d.tank.dead && (!this.task || this.task.kind !== 'item')) this.task = { kind: 'item', target: d.tank, until: now + 20000 }
      if (this.task) return
      const c = s.cursor
      if (engaged(s, now)) {
        // the user drives: walk toward the pointer, aim at it (not while the keyboard has her)
        if (c && c.y < H + 6 && !keyed(s, now)) this.task = { kind: 'follow', until: now + 400 }
        return
      }
      // running low: go for the energy drops
      const orb = s.actors.find((a) => a instanceof Orb && !a.dead)
      if (orb && d.energy < 70) {
        this.task = { kind: 'goto', x: clamp(orb.x - 7, 1, s.W - SW - 1), until: now + 5000 }
        return
      }
      // the nearest live threat
      let best = null
      let bd = 1e9
      for (const e of enemies(s)) {
        if (e.leaving || e.state === 'hanging' || (e.kind === 'leech' && e.ignored)) continue
        const dd = Math.abs(e.x + e.w / 2 - this.cx)
        if (dd < bd && dd < (s.busy ? 260 : 200)) {
          bd = dd
          best = e
        }
      }
      if (best) {
        this.task = { kind: 'fight', target: best, until: now + 9000, plan: this.plan(best) }
        return
      }
      if (now < this.pauseUntil) return
      // explore: a run, a roll under the title, a screw-attack hop
      const r = Math.random()
      const title = s.fixture('title')
      if (r < 0.22) {
        const tx = clamp(title.x + title.w / 2 - 9 + rand(-20, 20), 4, s.W - SW - 4)
        this.task = { kind: 'roll', x: tx, bombs: Math.floor(rand(1, 4)), until: now + 14000 }
      } else {
        let gx = this.x
        for (let i = 0; i < 6; i++) {
          gx = clamp(this.x + pick([-1, 1]) * rand(60, s.busy ? 260 : 180), 4, s.W - SW - 4)
          if (Math.abs(gx - this.x) > 40) break
        }
        this.task = { kind: 'goto', x: gx, until: now + 12000, hop: Math.random() < (s.busy ? 0.5 : 0.25) }
      }
      this.pauseUntil = now + (s.busy ? rand(400, 1400) : rand(1500, 4000))
    }
    plan(e) {
      if (e.kind === 'crawler') return Math.random() < (this.s.busy ? 0.6 : 0.35) ? 'screw' : 'bomb'
      return 'shoot'
    }
    walk(gx, dt, slow = false) {
      const s = this.s
      if (this.state === 'ball') {
        const want = Math.sign(gx - this.x)
        this.dir = want || this.dir
        this.rolling = true
        this.x = clamp(this.x + want * 36 * dt, 1, s.W - SW - 1)
        this.leg += dt * 12
        return FAST
      }
      if (!this.canAct()) return FAST
      const want = Math.sign(gx - this.x)
      if (want !== this.dir && this.turnCd > 0) return FAST
      if (want !== this.dir) this.turnCd = 0.4
      this.dir = want
      if (this.state !== 'shoot') this.state = 'run'
      this.x = clamp(this.x + want * (slow ? 24 : this.speed()) * dt, 1, s.W - SW - 1)
      this.leg += dt * 10
      return FAST
    }
    act(dt, now, s) {
      this.turnCd = (this.turnCd || 0) - dt
      const t = this.task
      const stop = () => {
        if (this.state === 'run') this.state = 'stand'
        this.rolling = false
      }
      if (!t) {
        stop()
        if (this.state === 'ball') this.unmorph()
        return this.fireCd > 0 || this.aimT > 0 ? FAST : Math.max(FAST, Math.min(this.pauseUntil - now, 30000 - (now - s.lastTouch) + 50))
      }
      if (t.kind === 'follow') {
        const c = s.cursor
        if (this.state === 'ball' && c) {
          if (Math.abs(c.x - this.cx) > 6) return this.walk(c.x - 9, dt)
          this.rolling = false
          return FAST
        }
        if (!c) return FAST
        // keep a little distance and aim at the pointer
        const dx = c.x - this.cx
        if (Math.abs(dx) > 34) return this.walk(c.x - 9 - Math.sign(dx) * 26, dt)
        stop()
        if (Math.abs(dx) > 3) this.dir = Math.sign(dx)
        const ady = this.y + 11 - c.y
        this.aim = ady > Math.abs(dx) * 2.2 ? 'up' : ady > Math.abs(dx) * 0.45 ? 'diag' : 'fwd'
        this.aimT = 0.3
        return FAST
      }
      if (t.kind === 'goto' || t.kind === 'item') {
        const gx = t.kind === 'item' ? t.target.x - 5 : t.x
        if (this.state === 'ball') this.unmorph()
        if (Math.abs(gx - this.x) > 2) {
          if (t.hop && this.canAct() && Math.abs(gx - this.x) > 50 && Math.random() < dt * 0.6) {
            t.hop = false
            this.screw(true)
            return FAST
          }
          return this.walk(gx, dt)
        }
        stop()
        if (t.kind === 'goto') this.task = null
        return FAST
      }
      if (t.kind === 'roll') {
        if (this.canAct() && this.state !== 'ball') {
          if (Math.abs(t.x - this.x) < 4) {
            this.task = null
            return FAST
          }
          this.dir = Math.sign(t.x - this.x)
          this.morph()
          return FAST
        }
        if (this.state === 'ball') {
          if (Math.abs(t.x - this.x) > 2) {
            // drop a bomb now and then along the way
            if (t.bombs > 0 && Math.random() < dt * 0.8) {
              t.bombs--
              this.bomb()
            }
            return this.walk(t.x, dt)
          }
          this.rolling = false
          if (t.bombs > 0 && !s.actors.some((a) => a.isBomb)) {
            t.bombs--
            this.bomb()
          }
          if (!s.actors.some((a) => a.isBomb)) {
            this.unmorph()
            this.task = null
          }
          return FAST
        }
        return FAST
      }
      if (t.kind === 'fight') {
        const e = t.target
        const ex = e.x + e.w / 2
        const dx = ex - this.cx
        if (t.plan === 'bomb') {
          // curl up and roll right up to it, then drop a bomb
          if (Math.abs(dx) > 40 && this.state !== 'ball') return this.walk(ex - 9 - Math.sign(dx) * 32, dt)
          if (this.state !== 'ball') {
            this.dir = Math.sign(dx) || 1
            this.morph()
            return FAST
          }
          if (Math.abs(dx) > 12 && !s.actors.some((a) => a.isBomb)) return this.walk(ex - 9 - Math.sign(dx) * 8, dt)
          this.rolling = false
          if (!s.actors.some((a) => a.isBomb)) this.bomb()
          return FAST
        }
        if (this.state === 'ball') {
          this.unmorph()
          return FAST
        }
        if (t.plan === 'screw') {
          if (Math.abs(dx) > 30) return this.walk(ex - 9 - Math.sign(dx) * 26, dt)
          this.dir = Math.sign(dx) || 1
          this.screw(true)
          this.task = null
          return FAST
        }
        // shoot: get in range with a clear line, then ice, then missiles
        const range = e.kind === 'diver' || e.kind === 'dragon' ? 70 : 110
        if (Math.abs(dx) > range) return this.walk(ex - 9 - Math.sign(dx) * (range - 20), dt)
        if (Math.abs(dx) < 16 && e.kind !== 'diver' && e.kind !== 'dragon') return this.walk(this.x - Math.sign(dx || 1) * 20, dt)
        stop()
        if (this.fireCd <= 0) {
          const kind = e.frozen || e.kind === 'dragon' ? 'missile' : 'beam'
          if (!e.frozen || (e.stillFor ?? 1) > 0.4) this.fire(ex, e.y + e.h / 2, kind)
        }
        return FAST
      }
      return FAST
    }
    draw(c, s) {
      if (this.state === 'gone') return
      if (this.state === 'dying') {
        const fl = Math.floor(this.t * 12) & 1
        return blit(c, fl ? HERO.flash : HERO.stand, this.dir, this.x, FLOOR - SH)
      }
      if (this.inv > 0 && Math.floor(this.inv * 14) & 1) return
      const x = this.x
      const st = this.state
      const latched = this.latched && Math.floor(performance.now() / 90) & 1
      if (st === 'ball' || st === 'morph' || st === 'unmorph') {
        if (st !== 'ball') return blit(c, HERO.crouch, this.dir, x, FLOOR - 21)
        const f = (Math.floor(this.leg) * (this.dir > 0 ? 1 : 3)) & 3
        const glow = s.actors.some((a) => a.isBomb) && Math.floor(performance.now() / 120) & 1
        return c.drawImage((glow ? BALL_GLOW : BALL)[f], Math.round(x + 3), Math.round(FLOOR - 11 - (this.hopY || 0)))
      }
      if (st === 'spin') {
        const f = (Math.floor(this.jt * 16) * (this.dir > 0 ? 1 : 3)) & 3
        const y = Math.round(FLOOR - 17 - this.jy)
        c.drawImage(SPIN[f], Math.round(x) + 1, y)
        c.drawImage(AURA[Math.floor(this.jt * 12) & 1], Math.round(x) - 2, y - 3)
        return
      }
      if (st === 'kneel') return blit(c, HERO.kneel, this.dir, x, FLOOR - 22)
      if (st === 'fanfare') return blit(c, HERO.front, 1, x, FLOOR - SH)
      if (st === 'face') return blit(c, HERO.face, 1, x, FLOOR - SH)
      let img
      if (st === 'run') img = (this.aim === 'diag' || this.aim === 'up' ? HERO.runDiag : HERO.run)[Math.floor(this.leg) & 3]
      else img = this.aim === 'up' ? HERO.up : this.aim === 'diag' ? HERO.diag : HERO.stand
      blit(c, img, this.dir, x, FLOOR - SH + (latched ? 1 : 0))
    }
  }

  // ---- shots, bombs, pickups ----------------------------------------------------
  class Shot {
    constructor(s, kind, x, y, vx, vy) {
      this.s = s
      this.kind = kind
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.life = 1.6
      this.z = 6
      this.moving = true
    }
    update(dt, now, s) {
      this.life -= dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.life <= 0 || this.x < -6 || this.x > s.W + 6 || this.y < -6 || this.y > FLOOR) {
        this.dead = true
        return FAST
      }
      for (const e of enemies(s)) {
        const b = e.box
        if (b && this.x > b.x0 - 2 && this.x < b.x1 + 2 && this.y > b.y0 - 2 && this.y < b.y1 + 2) {
          this.dead = true
          e.shot(this.kind, this)
          return FAST
        }
      }
      return FAST
    }
    draw(c) {
      if (this.kind === 'missile') {
        if (Math.abs(this.vy) > Math.abs(this.vx)) c.drawImage(MISSILE_V, Math.round(this.x - 2), Math.round(this.y - 3))
        else c.drawImage(MISSILE[this.vx > 0 ? 1 : -1], Math.round(this.x - 4), Math.round(this.y - 2))
      } else c.drawImage(BEAM, Math.round(this.x - 1), Math.round(this.y - 1))
    }
  }
  class Bomb {
    constructor(s, x, y) {
      this.s = s
      this.isBomb = true
      this.x = x
      this.y = y
      this.t = 0.8
      this.z = 4
    }
    update(dt, now, s) {
      this.t -= dt
      if (this.t > 0) return FAST
      this.dead = true
      boom(s, this.x + 2, this.y + 2, 12, ['Y', 'w', 'O'])
      const hero = s.data.hero
      for (const e of enemies(s)) {
        const b = e.box
        if (!b) continue
        const cx = (b.x0 + b.x1) / 2
        const cy = (b.y0 + b.y1) / 2
        if (Math.abs(cx - this.x) < 16 && Math.abs(cy - this.y) < 26) e.bombed()
      }
      // a bomb under the ball pops it into the air (the bomb jump)
      if (hero.state === 'ball' && Math.abs(hero.x + 9 - this.x - 2) < 8) hero.hop = 0.45
      return FAST
    }
    draw(c) {
      c.drawImage(BOMB[Math.floor(this.t * 10) & 1], Math.round(this.x), Math.round(this.y))
    }
  }
  class Orb {
    constructor(s, x, y) {
      this.s = s
      this.x = x
      this.y = y
      this.vy = -30
      this.life = 9
      this.z = 4
      this.pickup = true
    }
    hit(px, py) {
      return Math.abs(px - this.x - 2) < 7 && Math.abs(py - this.y - 2) < 7
    }
    onClick() {
      engage(this.s)
      this.s.data.hero.task = { kind: 'goto', x: this.x - 7, until: performance.now() + 6000 }
    }
    update(dt, now, s) {
      this.life -= dt
      if (this.life <= 0 || !s.lively(now)) {
        this.dead = true
        return FAST
      }
      this.vy = Math.min(60, this.vy + 120 * dt)
      this.y = Math.min(FLOOR - 5, this.y + this.vy * dt)
      const b = s.data.hero.box
      if (this.x + 4 > b.x0 && this.x < b.x1 && this.y + 4 > b.y0) {
        this.dead = true
        s.data.energy = Math.min(99, s.data.energy + 8)
        s.particle({ digits: '+8', x: this.x - 2, y: Math.max(0, this.y - 8), vy: -8, life: 0.8 })
      }
      return FAST
    }
    draw(c) {
      c.drawImage(ORB[Math.floor(this.life * 6) & 1], Math.round(this.x), Math.round(this.y))
    }
  }
  class Tank {
    // the Done prize: an energy tank floats down onto an open spot
    constructor(s, x) {
      this.s = s
      this.x = x
      this.y = -10
      this.z = 4
      this.t = 0
      this.prop = true
    }
    hit(px, py) {
      return px > this.x - 3 && px < this.x + 14 && py > this.y - 3 && py < this.y + 12
    }
    onClick() {
      engage(this.s)
    }
    update(dt, now, s) {
      this.t += dt
      this.y = Math.min(FLOOR - 9, this.y + 22 * dt)
      const hero = s.data.hero
      const b = hero.box
      if (this.y > FLOOR - 12 && this.x + 8 > b.x0 && this.x + 2 < b.x1 && hero.canAct()) {
        this.dead = true
        s.data.tank = null
        s.data.energy = 99
        s.data.tanks = Math.min(6, s.data.tanks + 1)
        hero.state = 'fanfare'
        hero.t = 3.2
        hero.task = null
        hero.x = clamp(hero.x, 1, s.W - SW - 1)
        s.say('ENERGY TANK', hero.cx, 0, { color: '#f8d040', life: 3 })
        for (let i = 0; i < 4; i++) s.particle({ img: BUBBLE['♪'], x: hero.cx + rand(-14, 14), y: rand(6, 14), vy: -5, life: 2.4 })
        boom(s, hero.cx, FLOOR - 14, 18, ['Y', 'w', 'G', 'c'])
      }
      return FAST
    }
    draw(c) {
      c.drawImage(Math.floor(this.t * 6) & 1 ? TANK_GLOW : TANK, Math.round(this.x) - 1, Math.round(this.y) - 1)
    }
  }

  // ---- enemies ----------------------------------------------------------------------
  class Enemy {
    constructor(s, kind) {
      this.s = s
      this.kind = kind
      this.enemy = true
      this.frozen = 0
      this.flash = 0
      this.z = 3
      this.phase = rand(0, 6)
      this.stillFor = 0
    }
    get box() {
      return { x0: this.x, x1: this.x + this.w, y0: this.y, y1: this.y + this.h }
    }
    get moving() {
      return !this.frozen
    }
    hit(px, py) {
      const b = this.box
      return px > b.x0 - 5 && px < b.x1 + 5 && py > b.y0 - 5 && py < b.y1 + 5
    }
    onClick() {
      // point at it and she deals with it
      const s = this.s
      engage(s)
      const hero = s.data.hero
      if (this.kind === 'leech' && this.state === 'latched') return hero.state === 'ball' ? hero.bomb() : hero.morph()
      if (this.kind === 'crawler' && !this.frozen) {
        if (Math.abs(this.x - hero.x) < 40) {
          hero.dir = Math.sign(this.x - hero.x) || 1
          return hero.screw(true)
        }
        hero.task = { kind: 'fight', target: this, until: performance.now() + 8000, plan: 'bomb' }
        return
      }
      if (this.state === 'hanging') this.dive()
      if (hero.state === 'ball') hero.unmorph()
      hero.fireCd = 0
      hero.fire(this.x + this.w / 2, this.y + this.h / 2, this.frozen || this.kind === 'dragon' ? 'missile' : 'beam')
    }
    freeze() {
      this.frozen = this.s.busy ? 5 : 6.5
      this.stillFor = 0
      shatterLite(this.s, this.x + this.w / 2, this.y + this.h / 2)
    }
    shot(kind) {
      if (kind === 'beam' && !this.frozen) return this.freeze()
      if (kind === 'missile' && this.frozen) return this.kill()
      if (kind === 'missile') return this.kill()
      this.flash = 0.15
    }
    bombed() {
      this.kill()
    }
    kill(screw = false) {
      const s = this.s
      if (this.dead) return
      this.dead = true
      const cx = this.x + this.w / 2
      const cy = this.y + this.h / 2
      if (this.frozen) shatter(s, cx, cy)
      else boom(s, cx, cy, screw ? 16 : 12)
      s.particle({ digits: '100', x: cx - 6, y: clamp(cy - 10, 0, FLOOR - 8), vy: -6, life: 0.9 })
      drop(s, cx - 2, cy)
    }
    leave() {
      this.leaving = true
    }
    tickFrozen(dt) {
      this.stillFor += dt
      this.frozen -= dt
      if (this.frozen <= 0) this.frozen = 0
    }
  }
  function shatterLite(s, x, y) {
    s.burst(x, y, 5, ['c', 'w'])
  }

  class Crawler extends Enemy {
    constructor(s) {
      super(s, 'crawler')
      this.w = 12
      this.h = 9
      const left = s.data.hero.cx > s.W / 2
      this.x = left ? -12 : s.W
      this.y = FLOOR - 9
      this.vx = (left ? 1 : -1) * (s.busy ? 12 : 9)
      this.harm = 5
    }
    get moving() {
      return !this.frozen
    }
    update(dt, now, s) {
      this.phase += dt * 6
      if (this.frozen) {
        this.tickFrozen(dt)
        return FAST
      }
      if (!s.lively(now) || this.leaving) {
        // scuttle off the nearer edge
        this.leaving = true
        this.vx = (this.x + 6 < s.W / 2 ? -1 : 1) * 45
      }
      this.x += this.vx * dt
      if (this.x < -14 || this.x > s.W + 2) this.dead = true
      return FAST
    }
    bump() {}
    draw(c) {
      const img = this.frozen ? (this.frozen < 1.2 && Math.floor(this.frozen * 8) & 1 ? ZOOM[0] : ZOOM_ICE) : ZOOM[Math.floor(this.phase) & 1]
      blit(c, img, this.vx > 0 ? 1 : -1, this.x, this.y)
    }
  }

  class Flyer extends Enemy {
    constructor(s) {
      super(s, 'flyer')
      this.w = 16
      this.h = 6
      const left = s.data.hero.cx > s.W / 2
      this.x = left ? -16 : s.W
      this.y = FLOOR - rand(18, 24)
      this.vx = (left ? 1 : -1) * (s.busy ? 26 : 20)
      this.harm = 5
    }
    shot(kind) {
      // armoured: the beam only freezes it, a missile breaks it
      if (kind === 'beam' && !this.frozen) return this.freeze()
      if (kind === 'missile') return this.kill()
      this.flash = 0.15
    }
    bombed() {}
    update(dt, now, s) {
      this.phase += dt * 6
      if (this.frozen) {
        this.tickFrozen(dt)
        return FAST
      }
      if (!s.lively(now) || this.leaving) {
        this.leaving = true
        this.vx = (this.x + 8 < s.W / 2 ? -1 : 1) * 60
      }
      this.x += this.vx * dt
      if (this.x < -18 || this.x > s.W + 2) this.dead = true
      return FAST
    }
    bump() {}
    draw(c) {
      const img = this.frozen ? (this.frozen < 1.2 && Math.floor(this.frozen * 8) & 1 ? RIP[0] : RIP_ICE) : RIP[Math.floor(this.phase) & 1]
      blit(c, img, this.vx > 0 ? -1 : 1, this.x, this.y)
    }
  }

  class Diver extends Enemy {
    constructor(s) {
      super(s, 'diver')
      this.w = 10
      this.h = 10
      const hero = s.data.hero
      // hang ahead of her, out over open floor
      this.x = clamp(hero.cx + hero.dir * rand(40, 120), 4, s.W - 14)
      this.y = -10
      this.state = 'drop-in'
      this.harm = 6
      this.vy = 0
    }
    get moving() {
      return this.state !== 'hanging' && !this.frozen
    }
    dive() {
      if (this.state !== 'hanging') return
      this.state = 'dive'
      this.vy = 20
      this.s.poke()
    }
    shot(kind) {
      if (kind === 'beam' && !this.frozen) {
        this.freeze()
        return
      }
      this.kill()
    }
    update(dt, now, s) {
      this.phase += dt * 10
      if (this.frozen) {
        this.tickFrozen(dt)
        if (this.state === 'dive' && this.y + this.h < FLOOR) this.y = Math.min(FLOOR - this.h, this.y + 30 * dt)
        return FAST
      }
      const hero = s.data.hero
      if (this.state === 'drop-in') {
        this.y = Math.min(0, this.y + 20 * dt)
        if (this.y >= 0) this.state = 'hanging'
        return FAST
      }
      if (this.state === 'hanging') {
        if (!s.lively(now)) {
          this.dead = true
          return FAST
        }
        this.hangT = (this.hangT || 0) + dt
        if (Math.abs(hero.cx - this.x - 5) < 22 || this.hangT > 14) this.dive()
        return SLOW
      }
      // diving, spinning
      this.vy = Math.min(90, this.vy + 140 * dt)
      this.y += this.vy * dt
      this.x += clamp(hero.cx - this.x - 5, -1, 1) * 10 * dt
      if (this.y + this.h >= FLOOR) {
        // burrows in and bursts into four shards
        this.dead = true
        boom(this.s, this.x + 5, FLOOR - 3, 8, ['q', 'Q', 'w'])
        for (const [vx, vy] of [[-40, -40], [-20, -60], [20, -60], [40, -40]]) s.spawn(new Shard(s, this.x + 4, FLOOR - 4, vx, vy))
      }
      return FAST
    }
    draw(c) {
      const img = this.frozen ? DIVER_ICE : DIVER[this.state === 'dive' ? Math.floor(this.phase) & 1 : 0]
      blit(c, img, 1, this.x, this.y)
    }
  }
  class Shard {
    constructor(s, x, y, vx, vy) {
      this.s = s
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.life = 0.8
      this.z = 4
    }
    update(dt, now, s) {
      this.life -= dt
      this.vy += 120 * dt
      this.x += this.vx * dt
      this.y = Math.min(FLOOR - 2, this.y + this.vy * dt)
      const hero = s.data.hero
      const b = hero.box
      if (this.x > b.x0 && this.x < b.x1 && this.y > b.y0) {
        hero.hurt(4, this.x)
        this.dead = true
      }
      if (this.life <= 0) this.dead = true
      return FAST
    }
    draw(c) {
      c.drawImage(SHARD, Math.round(this.x), Math.round(this.y))
    }
  }

  class Leech extends Enemy {
    constructor(s) {
      super(s, 'leech')
      this.w = 18
      this.h = 14
      const hero = s.data.hero
      const left = hero.cx > s.W / 2
      this.x = left ? -18 : s.W
      this.y = rand(0, 6)
      this.vx = 0
      this.vy = 0
      this.state = 'float'
      this.hp = 3
      this.harm = 0
      // sometimes she doesn't notice this one until it's on her head
      this.ignored = Math.random() < (s.busy ? 0.25 : 0.5)
      this.noticeAt = performance.now() + rand(6000, 11000)
      this.z = 6
    }
    get moving() {
      return !this.frozen
    }
    shot(kind) {
      if (this.state === 'latched') return
      if (kind === 'beam' && !this.frozen) {
        this.freeze()
        this.state = 'float'
        this.vx = 0
        this.vy = 0
        return
      }
      if (kind === 'missile' && this.frozen) {
        this.hp--
        this.flash = 0.2
        if (this.hp <= 0) this.kill()
        return
      }
      // a beam or missile while it is thawed just knocks it back
      this.vx = -this.vx * 0.5
      this.flash = 0.15
    }
    bombed() {
      if (this.state === 'latched') {
        const hero = this.s.data.hero
        hero.latched = null
        this.state = 'stunned'
        this.t = 1.4
        this.vy = -45
        this.vx = rand(-25, 25)
        this.ignored = false
      }
    }
    update(dt, now, s) {
      this.phase += dt * 4
      if (this.flash > 0) this.flash -= dt
      const hero = s.data.hero
      if (this.frozen) {
        this.tickFrozen(dt)
        if (this.frozen <= 0) this.state = 'float'
        return FAST
      }
      if (this.state === 'latched') {
        if (hero.latched !== this) {
          this.state = 'stunned'
          this.t = 1
          this.vy = -30
          return FAST
        }
        this.x = hero.x + 1
        const top = hero.small ? FLOOR - 11 - (hero.hopY || 0) : hero.y
        this.y = Math.max(-2, top - 9 + (Math.floor(this.phase * 2) & 1))
        return FAST
      }
      if (this.state === 'stunned') {
        this.t -= dt
        this.vy *= 1 - 2 * dt
        this.vx *= 1 - 2 * dt
        this.x += this.vx * dt
        this.y = clamp(this.y + this.vy * dt, 0, FLOOR - this.h)
        if (this.t <= 0) this.state = 'float'
        return FAST
      }
      if (this.ignored && now > this.noticeAt) this.ignored = false
      if (!s.lively(now) || this.leaving) {
        this.leaving = true
        this.vx = this.x + 9 < s.W / 2 ? -24 : 24
        this.x += this.vx * dt
        this.y = Math.max(-2, this.y - 6 * dt)
        if (this.x < -20 || this.x > s.W + 2) this.dead = true
        return FAST
      }
      // home in on the cursor if it lingers nearby (it wants to latch onto it), else her helmet
      const c = s.cursor
      let tx = hero.x + 1
      let ty = hero.y - 9
      if (c && c.y < H + 4 && now - c.t < 1500 && Math.hypot(c.x - this.x - 9, c.y - this.y - 7) < 70) {
        tx = c.x - 9
        ty = clamp(c.y - 7, -2, FLOOR - this.h)
      } else if (hero.small || hero.state === 'spin') ty = 0
      const close = Math.hypot(tx - this.x, ty - this.y) < 30
      const max = close ? 40 : s.busy ? 22 : 16
      this.vx = clamp(this.vx + clamp((tx - this.x) * 1.4, -40, 40) * dt, -max, max)
      this.vy = clamp(this.vy + clamp((ty - this.y) * 1.4, -40, 40) * dt, -max, max)
      if (close) {
        this.vx = clamp((tx - this.x) * 3, -max, max)
        this.vy = clamp((ty - this.y) * 3, -max, max)
      }
      this.x += this.vx * dt
      this.y = clamp(this.y + this.vy * dt + Math.sin(this.phase) * 0.12, -2, FLOOR - this.h)
      if (!hero.small && hero.state !== 'gone' && hero.state !== 'dying' && hero.state !== 'spin' && hero.state !== 'fanfare' && hero.state !== 'face' && !hero.latched && Math.abs(this.x - hero.x - 1) < 4 && Math.abs(this.y - (hero.y - 9)) < 4) {
        this.state = 'latched'
        hero.latched = this
        hero.latchT = 0
        s.particle({ img: BUBBLE['!'], x: hero.x + 16, y: Math.max(0, hero.y - 2), life: 0.8 })
      }
      return FAST
    }
    draw(c) {
      let img = MET[Math.floor(this.phase) & 1]
      if (this.frozen) img = this.frozen < 1.2 && Math.floor(this.frozen * 8) & 1 ? MET[0] : MET_ICE
      if (this.flash > 0) img = MET_HIT
      blit(c, img, 1, this.x, this.y)
    }
  }

  class Dragon extends Enemy {
    constructor(s) {
      super(s, 'dragon')
      this.w = 32
      this.h = 24
      this.x = s.W + 4
      this.y = -24
      this.hp = 8
      this.harm = 8
      this.state = 'enter'
      this.dir = -1
      this.fireAt = performance.now() + 2500
      this.z = 2
      this.homeX = s.W * 0.65
    }
    get box() {
      return { x0: this.x + 2, x1: this.x + 30, y0: this.y + 2, y1: this.y + 22 }
    }
    freeze() {
      this.flash = 0.12
    }
    shot(kind) {
      this.flash = 0.18
      this.hp -= kind === 'missile' ? 1 : 0.34
      if (this.hp <= 0) this.kill(false)
    }
    bombed() {}
    kill() {
      const s = this.s
      if (this.dead) return
      this.dead = true
      for (let i = 0; i < 4; i++) boom(s, this.x + rand(4, 28), this.y + rand(4, 20), 10, ['V', 'v', 'Y', 'w', 'O'])
      s.particle({ digits: '1000', x: this.x + 8, y: clamp(this.y, 0, 20), vy: -6, life: 1.2 })
      drop(s, this.x + 10, this.y + 10)
      drop(s, this.x + 20, this.y + 10)
      s.data.dragonAt = performance.now() + 45000
    }
    update(dt, now, s) {
      this.phase += dt * 6
      if (this.flash > 0) this.flash -= dt
      const hero = s.data.hero
      this.age = (this.age || 0) + dt
      if (!s.busy || this.leaving || this.age > 32) {
        // flies off
        this.leaving = true
        this.x += 50 * dt
        this.y -= 20 * dt
        if (this.x > s.W + 4 || this.y < -30) this.dead = true
        return FAST
      }
      if (this.state === 'enter') {
        this.x += (this.homeX - this.x) * 1.5 * dt
        this.y += (2 - this.y) * 1.5 * dt
        if (Math.abs(this.x - this.homeX) < 4) this.state = 'hover'
        return FAST
      }
      // hover over her, swaying, and spit fireballs that bounce along the floor
      const tx = clamp(hero.cx - 16 + Math.sin(this.phase * 0.25) * 50, 0, s.W - 32)
      this.x += clamp(tx - this.x, -30, 30) * dt
      this.y = 1 + Math.sin(this.phase * 0.5) * 2
      this.dir = hero.cx < this.x + 16 ? -1 : 1
      if (now >= this.fireAt) {
        this.fireAt = now + rand(1400, 2600)
        s.spawn(new Fireball(s, this.x + (this.dir < 0 ? 4 : 26), this.y + 6, this.dir * rand(30, 50)))
      }
      return FAST
    }
    draw(c) {
      const img = this.flash > 0 ? DRAGON_HIT : DRAGON[Math.floor(this.phase / 2) & 1]
      c.drawImage(img[this.dir], Math.round(this.x) - 1, Math.round(this.y) - 1)
    }
  }
  class Fireball {
    constructor(s, x, y, vx) {
      this.s = s
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = -10
      this.bounces = 2
      this.z = 4
      this.moving = true
    }
    update(dt, now, s) {
      this.vy += 160 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.y >= FLOOR - 4) {
        this.y = FLOOR - 4
        this.vy = -60
        if (--this.bounces < 0) this.dead = true
      }
      const b = s.data.hero.box
      if (this.x + 3 > b.x0 && this.x < b.x1 && this.y + 3 > b.y0 && this.y < b.y1) {
        s.data.hero.hurt(5, this.x)
        this.dead = true
        boom(s, this.x, this.y, 5, ['f', 'F'])
      }
      if (this.x < -5 || this.x > s.W + 5) this.dead = true
      return FAST
    }
    draw(c) {
      c.drawImage(FIREBALL[Math.floor(this.y / 3) & 1], Math.round(this.x), Math.round(this.y))
    }
  }

  // ---- director -------------------------------------------------------------------
  function spawnEnemy(s) {
    const d = s.data
    const now = performance.now()
    const list = enemies(s)
    const has = (k) => list.some((e) => e.kind === k)
    const w = [
      ['crawler', 3],
      ['flyer', 2],
      ['diver', 2],
      ['leech', has('leech') ? 0 : 2],
    ]
    let tot = w.reduce((a, b) => a + b[1], 0)
    let r = Math.random() * tot
    let kind = 'crawler'
    for (const [k, n] of w) {
      if ((r -= n) < 0) {
        kind = k
        break
      }
    }
    if (kind === 'crawler') {
      s.spawn(new Crawler(s))
      if (s.busy && Math.random() < 0.4) d.nextCrawler = now + 1800
    } else if (kind === 'flyer') s.spawn(new Flyer(s))
    else if (kind === 'diver') {
      const n = s.busy ? 2 : 1
      for (let i = 0; i < n; i++) s.spawn(new Diver(s))
    } else s.spawn(new Leech(s))
  }

  registerConcept({
    key: 'suitexplorer',
    title: 'Power-suit explorer',
    blurb:
      'The hunter patrols the bar in her armoured suit: crawlers creep along the floor (she curls into a ball and bombs them, or spin-attacks through), flyers come in at chest height (the ice beam freezes them, a missile breaks the block), divers hang from the top and swoop, and a leech drifts in to latch onto her helmet and drain her energy until she curls up and bombs it off. Now and then she rolls under the title laying bombs. <b>Click</b> an enemy to have her freeze it, then click again for a missile; click the hunter for a spin attack, double-click to morph, click the ball to bomb, drag her somewhere. Move over the bar and she turns and aims at you, and a leech will try to latch onto your pointer. Work brings a winged dragon for a boss fight, Done drops an energy tank with the item fanfare, and when it is quiet she kneels.',
    setup(s) {
      s.data = { energy: 99, tanks: 0, nextAt: performance.now() + 2500, dragonAt: performance.now() + 9000, engagedUntil: 0, tank: null }
      s.data.hero = new Hunter(s)
      s.actors.push(s.data.hero)
    },
    relayout(s) {
      const hero = s.data.hero
      hero.x = clamp(hero.x, 1, s.W - SW - 1)
      hero.restX = null
      if (hero.task && hero.task.x !== undefined) hero.task.x = clamp(hero.task.x, 1, s.W - SW - 1)
      for (const e of enemies(s)) e.x = clamp(e.x, -e.w, s.W)
      if (s.data.tank) s.data.tank.x = clamp(s.data.tank.x, 2, s.W - 12)
    },
    // keyboard: A/D run, W screw attack, S ball form, Space fires (a bomb in the ball); W in the ball stands up
    onKey(s, k, down) {
      const sm = s.data.hero
      if (!down || !sm) return
      if (sm.state === 'kneel') sm.state = 'stand'
      sm.task = null
      if (k === 'fire') {
        if (sm.state === 'ball') return sm.bomb()
        const ahead = enemies(s).find((e) => e.frozen && (e.x + e.w / 2 - sm.cx) * sm.dir > 0 && Math.abs(e.x + e.w / 2 - sm.cx) < 140)
        if (ahead) sm.fire(ahead.x + ahead.w / 2, ahead.y + ahead.h / 2, 'missile')
        else sm.fire(sm.cx + sm.dir * 100, sm.y + 11)
      } else if (k === 'up') {
        if (sm.state === 'ball') return sm.unmorph()
        const kd = keyDir(s)
        if (kd) sm.dir = kd
        sm.screw(!!kd)
      } else if (k === 'down') {
        if (sm.state === 'ball') sm.bomb()
        else sm.morph()
      }
    },
    onBusy(s) {
      const d = s.data
      d.nextAt = Math.min(d.nextAt, performance.now() + 800)
      d.dragonAt = Math.min(d.dragonAt, performance.now() + 7000)
    },
    onDone(s) {
      const d = s.data
      const hero = d.hero
      for (const e of enemies(s)) {
        if (e.frozen) e.kill()
        else e.leave()
      }
      if (!d.tank) {
        const x = openSpot(s, clamp(hero.x + hero.dir * 60, 10, s.W - 30), 12)
        d.tank = s.spawn(new Tank(s, x + 4))
      }
      d.nextAt = performance.now() + 9000
    },
    onNap(s) {
      for (const e of enemies(s)) e.leave()
    },
    drawFront(s, c) {
      // EN..99 in the corner, with a square per energy tank
      const d = s.data
      const x = 3
      c.globalAlpha = 0.9
      c.drawImage(GLYPH.E, x, 2)
      c.drawImage(GLYPH.N, x + 4, 2)
      c.drawImage(GLYPH['.'], x + 7, 2)
      c.drawImage(GLYPH['.'], x + 9, 2)
      drawDigits(c, String(d.energy).padStart(2, '0'), x + 13, 2)
      for (let i = 0; i < d.tanks; i++) c.drawImage(GLYPH.T, x + 22 + i * 3, 3)
      c.globalAlpha = 1
    },
    update(s, dt, now) {
      const d = s.data
      if (!s.lively(now)) return Infinity
      const live = enemies(s).filter((e) => !e.leaving && e.kind !== 'dragon').length
      const boss = enemies(s).some((e) => e.kind === 'dragon')
      const max = boss ? 1 : s.busy ? 3 : 2
      if (live < max && now >= d.nextAt && !d.tank) {
        spawnEnemy(s)
        d.nextAt = now + (s.busy ? rand(2500, 5000) : rand(5000, 9000))
      }
      if (d.nextCrawler && now >= d.nextCrawler) {
        d.nextCrawler = 0
        s.spawn(new Crawler(s))
      }
      if (s.busy && now >= d.dragonAt && !enemies(s).some((e) => e.kind === 'dragon') && !d.tank) {
        s.spawn(new Dragon(s))
        d.dragonAt = now + 60000
      }
      return Math.max(FAST, Math.min(d.nextAt - now, 30000 - (now - s.lastTouch) + 50))
    },
  })
})()
