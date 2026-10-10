;(() => {
  // Donkey Kong: an ape by the window dots rolls barrels left along the floor,
  // under the title (where the damsel waits) and into the oil drum by the eyes.
  // Jumpman hops them with a fixed arc, grabs the hammer, and gets flattened now and then.
  const P = {
    ...PAL,
    k: '#7a3f18', K: '#d08a4a', h: '#c4462a', p: '#ff7fb0', P: '#c9467a', n: '#8a5a2a',
    b: '#2f6fd8', D: '#1d3f86', R: '#e0322c', B: '#3a5ee8',
  }
  const sp = (rows) => pair(rows, P)
  const flipV = (rows) => rows.slice().reverse()
  const rot = (rows) => {
    // 90° clockwise
    const h = rows.length
    const w = Math.max(...rows.map((r) => r.length))
    const out = []
    for (let c = 0; c < w; c++) {
      let line = ''
      for (let r = h - 1; r >= 0; r--) line += rows[r][c] || '.'
      out.push(line)
    }
    return out
  }

  // ---- art -----------------------------------------------------------------
  // Kong, 14×13: big shoulders, light chest and face, knuckles down
  const DK_LEGS = ['....kkkkkk....', '...kkk..kkk...', '..KKKK..KKKK..']
  const DK_IDLE = ['....kkkkkk....', '...kkkkkkkk...', '...kKEKKEKk...', '..kkKKKKKKkk..', '..kKKKkkKKKk..', '.kkkKKKKKKkkk.', 'kkkkkkKKkkkkkk', 'kkk.kKKKKk.kkk', 'kK..kKKKKk..Kk', 'KK..kKKKKk..KK', ...DK_LEGS]
  const DK_GRIN = DK_IDLE.map((r, i) => (i === 5 ? '.kkkwwwwwwkkk.' : r))
  // upside down, head on the floor, legs kicking the air
  const KICK = ['.KK........KK.', '..kk......kk..', '...kkk..kkk...']
  const DK = {
    idle: sp(DK_IDLE),
    grin: sp(DK_GRIN),
    up: sp(['kk..kkkkkk..kk', 'kk.kkkkkkkk.kk', '.kkkKEKKEKkkk.', '..kkKKKKKKkk..', '..kKKKkkKKKk..', '..kkKKKKKKkk..', '...kkkKKkkk...', '...kKKKKKKk...', '...kKKKKKKk...', '....kKKKKk....', ...DK_LEGS]),
    beat: sp(['....kkkkkk....', '...kkkkkkkk...', '...kKEKKEKk...', '..kkKKKKKKkk..', '..kKKwwwwKKk..', '.kkkKwEEwKkkk.', 'kkkkkkkkKkkkkk', 'kK.kkkkKKk.kkk', 'KK..kKKKKk..Kk', '....kKKKKk..KK', ...DK_LEGS]),
    // faces left: shoving a barrel along the floor
    roll: sp(['...kkkkkk.....', '..kkkkkkkk....', '..kEKKEKKk....', '.kkKKKKKKkk...', '.kKKkkKKKKk...', 'kkkKKKKKKkkk..', 'kkkkkKKkkkkkk.', 'KKk.kKKKKk.kkk', 'KK..kKKKKk..Kk', '....kKKKKk..KK', ...DK_LEGS]),
    sit: sp(['..............', '..............', '..............', '....kkkkkk....', '...kkkkkkkk...', '...kKkKKkKk...', '..kkKKKKKKkk..', '.kkkKKkkKKkkk.', 'kkkkkKKKKkkkkk', 'kK.kKKKKKKk.Kk', 'KK.kKKKKKKk.KK', '.kkkkkkkkkkkk.', 'KKKK......KKKK']),
    tumble: sp(flipV(['....kkkkkk....', '...kkkkkkkk...', '...kKEKKEKk...', '..kkKKKKKKkk..', '..kKKwwwwKKk..', '.kkkKwwwwKkkk.', 'kkkkkkKKkkkkkk', 'kkk.kKKKKk.kkk', 'kK..kKKKKk..Kk', 'KK..kKKKKk..KK', ...DK_LEGS])),
    head: [sp(flipV(DK_IDLE)), sp([...KICK, ...flipV(DK_IDLE).slice(3)])],
  }
  const BARREL = [
    sprite(['.KKK.', 'KKKKK', 'kkkkk', 'KKKKK', '.KKK.'], P),
    sprite(['.KkK.', 'KKkKK', 'KKkKK', 'KKkKK', '.KkK.'], P),
    sprite(['.KKK.', 'KLKKK', 'kkkkk', 'KKKLK', '.KKK.'], P),
    sprite(['.KkK.', 'KKkLK', 'KKkKK', 'KLkKK', '.KkK.'], P),
  ]
  const UPRIGHT = sprite(['kKKk', 'KKKK', 'kkkk', 'KKKK', 'kKKk'], P)
  const DRUM = sprite(['DbbbbbD', 'DbbbbbD', 'wwwwwww', 'DbwbwbD', 'DbbbbbD', 'wwwwwww', 'DbbbbbD', 'DbbbbbD'], P)
  const FLAME = [sprite(['..y..', '.yOy.', 'yOrOy', '.OrO.'], P), sprite(['.y...', '..Oy.', '.yrOy', 'yOrO.'], P)]
  const FIRE = [sprite(['..y..', '.yOy.', 'yOrOy', 'rEOEr', '.rrr.'], P), sprite(['.y...', '..Oy.', '.yrOy', 'rEOEr', '.rrr.'], P)]
  const PAUL = {
    idle: sp(['.hhh..', 'hhSS..', 'hhSE..', '.pSp..', '.ppp..', 'ppppp.', 'pPpPp.', '.S.S..']),
    wave: sp(['.hhh.S', 'hhSSS.', 'hhSE..', '.pSp..', '.ppp..', 'ppppp.', 'pPpPp.', '.S.S..']),
  }
  const JM_TOP = ['..RRR..', '.RRRRRR', '.kSSkS.', '..SSkkk']
  const JM = {
    stand: sp([...JM_TOP, '.RRBRR.', 'SRBBBRS', '.BB.BB.', 'kk...kk']),
    run: [sp([...JM_TOP, '.RRBRR.', '.RBBBS.', '.BB.BB.', 'kk...kk']), sp([...JM_TOP, '.RRBRR.', '.SBBBR.', '..BBB..', '..kkk..'])],
    jump: sp(['..RRR.S', '.RRRRRR', '.kSSkS.', '..SSkkk', 'SRRBRR.', '.RBBBR.', 'BB...BB', 'k.....k']),
    hammer: sp([...JM_TOP, '.RRBRS.', '.RBBBR.', '.BB.BB.', 'kk...kk']),
  }
  const JM_DEAD = sp(rot([...JM_TOP, '.RRBRR.', 'SRBBBRS', '.BB.BB.', 'kk...kk']).reverse())
  const HALO = sprite(['.yyy.', 'y...y', '.yyy.'], P)
  const HAM_UP = sp(['KKKK', 'KKKK', '.n..', '.n..'])
  const HAM_DN = sp(['....KK', 'nnnnKK', '....KK'])
  const HEART = sprite(['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'])

  const JW = 7
  const JH = 8
  const JUMP_V = 55
  const JUMP_G = 180

  // ---- the stage layout (recomputed every tick: cheap, and survives zoom) ---
  function layout(s) {
    const d = s.data
    const title = s.fixture('title')
    const eyes = s.fixture('eyes')
    // Kong and his stack stand just left of whatever sits right of the title
    // (menu glyph, pinned buttons, window dots)
    const tc = title.x + title.w / 2
    const right = s.fix.filter((f) => f !== title && f.x > tc).map((f) => f.x)
    const edge = Math.min(s.W - 2, ...right)
    d.stackX = edge - 11
    d.dkX = d.stackX - 15
    d.drumX = Math.max(1, eyes.x - 10)
    const lo = eyes.x + eyes.w + 3
    const hi = Math.max(lo + 12, d.dkX - JW - 6)
    // open floor (nothing overhead) inside [lo, hi]; Jumpman prefers the widest stretch
    const gaps = []
    let x = lo
    const over = s.fix.filter((f) => f.x + f.w > lo && f.x < hi).sort((a, b) => a.x - b.x)
    for (const f of [...over, { x: hi + JW + 2, w: 0 }]) {
      gaps.push([x, Math.min(hi, f.x - JW - 2)])
      x = Math.max(x, f.x + f.w + 2)
    }
    // the stretch nearest Kong that is roomy enough, else the widest; on a wide
    // window keep only the part close to him so the barrels arrive in good time
    let best = gaps.filter((g) => g[1] - g[0] >= 40).pop() || gaps.reduce((a, g) => (g[1] - g[0] > a[1] - a[0] ? g : a))
    if (best[1] - best[0] > 200) best = [best[1] - 200, best[1]]
    d.open = best
    // too cramped (long session name, narrow window)? use the whole run, low jumps under the title
    d.zone = best[1] - best[0] >= 30 ? best : [lo, hi]
    d.title = title
  }
  /** Lowest furniture bottom over [x0, x1], or 0 if open sky. */
  function ceilAt(s, x0, x1) {
    let c = 0
    for (const f of s.fix) if (x1 > f.x && x0 < f.x + f.w) c = Math.max(c, f.y + f.h)
    return c
  }

  const hazards = (s) => s.actors.filter((a) => a.hazard && !a.dead)

  // ---- Donkey Kong -----------------------------------------------------------
  class Kong {
    constructor(s) {
      this.s = s
      this.state = 'idle'
      this.t = 0
      this.next = performance.now() + 1200
      this.beatCd = 0
      this.z = 1
    }
    get x() {
      return this.s.data.dkX
    }
    get y() {
      return FLOOR - 13 - (this.jy || 0)
    }
    get asleep() {
      return this.state === 'sit'
    }
    get moving() {
      return this.state !== 'idle' && this.state !== 'sit' && this.state !== 'dazed'
    }
    hit(px, py) {
      return px >= this.x && px <= this.x + 14 && py >= this.y
    }
    onClick() {
      this.rage(true)
      this.next = 0
    }
    rage(force = false) {
      const now = performance.now()
      if (!force && now < this.beatCd) return
      if (['sit', 'leap', 'tumble', 'head', 'dazed'].includes(this.state)) return
      this.beatCd = now + 4500
      this.state = 'beat'
      this.t = 1.3
    }
    laugh() {
      if (this.state === 'idle') {
        this.state = 'laugh'
        this.t = 1.4
      }
    }
    update(dt, now, s) {
      const d = s.data
      const lively = s.lively(now)
      if (!lively && !['sit', 'grab', 'hold', 'roll', 'leap', 'tumble', 'head'].includes(this.state)) {
        this.state = 'sit'
        return Infinity
      }
      if (this.state === 'sit') {
        if (!lively || now < d.endUntil) return Infinity
        this.state = 'idle'
        this.next = now + 1500
      }
      if (this.state === 'dazed') {
        if (now < d.endUntil) return Math.max(FAST, d.endUntil - now)
        this.state = 'idle'
        this.next = now + 1500
      }
      // cursor right on top of him annoys him
      const c = s.cursor
      if (c && this.state === 'idle' && Math.abs(c.x - this.x - 7) < 14 && c.y > FLOOR - 20) this.rage()
      // the ending: a great leap, and down he comes, head first
      if (this.state === 'leap' || this.state === 'tumble') {
        this.jt += dt
        this.jy = this.jv * this.jt - 100 * this.jt * this.jt
        if (this.state === 'leap' && this.jt > this.jv / 200) this.state = 'tumble'
        if (this.jy <= 0 && this.jt > 0.1) {
          this.jy = 0
          this.state = 'head'
          this.t = 2.4
          s.burst(this.x + 7, FLOOR - 1, 12, ['N', 'n', 'w'])
          for (let i = 0; i < 3; i++) s.particle({ img: STAR, x: this.x + 2 + i * 4, y: FLOOR - 16, vx: rand(-12, 12), vy: -rand(14, 24), g: 30, life: 1.4, fade: true })
          d.heartAt = now + 500
        }
        return FAST
      }
      if (this.state !== 'idle') {
        this.t -= dt
        if (this.t > 0) return FAST
        switch (this.state) {
          case 'grab':
            this.state = 'hold'
            this.t = 0.4
            return FAST
          case 'hold':
            this.state = 'roll'
            this.t = 0.35
            s.spawn(new Barrel(this.x - 4, s.busy ? 46 : 34))
            return FAST
          case 'head':
            this.state = 'dazed'
            return FAST
          case 'beat':
            if (d.ending && !this.fell) {
              this.fell = true
              this.state = 'leap'
              this.jt = 0
              // as high as the headroom over him allows
              const room = FLOOR - 13 - ceilAt(s, this.x, this.x + 14) - 1
              this.jv = Math.sqrt(2 * 100 * clamp(room, 3, 16))
              return FAST
            }
          // falls through
          default:
            this.state = 'idle'
            this.next = Math.max(this.next, now + 600)
        }
      }
      const jm = d.jm
      if (now >= this.next && !d.ending) {
        if (jm.state !== 'dead' && hazards(s).length < 5) {
          this.state = 'grab'
          this.t = 0.35
          this.next = now + (s.busy ? rand(1300, 2300) : rand(3200, 6000))
          return FAST
        }
        this.next = now + 800
      }
      return Math.max(FAST, this.next - now)
    }
    draw(c, s) {
      const x = Math.round(this.x)
      let img = DK.idle[1]
      let dy = 0
      if (this.state === 'grab') img = DK.roll['-1'] // reaching back to the stack
      else if (this.state === 'hold') img = DK.up[1]
      else if (this.state === 'roll') img = DK.roll[1]
      else if (this.state === 'beat') img = DK.beat[Math.floor(this.t * 8) % 2 ? 1 : -1]
      else if (this.state === 'laugh') {
        img = DK.grin[1]
        dy = Math.floor(this.t * 8) % 2
      } else if (this.state === 'sit' || this.state === 'dazed') img = DK.sit[1]
      else if (this.state === 'leap') img = DK.up[1]
      else if (this.state === 'tumble') img = DK.tumble[1]
      else if (this.state === 'head') img = DK.head[Math.floor(this.t * 6) & 1][1]
      c.drawImage(img, x, Math.round(this.y) + dy)
      if (this.state === 'hold') c.drawImage(BARREL[0], x + 5, this.y - 5)
      if (this.state === 'dazed' && s.lively()) c.drawImage(STAR, x + 11, this.y + 3)
      if (this.state === 'sit' && !s.lively()) c.drawImage(ZZ, x + 12, this.y + 1)
      // the barrel stack
      const sx = Math.round(s.data.stackX)
      c.drawImage(UPRIGHT, sx, FLOOR - 5)
      c.drawImage(UPRIGHT, sx + 5, FLOOR - 5)
      c.drawImage(UPRIGHT, sx + 2, FLOOR - 10)
    }
  }

  // ---- barrels and fireballs -------------------------------------------------
  class Barrel {
    constructor(x, speed) {
      this.hazard = true
      this.x = x
      this.y = FLOOR - 5
      this.vx = -speed
      this.w = 5
      this.jumped = false
      this.miss = Math.random() < 0.05 // Jumpman will mistime this one
      this.z = 2
      this.moving = true
    }
    hit(px, py) {
      return Math.abs(px - this.x - 2.5) < 5 && py > this.y - 4
    }
    onClick() {
      smash(this.s, this, '300')
    }
    update(dt, now, s) {
      this.s = s
      // once the bar goes quiet, the last barrels pick up speed and clear out
      if (!s.lively(now)) this.vx = Math.max(-120, this.vx - 30 * dt)
      this.x += this.vx * dt
      const drumX = s.data.drumX
      if (this.x < drumX + 4) {
        this.dead = true
        s.data.drum.flare(s, true)
      }
      return FAST
    }
    draw(c) {
      c.drawImage(BARREL[Math.floor(-this.x / 2) & 3], Math.round(this.x), this.y)
    }
  }
  class Fireball {
    constructor(x) {
      this.hazard = true
      this.fire = true
      this.x = x
      this.y = FLOOR - 5
      this.vx = 12
      this.w = 5
      this.life = rand(10, 14)
      this.turnCd = 0
      this.miss = false
      this.z = 2
      this.moving = true
    }
    hit(px, py) {
      return Math.abs(px - this.x - 2.5) < 5 && py > this.y - 4
    }
    onClick() {
      smash(this.s, this, '500')
    }
    update(dt, now, s) {
      this.s = s
      this.life -= dt
      if (this.life <= 0 || !s.lively(now)) {
        this.dead = true
        s.burst(this.x + 2, this.y + 2, 6, ['O', 'y', 'r'])
        return FAST
      }
      // creep after Jumpman, slowly, without dithering
      const jm = s.data.jm
      this.turnCd -= dt
      const want = jm.state === 'dead' ? -1 : Math.sign(jm.x - this.x) || 1
      if (want !== Math.sign(this.vx) && this.turnCd <= 0 && Math.abs(jm.x - this.x) > 10) {
        this.vx = -this.vx
        this.turnCd = 1.6
      }
      this.x = clamp(this.x + this.vx * dt, s.data.drumX + 7, s.data.dkX - 8)
      if (this.x <= s.data.drumX + 7 && jm.state === 'dead') this.life = 0
      return FAST
    }
    draw(c) {
      c.drawImage(FIRE[Math.floor(this.x / 3) & 1], Math.round(this.x), this.y - (Math.floor(this.x / 2) & 1))
    }
  }
  function smash(s, h, pts) {
    if (!h || h.dead) return
    h.dead = true
    s.burst(h.x + 2, h.y + 2, 10, h.fire ? ['O', 'y', 'r'] : ['K', 'k', 'y', 'w'])
    s.particle({ digits: pts, x: h.x - 2, y: h.y - 8, vy: -8, life: 1 })
    s.data.dk.rage()
    s.data.paul.react('cheer')
  }

  class Drum {
    constructor(s) {
      this.s = s
      this.prop = true
      this.flame = 0
      this.z = 3
    }
    get x() {
      return this.s.data.drumX
    }
    flare(s, barrel) {
      this.flame = 1.4
      if (barrel && s.lively() && Math.random() < (s.busy ? 0.35 : 0.15) && !hazards(s).some((h) => h.fire)) s.spawn(new Fireball(this.x + 8))
    }
    update(dt) {
      if (this.flame <= 0) return Infinity
      this.flame -= dt
      return FAST
    }
    draw(c) {
      const x = Math.round(this.x)
      c.drawImage(DRUM, x, FLOOR - 8)
      if (this.flame > 0) c.drawImage(FLAME[Math.floor(this.flame * 8) & 1], x + 1, FLOOR - 12)
    }
  }

  class Hammer {
    constructor(x) {
      this.x = x
      this.y = FLOOR - JH - 8
      this.prop = true
      this.pickup = true
    }
    update() {
      return Infinity
    }
    draw(c) {
      c.drawImage(HAM_UP[1], Math.round(this.x), this.y)
    }
  }

  // ---- Pauline ---------------------------------------------------------------
  class Pauline {
    constructor(s) {
      this.s = s
      this.wave = 0
      this.next = performance.now() + rand(3000, 6000)
      this.cd = 0
      this.hop = 0
      this.z = 1
    }
    get x() {
      const t = this.s.data.title
      return t.x + t.w / 2 - 3
    }
    get y() {
      return this.s.data.title.y - 8
    }
    get dir() {
      return this.s.data.jm.x + 3 < this.x ? -1 : 1
    }
    hit(px, py) {
      return Math.abs(px - this.x - 3) < 6 && py < this.y + 10
    }
    onClick() {
      this.react('love', true)
      this.s.data.jm.glance(this.x)
    }
    side() {
      // speech goes on the side away from the edge
      return this.x + 3 + this.dir * 16
    }
    react(kind, force = false) {
      const s = this.s
      const now = performance.now()
      if (!force && now < this.cd) return
      this.cd = now + 5000
      if (kind === 'help') {
        this.wave = 1.6
        s.say('HELP!', this.side(), 1, { color: '#ff8fb3', life: 1.4, size: 6 })
      } else if (kind === 'love') s.particle({ img: BUBBLE['♥'], x: this.x + (this.dir > 0 ? 6 : -8), y: this.y - 1, life: 1.2 })
      else if (kind === 'gasp') s.particle({ img: BUBBLE['!'], x: this.x + (this.dir > 0 ? 7 : -6), y: this.y, life: 1.2 })
      else if (kind === 'cheer') {
        this.hop = 0.6
        this.wave = 0.6
      }
    }
    update(dt, now, s) {
      if (this.wave > 0 || this.hop > 0) {
        this.wave -= dt
        this.hop -= dt
        return FAST
      }
      if (!s.lively(now) || s.data.ending) return Infinity
      const c = s.cursor
      if (c && Math.abs(c.x - this.x - 3) < 14 && c.y < 14) this.react('help')
      if (now >= this.next) {
        this.react('help')
        this.next = now + (s.busy ? rand(6000, 10000) : rand(11000, 18000))
      }
      return Math.max(FAST, this.next - now)
    }
    draw(c) {
      const img = (this.wave > 0 && Math.floor(this.wave * 6) % 2 ? PAUL.wave : PAUL.idle)[this.dir]
      c.drawImage(img, Math.round(this.x), Math.round(this.y - (this.hop > 0 && Math.floor(this.hop * 8) % 2 ? 1 : 0)))
    }
  }

  // ---- Jumpman ---------------------------------------------------------------
  class Jumpman {
    constructor(s) {
      this.s = s
      this.x = s.data.zone[0] + 4
      this.jy = 0 // height above the floor
      this.vy = 0
      this.vx = 0
      this.dir = 1
      this.state = 'stand'
      this.t = 0
      this.tx = null
      this.turnCd = 0
      this.pause = 0
      this.hammer = 0
      this.flee = null
      this.leg = 0
      this.z = 4
    }
    get y() {
      return FLOOR - JH - this.jy
    }
    get moving() {
      return this.state === 'run' || this.state === 'jump'
    }
    get asleep() {
      return this.state === 'stand' && !this.s.lively()
    }
    hit(px, py) {
      return Math.abs(px - this.x - 3.5) < 6 && py > this.y - 3
    }
    onClick() {
      this.jump()
    }
    glance(x) {
      this.dir = x > this.x ? 1 : -1
      this.turnCd = 1
    }
    jump(toward = 0) {
      if (this.state === 'dead' || this.jy > 0 || this.hammer > 0) return
      this.state = 'jump'
      this.jt = 0
      // over a hazard: always leap at it, so the arc carries him clear
      if (toward) this.dir = toward
      this.jv = this.jumpV(toward || (this.tx !== null && Math.abs(this.tx - this.x) > 2 ? this.dir : 0))
      this.vx = toward ? toward * this.speed() : this.tx !== null && Math.abs(this.tx - this.x) > 2 ? this.dir * this.speed() : 0
    }
    speed() {
      return this.s.busy ? 26 : 22
    }
    /** Take-off speed: full arc in the open, a shorter hop under the furniture. */
    jumpV(dir) {
      const x0 = Math.min(this.x, this.x + dir * 14)
      const room = FLOOR - JH - ceilAt(this.s, x0, x0 + JW + Math.abs(dir) * 14) - 0.5
      return Math.min(JUMP_V, Math.sqrt(2 * JUMP_G * Math.max(1, room)))
    }
    die() {
      const s = this.s
      this.state = 'dead'
      this.t = 2.6
      this.hammer = 0
      this.jy = 0
      s.data.dk.laugh()
      s.data.paul.react('gasp', true)
    }
    update(dt, now, s) {
      const d = s.data
      const [zL, zR] = d.zone
      this.turnCd -= dt
      if (this.state === 'dead') {
        this.t -= dt
        if (this.t > 0) return FAST
        // come back in only when the doorway is clear
        if (hazards(s).some((h) => !h.fire && h.x < zL + 30 && h.x + h.w > zL - 6)) return FAST
        this.state = 'stand'
        this.x = zL + 2
        this.dir = 1
        this.blink = 0.8
        return FAST
      }
      if (this.blink > 0) this.blink -= dt
      // actual ground speed last tick, for judging when to jump
      const mine = dt > 0 && this.px !== undefined ? (this.x - this.px) / dt : 0
      this.px = this.x
      if (this.hammer > 0) {
        this.hammer -= dt
        for (const h of hazards(s)) if (h.x + h.w > this.x - 7 && h.x < this.x + JW + 7) smash(s, h, h.fire ? '500' : '300')
      }
      // airborne
      if (this.state === 'jump') {
        // exact arc, so the jump is the same at any frame rate
        this.jt += dt
        this.jy = this.jv * this.jt - (JUMP_G * this.jt * this.jt) / 2
        this.x = clamp(this.x + this.vx * dt, zL, zR)
        this.grab(s)
        if (this.jy <= 0) {
          this.jy = 0
          this.state = 'stand'
        }
      }
      // what's coming at me?
      for (const h of hazards(s)) {
        const right = h.x > this.x
        const gap = right ? h.x - (this.x + JW) : this.x - (h.x + h.w)
        const closing = right ? mine - h.vx : h.vx - mine
        if (gap < -1 && gap > -(JW + h.w - 2)) {
          if (this.jy < 3.5) {
            if (this.hammer > 0 || this.blink > 0) continue
            this.die()
            return FAST
          }
          if (!h.jumped) {
            h.jumped = true
            s.particle({ digits: '100', x: h.x - 1, y: this.y - 6, vy: -8, life: 0.9 })
            if (Math.random() < 0.4) d.paul.react('love')
          }
        } else if (this.state !== 'jump' && this.hammer <= 0 && closing > 5 && gap > -1 && !h.miss) {
          // he leaps at it; if the zone edge stops him, the arc has only the hazard's speed to work with
          const free = (right ? zR - this.x : this.x - zL) > 4 ? this.speed() : 0
          const cj = Math.abs(h.vx) + free
          // when is the arc above the barrel's top, and does the pass fit inside that window?
          const v = this.jumpV(right ? 1 : -1)
          const disc = v * v - 2 * JUMP_G * 3.5
          const t1 = (v - Math.sqrt(Math.max(0, disc))) / JUMP_G
          const t2 = (v + Math.sqrt(Math.max(0, disc))) / JUMP_G
          const late = t2 - 9 / cj - 0.02
          if (cj < 30 || disc <= 0 || late < t1 + 0.01) {
            // can't clear it from here: back off toward open floor
            if (!this.flee) this.flee = { x: right ? zL : zR, until: now + 2500 }
          } else if ((gap - 1) / cj <= Math.min(late, t1 + 0.1)) this.jump(right ? 1 : -1)
        }
      }
      if (this.state === 'jump') return FAST
      // where to go
      const lively = s.lively(now)
      const c = s.cursor
      let goal = null
      if (this.flee && now > this.flee.until) this.flee = null
      if (this.flee && !d.ending) goal = this.flee.x
      else if (d.ending) goal = d.paul.x + 3 < zL ? zL : d.paul.x + 3 > zR + JW ? zR : clamp(d.paul.x - JW - 2, zL, zR)
      else if (!lively) goal = null
      else if (c && c.y < H + 6) goal = clamp(c.x - JW / 2, zL, zR)
      else {
        const ham = s.actors.find((a) => a.pickup)
        if (ham && this.hammer <= 0) goal = clamp(ham.x - 1, zL, zR)
        else if (this.pause > 0) this.pause -= dt
        else if (this.tx === null || Math.abs(this.tx - this.x) < 1.5) {
          // patrol: march up toward Kong, then back off and try again
          const toKong = d.zone === undefined || zR > zL ? (this.x < (zL + zR) / 2 ? zR : zL) : zL
          goal = toKong
          this.pause = rand(0.4, 1.4)
        } else goal = this.tx
      }
      // hysteresis: a new goal must differ meaningfully from the old one
      if (goal === null) this.tx = lively && this.tx !== null ? this.tx : null
      else if (this.tx === null || Math.abs(goal - this.tx) > 5) this.tx = goal
      if (this.tx !== null) this.tx = clamp(this.tx, zL, zR)
      const ham = s.actors.find((a) => a.pickup)
      if (ham && this.hammer <= 0 && Math.abs(this.x - (ham.x - 1)) < 2 && this.jy === 0) this.jump()
      if (this.state === 'jump') return FAST
      if (this.tx !== null && Math.abs(this.tx - this.x) > 1.5 && (this.pause <= 0 || c || d.ending)) {
        const want = Math.sign(this.tx - this.x)
        if (want !== this.dir && this.turnCd > 0) {
          this.state = 'stand'
          return FAST
        }
        if (want !== this.dir) this.turnCd = 0.5
        this.dir = want
        this.state = 'run'
        this.x = clamp(this.x + want * this.speed() * dt, zL, zR)
        this.leg += dt * 8
        return FAST
      }
      this.state = 'stand'
      if (d.ending) {
        this.dir = d.paul.x > this.x ? 1 : -1
        return this.hammer > 0 ? FAST : Infinity
      }
      if (this.hammer > 0 || this.blink > 0) return FAST
      if (this.pause > 0 && lively) return FAST
      return Infinity
    }
    grab(s) {
      const ham = s.actors.find((a) => a.pickup)
      if (!ham) return
      if (this.x + JW > ham.x && this.x < ham.x + 4 && this.y < ham.y + 4) {
        ham.dead = true
        this.hammer = 6
        s.particle({ img: BUBBLE['♪'], x: this.x + 8, y: Math.max(0, this.y - 2), vy: -6, life: 1.2 })
      }
    }
    draw(c, s) {
      if (this.blink > 0 && Math.floor(this.blink * 10) % 2) return
      const x = Math.round(this.x)
      const y = Math.round(this.y)
      if (this.state === 'dead') {
        if (this.t > 1.8) {
          const spin = Math.floor(this.t * 10) % 4
          c.drawImage(spin < 2 ? JM.stand[spin ? 1 : -1] : JM_DEAD[1], x, spin < 2 ? y : FLOOR - JW)
        } else {
          c.drawImage(JM_DEAD[1], x - 1, FLOOR - JW)
          c.drawImage(HALO, x + 1, FLOOR - JW - 4)
        }
        return
      }
      let img = JM.stand[this.dir]
      if (this.state === 'jump') img = JM.jump[this.dir]
      else if (this.hammer > 0) img = JM.hammer[this.dir]
      else if (this.state === 'run') img = JM.run[Math.floor(this.leg) & 1][this.dir]
      c.drawImage(img, x, y)
      if (this.hammer > 0) {
        const up = Math.floor(this.hammer * 6) % 2
        const flash = this.hammer < 1.5 && Math.floor(this.hammer * 10) % 2
        if (!flash) {
          if (up) c.drawImage(HAM_UP[this.dir], this.dir > 0 ? x + 4 : x - 1, y - 4)
          else c.drawImage(HAM_DN[this.dir], this.dir > 0 ? x + 6 : x - 5, y + 3)
        }
      }
    }
  }

  // ---- director --------------------------------------------------------------
  function finale(s) {
    const d = s.data
    const now = performance.now()
    d.ending = true
    d.endUntil = now + 9000
    for (const h of hazards(s)) {
      h.dead = true
      s.burst(h.x + 2, h.y + 2, 6, ['K', 'k', 'y'])
    }
    for (const a of s.actors) if (a.pickup) a.dead = true
    const dk = d.dk
    dk.state = 'beat'
    dk.t = 1.2
    dk.beatCd = 0
    dk.fell = false // after the chest-thump he leaps, and falls on his head
    d.heartAt = 0
  }

  registerConcept({
    key: 'donkeykong',
    title: 'Donkey Kong',
    sub: 'Nintendo, 1981',
    blurb:
      'Kong rolls barrels from his stack by the window dots, under the title where the damsel waits, and into the oil drum by the eyes, which sometimes coughs up a fireball. Jumpman hops them with a fixed arc and grabs the floating hammer to smash them. Kong thumps his chest when a barrel gets smashed and laughs when Jumpman gets flattened; she gasps, cheers and calls for help. <b>Click a barrel</b> to smash it, the bar or Jumpman to jump, Kong to make him throw; Jumpman runs after your cursor. Work speeds the barrels up, Done topples Kong and a heart pops between the two, and when it is quiet Kong sits down for a nap.',
    setup(s) {
      s.data = { ending: false, endUntil: 0, hammerAt: performance.now() + rand(9000, 15000) }
      layout(s)
      const d = s.data
      d.drum = new Drum(s)
      d.dk = new Kong(s)
      d.paul = new Pauline(s)
      d.jm = new Jumpman(s)
      s.actors.push(d.drum, d.dk, d.paul, d.jm)
    },
    relayout(s) {
      layout(s)
      const d = s.data
      d.jm.x = clamp(d.jm.x, d.zone[0], d.zone[1])
      for (const a of s.actors) if (a.pickup) a.x = clamp(a.x, d.open[0] + 2, Math.max(d.open[0] + 2, d.open[1] - 2))
    },
    onBarClick(s) {
      s.data.jm.jump()
    },
    onBusy(s) {
      s.data.dk.next = Math.min(s.data.dk.next, performance.now() + 400)
      s.data.ending = false
    },
    onDone(s) {
      finale(s)
    },
    onNap(s) {
      for (const a of s.actors) if (a.pickup || a.fire) a.dead = true
      s.data.jm.hammer = 0
    },
    onBonk(s) {
      // knocking on his window: he takes it personally
      s.data.dk.rage(true)
    },
    update(s, dt, now) {
      layout(s)
      const d = s.data
      if (d.heartAt && now >= d.heartAt) {
        d.heartAt = 0
        // between the two of them, clear of the title text
        const t = d.title
        const mid = d.jm.x < t.x ? Math.min((d.jm.x + d.paul.x) / 2, t.x - 9) : Math.max((d.jm.x + d.paul.x) / 2, t.x + t.w + 2)
        s.particle({ img: HEART, x: mid, y: 5, vy: -1.5, life: 2.6 })
        d.paul.react('love', true)
      }
      if (d.ending && now >= d.endUntil) d.ending = false
      if (!s.lively(now)) {
        for (const a of s.actors) if (a.pickup) a.dead = true
        return d.heartAt ? FAST : Infinity
      }
      // a hammer now and then (not during the ending)
      if (d.ending) d.hammerAt = Math.max(d.hammerAt, d.endUntil + 2000)
      if (!d.ending && now >= d.hammerAt) {
        d.hammerAt = now + (s.busy ? rand(12000, 18000) : rand(18000, 30000))
        if (!s.actors.some((a) => a.pickup) && d.jm.hammer <= 0) {
          // it hangs over open floor, where a jump can reach it
          const [oL, oR] = d.open
          if (oR - oL >= 12) s.spawn(new Hammer(oL + (oR - oL) * rand(0.3, 0.7)))
        }
      }
      if (d.heartAt) return FAST
      const wake = Math.min(d.hammerAt, d.ending ? d.endUntil : Infinity) - now
      return Math.max(FAST, Math.min(wake, 30000 - (now - s.lastTouch) + 50))
    },
  })
})()
