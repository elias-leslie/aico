;(() => {
  // Joust: a knight on an ostrich flaps across the bar with real flap/gravity
  // physics and horizontal wrap. Buzzard riders hunt him; the higher lance wins.
  const JP = { ...PAL, Z: '#8f9c70', z: '#5c6747', h: '#d9d2c0' }
  const RW = 13 // rider sprite width
  const RH = 10 // rider sprite height: fits the 11 px lanes above and below the eyes
  const GRAV = 70

  const LEGS = [
    ['..O...O......', '.OO..OO......'],
    ['...O.O.......', '..O...O......'],
    ['.O.....O.....', 'O.......O....'],
  ]
  // knight: plumed helmet, lance couched across the ostrich's neck
  const K_TOP = ['..aAa........', '..AEA....YY..', '...A.....YEOO', '.AAAANNNNYNNN', '..AAA...Y....', 'YYAAAYYY.....', 'YLLLLYYY.....', '.YYYYYY......']
  const K_UP = ['L.aAa........', 'LLAEA....YY..', '.LLA.....YEOO', '.ALLANNNNYNNN', '..ALA...Y....', 'YYAAAYYY.....', 'YYYYYYYY.....', '.YYYYYY......', '...OOO.......', '.............']
  const K_DN = [...K_TOP.slice(0, 6), 'YLLLLYYY.....', 'LLLLYYY......', 'LL..OOO......', 'L............']
  // buzzard: hunched, head low, hooked beak
  const B_TOP = ['..rRr........', '..RER........', '...R.........', '.RRRRNNNNNNNN', '..RRR...ZZZ..', 'ZZRRRZZZZZEhh', 'ZzzzzZZZ....h', '.ZZZZZZ......']
  const B_UP = ['z.rRr........', 'zzRER........', '.zzR.........', '.RzzRNNNNNNNN', '..RzR...ZZZ..', 'ZZRRRZZZZZEhh', 'ZZZZZZZZ....h', '.ZZZZZZ......', '...kkk.......', '.............']
  const B_DN = [...B_TOP.slice(0, 6), 'ZzzzzZZZ....h', 'zzzzZZZ......', 'zz..kkk......', 'z............']
  // riderless buzzard (comes to pick up a hatched rider)
  const noRider = (rows) => rows.map((r, i) => (i < 5 ? r.replace(/[rREN]/g, '.') : r))
  const E_UP = noRider(B_UP)
  const E_DN = noRider(B_DN)

  const set = (top, up, dn, legMap) => ({
    run: LEGS.map((l) => pair([...top, ...recolor(l, legMap)], JP)),
    up: pair(up, JP),
    dn: pair(dn, JP),
  })
  const KNIGHT = set(K_TOP, K_UP, K_DN, {})
  const RIDERS = [
    { R: 'R', r: 'r' }, // bounder
    { R: 'a', r: 'A' }, // hunter
    { R: 'b', r: 'c' }, // shadow lord
  ].map((m) => set(recolor(B_TOP, m), recolor(B_UP, m), recolor(B_DN, m), { O: 'k' }))
  const EMPTY = { up: pair(E_UP, JP), dn: pair(E_DN, JP) }
  const EGG = sprite(['.ww.', 'wwww', 'wwww', 'wwwA', '.AA.'])
  const EGG_CRACK = sprite(['.ww.', 'w.ww', 'ww.w', 'wwwA', '.AA.'])
  const PILOT = pair(['.r..', 'RRR.', '.R..', 'R.R.'], JP)
  const DUST = pix('N')

  const wrap = (x, W) => ((x % W) + W) % W
  const wdx = (dx, W) => wrap(dx + W / 2, W) - W / 2
  const overlap = (x, y, w, h, f) => x + 1 < f.x + f.w && x + w - 1 > f.x && y + h > f.y + 0.5 && y < f.y + f.h - 0.5

  function blit(c, s, img, x, y, phase = -1) {
    const X = Math.round(x)
    const Y = Math.round(y)
    for (const ox of X + img.width > s.W ? [X, X - s.W] : [X]) {
      if (phase < 0) c.drawImage(img, ox, Y)
      // materialize: draw alternate scanlines
      else for (let r = phase % 2; r < img.height; r += 2) c.drawImage(img, 0, r, img.width, 1, ox, Y + r, img.width, 1)
    }
  }

  const riders = (s) => s.actors.filter((a) => a.enemy && !a.dead)
  const eggs = (s) => s.actors.filter((a) => a.egg && !a.dead)

  // ---- shared flap/gravity body -------------------------------------------
  class Body {
    constructor(x, y, dir) {
      this.x = x
      this.y = y
      this.vx = 0
      this.vy = 0
      this.dir = dir
      this.onGround = false
      this.flapCd = 0
      this.flapT = 0
      this.turnCd = 0
      this.leg = 0
      this.skid = 0
    }
    get moving() {
      return !this.onGround || Math.abs(this.vx) > 1
    }
    flap(power = 24) {
      if (this.flapCd > 0) return
      this.vy = Math.max(-40, Math.min(this.vy, 4) - power)
      this.flapCd = 0.16
      this.flapT = 0.12
      this.onGround = false
    }
    /** Turn only after a cooldown and with a clear reason (dx beyond a deadband). */
    steer(dx, dead = 8) {
      const d = Math.abs(dx) > 3 ? Math.sign(dx) : 0
      if (d && d !== this.dir && this.turnCd <= 0 && Math.abs(dx) > dead) {
        this.dir = d
        this.turnCd = 0.7
        if (this.onGround && Math.abs(this.vx) > 12) this.skid = 0.25
      }
      return d === this.dir ? d : 0
    }
    physics(dt, s, want, maxV) {
      this.flapCd -= dt
      this.flapT -= dt
      this.turnCd -= dt
      this.skid -= dt
      const acc = this.onGround ? 80 : 50
      if (want) this.vx += want * acc * dt
      else this.vx *= this.onGround ? Math.max(0, 1 - 7 * dt) : 1 - 0.5 * dt
      this.vx = clamp(this.vx, -maxV, maxV)
      if (!this.onGround) this.vy = Math.min(this.vy + GRAV * dt, 55)
      const px = this.x
      const py = this.y
      // horizontal, with furniture sides bouncing you back (Joust platforms are solid)
      this.x = wrap(this.x + this.vx * dt, s.W)
      for (const f of s.fix) {
        if (!overlap(this.x, py, RW, RH, f)) continue
        if (this.vx > 0) this.x = f.x - RW + 1
        else this.x = f.x + f.w - 1
        this.vx = -this.vx * 0.6
        this.x = wrap(this.x, s.W)
      }
      // vertical
      this.y += this.vy * dt
      if (this.vy >= 0) {
        const g = s.groundAt(this.x + 2, this.x + RW - 3, py + RH, 1)
        if (this.y + RH >= g) {
          if (!this.onGround && this.vy > 20) s.particle({ img: DUST, x: this.x + 2, y: g - 1, vx: -12, life: 0.3 })
          this.y = g - RH
          this.vy = 0
          this.onGround = true
        }
      } else {
        if (this.y < 0) {
          // the top of the bar is a hard ceiling: you bounce off it, you can't camp there
          this.y = 0
          this.vy = 14
        }
        for (const f of s.fix)
          if (overlap(this.x, this.y, RW, RH, f) && py >= f.y + f.h - 1) {
            this.y = f.y + f.h
            this.vy = 8
          }
      }
      if (this.onGround) {
        const g = s.groundAt(this.x + 2, this.x + RW - 3, this.y + RH, 1)
        if (g > this.y + RH + 0.5) this.onGround = false
        else if (Math.abs(this.vx) > 2) this.leg += Math.abs(this.vx) * dt * 0.35
      }
      this.y = clamp(this.y, 0, FLOOR - RH)
    }
    frame(set) {
      if (this.onGround) return set.run[this.skid > 0 ? 2 : Math.abs(this.vx) > 2 ? Math.floor(this.leg) % 3 : 0][this.dir]
      return (this.flapT > 0 ? set.dn : set.up)[this.dir]
    }
    get cx() {
      return this.x + RW / 2
    }
    get cy() {
      return this.y + RH / 2
    }
  }

  // ---- the knight ------------------------------------------------------------
  class Knight extends Body {
    constructor(s) {
      const t = s.fixture('title')
      super(t.x + t.w / 2 - RW / 2, t.y - RH, 1)
      this.s = s
      this.onGround = true
      this.z = 2
      this.out = 0 // seconds until respawn after losing
      this.spawn = 0
      this.click = null
      this.hunt = null
      this.wander = null
      this.wanderAt = 0
    }
    get asleep() {
      return this.onGround && !this.s.lively() && Math.abs(this.vx) < 1
    }
    hit(px, py) {
      return !this.out && Math.abs(wdx(px - this.cx, this.s.W)) < 8 && py > this.y - 3 && py < this.y + RH + 3
    }
    onClick() {
      this.flap(34)
      this.s.burst(this.cx, this.y + 5, 5, ['w', 'Y'])
    }
    perch(f, x) {
      if (!f) return { x, y: FLOOR - RH / 2 - 2, land: FLOOR }
      return { x: clamp(x, f.x + 4, f.x + f.w - 4), y: f.y - RH / 2 - 2, land: f.y, f }
    }
    target(now) {
      const s = this.s
      const d = s.data
      const c = s.cursor
      if (this.click && now < this.click.until) return this.click
      this.click = null
      if (this.hunt && (this.hunt.dead || now > this.hunt.until)) this.hunt = null
      if (this.hunt) return { x: this.hunt.cx, y: this.hunt.y - 5 }
      const egg = eggs(s).sort((a, b) => Math.abs(wdx(a.x - this.cx, s.W)) - Math.abs(wdx(b.x - this.cx, s.W)))[0]
      const cursorFresh = c && c.y < H + 4 && now - c.since < 1500
      if (egg && (d.mode === 'done' || !cursorFresh)) return egg.grounded ? { x: egg.x + 2, y: egg.y - 2, land: egg.y + 5 } : { x: egg.x + 2, y: egg.y }
      if (cursorFresh) return { x: c.x, y: clamp(c.y, 3, FLOOR - 3) }
      const foe = riders(s).filter((r) => r.spawn <= 0 && !r.carrier && !(r.leaving > 0))[0]
      if (foe) return { x: foe.cx, y: Math.max(RH / 2 + 3, foe.cy - 4) } // get above him: the higher lance wins
      if (c && c.y < H + 4) {
        const f = s.fix.find((f) => c.x >= f.x && c.x <= f.x + f.w && c.y >= f.y - 4 && c.y <= f.y + f.h)
        return this.perch(f, c.x)
      }
      if (!s.lively(now) || d.mode === 'done' || now < (d.titleUntil || 0)) {
        const t = s.fixture('title')
        return this.perch(t, t.x + t.w / 2)
      }
      if (!this.wander || now > this.wanderAt) {
        const spots = s.fix.filter((f) => f.kind !== 'glyph')
        const f = Math.random() < 0.3 ? null : pick(spots)
        this.wander = this.perch(f, f ? f.x + rand(4, f.w - 4) : rand(20, s.W - 20))
        this.wanderAt = now + rand(6000, 11000)
      }
      return this.wander
    }
    update(dt, now, s) {
      if (this.out > 0) {
        this.out -= dt
        if (this.out > 0) return FAST
        // rematerialize on a ledge
        const f = pick(s.fix.filter((f) => f.kind === 'title' || f.kind === 'eyes'))
        this.x = f.x + f.w / 2 - RW / 2
        this.y = f.y - RH
        this.vx = this.vy = 0
        this.onGround = true
        this.spawn = 0.8
      }
      if (this.spawn > 0) {
        this.spawn -= dt
        return FAST
      }
      // still not down long after things went quiet (boxed in somewhere):
      // blink out and back in on the title, like a respawn
      if (!s.lively(now) && !this.onGround && now - s.lastTouch > REST_AFTER + 15000) {
        const f = s.fixture('title')
        this.x = f.x + f.w / 2 - RW / 2
        this.y = f.y - RH
        this.vx = this.vy = 0
        this.onGround = true
        this.spawn = 0.8
        return FAST
      }
      const t = this.target(now)
      let tx = t.x
      // under the ledge I want to stand on? get out from under it first
      if (t.f && this.y >= t.f.y && this.x + RW > t.f.x && this.x < t.f.x + t.f.w)
        tx = this.cx < t.f.x + t.f.w / 2 ? t.f.x - RW : t.f.x + t.f.w + RW
      const dx = wdx(tx - this.cx, s.W)
      let dy = t.y - this.cy
      let want = this.steer(dx, t.land ? 4 : 8)
      let doFlap = false
      if (t.land !== undefined) {
        const feet = this.y + RH
        const onIt = this.onGround && Math.abs(feet - t.land) < 1
        if (Math.abs(dx) < 4) want = this.onGround && feet < t.land - 1 ? this.dir : 0 // step off a ledge above the spot
        if (!onIt && t.land < FLOOR && (Math.abs(dx) > 4 || feet > t.land + 0.5)) doFlap = feet > t.land - 2 && this.vy > -10
        if (!this.onGround && this.vy > 32) doFlap = true
      } else {
        // something solid straight ahead at my height? go over or under it
        const ahead = s.fix.find((f) => overlap(this.x + this.dir * 10, this.y, RW, RH, f))
        if (ahead) dy = this.cy < ahead.y + ahead.h / 2 ? -20 : 20
        doFlap = (dy < -1.5 && this.vy > -12) || this.vy > 30
        if (Math.abs(dx) < 3) want = 0
      }
      // walking into a taller fixture gets him nowhere: hop over it
      if (this.onGround && want && Math.abs(this.x - (this.lastX ?? this.x)) < 0.2) this.stuck = (this.stuck || 0) + dt
      else this.stuck = 0
      this.lastX = this.x
      if (this.stuck > 1) {
        this.stuck = 0
        this.flap(34)
      }
      if (doFlap) this.flap()
      this.physics(dt, s, want, this.onGround ? 30 : 44)
      this.joust(s, now)
      this.collect(s)
      if (this.moving || this.flapT > 0) return FAST
      if (t === this.wander && s.lively(now)) return Math.max(FAST, this.wanderAt - now)
      return Infinity
    }
    collect(s) {
      for (const e of eggs(s)) {
        if (e.fresh <= 0 && Math.abs(wdx(e.x + 2 - this.cx, s.W)) < 6 && e.y + 2 > this.y - 1 && e.y < this.y + RH + 1) {
          e.dead = true
          const pts = e.hatched ? '1000' : e.grounded ? '250' : '500'
          s.particle({ digits: pts, x: e.x - 4, y: clamp(e.y - 6, 0, FLOOR - 6), vy: -6, life: 1.1 })
          s.burst(e.x + 2, e.y + 2, 5, ['w', 'y'])
          if (s.data.mode === 'done' && !eggs(s).length && !riders(s).length) {
            s.data.mode = 'calm'
            s.data.visitAt = performance.now() + 25000
            s.data.titleUntil = performance.now() + 20000
            s.say('SURVIVAL WAVE', s.W / 2, 1, { color: '#f2d14b', life: 2.2 })
          }
        }
      }
    }
    joust(s, now) {
      for (const r of riders(s)) {
        if (r.spawn > 0 || r.leaving > 0 || r.carrier || r.tieCd > 0) continue
        if (Math.abs(wdx(r.cx - this.cx, s.W)) > 11 || Math.abs(r.y - this.y) > 8) continue
        const sparkX = this.cx + wdx(r.cx - this.cx, s.W) / 2
        // height decides; whoever is climbing at the moment of impact gets a slight edge
        const ky = this.y + this.vy * 0.04
        const ry = r.y + r.vy * 0.04
        if (ky < ry - 0.8) {
          r.unseat(s)
          s.particle({ digits: '500', x: r.x, y: clamp(r.y - 7, 0, FLOOR - 6), vy: -6, life: 1 })
          s.burst(sparkX, this.y + 3, 8, ['w', 'y', 'c'])
          this.vy = Math.min(this.vy, -8)
          for (const o of riders(s)) if (o !== r) o.fear = 2.5 // the rest scatter for a moment
        } else if (ry < ky - 0.8) {
          s.burst(this.cx, this.cy, 14, ['Y', 'L', 'w'])
          r.gloat = 1.2
          this.out = 1.6
          this.x = -100
          this.hunt = null
        } else {
          // dead even: both bounce off
          s.burst(sparkX, this.y + 3, 6, ['w', 'A'])
          const side = Math.sign(wdx(this.cx - r.cx, s.W)) || 1
          this.vx = side * 26
          r.vx = -side * 26
          this.vy = r.vy = -14
          this.turnCd = r.turnCd = 0.8
          r.tieCd = 1.2
        }
        return
      }
    }
    draw(c, s) {
      if (this.out > 0) return
      blit(c, s, this.frame(KNIGHT), this.x, this.y, this.spawn > 0 ? Math.floor(this.spawn * 12) : -1)
      if (this.asleep) c.drawImage(ZZ, Math.round(this.x + RW - 2), Math.round(this.y - 4))
    }
  }

  // ---- buzzard riders --------------------------------------------------------
  class Buzzard extends Body {
    constructor(s, x, y, kind = 0, carrier = false) {
      super(x, y, Math.random() < 0.5 ? 1 : -1)
      this.s = s
      this.enemy = true
      this.kind = kind
      this.carrier = carrier // riderless: flying in to pick up a hatched rider
      this.spawn = carrier ? 0 : 0.8
      this.leaving = 0
      this.fear = 0
      this.gloat = 0
      this.tieCd = 0
      this.retarget = 0
      this.tx = x
      this.ty = y
      this.onGround = !carrier
      this.z = 1
    }
    hit(px, py) {
      return Math.abs(wdx(px - this.cx, this.s.W)) < 8 && py > this.y - 3 && py < this.y + RH + 3
    }
    onClick() {
      // point the knight at this one
      const k = this.s.data.knight
      if (k && !this.carrier) {
        this.until = performance.now() + 5000
        k.hunt = this
      }
    }
    unseat(s) {
      this.dead = true
      s.spawn(new Egg(this.x + 4, this.y + 2, this.vx * 0.6 + this.dir * 8, -18, this.kind))
    }
    leave() {
      if (!this.leaving) this.leaving = 0.7
    }
    update(dt, now, s) {
      if (this.leaving > 0) {
        this.leaving -= dt
        if (this.leaving <= 0) this.dead = true
        return FAST
      }
      if (this.spawn > 0) {
        this.spawn -= dt
        return FAST
      }
      this.fear -= dt
      this.gloat -= dt
      this.tieCd -= dt
      this.retarget -= dt
      const k = s.data.knight
      const busy = s.busy
      if (this.carrier) {
        // fly to the waiting rider, scoop him up
        const p = this.carrier.dead ? null : this.carrier
        if (!p) {
          this.carrier = false
          this.leave()
          return FAST
        }
        this.tx = p.x + 1
        this.ty = p.y - 2
        if (Math.abs(wdx(this.tx - this.cx, s.W)) < 5 && Math.abs(this.ty - this.cy) < 6) {
          p.dead = true
          this.carrier = false
          this.kind = p.kind
          s.burst(this.cx, this.cy, 4, ['w'])
        }
      } else if (this.retarget <= 0) {
        this.retarget = rand(0.8, 1.6)
        const kOk = k && k.out <= 0
        // each rider keeps his own altitude lane and only sometimes breaks it to attack
        if (this.lane === undefined || Math.random() < 0.2) this.lane = pick([0.3, 0.5, 0.72]) * FLOOR
        if (this.gloat > 0 || !kOk || Math.random() < 0.45) {
          // patrol: sweep across the bar in my lane
          this.tx = this.cx + this.dir * rand(60, 140)
          this.ty = this.lane + rand(-2, 2)
        } else if (this.fear > 0 || (k.y < this.y - 4 && Math.random() < 0.7)) {
          // he's above me: veer away, low
          this.tx = k.cx - Math.sign(wdx(k.cx - this.cx, s.W) || 1) * rand(40, 80)
          this.ty = Math.max(this.lane, k.cy + 6)
        } else {
          // dive at him from just above
          this.tx = k.cx + rand(-20, 20)
          this.ty = Math.max(RH / 2 + 3, k.cy - rand(1, 4))
        }
        // keep a little apart from the other riders
        for (const o of riders(s))
          if (o !== this && Math.abs(wdx(o.cx - this.cx, s.W)) < 14 && Math.abs(o.cy - this.cy) < 8) this.ty = clamp(this.ty + (o.cy > this.cy ? -6 : 6), RH / 2 + 2, FLOOR - RH / 2)
      }
      const dx = wdx(this.tx - this.cx, s.W)
      const want = this.steer(dx, 10)
      if (this.ty < this.cy - 1.5 && this.vy > -10 && Math.random() < 0.6) this.flap(21)
      else if (this.vy > 32) this.flap(21)
      this.physics(dt, s, want, busy ? 36 : 28)
      return FAST
    }
    draw(c, s) {
      const set = this.carrier ? EMPTY : RIDERS[this.kind]
      const img = this.carrier ? (this.flapT > 0 ? set.dn : set.up)[this.dir] : this.frame(set)
      const ph = this.spawn > 0 ? Math.floor(this.spawn * 12) : this.leaving > 0 ? Math.floor(this.leaving * 12) : -1
      blit(c, s, img, this.x, this.y, ph)
    }
  }

  // ---- eggs ------------------------------------------------------------------
  class Egg {
    constructor(x, y, vx, vy, kind) {
      this.egg = true
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.kind = kind
      this.grounded = false
      this.age = 0
      this.hatchIn = rand(9, 14)
      this.hatched = false
      this.called = false
      this.fresh = 0.8 // can't be scooped up the instant it pops out
      this.z = 0
    }
    get moving() {
      return !this.grounded || Math.abs(this.vx) > 1
    }
    hit(px, py) {
      return Math.abs(px - this.x - 2) < 5 && Math.abs(py - this.y - 2) < 5
    }
    onClick() {
      // the knight swoops for this one
      const k = this.s?.data.knight
      if (k) k.click = { x: this.x + 2, y: this.y - 2, land: this.y + 5, until: performance.now() + 3000 }
    }
    update(dt, now, s) {
      this.s = s
      this.fresh -= dt
      if (!this.grounded) {
        this.vy = Math.min(this.vy + GRAV * dt, 50)
        const py = this.y
        this.y += this.vy * dt
        this.x = wrap(this.x + this.vx * dt, s.W)
        const g = s.groundAt(this.x, this.x + 4, py + 5, 1)
        if (this.y + 5 >= g) {
          this.y = g - 5
          if (this.vy > 25) this.vy = -this.vy * 0.3
          else {
            this.vy = 0
            this.grounded = true
          }
        }
        return FAST
      }
      // roll to a stop, then wait to hatch
      if (Math.abs(this.vx) > 1) {
        this.x = wrap(this.x + this.vx * dt, s.W)
        this.vx *= 1 - 2.5 * dt
        for (const f of s.fix) if (overlap(this.x, this.y, 4, 5, f)) this.vx = -this.vx
        if (s.groundAt(this.x, this.x + 4, this.y + 5, 1) > this.y + 5.5) this.grounded = false
        return FAST
      }
      this.vx = 0
      if (!s.lively(now) || s.data.mode === 'done') return Infinity
      this.age += dt
      if (!this.hatched) {
        if (this.age < this.hatchIn) return Math.max(FAST, (this.hatchIn - this.age - 1) * 1000)
        this.hatched = true
        s.particle({ img: BUBBLE['!'], x: this.x - 1, y: clamp(this.y - 9, 0, 20), life: 0.8 })
        // a riderless buzzard comes for him
        const side = Math.random() < 0.5 ? -8 : s.W + 2
        const b = new Buzzard(s, wrap(side, s.W), 2, this.kind, this)
        s.spawn(b)
      }
      return SLOW
    }
    draw(c, s) {
      if (!this.hatched) {
        const crack = this.grounded && this.age > this.hatchIn - 1.5 && Math.floor(this.age * 6) % 2
        blit(c, s, crack ? EGG_CRACK : EGG, this.x, this.y)
      } else {
        // the hatched rider stands on his shell and waves for a lift
        blit(c, s, PILOT[Math.floor(this.age * 3) % 2 ? 1 : -1], this.x, this.y + 1)
      }
    }
  }

  // ---- director --------------------------------------------------------------
  function spawnRider(s, f, kind = 0) {
    const x = f ? f.x + rand(2, Math.max(3, f.w - RW - 2)) : rand(20, s.W - 30)
    const y = (f ? f.y : FLOOR) - RH
    return s.spawn(new Buzzard(s, x, y, kind))
  }
  function settle(s) {
    for (const r of riders(s)) r.leave()
    for (const e of eggs(s)) {
      e.dead = true
      s.burst(e.x + 2, e.y + 2, 3, ['w'])
    }
  }

  registerConcept({
    key: 'joust',
    title: 'Joust',
    sub: 'Williams, 1982',
    blurb:
      'A knight on an ostrich flaps after your cursor, wrapping around the edges and landing on the furniture; hold still and he lands under you. Buzzard riders hunt him and try to get above him. When they meet, the higher lance wins: a loser turns into an egg, and the other riders scatter for a moment. Leave an egg alone and it hatches, and a riderless buzzard flies in to pick the rider up. <b>Click</b> the bar to send him there, a rider to charge it, an egg to grab it. Work brings waves, Done turns every rider into an egg for him to collect, and when it is quiet he lands on the title and dozes.',
    setup(s) {
      s.data = { mode: 'calm', wave: 0, waveAt: 0, visitAt: performance.now() + 2000, resting: false }
      s.data.knight = new Knight(s)
      s.actors.push(s.data.knight)
    },
    relayout(s) {
      for (const a of s.actors) if (a.x > s.W) a.x = wrap(a.x, s.W)
    },
    onBarClick(s, p) {
      const k = s.data.knight
      k.click = { x: p.x, y: clamp(p.y, 3, FLOOR - 3), until: performance.now() + 1500 }
      k.flap(30)
    },
    onBusy(s) {
      s.data.mode = 'busy'
      s.data.waveAt = performance.now() + 600
      if (!s.data.wave) s.say('PREPARE TO JOUST', s.W / 2, 1, { color: '#f2d14b', life: 2 })
    },
    onDone(s) {
      s.data.mode = 'done'
      for (const r of riders(s)) if (!r.carrier) r.unseat(s)
      for (const r of riders(s)) r.leave()
      for (const e of eggs(s)) if (e.hatched) e.dead = true
      s.data.visitAt = performance.now() + 25000
      if (!eggs(s).length) {
        s.data.mode = 'calm'
        s.data.titleUntil = performance.now() + 20000
      }
    },
    onNap(s) {
      s.data.mode = 'calm'
      settle(s)
    },
    onBonk(s, rect) {
      if (riders(s).length < 4) spawnRider(s, s.fixture('controls'), Math.floor(rand(0, 3)))
    },
    update(s, dt, now) {
      const d = s.data
      if (!s.lively(now)) {
        if (!d.resting) {
          d.resting = true
          d.mode = 'calm'
          settle(s)
        }
        return Infinity
      }
      d.resting = false
      const n = riders(s).length + eggs(s).length
      if (d.mode === 'busy') {
        if (n === 0) {
          if (!d.waveAt) d.waveAt = now + 1800
          if (now >= d.waveAt) {
            d.wave++
            d.waveAt = 0
            if (d.wave > 1) s.say(`WAVE ${d.wave}`, s.W / 2, 1, { color: '#f2d14b', life: 1.6 })
            const count = Math.min(2 + Math.floor(d.wave / 2), 4)
            const spots = [s.fixture('title'), s.fixture('controls'), null, s.fixture('eyes')]
            for (let i = 0; i < count; i++) spawnRider(s, spots[i], Math.min(2, Math.floor(rand(0, 1 + d.wave / 2))))
          }
          return d.waveAt ? Math.max(FAST, d.waveAt - now) : FAST
        }
        return Infinity
      }
      if (d.mode === 'calm' && n === 0) {
        if (now >= d.visitAt) {
          spawnRider(s, pick([s.fixture('title'), s.fixture('controls'), null]), 0)
          d.visitAt = now + rand(22000, 38000)
        }
        // wake up for the visitor or for the slide into rest, whichever is first
        return Math.max(FAST, Math.min(d.visitAt - now, 30000 - (now - s.lastTouch) + 50))
      }
      return Math.max(FAST, 30000 - (now - s.lastTouch) + 50)
    },
  })
})()
