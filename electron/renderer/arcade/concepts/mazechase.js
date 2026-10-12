;(() => {
  // Maze chase, big: a 21 px round chomper and four ghosts play a
  // one-lane maze along the floor of the bar. A row of dots with four power
  // pellets, fruit, the side tunnel (the bar edges wrap), ghost-eating combos
  // (200/400/800/1600), the death spin, level-clear flash and the three
  // cutscenes (the giant chomper chase, the red ghost's torn sheet, the patched sheet).
  // The ghost house is behind the title.

  // ---- art ----------------------------------------------------------------------
  const GP = {
    y: '#ffff00', r: '#ff0000', p: '#ffb8ff', c: '#00ffff', o: '#ffb852',
    w: '#ffffff', e: '#2121de', b: '#2121de', f: '#ffb8ae', P: '#ffb8de', q: '#f08aa8',
    a: '#9aa0aa', A: '#d8dce2', g: '#2fbf3f', G: '#7a4a1a', R: '#ff2020', O: '#ffb84a', k: '#c97a12',
    K: '#00d8ff', n: '#ff6060',
  }
  const PR = 10 // chomper radius: 21 px sprite
  const GW = 20 // ghost width and height
  const CY = FLOOR - 10.5 // the lane's centre line

  /** The chomper as a disc with a wedge cut out, facing angle `face`. */
  function chompRows(r, half, face = 0) {
    const rows = []
    for (let j = 0; j <= 2 * r; j++) {
      let row = ''
      for (let i = 0; i <= 2 * r; i++) {
        const dx = i - r
        const dy = j - r
        let inside = dx * dx + dy * dy <= (r + 0.35) * (r + 0.35)
        if (inside && half > 0 && (dx || dy)) {
          let a = Math.atan2(dy, dx) - face
          a = Math.atan2(Math.sin(a), Math.cos(a))
          if (Math.abs(a) < half) inside = false
        }
        row += inside ? 'y' : '.'
      }
      rows.push(row)
    }
    return rows
  }
  const CHOMP = [0, 0.34, 0.68].map((h) => pairOutlined(chompRows(PR, h), GP))
  const GIANT = [0, 0.34, 0.68].map((h) => pairOutlined(chompRows(16, h), GP))
  const DEATH = [0.25, 0.55, 0.85, 1.15, 1.45, 1.75, 2.05, 2.35, 2.65, 2.9, 3.1].map((h) => outline(sprite(chompRows(PR, h, -Math.PI / 2), GP)))
  const POP = (() => {
    const g = Array.from({ length: 21 }, () => Array(21).fill('.'))
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      for (let d = 5; d <= 9; d++) g[Math.round(10 + Math.sin(a) * d)][Math.round(10 + Math.cos(a) * d)] = 'y'
    }
    return sprite(g.map((r) => r.join('')), GP)
  })()

  const DOME = [[7, 12], [5, 14], [4, 15], [3, 16], [2, 17], [2, 17], [1, 18], [1, 18]]
  const SKIRT = [
    ['kkkkkkkkkkkkkkkkkkkk', 'kkkk.kkkk..kkkk.kkkk', 'kkk...kk....kk...kkk'],
    ['kkkkkkkkkkkkkkkkkkkk', 'kk.kkkk.kkkk.kkkk.kk', 'k...kk...kk...kk...k'],
  ]
  /** A ghost grid: body letter k, eyes looking 'r' | 'u' | 'd', skirt frame. */
  function ghostGrid(k, look, legs) {
    const g = []
    for (let j = 0; j < 17; j++) {
      const [a, b] = DOME[j] || [0, 19]
      g.push([...Array(GW)].map((_, i) => (i >= a && i <= b ? k : '.')))
    }
    for (const r of SKIRT[legs]) g.push([...r].map((ch) => (ch === 'k' ? k : '.')))
    if (look) {
      const ox = look === 'r' ? 1 : 0
      const oy = look === 'u' ? -1 : 0
      for (const ex of [3, 11]) {
        const W5 = ['.ww.', 'wwww', 'wwww', 'wwww', '.ww.']
        W5.forEach((r, j) => [...r].forEach((ch, i) => ch === 'w' && (g[5 + oy + j][ex + ox + i] = 'w')))
        const [px, py] = look === 'r' ? [2, 1] : look === 'u' ? [1, 0] : [1, 3]
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g[5 + oy + py + dy][ex + ox + px + dx] = 'e'
      }
    }
    return g
  }
  const rowsOf = (g) => g.map((r) => r.join(''))
  const GHOST = {}
  const GHOST_UP = {}
  for (const k of ['r', 'p', 'c', 'o']) {
    GHOST[k] = [0, 1].map((l) => pairOutlined(rowsOf(ghostGrid(k, 'r', l)), GP))
    GHOST_UP[k] = outline(sprite(rowsOf(ghostGrid(k, 'u', 0)), GP))
  }
  function scaredGrid(body, face, legs) {
    const g = ghostGrid(body, null, legs)
    for (const [x, y] of [[6, 7], [7, 7], [6, 8], [7, 8], [12, 7], [13, 7], [12, 8], [13, 8]]) g[y][x] = face
    ;[3, 4, 7, 8, 11, 12, 15, 16].forEach((x) => (g[12][x] = face))
    ;[2, 5, 6, 9, 10, 13, 14, 17].forEach((x) => (g[13][x] = face))
    return outline(sprite(rowsOf(g), GP))
  }
  const SCARED = [0, 1].map((l) => scaredGrid('b', 'f', l))
  const FLASH = [0, 1].map((l) => scaredGrid('w', 'n', l))
  const EYES = pairOutlined(rowsOf(ghostGrid('.', 'r', 0)).slice(3, 11), GP)

  // the red ghost's torn sheet: the back of the skirt is ripped off and a pink leg shows
  const TORN = (() => {
    const g = ghostGrid('r', 'd', 0)
    for (let j = 12; j < 20; j++) for (let i = 0; i < 8; i++) g[j][i] = '.'
    const art = ['.r.r.rrr', '......rr', '.......r', '...PP...', '...PP...', '..PPP...', '..PP....', '.PPPq...']
    art.forEach((r, j) => [...r].forEach((ch, i) => ch !== '.' && (g[12 + j][i] = ch)))
    return pairOutlined(rowsOf(g), GP)
  })()
  const PATCHED = [0, 1].map((l) => {
    const g = ghostGrid('r', 'r', l)
    const patch = ['wnwnw', 'nnnnn', 'wnnnw', 'nnnnn', 'wnwnw']
    patch.forEach((r, j) => [...r].forEach((ch, i) => (g[11 + j][1 + i] = ch)))
    return pairOutlined(rowsOf(g), GP)
  })
  const RAG = pairOutlined(['rrrr.......', 'rrrrrr.r...', '.rrrrrrrr.r', '..rr.rrrrrr', '.....rr.rr.'], GP)
  const SCRAP = sprite(['rr.', 'rrr', '.rr', 'r.r'], GP)
  const WORM = [
    ['..........wwww..', '.........wewwew.', '...PP...PPPPPPP.', '..PPPP.PPPPPPPPP', '.PPPPPPPPP.PPPP.', 'PPP..PPP.....PP.', 'PP.........q.q..'],
    ['..........wwww..', '.........wewwew.', '.........PPPPPP.', '.PPPPPPPPPPPPPPP', 'PPPPPPPPPPPPPPP.', 'PPPPPPPPPPPPP...', '.q.q.......q.q..'],
  ].map((r) => pairOutlined(r, GP))
  const NAIL = sprite(['aAa', '.A.', '.a.', '.a.', '.a.', '.a.', '.a.'], GP)

  const DOT = sprite(['fff', 'fff', 'fff'], GP)
  const POWER = sprite(['..ffff..', '.ffffff.', 'ffffffff', 'ffffffff', 'ffffffff', 'ffffffff', '.ffffff.', '..ffff..'], GP)
  const FRUIT = [
    { pts: 100, img: ['.........gg.', '.......gg.g.', '......g...g.', '.....g....g.', '...rrg...g..', '..rrrrr.rrr.', '.rrwrrrrrrrr', '.rwrrrrwrrrr', '.rrrrrrrwrrr', '.rrrrr.rrrrr', '..rrr...rrr.'] },
    { pts: 300, img: ['....gggg....', '...gggggg...', '..RRRgggRR..', '.RRwRRRRRRR.', '.RRRRRwRRwR.', '.RwRRRRRRRR.', '.RRRRwRRwRR.', '..RwRRRRRR..', '..RRRRwRR...', '...RRRRR....', '....RRR.....'] },
    { pts: 500, img: ['.....gg.....', '....g.gg....', '...OOOOO....', '..OOOOOOO...', '.OOOOOOOOO..', '.OOOOOOOwO..', '.OOOOOOOOO..', '.OOOOOOOOO..', '..OOOOOOO...', '...OOOOO....'] },
    { pts: 700, img: ['.....G......', '.....G.gg...', '..RRRGRRR...', '.RRRRRRRRR..', '.RwRRRRRRR..', '.RwRRRRRRR..', '.RRRRRRRRR..', '.RRRRRRRRR..', '..RRRRRRR...', '...RR.RR....'] },
    { pts: 5000, img: ['...KKKK.....', '..KK..KK....', '..K....K....', '..KK..KK....', '...KKKK.....', '....AA......', '....AA......', '....AAAA....', '....AA......', '....AAA.....', '....AA......'] },
  ].map((f) => ({ pts: f.pts, img: outline(sprite(f.img, GP)) }))
  const NICK = { r: 'SHADOW "BLINKY"', p: 'SPEEDY "PINKY"', c: 'BASHFUL "INKY"', o: 'POKEY "CLYDE"' }
  const COL = { r: '#ff4040', p: '#ffb8ff', c: '#00ffff', o: '#ffb852' }
  const ORDER = ['r', 'p', 'c', 'o']

  // ---- lane ---------------------------------------------------------------------
  // Centres run from -12 to W+12; past either end you come out the other side.
  const M = 12
  const L = (s) => s.W + 2 * M
  const wrapX = (s, x) => (x < -M ? x + L(s) : x >= s.W + M ? x - L(s) : x)
  /** Distance travelled going `dir` from a to b, through the tunnel if need be. */
  const ahead = (s, a, b, dir) => ((((b - a) * dir) % L(s)) + L(s)) % L(s)
  const dist = (s, a, b) => Math.min(ahead(s, a, b, 1), ahead(s, a, b, -1))
  const shortDir = (s, a, b) => (ahead(s, a, b, 1) <= ahead(s, a, b, -1) ? 1 : -1)
  const house = (s) => {
    const t = s.fixture('title')
    return t.x + t.w / 2
  }
  const houseHalf = (s) => s.fixture('title').w / 2 + GW / 2 + 2
  /** Open stretches of floor between furniture, for resting. */
  function restSpot(s, near) {
    const spans = s.fix.map((f) => [f.x - 16, f.x + f.w + 16]).sort((a, b) => a[0] - b[0])
    let x = 16
    let best = null
    for (const [a, b] of [...spans, [s.W - 16, s.W + 99]]) {
      if (a - x >= 30) {
        const c = (x + a) / 2
        if (!best || Math.abs(c - near) < Math.abs(best - near)) best = c
      }
      x = Math.max(x, b)
    }
    return best ?? s.W * 0.3
  }
  // keyboard: A/D send him left or right (he keeps going, as in the arcade), S holds him still,
  // W or Space gulps a power pellet
  const keying = (s, now) => now - (s.keyAt ?? -1e9) < 9000
  const keyDir = (s) => (s.keys && s.keys.has('left') !== s.keys.has('right') ? (s.keys.has('left') ? -1 : 1) : 0)
  const engaged = (s, now) => keying(s, now) || now - (s.data.lastClick || -1e9) < 9000 || (s.cursor && now - s.cursor.t < 1200 && s.cursor.y < H + 2)

  function clip(c, s) {
    const t = s.fixture('title')
    c.save()
    c.beginPath()
    c.rect(-50, 0, t.x + 50, H)
    c.rect(t.x + t.w, 0, s.W - t.x - t.w + 50, H)
    c.clip()
  }

  // ---- chomper ----------------------------------------------------------------------
  class Chomper {
    constructor(s) {
      this.s = s
      this.x = 40
      this.dir = 1
      this.anim = 0
      this.power = 0
      this.combo = 0
      this.turnCool = 0
      this.dying = 0
      this.sleeping = false
      this.grabbable = true
      this.z = 3
    }
    get y() {
      return FLOOR
    }
    get moving() {
      return !this.sleeping && !this.dying && !this.s.data.show
    }
    get asleep() {
      return this.sleeping
    }
    hit(px, py) {
      return !this.s.data.show && !this.dying && dist(this.s, px, this.x) < 14 && py > CY - 14 && py < FLOOR + 2
    }
    grab() {
      this.held = true
      this.s.data.lastClick = performance.now()
    }
    drag(p) {
      this.x = clamp(p.x, 4, this.s.W - 4)
      this.liftY = clamp(p.y - CY, -14, 0)
    }
    drop() {
      this.held = false
      this.liftY = 0
      this.s.data.lastClick = performance.now()
    }
    gulp(now) {
      const s = this.s
      if (this.power <= 0 && now - (this.lastGulp || 0) > 7000 && s.data.ghosts.some((g) => g.mode === 'out')) {
        this.lastGulp = now
        this.givePower(6)
        s.say('50', this.x, CY - 24, { color: '#ffb8ae', life: 0.9, vy: -8 })
        return true
      }
      return false
    }
    onClick() {
      const s = this.s
      const now = performance.now()
      s.data.lastClick = now
      if (this.sleeping) {
        this.yawn = 1.2
        this.sleeping = false
        s.particle({ img: BUBBLE['!'], x: this.x - 2, y: CY - 22, life: 0.8 })
        return
      }
      // he swallows your click like a power pellet
      if (this.power <= 0 && now - (this.lastGulp || 0) > 7000 && s.data.ghosts.some((g) => g.mode === 'out')) {
        this.lastGulp = now
        this.givePower(6)
        s.say('50', this.x, CY - 24, { color: '#ffb8ae', life: 0.9, vy: -8 })
      } else {
        this.dir = -this.dir
        this.turnCool = 0.8
        this.target = null
      }
    }
    givePower(sec) {
      this.power = sec
      this.combo = 0
      for (const g of this.s.data.ghosts) if (g.mode === 'out' || g.mode === 'scared') g.scare(sec)
    }
    respawn(x) {
      this.x = x
      this.dir = x < this.s.W / 2 ? 1 : -1
      this.dying = 0
      this.power = 0
      this.flee = null
      this.target = null
    }
    update(dt, now, s) {
      const d = s.data
      this.anim += dt
      this.turnCool -= dt
      if (d.show) return Infinity
      if (this.held) return FAST
      if (this.dying) {
        this.dying -= dt
        if (this.dying > 0) return FAST
        d.died(now)
        return FAST
      }
      if (now < d.freezeUntil || d.state === 'clear' || d.state === 'ready') return FAST
      if (this.power > 0) this.power -= dt
      if (this.yawn > 0) {
        this.yawn -= dt
        return FAST
      }
      const ghosts = d.ghosts
      const lively = s.lively(now)
      if (keying(s, now) && lively) {
        // the player drives: no autopilot, no flinching from ghosts
        const kd = keyDir(s)
        if (kd) this.dir = kd
        this.sleeping = false
        this.sleptAt = 0
        this.target = null
        this.flee = null
        if (!s.keys.has('down')) this.x += this.dir * (this.power > 0 ? 48 : 44) * dt
        const before = this.x
        this.x = wrapX(s, this.x)
        if (this.x !== before) this.wrapped = true
        this.eat(s, now)
        return FAST
      }

      // ---- choose where to go -------------------------------------------------
      let tx = null
      const user = engaged(s, now)
      const steering = user && s.cursor && now - s.cursor.t < 1500
      if (this.target && (this.target.mode === 'eyes' || this.target.mode === 'home' || now > this.targetUntil)) this.target = null
      if (!lively && !s.busy) {
        if (!d.restX) d.restX = restSpot(s, this.x)
        tx = d.restX
      } else if (this.target) tx = this.target.x
      else if (steering) tx = s.cursor.x
      else if (this.power > 0 && ghosts.some((g) => g.mode === 'scared')) tx = ghosts.filter((g) => g.mode === 'scared').reduce((a, b) => (dist(s, this.x, a.x) < dist(s, this.x, b.x) ? a : b)).x
      else if (d.fruit) tx = d.fruit.x
      else if (d.dots.length) {
        let best = 1e9
        for (const p of d.dots) {
          const dd = dist(s, this.x, p.x)
          if (dd < best) {
            best = dd
            tx = p.x
          }
        }
      }

      if (tx === null || (!lively && !s.busy && Math.abs(tx - this.x) < 2)) {
        // home and dry: curl up, a few z's, then park
        this.sleeping = true
        this.sleptAt ||= now
        if (now - this.sleptAt < 6000) {
          if (now - (this.lastZ || 0) > 1500) {
            this.lastZ = now
            s.particle({ img: ZZ, x: this.x + 6, y: CY - 16, vx: 3, vy: -5, life: 2.2, fade: true })
          }
          return 1500
        }
        return Infinity
      }
      this.sleeping = false
      this.sleptAt = 0

      // ---- steer, with the autopilot keeping clear of hunting ghosts ----------
      const hunters = this.power > 0 || now < d.graceUntil ? [] : ghosts.filter((g) => g.mode === 'out')
      const gap = (dir) => {
        let m = 1e9
        for (const g of hunters) m = Math.min(m, ahead(s, this.x, g.x, dir))
        return m
      }
      const pilot = !steering && !this.target && (lively || s.busy)
      if (pilot) {
        const threat = hunters.find((g) => ahead(s, this.x, g.x, this.dir) < 60)
        if (threat && !this.flee && gap(-this.dir) > gap(this.dir) + 20) {
          this.flee = threat
          this.wrapped = false
          this.dir = -this.dir
          this.turnCool = 1
        }
        if (this.flee && (this.power > 0 || this.wrapped || this.flee.mode !== 'out' || ahead(s, this.x, this.flee.x, -this.dir) > 150)) {
          this.flee = null
          this.calmUntil = now + 1500
        }
        // boxed in? make for the nearest power pellet in the way
        if (threat && gap(-this.dir) < 70) {
          const pel = d.dots.find((p) => p.power && ahead(s, this.x, p.x, this.dir) < gap(this.dir))
          if (pel) this.flee = null
        }
      }
      if (this.turnCool <= 0 && !this.flee && Math.abs(tx - this.x) > 3) {
        const r = ahead(s, this.x, tx, 1)
        const l = ahead(s, this.x, tx, -1)
        let want = r <= l ? 1 : -1
        if (steering && !this.target) want = tx > this.x ? 1 : -1 // follow the pointer, no tunnel tricks
        if (pilot) {
          const blocked = (dir, dd) => gap(dir) < dd + 20
          if (blocked(want, Math.min(r, l)) && !blocked(-want, Math.max(r, l))) want = -want
          if (want !== this.dir && now < (this.calmUntil || 0) && gap(want) < 120) want = this.dir
        }
        if (want !== this.dir) {
          this.dir = want
          this.turnCool = user ? 0.25 : 0.45
        }
      }
      const near = Math.abs(tx - this.x) <= 3 && (steering || !lively)
      if (!near) this.x += this.dir * (this.target ? 60 : this.power > 0 ? 48 : s.busy ? 44 : 38) * dt
      const before = this.x
      this.x = wrapX(s, this.x)
      if (this.x !== before) this.wrapped = true
      this.eat(s, now)
      return near && !ghosts.some((g) => g.moving) ? SLOW : FAST
    }
    eat(s, now) {
      const d = s.data
      const mouth = this.x + this.dir * 5
      for (let i = d.dots.length - 1; i >= 0; i--) {
        const p = d.dots[i]
        if (Math.abs(p.x - mouth) > 4) continue
        d.dots.splice(i, 1)
        d.eaten++
        d.score += p.power ? 50 : 10
        if (p.power) this.givePower(s.busy ? 7 : 6)
        if (d.eaten === 20 || d.eaten === Math.floor(d.total * 0.7)) d.dropFruit(now)
      }
      if (d.fruit && Math.abs(d.fruit.x - mouth) < 6) {
        s.say(String(d.fruit.pts), d.fruit.x, CY - 8, { color: '#ffb8ff', life: 1.6 })
        d.fruit = null
      }
      for (const g of d.ghosts) {
        if (dist(s, g.x, this.x) > 13 || g.inHouse) continue
        if (g.mode === 'scared') {
          this.combo = Math.min(4, this.combo + 1)
          const pts = String(200 * 2 ** (this.combo - 1))
          d.score += +pts
          s.say(pts, g.x, CY - 6, { color: '#00ffff', life: 1.1 })
          g.eaten(now)
          d.freezeUntil = now + 600
          if (this.target === g) this.target = null
          // the others notice and bolt
          for (const o of d.ghosts) if (o !== g && o.mode === 'scared') o.dir = Math.sign(o.x - this.x) || 1
        } else if (g.mode === 'out') {
          if (now < d.graceUntil) {
            // just respawned: the ghost loses him for a moment
            g.dir = Math.sign(g.x - this.x) || 1
            g.turnCool = 2
          } else {
            this.dying = 1.9
            this.anim = 0
            d.freezeUntil = now + 900
          }
        }
      }
    }
    draw(c, s) {
      const d = s.data
      if (d.show) return
      const now = performance.now()
      const x = Math.round(this.x) - PR - 1
      const y = Math.round(CY + (this.liftY || 0)) - PR - 1
      if (this.dying) {
        const t = 1.9 - this.dying
        if (t < 0.9) c.drawImage(CHOMP[0][this.dir], x, y)
        else if (t < 1.75) c.drawImage(DEATH[clamp(Math.floor((t - 0.9) / 0.077), 0, 10)], x, y)
        else c.drawImage(POP, x + 1, y + 1)
        return
      }
      if (now < d.freezeUntil && !this.dying && d.state === 'play') return // the score shows where he is
      let f = this.sleeping ? 1 : 0
      if (this.yawn > 0) f = 2
      else if (!this.sleeping && d.state === 'play') f = [0, 1, 2, 1][Math.floor(this.anim * 16) % 4]
      c.drawImage(CHOMP[f][this.dir], x, y)
    }
  }

  // ---- ghosts ---------------------------------------------------------------------
  class Ghost {
    constructor(s, k, i) {
      this.s = s
      this.k = k
      this.i = i
      this.mode = 'home'
      this.x = house(s)
      this.dir = i % 2 ? 1 : -1
      this.anim = Math.random()
      this.turnCool = 0
      this.releaseAt = 0
      this.scaredUntil = 0
      this.inHouse = true
      this.peekAt = 0
      this.peek = false
      this.z = 2
    }
    get y() {
      return FLOOR
    }
    get moving() {
      return this.mode !== 'home'
    }
    get prop() {
      return this.mode === 'home'
    }
    get asleep() {
      return this.mode === 'home'
    }
    hit(px, py) {
      if (this.s.data.show || this.inHouse || (this.mode !== 'out' && this.mode !== 'scared')) return false
      return dist(this.s, px, this.x) < 13 && py > FLOOR - GW - 4 && py < FLOOR + 2
    }
    onClick() {
      const s = this.s
      const now = performance.now()
      s.data.lastClick = now
      const hero = s.data.hero
      // a blue one: the chomper pounces on it. A hunting one: spook it blue first.
      if (this.mode === 'out') {
        this.scare(5)
        s.particle({ img: BUBBLE['!'], x: this.x - 2, y: FLOOR - GW - 9, life: 0.7 })
      }
      hero.target = this
      hero.targetUntil = now + 5000
      hero.turnCool = 0
      hero.flee = null
      hero.sleeping = false
    }
    onDblClick() {
      // their names from the attract screen
      this.s.say(NICK[this.k], this.x, FLOOR - GW - 9, { color: COL[this.k], life: 1.6 })
    }
    scare(sec) {
      if (this.mode !== 'out' && this.mode !== 'scared') return
      if (this.mode === 'out') this.dir = -this.dir // ghosts reverse when frightened
      this.mode = 'scared'
      this.scaredUntil = performance.now() + sec * 1000
      this.turnCool = 0.6
    }
    eaten(now) {
      this.mode = 'eyes'
      this.hideUntil = now + 600
    }
    goHome(now, delay) {
      this.mode = 'home'
      this.inHouse = true
      this.x = house(this.s)
      this.releaseAt = now + delay
    }
    target(s, now, hero) {
      const d = s.data
      const corner = this.i % 2 ? 18 : s.W - 18
      if (now < d.scatterUntil || now < d.graceUntil) return this.k === 'r' && d.dots.length < d.total * 0.2 ? hero.x : this.i % 2 ? 18 : s.W - 18
      const leader = d.ghosts[0]
      switch (this.k) {
        case 'r':
          return hero.x
        case 'p':
          return hero.x + hero.dir * 70 // cut him off from the front
        case 'c':
          return hero.x + (hero.x - leader.x) * 0.8 + rand(-30, 30) // pincer with the red ghost, unpredictably
        default:
          return dist(s, this.x, hero.x) > 110 ? hero.x : corner // the orange ghost loses his nerve up close
      }
    }
    update(dt, now, s) {
      const d = s.data
      const hero = d.hero
      this.anim += dt
      this.turnCool -= dt
      if (d.show) return Infinity
      const lively = s.lively(now) || s.busy
      if (this.mode === 'home') {
        this.inHouse = true
        if (lively && d.state === 'play' && now > this.releaseAt && !hero.dying) {
          this.mode = 'out'
          this.x = house(s)
          this.dir = hero.x > this.x ? -1 : 1
          this.turnCool = 1
          return FAST
        }
        // the odd peek over the title while they wait their turn
        if (lively && !s.busy) {
          if (now > this.peekAt) {
            this.peek = !this.peek && Math.random() < 0.6
            this.peekAt = now + (this.peek ? rand(900, 1600) : rand(2500, 7000))
          }
          return Math.max(FAST, Math.min(this.peekAt, this.releaseAt > now ? this.releaseAt : Infinity) - now)
        }
        this.peek = false
        return lively ? Math.max(FAST, this.releaseAt - now) : Infinity
      }
      if (now < d.freezeUntil || d.state !== 'play' || hero.dying) return FAST
      const hx = house(s)
      this.inHouse = dist(s, this.x, hx) < houseHalf(s) && (this.mode === 'eyes' || this.mode === 'return' || this.inHouse)
      if (this.mode === 'eyes' || this.mode === 'return') {
        // eaten (or bedtime): straight back to the house behind the title
        const sp = this.mode === 'eyes' ? 120 : 46
        this.dir = shortDir(s, this.x, hx)
        const dd = dist(s, this.x, hx)
        this.x = wrapX(s, this.x + this.dir * Math.min(dd, sp * dt))
        if (dist(s, this.x, hx) < 1) this.goHome(now, lively ? (s.busy ? 1200 : 2500) : 0)
        return FAST
      }
      if (!lively) {
        this.mode = 'return'
        return FAST
      }
      if (this.mode === 'scared') {
        if (now > this.scaredUntil) {
          this.mode = 'out'
          this.turnCool = 0.5
        } else if (this.turnCool <= 0) {
          const away = -shortDir(s, this.x, hero.x)
          if (away !== this.dir && dist(s, this.x, hero.x) < 120) {
            this.dir = away
            this.turnCool = 1.2
          }
        }
        this.x = wrapX(s, this.x + this.dir * (d.doneRush ? 13 : 19) * dt)
        return FAST
      }
      if (this.turnCool <= 0 && !hero.dying) {
        const t = clamp(this.target(s, now, hero), 6, s.W - 6)
        if (dist(s, t, this.x) > 10) {
          const want = this.k === 'p' ? shortDir(s, this.x, t) : t > this.x ? 1 : -1
          if (want !== this.dir) this.dir = want
        }
        this.turnCool = this.k === 'c' ? rand(0.5, 1.6) : rand(0.8, 1.3)
      }
      // only the pink ghost slips through the tunnel on purpose; the rest stay in the bar
      let sp = s.busy ? 37 : 33
      if (this.k === 'r') sp += d.dots.length < d.total * 0.2 ? 8 : 3 // late-level speed-up
      if (this.inHouse) sp = 22
      this.x = wrapX(s, this.x + this.dir * sp * dt)
      if (this.k !== 'p' && (this.x < 8 || this.x > s.W - 8) && this.turnCool <= 0) {
        this.dir = this.x < 8 ? 1 : -1
        this.turnCool = 1
      }
      return FAST
    }
    draw(c, s) {
      const d = s.data
      if (d.show || d.state === 'clear') return
      const now = performance.now()
      const legs = Math.floor(this.anim * 6) % 2
      const x = Math.round(this.x) - GW / 2 - 1
      const y = FLOOR - GW - 1
      if (this.mode === 'home') {
        if (!this.peek) return
        const t = s.fixture('title')
        const px = Math.round(t.x + 6 + ((this.i + 0.5) / 4) * Math.max(0, t.w - 12)) - GW / 2 - 1
        c.drawImage(GHOST_UP[this.k], 0, 0, GW + 2, 10, px, t.y - 10, GW + 2, 10)
        return
      }
      if (d.hero.dying && d.hero.dying < 1.4) return // they vanish for the death spin
      if (this.mode === 'eyes' && now < this.hideUntil) return
      if (this.inHouse) clip(c, s)
      const cur = s.cursor
      if (this.mode === 'eyes') c.drawImage(EYES[this.dir], x, y + 3)
      else if (this.mode === 'scared') {
        const left = this.scaredUntil - now
        c.drawImage(left < 1800 && Math.floor(left / 200) % 2 ? FLASH[legs] : SCARED[legs], x, y)
      } else if (cur && cur.y < FLOOR - GW && Math.abs(cur.x - this.x) < 16 && now - cur.t < 3000) c.drawImage(GHOST_UP[this.k], x, y) // looking up at you
      else c.drawImage(GHOST[this.k][legs][this.dir], x, y)
      if (this.inHouse) c.restore()
    }
  }

  // ---- cutscenes ------------------------------------------------------------------
  const SHOWS = ['giant', 'torn', 'patched']
  class Show {
    constructor(s, kind) {
      this.s = s
      this.kind = kind
      this.t = 0
      this.z = 5
      this.v = Math.max(55, (s.W + 80) / 9)
      this.nail = Math.round(s.W * 0.42)
      this.done = false
    }
    get moving() {
      return true
    }
    get x() {
      return this.px ?? -50
    }
    get y() {
      return FLOOR
    }
    hit(px, py) {
      return this.bx !== undefined && Math.abs(px - this.bx) < 14 && py > FLOOR - 24
    }
    onClick() {
      // a little encouragement for the villain
      this.s.data.lastClick = performance.now()
      this.s.particle({ img: BUBBLE['?'], x: this.bx - 2, y: FLOOR - 32, life: 0.8 })
    }
    update(dt, now, s) {
      this.t += dt
      const t = this.t
      const v = this.v
      const W = s.W
      this.px = this.bx = this.gx = this.wx = undefined
      if (this.kind === 'giant') {
        const t1 = (W + 2 * M + 50) / (v * 1.05)
        if (t < t1) {
          this.px = W + M - v * t
          this.bx = W + M + 50 - v * 1.05 * t
        } else if (t < t1 + 1) {
          // empty stage for a beat
        } else {
          const u = t - t1 - 1
          this.bx = -M + v * 0.85 * u
          this.gx = -M - 80 + v * 0.95 * u
          if (this.gx > W + 20) this.done = true
        }
      } else if (this.kind === 'torn') {
        const snagAt = (W + M + 45 - (this.nail - 6)) / v
        if (t < snagAt) {
          this.px = W + M - v * t
          this.bx = W + M + 45 - v * t
          this.stretch = 0
        } else {
          this.px = W + M - v * t
          const u = t - snagAt
          if (u < 1.6) {
            this.bx = this.nail - 6 - 22 * u + 4 * u * u
            this.stretch = this.nail - (this.bx + 9)
          } else {
            if (!this.ripped) {
              this.ripped = true
              s.burst(this.nail, FLOOR - 6, 5, ['r', 'w'])
            }
            const w = u - 1.6
            const stop = this.nail - 6 - 22 * 1.6 + 4 * 1.6 * 1.6 - 8
            this.bx = w < 3 ? stop : stop - 22 * (w - 3)
            this.look = w > 0.5 && w < 3
            if (w > 0.6 && !this.bang) {
              this.bang = true
              s.particle({ img: BUBBLE['!'], x: stop - 2, y: FLOOR - 31, life: 1.4 })
            }
            if (this.bx < -M - 10) this.done = true
          }
        }
      } else {
        const t1 = (W + 2 * M + 60) / v
        if (t < t1) {
          this.px = W + M - v * t
          this.bx = W + M + 45 - v * t
        } else if (t > t1 + 0.8) {
          this.wx = -24 + v * 0.55 * (t - t1 - 0.8)
          if (this.wx > W + 24) this.done = true
        }
      }
      return FAST
    }
    draw(c, s) {
      const f = Math.floor(this.t * 16) % 4
      const leg = Math.floor(this.t * 6) % 2
      const gy = FLOOR - GW - 1
      if (this.kind === 'torn') {
        c.drawImage(NAIL, this.nail - 1, FLOOR - 7)
        if (this.ripped) c.drawImage(SCRAP, this.nail - 3, FLOOR - 9)
      }
      if (this.px !== undefined) c.drawImage(CHOMP[[0, 1, 2, 1][f]][-1], Math.round(this.px) - PR - 1, Math.round(CY) - PR - 1)
      if (this.bx !== undefined) {
        const x = Math.round(this.bx) - GW / 2 - 1
        if (this.kind === 'giant' && this.gx !== undefined) c.drawImage(SCARED[leg], x, gy)
        else if (this.kind === 'giant') c.drawImage(GHOST.r[leg][-1], x, gy)
        else if (this.kind === 'torn') {
          if (!this.ripped) {
            if (this.stretch > 0) {
              // the sheet stretching back to the nail
              c.fillStyle = '#ff0000'
              const x0 = Math.round(this.bx + 8)
              for (let i = 0; i < this.stretch; i++) {
                const h = Math.max(1, Math.round(6 - (i / this.stretch) * 5))
                c.fillRect(x0 + i, FLOOR - 3 - h, 1, h)
              }
            }
            c.drawImage(GHOST.r[leg][-1], x, gy)
          } else c.drawImage(TORN[-1], x, gy)
        } else {
          c.drawImage(RAG[-1], x + GW - 2, FLOOR - 6)
          c.drawImage(PATCHED[leg][-1], x, gy)
        }
      }
      if (this.gx !== undefined) c.drawImage(GIANT[[0, 1, 2, 1][f]][1], Math.round(this.gx) - 17, FLOOR - 34)
      if (this.wx !== undefined) c.drawImage(WORM[leg][1], Math.round(this.wx) - 9, FLOOR - 8)
    }
  }

  // ---- director -------------------------------------------------------------------
  function layDots(s, keep = 1) {
    const d = s.data
    const sp = Math.max(13, s.W / 40)
    const xs = []
    for (let x = 12; x < s.W - 10; x += sp) {
      const blocked = s.fix.some((f) => x > f.x - 4 && x < f.x + f.w + 4 && f.y <= CY + 3 && f.y + f.h >= CY - 3)
      if (!blocked) xs.push(Math.round(x))
    }
    const powerAt = new Set([0.08, 0.36, 0.64, 0.92].map((k) => Math.round(k * (xs.length - 1))))
    d.dots = xs.map((x, i) => ({ x, power: powerAt.has(i) })).filter(() => Math.random() < keep)
    d.total = xs.length
    d.eaten = d.total - d.dots.length
  }
  function startLevel(s, now) {
    const d = s.data
    d.level++
    layDots(s)
    d.fruit = null
    d.state = 'ready'
    d.readyUntil = now + 1800
    d.hero.respawn(restSpot(s, s.W * 0.2))
    d.ghosts.forEach((g, i) => g.goHome(now, 1800 + i * (s.busy ? 1500 : 3000)))
    const t = s.fixture('title')
    if (s.lively(now) || s.busy) s.say('READY!', t.x + t.w / 2, H - 9, { color: '#ffff00', life: 1.7 })
  }

  registerConcept({
    key: 'mazechase',
    title: 'Maze chase',
    chosen: true,
    blurb:
      'A full-size round chomper works along a row of dots and power pellets on the floor of the bar, and the four ghosts come out of their house behind the title: the red one chases, the pink one cuts him off through the side tunnel, the cyan one works with the red one, and the orange one loses his nerve up close. A power pellet turns them blue; he eats them for 200, 400, 800 and 1600, and their eyes fly home. Fruit appears twice a level, and clearing the dots plays one of the cutscenes: the giant chomper chase, the red ghost\'s torn sheet, or the patched sheet. <b>Move the cursor</b> over the bar and he follows it; <b>click a ghost</b> to turn it blue and send him after it, <b>click the chomper</b> to give him a power pellet, drag him out of trouble, and double-click a ghost for its name. Ghosts look up at the cursor when it hovers over them. Leave it and he plays on his own. Work brings all four ghosts out, Done gives him a free pellet and a fruit, and when it is quiet the ghosts go home and he sleeps.',
    setup(s) {
      const now = performance.now()
      const d = (s.data = { dots: [], total: 0, eaten: 0, level: 0, fruit: null, score: 0, state: 'play', freezeUntil: 0, scatterUntil: 0, nextScatter: now + 20000, graceUntil: 0, lastClick: -1e9, show: null, showN: Math.floor(Math.random() * 3), resting: false, restX: 0 })
      d.hero = new Chomper(s)
      d.ghosts = ORDER.map((k, i) => new Ghost(s, k, i))
      s.actors.push(d.hero, ...d.ghosts)
      d.dropFruit = (now) => {
        const lv = Math.min(FRUIT.length - 1, Math.floor((d.level - 1) / 2))
        d.fruit = { x: restSpot(s, d.hero.x + d.hero.dir * s.W * 0.4), ...FRUIT[lv], until: now + 10000 }
      }
      d.died = (now) => {
        d.hero.respawn(restSpot(s, d.hero.x < s.W / 2 ? s.W * 0.8 : s.W * 0.2))
        d.graceUntil = now + 16000
        d.scatterUntil = now + 8000
        d.state = 'ready'
        d.readyUntil = now + 1500
        d.ghosts.forEach((g, i) => g.goHome(now, 1500 + i * 2500))
        const t = s.fixture('title')
        s.say('READY!', t.x + t.w / 2, H - 9, { color: '#ffff00', life: 1.4 })
      }
      startLevel(s, now)
    },
    relayout(s) {
      const d = s.data
      const left = d.total ? d.dots.length / d.total : 1
      layDots(s, left)
      d.restX = 0
      if (d.fruit) d.fruit.x = clamp(d.fruit.x, 12, s.W - 12)
      for (const a of [d.hero, ...d.ghosts]) a.x = clamp(a.x, 0, s.W)
      for (const g of d.ghosts) if (g.mode === 'home') g.x = house(s)
      if (d.show) {
        d.show.dead = true
        d.show = null
        startLevel(s, performance.now())
      }
      s.poke()
    },
    update(s, dt, now) {
      const d = s.data
      const lively = s.lively(now) || s.busy
      if (d.show) {
        if (d.show.done || !lively) {
          d.show.dead = true
          d.show = null
          startLevel(s, now)
        }
        return FAST
      }
      if (d.state === 'ready') {
        if (now > d.readyUntil) d.state = 'play'
        return FAST
      }
      if (d.state === 'clear') {
        if (now - d.clearAt > 2200) {
          d.state = 'play'
          if (lively) {
            d.show = s.spawn(new Show(s, SHOWS[d.showN++ % SHOWS.length]))
            d.dots = []
          } else startLevel(s, now)
        }
        return FAST
      }
      // bedtime: everyone goes home, he walks to an open stretch and curls up
      if (!lively) {
        if (!d.resting) {
          d.resting = true
          d.restAt = now
          d.restX = restSpot(s, d.hero.x)
          d.hero.power = 0
          d.fruit = null
          for (const g of d.ghosts) if (g.mode === 'out' || g.mode === 'scared') g.mode = 'return'
        }
        // backstop: whatever is still out after a while is tidied away
        if (now - d.restAt > 18000 && !d.hero.dying) {
          for (const g of d.ghosts) if (g.mode !== 'home') g.goHome(now, 0)
          d.hero.x = d.restX
          d.hero.held = false
        }
        return Infinity
      }
      if (d.resting) {
        d.resting = false
        d.restX = 0
        d.ghosts.forEach((g, i) => g.mode === 'home' && (g.releaseAt = now + 1200 + i * (s.busy ? 1200 : 2600)))
      }
      if (d.fruit && now > d.fruit.until) d.fruit = null
      if (now > d.nextScatter) {
        d.nextScatter = now + rand(22000, 32000)
        d.scatterUntil = now + 6000
      }
      if (d.hero.power <= 0) d.doneRush = false
      if (!d.dots.length && !d.hero.dying && d.state === 'play') {
        d.state = 'clear'
        d.clearAt = now
        d.fruit = null
        for (const g of d.ghosts) g.goHome(now, 99999)
        d.hero.power = 0
      }
      return Infinity
    },
    onKey(s, key, down) {
      const p = s.data.hero
      if (!down || !p || p.held || p.dying || s.data.show) return
      const now = performance.now()
      p.sleeping = false
      if (key === 'left' || key === 'right') {
        p.dir = key === 'left' ? -1 : 1
        p.turnCool = 0
        p.x = wrapX(s, p.x + p.dir * 2) // the turn happens now
      } else if (key === 'up' || key === 'fire') {
        if (!p.gulp(now)) s.say(pick(['wakka', 'wakka wakka']), p.x, CY - 22, { color: '#ffff00', life: 0.7, size: 6, vy: -6 })
      }
      s.poke()
    },
    onBusy(s) {
      const now = performance.now()
      s.data.ghosts.forEach((g, i) => g.mode === 'home' && (g.releaseAt = Math.min(g.releaseAt, now + 800 + i * 1200)))
    },
    onDone(s) {
      const d = s.data
      const now = performance.now()
      if (d.show || d.state !== 'play') return
      // payoff: everyone out, a free power pellet, and a fruit
      d.ghosts.forEach((g) => {
        if (g.mode === 'home') {
          g.mode = 'out'
          g.x = house(s)
          g.dir = g.i % 2 ? 1 : -1
        }
      })
      d.doneRush = true
      d.hero.givePower(9)
      d.hero.sleeping = false
      s.burst(d.hero.x, CY, 10, ['y', 'w'])
      d.dropFruit(now)
    },
    onNap(s) {
      const d = s.data
      if (d.show) {
        d.show.dead = true
        d.show = null
        startLevel(s, performance.now())
      }
    },
    drawBehind(s, c) {
      const d = s.data
      // the maze wall: a blue double line along the floor, flashing white on a clear
      const flash = d.state === 'clear' && Math.floor((performance.now() - d.clearAt) / 250) % 2
      c.fillStyle = flash ? '#ffffff' : '#2121de'
      c.globalAlpha = 0.7
      c.fillRect(0, H - 1, s.W, 1)
      c.globalAlpha = 1
      if (d.show) return
      const blink = Math.floor(performance.now() / 220) % 2 || !s.lively()
      for (const p of d.dots) {
        if (p.power) {
          if (blink) c.drawImage(POWER, p.x - 4, Math.round(CY) - 4)
        } else c.drawImage(DOT, p.x - 1, Math.round(CY) - 1)
      }
      if (d.fruit) c.drawImage(d.fruit.img, d.fruit.x - 7, FLOOR - 15)
    },
  })
})()
