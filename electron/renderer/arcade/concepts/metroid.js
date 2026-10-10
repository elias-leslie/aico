;(() => {
  // Metroid: Samus explores the floor, morph-balls under the furniture (she is
  // too tall to walk under it) and freezes metroids with the ice beam.
  const P = {
    ...PAL,
    O: '#e8862a', R: '#a8341c', y: '#f8d84a', G: '#5ce05a', E: '#151515',
    M: '#8fe07a', m: '#3f9a3a', r: '#e0324a', A: '#e8e2cc',
    c: '#9fe8ff', b: '#3f8fe0', w: '#ffffff',
  }
  const sp = (rows) => pair(rows, P)
  const rot = (rows) => {
    const h = rows.length
    const w = rows[0].length
    const out = []
    for (let c = 0; c < w; c++) {
      let line = ''
      for (let r = h - 1; r >= 0; r--) line += rows[r][c] || '.'
      out.push(line)
    }
    return out
  }
  const rots = (rows) => {
    const o = [rows]
    for (let i = 1; i < 4; i++) o.push(rot(o[i - 1]))
    return o
  }

  // ---- art (all face right) -------------------------------------------------
  // Samus, 10×14: round helmet with visor, big shoulder pads, arm cannon
  const TORSO = ['...OOO....', '..OOOOO...', '..OGGGGO..', '..OGGGyO..', '...OOOO...', '.yyRRRyy..', 'yyyRRRyyyy', '.yRRRROOOy', '..RRyRR...']
  const LEGS = {
    stand: ['..OOOOO...', '.OO..OO...', '.OO...OO..', '.RR...RR..', 'RRR..RRR..'],
    a: ['..OOOO....', '.OO..OO...', 'OO.....OO.', 'RR......RR', 'R.........'],
    b: ['..OOOO....', '...OOO....', '...OO.....', '...RR.....', '..RRR.....'],
    c: ['..OOOO....', '..OO.OO...', '.OO...OO..', 'RR.....RR.', '......RRR.'],
  }
  const AIM_UP = ['...OOO.yy.', '..OOOOOyy.', '..OGGGGyy.', '..OGGGyyy.', '...OOOOyy.', '.yyRRRyyy.', 'yyyRRRyy..', '.yRRRRR...', '..RRyRR...']
  const AIM_DIAG = ['...OOO...y', '..OOOOO.yy', '..OGGGGyy.', '..OGGGyy..', '...OOyy...', '.yyRRyy...', 'yyyRRRy...', '.yRRRRR...', '..RRyRR...']
  const SAM = {
    stand: sp([...TORSO, ...LEGS.stand]),
    run: [sp([...TORSO, ...LEGS.a]), sp([...TORSO, ...LEGS.b]), sp([...TORSO, ...LEGS.c]), sp([...TORSO, ...LEGS.b])],
    up: sp([...AIM_UP, ...LEGS.stand]),
    diag: sp([...AIM_DIAG, ...LEGS.stand]),
    crouch: sp([...TORSO.slice(0, 8), '..RRyRR...', 'RRROORRR..']),
    kneel: sp(['...OOO....', '..OOOOO...', '..OGGGGO..', '..OGGGyO..', '...OOOO...', '.yyRRRyy..', 'yyyRRRyy..', '.yRRRRy...', '..RRyRR...', '..OOOOOO..', 'RRR..RRRR.']),
    front: sp(['...OOOO...', '..OOOOOO..', '..OGGGGO..', '..OGGGGO..', '...OOOO...', 'yyyRRRRyyy', 'yy.RRRR.yy', 'O..RRRR..O', 'O..RyyR..y', '...OOOO...', '..OO..OO..', '..OO..OO..', '..RR..RR..', '.RRR..RRR.']),
    win: sp(['yy.OOOO...', 'yyOOOOOO..', '.yOGGGGO..', '.yOGGGGO..', '.y.OOOO...', '.yyRRRRyyy', '...RRRR.yy', '...RRRR..O', '...RyyR..y', '...OOOO...', '..OO..OO..', '..OO..OO..', '..RR..RR..', '.RRR..RRR.']),
  }
  const BALL = rots(['..OOO..', '.OyRRO.', 'OyRRRRO', 'ORRRRRO', 'ORRRRyO', '.ORRyO.', '..OOO..']).map((r) => sprite(r, P))
  const SPIN = rots(['...OOO...', '..OGGGO..', '.yOOOOOy.', 'yyRRRRRyy', 'yRR...RRy', 'OR.....RO', '.OO...OO.', '..RR.RR..', '...RRR...']).map((r) => sprite(r, P))
  // metroid, 11×9: a jellyfish dome with red nuclei and four mandibles
  const MET_ROWS = [
    ['...mmmmm...', '..mMMwwMm..', '.mMMMwMMMm.', 'mMMrrMrrMMm', 'mMrrrMrrrMm', '.mMrrrrrMm.', '..mmmmmmm..', '..A.A.A.A..', '...A...A...'],
    ['...mmmmm...', '..mMMwwMm..', '.mMMMwMMMm.', 'mMMrrMrrMMm', 'mMrrrMrrrMm', '.mMrrrrrMm.', '..mmmmmmm..', '...A.A.A...', '..A.A.A.A..'],
  ]
  const MET = MET_ROWS.map((r) => sprite(r, P))
  const ICE = sprite(recolor(MET_ROWS[0], { M: 'c', m: 'b', r: 'w', A: 'c' }), P)
  const SHOT = sprite(['.c.', 'cwc', '.c.'], P)
  const BOMB = [sprite(['.E.', 'EyE', '.E.'], P), sprite(['.y.', 'ywy', '.y.'], P)]

  const SW = 10
  const SH = 14
  const MW = 11 // metroid
  const MH = 9
  const MCX = MW / 2
  const MCY = MH / 2

  /** No furniture between the cannon and the target. */
  function clearShot(s, x0, y0, x1, y1) {
    for (let i = 1; i < 12; i++) {
      const x = x0 + ((x1 - x0) * i) / 12
      const y = y0 + ((y1 - y0) * i) / 12
      if (s.fix.some((f) => x > f.x && x < f.x + f.w && y > f.y && y < f.y + f.h)) return false
    }
    return true
  }
  const metroids = (s) => s.actors.filter((a) => a.metroid && !a.dead)
  /** Furniture low enough to hit a standing Samus over [x0,x1]. */
  const blocked = (s, x0, x1) => s.fix.some((f) => x1 > f.x && x0 < f.x + f.w && f.y + f.h > FLOOR - SH)

  // ---- Samus ------------------------------------------------------------------
  class Samus {
    constructor(s) {
      this.s = s
      this.x = 90
      this.dir = 1
      this.state = 'stand'
      this.t = 0
      this.jy = 0
      this.jt = 0
      this.vx = 0
      this.goal = null
      this.pauseUntil = 0
      this.fireCd = 0
      this.pose = 'stand'
      this.leg = 0
      this.latched = null
      this.drain = 0
      this.winT = 0
      this.z = 3
    }
    get y() {
      return FLOOR - SH - this.jy
    }
    get head() {
      return { x: this.x + 4, y: FLOOR - SH - this.jy }
    }
    get small() {
      return this.state === 'ball' || this.state === 'crouch' || this.state === 'rise'
    }
    get moving() {
      return this.state === 'run' || this.state === 'ball' || this.state === 'spin'
    }
    get asleep() {
      return (this.state === 'kneel' || this.state === 'ball') && !this.s.lively()
    }
    hit(px, py) {
      return px > this.x && px < this.x + SW && py > (this.small ? FLOOR - 8 : this.y)
    }
    onClick() {
      if (this.state === 'ball') this.bomb()
      else this.spinJump(true)
    }
    speed() {
      return this.s.busy ? 34 : 26
    }
    /** Fire the ice beam toward a point (stops to aim; a ball lays a bomb instead). */
    fireAt(p, force = false) {
      const s = this.s
      if (this.state === 'ball' || this.state === 'crouch' || this.state === 'rise') {
        if (force) this.bomb()
        return
      }
      if (this.state === 'spin' || this.state === 'win' || (!force && this.fireCd > 0)) return
      const cx = this.x + 5
      const dx = p.x - cx
      const dy = p.y - (this.y + 6)
      if (Math.abs(dx) > 2) this.dir = Math.sign(dx)
      const adx = Math.abs(dx)
      const ady = -dy
      this.pose = ady > adx * 2 ? 'up' : ady > adx * 0.4 ? 'diag' : 'stand'
      const ox = this.pose === 'up' ? this.x + (this.dir > 0 ? 7.5 : 2.5) : this.pose === 'diag' ? this.x + (this.dir > 0 ? 10 : 0) : this.x + (this.dir > 0 ? 10 : 0)
      const oy = this.pose === 'up' ? this.y - 1 : this.pose === 'diag' ? this.y : this.y + 7
      const L = Math.hypot(p.x - ox, p.y - oy) || 1
      s.spawn(new Beam(ox, oy, ((p.x - ox) / L) * 150, ((p.y - oy) / L) * 150))
      this.state = 'shoot'
      this.t = 0.35
      this.fireCd = s.busy ? 0.6 : 0.8
    }
    bomb() {
      if (this.s.actors.some((a) => a.isBomb)) return
      this.s.spawn(new Bomb(this.x + 3, FLOOR - 3))
    }
    morph() {
      if (this.state === 'ball' || this.state === 'crouch') return
      this.state = 'crouch'
      this.t = 0.15
    }
    unmorph() {
      if (blocked(this.s, this.x, this.x + SW)) return false
      this.state = 'rise'
      this.t = 0.15
      return true
    }
    spinJump(force = false) {
      if (this.state !== 'stand' && this.state !== 'run') return
      const s = this.s
      const reach = this.dir * 26
      const x0 = Math.min(this.x, this.x + reach) - 2
      const x1 = Math.max(this.x, this.x + reach) + SW + 2
      // only in the open: the arc would clip the furniture otherwise
      if (s.fix.some((f) => x1 > f.x && x0 < f.x + f.w) || x0 < 0 || x1 > s.W) {
        if (force) {
          this.state = 'spin'
          this.jt = 0
          this.vx = 0
        }
        return
      }
      this.state = 'spin'
      this.jt = 0
      this.vx = this.dir * 42
    }
    update(dt, now, s) {
      const d = s.data
      this.fireCd -= dt
      const lively = s.lively(now)
      // timed transitions
      if (this.t > 0) {
        this.t -= dt
        if (this.t > 0) return FAST
        if (this.state === 'crouch') this.state = 'ball'
        else if (this.state === 'rise' || this.state === 'shoot') {
          this.state = 'stand'
          this.pose = 'stand'
        }
      }
      // a metroid on my head: curl up and bomb it off
      if (this.latched) {
        this.drain += dt
        if (this.latched.dead || this.latched.state !== 'latched') this.latched = null
        else if (this.drain > 0.9 && !this.small) this.morph()
        else if (this.state === 'ball' && !s.actors.some((a) => a.isBomb)) this.bomb()
        if (this.latched) return FAST
      }
      if (this.state === 'spin') {
        this.jt += dt
        this.jy = 80 * this.jt - 130 * this.jt * this.jt
        this.x = clamp(this.x + this.vx * dt, 1, s.W - SW - 1)
        if (this.jy <= 0) {
          this.jy = 0
          this.state = 'stand'
        }
        return FAST
      }
      if (this.state === 'win') {
        this.winT -= dt
        if (this.winT > 0) return Math.max(FAST, this.winT * 1000)
        this.state = 'stand'
      }
      // rest: kneel where there is headroom, otherwise stay curled up
      if (!lively) {
        if (this.state === 'ball' && !blocked(s, this.x, this.x + SW)) this.unmorph()
        else if (this.state === 'stand' || this.state === 'run') this.state = 'kneel'
        if (this.state === 'kneel' || this.state === 'ball') return Infinity
        return FAST
      }
      if (this.state === 'kneel') this.state = 'stand'
      // done: get out into the open and strike the pose
      if (d.victory) {
        const free = !blocked(s, this.x, this.x + SW)
        if (this.state === 'ball' && free) this.unmorph()
        else if (this.state !== 'ball' && free) {
          d.victory = false
          this.state = 'win'
          this.winT = 4
          s.burst(this.x + 5, this.y, 14, ['y', 'w', 'G', 'c'])
          return FAST
        }
      }
      // pick something to shoot
      const targets = metroids(s).filter((m) => m.state !== 'leaving' && m.state !== 'latched' && !m.ignored)
      let tgt = null
      let best = 120
      for (const m of targets) {
        const dd = Math.abs(m.x + MCX - this.x - 5)
        if (dd < best && clearShot(s, this.x + 5, this.y + 3, m.x + MCX, m.y + MCY)) {
          best = dd
          tgt = m
        }
      }
      // where to go
      const c = s.cursor
      let goal = null
      if (d.victory) goal = this.nearestOpen(s)
      else if (c && c.y < H + 6 && !tgt) goal = clamp(c.x - SW / 2, 1, s.W - SW - 1)
      else {
        if (now >= this.pauseUntil && (this.goal === null || Math.abs(this.goal - this.x) < 2)) {
          // mostly somewhere with headroom; now and then a spot under the furniture
          for (let i = 0; i < 6; i++) {
            goal = clamp(this.x + pick([-1, 1]) * rand(50, s.busy ? 220 : 140), 2, s.W - SW - 2)
            if (!blocked(s, goal, goal + SW) || Math.random() < 0.15) break
          }
          this.pauseUntil = now + (s.busy ? rand(200, 800) : rand(1200, 3500))
        }
      }
      if (goal !== null && (this.goal === null || Math.abs(goal - this.goal) > 8)) this.goal = goal
      if (tgt && this.state !== 'ball' && this.fireCd <= 0 && (this.state === 'stand' || this.state === 'run')) {
        const delay = tgt.state === 'frozen' ? (s.busy ? 1.2 : 2.5) : 0
        if (tgt.stillFor >= delay) {
          this.fireAt({ x: tgt.x + MCX, y: tgt.y + MCY })
          return FAST
        }
      }
      // move
      const going = this.goal !== null && Math.abs(this.goal - this.x) >= 2 && (now >= this.pauseUntil || c || d.victory)
      if (!going) {
        if (this.state === 'run') this.state = 'stand'
        // parked in a ball under the furniture: roll out once the goal moves away
        if (this.state === 'ball') {
          if (!blocked(s, this.x, this.x + SW)) this.unmorph()
          if (this.state === 'rise') return FAST
        }
        if (tgt || this.fireCd > 0) return FAST
        return now < this.pauseUntil ? Math.max(FAST, this.pauseUntil - now) : this.s.lively(now) ? Math.max(FAST, 30000 - (now - s.lastTouch) + 50) : Infinity
      }
      const want = Math.sign(this.goal - this.x)
      if (this.state === 'ball') {
        this.dir = want
        this.x = clamp(this.x + want * 30 * dt, 1, s.W - SW - 1)
        this.leg += dt * 10
        // pop back up once there is headroom and nothing low just ahead
        const ahead = blocked(s, this.x + want * 4, this.x + SW + want * 4)
        if (!blocked(s, this.x, this.x + SW) && (!ahead || Math.abs(this.goal - this.x) < 3)) this.unmorph()
        return FAST
      }
      if (this.state !== 'stand' && this.state !== 'run') return FAST
      this.dir = want
      // furniture ahead too low to walk under: morph
      if (blocked(s, this.x + want * 3, this.x + SW + want * 3)) {
        this.morph()
        return FAST
      }
      // a frozen metroid sitting in the way: hop it
      const ice = metroids(s).find((m) => m.state === 'frozen' && m.grounded && Math.abs(m.x + MCX - (this.x + 5 + want * 12)) < 7)
      if (ice) {
        this.spinJump(true)
        this.vx = want * 40
        return FAST
      }
      if (s.busy && Math.random() < dt * 0.25) {
        this.spinJump()
        if (this.state === 'spin') return FAST
      }
      this.state = 'run'
      this.x = clamp(this.x + want * this.speed() * dt, 1, s.W - SW - 1)
      this.leg += dt * 9
      return FAST
    }
    nearestOpen(s) {
      for (let r = 0; r < s.W; r += 4)
        for (const x of [this.x - r, this.x + r]) if (x > 2 && x < s.W - SW - 2 && !blocked(s, x - 2, x + SW + 2)) return x
      return this.x
    }
    draw(c, s) {
      if (this.latched && Math.floor(this.drain * 12) % 2) return // flashing while drained
      const x = Math.round(this.x)
      const st = this.state
      if (st === 'ball') c.drawImage(BALL[(Math.floor(this.leg) * (this.dir > 0 ? 1 : 3)) & 3], x + 1, FLOOR - 7)
      else if (st === 'spin') c.drawImage(SPIN[(Math.floor(this.jt * 14) * (this.dir > 0 ? 1 : 3)) & 3], x, Math.round(FLOOR - 10 - this.jy))
      else if (st === 'crouch' || st === 'rise') c.drawImage(SAM.crouch[this.dir], x, FLOOR - 10)
      else if (st === 'kneel') c.drawImage(SAM.kneel[this.dir], x, FLOOR - 11)
      else if (st === 'win') c.drawImage(SAM.win[1], x, FLOOR - SH)
      else if (st === 'shoot') c.drawImage((this.pose === 'up' ? SAM.up : this.pose === 'diag' ? SAM.diag : SAM.stand)[this.dir], x, FLOOR - SH)
      else if (st === 'run') c.drawImage(SAM.run[Math.floor(this.leg) & 3][this.dir], x, FLOOR - SH)
      else c.drawImage(SAM.stand[this.dir], x, FLOOR - SH)
      if (this.asleep && st === 'kneel') c.drawImage(ZZ, x + 9, FLOOR - 15)
    }
  }

  // ---- shots and bombs -----------------------------------------------------------
  class Beam {
    constructor(x, y, vx, vy) {
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.life = 1.2
      this.z = 4
      this.moving = true
    }
    update(dt, now, s) {
      this.life -= dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.life <= 0 || this.x < -3 || this.x > s.W + 3 || this.y < -3 || this.y > FLOOR) {
        this.dead = true
        return FAST
      }
      for (const m of metroids(s)) {
        if (m.state === 'leaving') continue
        if (Math.hypot(m.x + MCX - this.x, m.y + MCY - this.y) < 6.5) {
          this.dead = true
          m.shot(s)
          return FAST
        }
      }
      if (s.fix.some((f) => this.x > f.x && this.x < f.x + f.w && this.y > f.y && this.y < f.y + f.h)) {
        this.dead = true
        s.burst(this.x, this.y, 3, ['c', 'w'])
      }
      return FAST
    }
    draw(c) {
      c.drawImage(SHOT, Math.round(this.x - 1), Math.round(this.y - 1))
    }
  }
  class Bomb {
    constructor(x, y) {
      this.isBomb = true
      this.x = x
      this.y = y
      this.t = 0.7
      this.z = 2
    }
    update(dt, now, s) {
      this.t -= dt
      if (this.t > 0) return FAST
      this.dead = true
      s.burst(this.x + 1, this.y + 1, 12, ['y', 'w', 'O'])
      for (const m of metroids(s))
        if (Math.hypot(m.x + MCX - this.x, m.y + MCY - this.y) < 18) m.blast(s)
      return FAST
    }
    draw(c) {
      c.drawImage(BOMB[Math.floor(this.t * 10) & 1], Math.round(this.x), Math.round(this.y))
    }
  }

  // ---- metroids ------------------------------------------------------------------
  class Metroid {
    constructor(s) {
      this.metroid = true
      this.s = s
      // drift in from the nearer side; on a wide bar, sink in from the top a little way off
      const sx = s.data.samus.x
      const left = sx < s.W / 2
      if (Math.min(sx, s.W - sx) > 220) {
        this.x = clamp(sx + pick([-1, 1]) * rand(110, 200), 4, s.W - MW - 4)
        this.y = -MH
        this.vx = 0
        this.vy = 10
      } else {
        this.x = left ? -MW : s.W
        this.y = rand(2, 8)
        this.vx = left ? 10 : -10
        this.vy = 0
      }
      this.state = 'float'
      this.t = 0
      this.phase = rand(0, 6)
      this.stillFor = 0
      this.grounded = false
      this.flinch = 0
      // sometimes she doesn't notice this one until it is on her head
      this.ignored = Math.random() < (s.busy ? 0.15 : 0.55)
      this.noticeAt = performance.now() + rand(9000, 15000)
      this.z = 5
    }
    get moving() {
      return this.state === 'float' || this.state === 'fall' || this.state === 'stunned'
    }
    get asleep() {
      return this.state === 'frozen'
    }
    hit(px, py) {
      return Math.abs(px - this.x - MCX) < MCX + 1 && Math.abs(py - this.y - MCY) < MCY + 1
    }
    onClick(p) {
      const sam = this.s.data.samus
      sam.fireAt({ x: this.x + MCX, y: this.y + MCY }, true)
    }
    shot(s) {
      if (this.state === 'frozen' || this.state === 'fall') {
        // second hit: shatter
        this.dead = true
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2
          const v = rand(20, 60)
          s.particle({ img: pix(pick(['c', 'w', 'b'])), x: this.x + MCX, y: this.y + MCY, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20, g: 120, life: rand(0.5, 1), fade: true })
        }
        s.particle({ digits: '100', x: this.x, y: clamp(this.y - 6, 0, FLOOR - 8), vy: -6, life: 0.9 })
        // the others back off from the wreck
        for (const o of metroids(s)) if (Math.abs(o.x - this.x) < 60) o.flinch = 1.2
        s.data.lastGone = performance.now()
        return
      }
      if (this.state === 'latched') return
      this.state = 'fall'
      this.vy = 0
      this.vx *= 0.3
      this.stillFor = 0
      this.t = s.busy ? 5 : 7 // seconds frozen once it lands
      s.burst(this.x + MCX, this.y + MCY, 5, ['c', 'w'])
    }
    blast(s) {
      if (this.state !== 'latched' && this.state !== 'float') return
      this.ignored = false
      const sam = s.data.samus
      if (sam.latched === this) sam.latched = null
      this.state = 'stunned'
      this.t = 1.2
      this.vy = -45
      this.vx = rand(-20, 20)
    }
    leave() {
      if (this.state === 'frozen' || this.state === 'fall') return
      this.state = 'leaving'
      this.vx = this.x + MCX < this.s.W / 2 ? -22 : 22
    }
    update(dt, now, s) {
      this.phase += dt * 4
      this.flinch -= dt
      const sam = s.data.samus
      switch (this.state) {
        case 'leaving':
          this.x += this.vx * dt
          this.y = Math.max(1, this.y - 6 * dt)
          if (this.x < -12 || this.x > s.W + 3) {
            this.dead = true
            s.data.lastGone = now
          }
          return FAST
        case 'fall': {
          this.vy = Math.min(this.vy + 120 * dt, 70)
          const py = this.y
          this.y += this.vy * dt
          this.x += this.vx * dt
          const g = s.groundAt(this.x + 1, this.x + MW - 1, py + MH, 1)
          if (this.y + MH >= g) {
            this.y = g - MH
            this.state = 'frozen'
            this.grounded = true
            this.stillFor = 0
          }
          return FAST
        }
        case 'frozen':
          this.stillFor += dt
          if (!s.lively(now)) return Infinity // stays an ice block while the bar rests
          this.t -= dt
          if (this.t > 0) return this.t < 1.5 ? FAST : Math.max(FAST, (this.t - 1.5) * 1000)
          this.state = 'float'
          this.grounded = false
          this.vy = -12
          return FAST
        case 'latched':
          if (!sam.latched) sam.latched = this
          this.x = sam.x - 0.5
          this.y = Math.max(0, sam.y - 5 + (Math.floor(this.phase * 2) & 1)) // gnawing
          return FAST
        case 'stunned':
          this.t -= dt
          this.vy *= 1 - 2 * dt
          this.vx *= 1 - 2 * dt
          this.x += this.vx * dt
          this.y = clamp(this.y + this.vy * dt, 0, FLOOR - MH)
          if (this.t <= 0) this.state = 'float'
          return FAST
      }
      // float: home in on the cursor, or on Samus's helmet
      if (this.ignored && now > this.noticeAt) {
        // she finally spots it
        this.ignored = false
        if (!sam.small) s.particle({ img: BUBBLE['!'], x: sam.x + 11, y: Math.max(0, sam.y - 4), life: 0.8 })
      }
      if (!s.lively(now)) {
        this.leave()
        return FAST
      }
      const c = s.cursor
      let tx
      let ty
      if (c && c.y < H + 4) {
        tx = c.x - MCX
        ty = clamp(c.y - MCY, 0, FLOOR - MH)
      } else if (!sam.small && sam.state !== 'spin') {
        tx = sam.x - 0.5
        ty = sam.y - 5
      } else {
        // can't latch onto a morph ball: hover above it, waiting
        tx = sam.x - 2
        ty = 4
      }
      if (this.flinch > 0) ty = 0
      let ax = clamp((tx - this.x) * 1.2, -30, 30)
      let ay = clamp((ty - this.y) * 1.2, -30, 30)
      // keep clear of ice blocks and of each other
      for (const o of metroids(s)) {
        if (o === this) continue
        const dx = this.x - o.x
        const dy = this.y - o.y
        const dd = Math.hypot(dx, dy) || 1
        const r = o.state === 'frozen' || o.state === 'fall' ? 18 : 12
        if (dd < r) {
          ax += (dx / dd) * 60
          ay += (dy / dd) * 60
        }
      }
      // furniture is solid to them too: rise over it
      if (s.fix.some((f) => this.x + MW - 1 > f.x && this.x + 1 < f.x + f.w && this.y + MH > f.y && this.y < f.y + f.h)) ay -= 60
      // pounce when it gets close
      const max = Math.hypot(tx - this.x, ty - this.y) < 40 ? 38 : s.busy ? 22 : 16
      this.vx = clamp(this.vx + ax * dt, -max, max)
      this.vy = clamp(this.vy + ay * dt, -max, max)
      // close to her helmet: stop drifting and pounce straight at it
      if (max > 30 && this.flinch <= 0 && !(c && c.y < H + 4)) {
        this.vx = clamp((tx - this.x) * 4, -max, max)
        this.vy = clamp((ty - this.y) * 4, -max, max)
      }
      this.x += this.vx * dt
      this.y = clamp(this.y + this.vy * dt + Math.sin(this.phase) * 0.15, Math.min(this.y, 0), FLOOR - MH)
      this.stillFor = 0
      // latch on
      if (!sam.small && sam.state !== 'spin' && sam.state !== 'win' && !sam.latched && Math.abs(this.x - (sam.x - 0.5)) < 5 && Math.abs(this.y - (sam.y - 5)) < 5) {
        this.state = 'latched'
        sam.latched = this
        sam.drain = 0
        s.particle({ img: BUBBLE['!'], x: sam.x + 11, y: Math.max(0, sam.y - 4), life: 0.8 })
      }
      return FAST
    }
    draw(c) {
      const img = this.state === 'frozen' || this.state === 'fall' ? (this.state === 'frozen' && this.t < 1.5 && this.s.lively() && Math.floor(this.t * 8) % 2 ? MET[0] : ICE) : MET[Math.floor(this.phase) & 1]
      c.drawImage(img, Math.round(this.x), Math.round(this.y))
    }
  }

  registerConcept({
    key: 'metroid',
    title: 'Metroid',
    sub: 'Nintendo, 1986',
    blurb:
      'Samus explores the floor and is too tall to walk under the furniture, so she curls into a morph ball to roll beneath it. Metroids drift in and home in on your cursor, or on her helmet: one that latches on drains her until she curls up and bombs it off. The ice beam freezes a metroid so it drops as a block of ice; she spin-jumps over it, the others steer clear of it, and a second shot shatters it while the rest back away. <b>Click</b> to fire at that spot, or to drop a bomb while she is a ball. Work brings more metroids, Done gets a victory pose, and when it is quiet she kneels, or stays curled up if she is under something.',
    setup(s) {
      s.data = { samus: new Samus(s), nextAt: performance.now() + 2500, lastGone: 0, victory: false }
      s.actors.push(s.data.samus)
    },
    relayout(s) {
      const sam = s.data.samus
      sam.x = clamp(sam.x, 1, s.W - SW - 1)
    },
    onBarClick(s, p) {
      s.data.samus.fireAt({ x: p.x, y: clamp(p.y, 0, FLOOR) }, true)
    },
    onBusy(s) {
      s.data.nextAt = Math.min(s.data.nextAt, performance.now() + 800)
    },
    onDone(s) {
      s.data.victory = true
      s.data.nextAt = performance.now() + 12000
      for (const m of metroids(s)) {
        if (m.state === 'frozen' || m.state === 'fall') m.shot(s)
        else m.leave()
      }
    },
    onNap(s) {
      for (const m of metroids(s)) m.leave()
    },
    update(s, dt, now) {
      const d = s.data
      if (!s.lively(now)) return Infinity
      const live = metroids(s).filter((m) => m.state !== 'leaving').length
      const max = s.busy ? 2 : 1
      if (live < max && now >= d.nextAt && !d.victory) {
        s.spawn(new Metroid(s))
        d.nextAt = now + (s.busy ? rand(4000, 7000) : rand(9000, 16000))
      }
      if (live >= max) d.nextAt = Math.max(d.nextAt, now + (s.busy ? 3000 : 8000))
      return Math.max(FAST, Math.min(d.nextAt - now, 30000 - (now - s.lastTouch) + 50))
    },
  })
})()
