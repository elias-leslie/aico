;(() => {
  // Pac-Man (Namco, 1980) along the floor of the bar. Output arrives as dots,
  // the ghost house is behind the title, the side tunnel wraps, and your
  // cursor is a power pellet.

  function pacFrame(open) {
    // open: mouth half-angle in radians; built as palette rows like any sprite
    const rows = []
    for (let j = 0; j < 7; j++) {
      let r = ''
      for (let i = 0; i < 7; i++) {
        const dx = i - 3
        const dy = j - 3
        const out = dx * dx + dy * dy > 11 || (open > 0 && Math.abs(Math.atan2(dy, dx)) < open && dx > -1)
        r += out ? '.' : 'y'
      }
      rows.push(r)
    }
    return pair(rows, { y: '#ffd93d' })
  }
  const PAC = [pacFrame(0), pacFrame(0.5), pacFrame(0.95)]
  const DEATH = [0.95, 1.4, 1.9, 2.4, 2.8, 3.15].map(pacFrame)
  const GP = { ...PAL, r: '#ff3b3b', p: '#ffb8de', c: '#3fe0e0', o: '#ffb84a', b: '#2121de', w: '#ffffff', e: '#2121de', f: '#ffb8ae' }
  const ghostRows = (k, legs) => ['..kkk..', '.kkkkk.', 'kwekwek', 'kkkkkkk', 'kkkkkkk', 'kkkkkkk', legs ? 'k.kk.kk' : 'kk.kk.k'].map((r) => r.replace(/k/g, k))
  const GHOST = {}
  for (const k of ['r', 'p', 'c', 'o']) GHOST[k] = [pair(ghostRows(k, 0), GP), pair(ghostRows(k, 1), GP)]
  const scaredRows = (legs, k = 'b', f = 'f') => ['..kkk..', '.kkkkk.', 'kffkffk', 'kkkkkkk', 'kfkfkfk', 'kkkkkkk', legs ? 'k.kk.kk' : 'kk.kk.k'].map((r) => r.replace(/k/g, k).replace(/f/g, f))
  const SCARED = [pair(scaredRows(0), GP), pair(scaredRows(1), GP)]
  const FLASH = [pair(scaredRows(0, 'w', 'r'), GP), pair(scaredRows(1, 'w', 'r'), GP)]
  const EYES = pair(['.......', '.......', '.we.we.', '.ww.ww.'], GP)
  const DOT = sprite(['ff', 'ff'], GP)
  const POWER = sprite(['.ff.', 'ffff', 'ffff', '.ff.'], GP)
  const CHERRY = sprite(['...g.', '..g.g', '.g..g', 'rr.rr', 'rr.rr'], { ...GP, g: '#3fbf3f', r: '#ff2b2b' })
  const NAMES = { r: 'Blinky', p: 'Pinky', c: 'Inky', o: 'Clyde' }

  // The lane wraps through the side tunnel: positions run from -7 to s.W.
  const lane = (s) => s.W + 7
  /** Distance travelled going `dir` from a to b, through the tunnel if need be. */
  const ahead = (s, a, b, dir) => {
    const L = lane(s)
    return ((((b - a) * dir) % L) + L) % L
  }

  class Pac {
    constructor(s) {
      this.s = s
      this.x = 40
      this.y = FLOOR
      this.dir = 1
      this.anim = 0
      this.power = 0
      this.combo = 0
      this.turnCool = 0
      this.lastZ = 0
      this.grabbable = true
    }
    get moving() {
      return !this.sleeping && !this.dying
    }
    get asleep() {
      return this.sleeping
    }
    hit(px, py) {
      return Math.abs(px - this.x - 3) < 7 && Math.abs(py - this.y + 3) < 7
    }
    grab() {
      this.held = true
    }
    drag(p) {
      this.x = p.x - 3
      this.y = clamp(p.y + 3, 8, FLOOR)
    }
    drop() {
      this.held = false
      this.y = FLOOR
    }
    onClick() {
      this.dir *= -1
      this.turnCool = 0.6
    }
    ghosts() {
      return this.s.actors.filter((a) => a instanceof Ghost)
    }
    givePower() {
      this.power = 6
      this.combo = 0
      for (const g of this.ghosts()) if (g.mode === 'out') g.scare()
    }
    update(dt, now, s) {
      this.anim += dt
      this.turnCool = Math.max(0, this.turnCool - dt)
      if (this.held) return FAST
      if (this.dying) {
        this.dying -= dt
        if (this.dying <= 0) {
          this.dying = 0
          // restart well away from the ghost house
          const t = s.fixture('title')
          this.x = t.x + t.w / 2 > s.W / 2 ? 20 : s.W - 27
          this.dir = this.x < s.W / 2 ? 1 : -1
          this.flee = null
          s.data.scatterUntil = now + 7000
          s.say('READY!', t.x + t.w / 2, Math.min(t.y + t.h + 1, FLOOR - 9), { color: '#ffd93d', life: 1.2 })
        }
        return FAST
      }
      if (this.power > 0) {
        this.power -= dt
        if (this.power <= 0) for (const g of this.ghosts()) if (g.mode === 'scared') g.mode = 'out'
      }
      // your cursor is a power pellet: bring it down by Pac-Man and he eats it
      const cur = s.cursor
      if (cur && cur.y > FLOOR - 16 && Math.abs(cur.x - this.x - 3) < 10 && this.power <= 0 && now - (this.lastCursorPower || 0) > 8000) {
        this.lastCursorPower = now
        this.givePower()
        s.particle({ digits: '50', x: this.x, y: FLOOR - 18, life: 0.9, vy: -6 })
      }
      const d = s.data
      // pick a target: scared ghost > fruit > nearest dot
      let tx = null
      const near = (a, b) => (Math.min(ahead(s, this.x, a, 1), ahead(s, this.x, a, -1)) < Math.min(ahead(s, this.x, b, 1), ahead(s, this.x, b, -1)) ? a : b)
      const prey = this.power > 0 ? this.ghosts().filter((g) => g.mode === 'scared') : []
      if (prey.length) tx = prey.map((g) => g.x).reduce(near)
      else if (d.fruit) tx = d.fruit.x
      else if (d.dots.length) tx = d.dots.map((p) => p.x - 3).reduce(near)
      const hunters = this.power > 0 ? [] : this.ghosts().filter((g) => g.mode === 'out')
      const gap = (dir) => Math.min(1e9, ...hunters.map((g) => ahead(s, this.x, g.x, dir)))
      const threat = hunters.find((g) => ahead(s, this.x, g.x, this.dir) < 26)
      const lively = s.lively(now)
      const roaming = lively && this.ghosts().some((g) => g.mode === 'out')
      // gone quiet: leftover dots wait for later, he curls up where he is
      if (!lively && !s.busy && this.power <= 0) tx = null
      if (tx == null && !roaming) {
        this.sleeping = true
        if (now - (this.sleptAt ||= now) < 10000) {
          if (now - this.lastZ > 1600) {
            this.lastZ = now
            s.particle({ img: ZZ, x: this.x + 4, y: this.y - 10, vx: 2, vy: -4, life: 2.4, fade: true })
          }
          return 1600
        }
        return Infinity
      }
      this.sleeping = false
      this.sleptAt = 0
      // a ghost ahead: turn and commit to running until it's well behind or the
      // tunnel has carried him round, rather than doubling back into it
      // only turn back if that way is clearer; boxed in, he keeps going
      if (threat && !this.flee && gap(-this.dir) > gap(this.dir) + 8) {
        this.flee = threat
        this.wrapped = false
        this.dir = -this.dir
        this.turnCool = 0.9
      }
      if (this.flee && (this.power > 0 || this.wrapped || this.flee.mode !== 'out' || ahead(s, this.x, this.flee.x, -this.dir) > 80)) {
        this.flee = null
        this.calmUntil = now + 1500
      }
      if (this.turnCool <= 0 && !this.flee && tx != null && Math.abs(tx - this.x) > 2) {
        // head for the target the short way round, unless a ghost is on
        // that path; then go the long way through the tunnel
        const r = ahead(s, this.x, tx, 1)
        const l = ahead(s, this.x, tx, -1)
        const blocked = (dir, dist) => gap(dir) < dist + 10
        let want = r <= l ? 1 : -1
        if (blocked(want, Math.min(r, l)) && !blocked(-want, Math.max(r, l))) want = -want
        else if (blocked(want, Math.min(r, l)) && blocked(-want, Math.max(r, l))) want = gap(1) >= gap(-1) ? 1 : -1
        // just escaped: don't turn straight back towards the ghost
        if (want !== this.dir && now < (this.calmUntil || 0) && gap(want) < 60) want = this.dir
        if (want !== this.dir) {
          this.dir = want
          this.turnCool = 0.4
        }
      }
      this.x += this.dir * (this.power > 0 ? 26 : 22) * dt
      // the side tunnel
      if (this.x < -7 || this.x > s.W) {
        this.x = this.x < 0 ? s.W : -7
        this.wrapped = true
      }
      const mouth = this.x + 3 + this.dir * 2
      d.dots = d.dots.filter((p) => {
        if (Math.abs(p.x - mouth) > 2) return true
        if (p.power) this.givePower()
        d.score += p.power ? 50 : 10
        return false
      })
      if (d.fruit && Math.abs(d.fruit.x - mouth) < 3) {
        s.particle({ digits: '100', x: d.fruit.x - 4, y: FLOOR - 16, life: 1.2, vy: -5 })
        d.fruit = null
      }
      for (const g of this.ghosts()) {
        if (Math.abs(g.x - this.x) > 4) continue
        if (g.mode === 'scared') {
          this.combo++
          const pts = String(200 * 2 ** (this.combo - 1))
          s.particle({ digits: pts, x: g.x - 2, y: FLOOR - 16, life: 1.2, vy: -4 })
          g.mode = 'eyes'
          // the others notice and bolt
          for (const o of this.ghosts()) if (o !== g && o.mode === 'scared') o.dir = Math.sign(o.x - this.x) || 1
        } else if (g.mode === 'out') {
          this.dying = 1.6
          for (const o of this.ghosts()) if (o.mode === 'out') o.goHome(true)
          return FAST
        }
      }
      return FAST
    }
    draw(c) {
      let sp
      if (this.dying) sp = DEATH[clamp(Math.floor((1.6 - this.dying) * 5), 0, 5)]
      else if (this.sleeping) sp = PAC[0]
      else sp = PAC[[0, 1, 2, 1][Math.floor(this.anim * 14) % 4]]
      if (this.dying && this.dying < 0.4) return
      c.drawImage(sp[this.dir], Math.round(this.x), Math.round(this.y) - 7)
    }
  }

  class Ghost {
    constructor(s, color, i) {
      this.s = s
      this.color = color
      this.i = i
      this.mode = 'home'
      this.x = 0
      this.y = FLOOR
      this.dir = i % 2 ? 1 : -1
      this.anim = Math.random()
      this.turnCool = 0
      this.releaseAt = 0
      this.peek = false
      this.peekAt = 0
    }
    get moving() {
      return this.mode !== 'home'
    }
    get asleep() {
      return this.mode === 'home'
    }
    get prop() {
      return this.mode === 'home'
    }
    home() {
      const t = this.s.fixture('title')
      return t.x + t.w / 2 - 3 + (this.i - 1.5) * 6
    }
    scare() {
      this.mode = 'scared'
      this.dir *= -1
    }
    goHome(now = false) {
      this.mode = 'returning'
      if (now) {
        this.mode = 'home'
        this.releaseAt = performance.now() + 2500 + this.i * 1200
      }
    }
    pac() {
      return this.s.actors.find((a) => a instanceof Pac)
    }
    update(dt, now, s) {
      this.anim += dt
      this.turnCool = Math.max(0, this.turnCool - dt)
      const pac = this.pac()
      const lively = s.lively(now)
      if (this.mode === 'home') {
        if ((s.busy || lively) && now > this.releaseAt && !pac.dying && s.data.dots.length + (lively ? 1 : 0) > 0) {
          this.mode = 'out'
          this.x = this.home()
          this.turnCool = 0.5
          return FAST
        }
        // peek over the top of the title while you're around
        if (lively) {
          if (now > this.peekAt) {
            this.peek = !this.peek
            this.peekAt = now + (this.peek ? rand(800, 1400) : rand(3000, 7000))
          }
          return Math.max(FAST, Math.min(this.peekAt, this.releaseAt || Infinity) - now)
        }
        this.peek = false
        return Infinity
      }
      if (this.mode === 'eyes') {
        // eaten: the eyes fly back into Aico's eyes, then home behind the title
        const e = s.fixture('eyes')
        const hx = e.x + e.w / 2 - 3
        const hy = e.y + e.h / 2 + 2
        const dx = hx - this.x
        const dy = hy - this.y
        const dd = Math.hypot(dx, dy)
        if (dd < 3) {
          this.goHome(true)
          return FAST
        }
        this.x += (dx / dd) * 70 * dt
        this.y += (dy / dd) * 70 * dt
        this.dir = dx > 0 ? 1 : -1
        return FAST
      }
      this.y = FLOOR
      if (this.mode === 'returning' || (!lively && !s.busy && this.mode === 'out')) {
        const h = this.home()
        if (Math.abs(this.x - h) < 2) {
          this.mode = 'home'
          this.releaseAt = now + 1500 + this.i * 1000
          return FAST
        }
        this.mode = 'returning'
        this.dir = h > this.x ? 1 : -1
        this.x += this.dir * (lively ? 14 : 36) * dt
        return FAST
      }
      if (this.mode === 'scared') {
        if (this.turnCool <= 0) {
          const away = Math.sign(this.x - pac.x) || 1
          if (away !== this.dir) {
            this.dir = away
            this.turnCool = 1
          }
        }
        this.x += this.dir * 9 * dt
      } else {
        // each ghost has its own idea of where Pac-Man is going
        if (this.turnCool <= 0 && !pac.dying) {
          let target = pac.x
          if (this.color === 'p') target = pac.x + pac.dir * 28
          if (this.color === 'c') target = pac.x + (pac.x - (s.actors.find((a) => a.color === 'r')?.x ?? pac.x))
          if (this.color === 'o' && Math.abs(pac.x - this.x) < 50) target = this.x < s.W / 2 ? 0 : s.W
          // scatter: every so often (and right after a death) each ghost
          // heads for its own corner instead of hunting
          if (now < s.data.scatterUntil) target = this.i % 2 ? s.W - 10 : 10
          target = clamp(target, 4, s.W - 10)
          if (Math.abs(target - this.x) > 6) {
            const want = target > this.x ? 1 : -1
            if (want !== this.dir) this.dir = want
          }
          this.turnCool = rand(0.7, 1.4)
        }
        this.x += this.dir * (this.color === 'r' ? 15 : 13) * dt
      }
      if (this.x < -7) this.x = s.W
      if (this.x > s.W) this.x = -7
      return FAST
    }
    draw(c, s) {
      const legs = Math.floor(this.anim * 5) % 2
      if (this.mode === 'home') {
        if (!this.peek) return
        const t = s.fixture('title')
        const sp = GHOST[this.color][legs]
        c.drawImage(sp[this.dir], 0, 0, 7, 4, Math.round(this.home()), t.y - 4, 7, 4)
        return
      }
      if (this.mode === 'eyes') {
        c.drawImage(EYES[this.dir], Math.round(this.x), Math.round(this.y) - 6)
        return
      }
      let set = GHOST[this.color]
      if (this.mode === 'scared') {
        const pac = this.pac()
        set = pac.power < 1.6 && Math.floor(pac.power * 6) % 2 ? FLASH : SCARED
      }
      c.drawImage(set[legs][this.dir], Math.round(this.x), Math.round(this.y) - 7)
    }
  }

  function relayout(s) {
    for (const a of s.actors) if ((a instanceof Pac || a instanceof Ghost) && a.x > s.W) a.x = clamp(a.x, -7, s.W - 8)
    s.data.dots = s.data.dots.filter((p) => p.x < s.W - 4)
    if (s.data.fruit && s.data.fruit.x > s.W - 8) s.data.fruit.x = s.W - 20
    s.poke()
  }

  registerConcept({
    key: 'pacman',
    title: 'Pac-Man',
    sub: 'Namco, 1980',
    chosen: true,
    blurb:
      'Work arrives as dots and Pac-Man eats them as it comes in, with the odd power pellet. The ghost house is behind the title, and you can see them peeking over it. The four ghosts hunt differently: Blinky chases, Pinky cuts him off, Inky flanks, and Clyde loses his nerve up close. Pac-Man turns away from a ghost ahead of him and escapes through the side tunnel. Bring your <b>cursor down by Pac-Man</b> and he eats it like a power pellet: the ghosts turn blue, scatter when one of them is eaten, and their eyes fly home into Aico\'s eyes. Done drops a cherry. When it\'s quiet the ghosts go home and he naps.',
    setup(s) {
      s.data = { dots: [], fruit: null, score: 0, n: 0, scatterUntil: 0, nextScatter: performance.now() + 20000 }
      s.actors.push(new Pac(s))
      ;['r', 'p', 'c', 'o'].forEach((k, i) => {
        const g = new Ghost(s, k, i)
        g.releaseAt = performance.now() + 1500 + i * 1500
        s.actors.push(g)
      })
    },
    relayout,
    update(s, dt, now) {
      const d = s.data
      if (now > d.nextScatter) {
        d.nextScatter = now + rand(20000, 30000)
        d.scatterUntil = now + 6000
      }
      if (s.busy && now > (d.nextDot || 0) && d.dots.length < 36) {
        d.nextDot = now + 350
        d.n++
        d.dots.push({ x: Math.round(rand(8, s.W - 12)), power: d.n % 14 === 0 })
        return 350
      }
      return s.busy ? Math.max(FAST, d.nextDot - now) : Infinity
    },
    onDone(s) {
      const t = s.fixture('title')
      s.data.fruit = { x: Math.round(rand(20, Math.max(30, s.W - 30))) }
      s.say('BONUS!', t.x + t.w / 2, 1, { color: '#ffb8de', life: 1.4 })
    },
    drawBehind(s, c) {
      const d = s.data
      const blink = Math.floor(performance.now() / 250) % 2
      for (const p of d.dots) {
        if (p.power) {
          if (blink) c.drawImage(POWER, p.x - 1, FLOOR - 5)
        } else c.drawImage(DOT, p.x, FLOOR - 4)
      }
      if (d.fruit) c.drawImage(CHERRY, d.fruit.x, FLOOR - 6)
    },
  })
})()
