;(() => {
  // Lemmings (DMA Design / Psygnosis, 1991). Walkers pass through each other
  // the way they do in the game; only a Blocker turns them around. Bombers count
  // down 5…1 over their heads, cry "Oh no!" and pop; a hatch drops replacements.

  const L = {
    walk: [
      pair(['.GG...', 'GGGG..', '.GSS..', '.BBB..', 'SBBBS.', '.BBB..', '.B..B.', 'D....D']),
      pair(['.GG...', 'GGGG..', '.GSS..', '.BBB..', '.BBS..', '.BBB..', '..BB..', '..DD..']),
      pair(['.GG...', 'GGGG..', '.GSS..', '.BBB..', '.BBBS.', '.BBB..', '.B.B..', '.D..D.']),
      pair(['.GG...', 'GGGG..', '.GSS..', '.BBB..', '.SBB..', '.BBB..', '..BB..', '..DD..']),
    ],
    crouch: [
      pair(['.GG...', 'GGGG..', '.GSS..', '.BBBS.', '.BBB..', 'D..D..']),
      pair(['.GG...', 'GGGG..', '.GSS..', '.BBBS.', '.BBB..', '.DD...']),
    ],
    stand: pair(['.GG...', 'GGGG..', '.GSS..', '.BBB..', '.BBS..', '.BBB..', '.B.B..', '.D.D..']),
    look: pair(['.GG.S.', 'GGGG..', '.GSS..', '.BBB..', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
    up: pair(['..GG..', '.GGGG.', '.SSSS.', '..BB..', '.BBBB.', '..BB..', '..BB..', '.D..D.']),
    reach: pair(['...S..', '.GGS..', 'GGGG..', '.GSS..', '.BBB..', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
    fall: [
      pair(['S...S.', 'SGG.S.', 'GGGG..', '.GSS..', '.BBB..', '.BBB..', '.B.B..', 'D...D.']),
      pair(['.S.S..', '.SGGS.', 'GGGG..', '.GSS..', '.BBB..', '.BBB..', '..BB..', '.D..D.']),
    ],
    climb: [
      pair(['.GG...', 'GGGGS.', '.GSS..', '.BBBS.', '.BBB..', '.BBB..', '..BBD.', '...D..']),
      pair(['.GG.S.', 'GGGG..', '.GSSS.', '.BBB..', '.BBB..', '.BBBD.', '..B...', '..D...']),
    ],
    hang: [
      pair(['....SS', '.GG.S.', 'GGGG..', '.GSS..', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
      pair(['....SS', '...GS.', '..GGGG', '...GSS', '...BBB', '...BBB', '...B.B', '...D.D']),
    ],
    sit: pair(['.GG...', 'GGGG..', '.GSS..', '.BBBS.', '.BBBBB', '.....D']),
    sleep: [pair(['G........', 'GGSBBBBD.', '.G.BBBBDD']), pair(['.........', 'GGSBBBBD.', 'GG.BBBBDD'])],
    lean: pair(['..GG..', '.GGGG.', '..GSS.', '..BBB.', '.BBBS.', '.BBB..', '.B.B..', 'D..D..']),
    wave: [
      pair(['.GG..S', 'GGGG.S', '.GSSS.', '.BBB..', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
      pair(['.GG.S.', 'GGGGS.', '.GSSS.', '.BBB..', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
    ],
    cheer: [
      pair(['S...S.', 'SGG.S.', 'GGGG..', '.GSS..', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
      pair(['.....', 'SGGS.', 'GGGG.', '.GSS.', 'SBBBS', '.BBB.', 'B...B', 'D...D']),
    ],
    build: [
      pair(['......', '.GG...', 'GGGG..', '.GSS..', '.BBBSK', '.BBB..', '.DDD..']),
      pair(['......', '.GG...', 'GGGG..', '.GSS.K', '.BBBS.', '.BBB..', '.DDD..']),
    ],
    shrug: pair(['......', 'S.GG.S', '.GGGG.', '.SGSSS', '..BBB.', '..BBB.', '..B.B.', '..D.D.']),
    block: pair(['..GG...', '.GGGG..', '..SS...', 'SBBBBBS', '..BBB..', '..BBB..', '..B.B..', '.DD.DD.']),
    ohno: [
      pair(['.SGGS.', '.GGGG.', '..SS..', '..BB..', '.BBBB.', '..BB..', '..BB..', '.D..D.']),
      pair(['S.GG.S', '.GGGG.', '..SS..', '..BB..', '.BBBB.', '..BB..', '..BB..', '.D..D.']),
    ],
    five: pair(['.GG..S', 'GGGG.S', '.GSSS.', '.BBB..', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
    held: [
      pair(['.GG...', 'GGGG..', '.GSS..', 'SBBBS.', '.BBB..', '.BBB..', 'B...B.', 'D...D.']),
      pair(['.GG...', 'GGGG..', '.GSS..', 'SBBBS.', '.BBB..', '.BBB..', '.B.B..', '.D.D..']),
    ],
  }
  const UMBRELLA = sprite(['..RWR..', '.RWRWR.', 'RWRWRWR', '...k...', '...k...'])
  const BLOCK = sprite(['LL', 'LL'])
  const BRICK = sprite(['KKK'])
  const HATCH = [
    sprite(['kkkkkkkkkkkk', 'kKKKKKKKKKKk', 'kKKKKKKKKKKk']),
    sprite(['kkkkkkkkkkkk', 'kKKKK..KKKKk', 'kK........Kk']),
    sprite(['kkkkkkkkkkkk', 'kK........Kk', 'k..........k']),
  ]
  const BOOM = ['G', 'B', 'S', 'y', 'O', 'w', 'r']

  class Lem {
    constructor(s, x, y = FLOOR) {
      this.s = s
      this.x = x
      this.y = y
      this.dir = Math.random() < 0.5 ? 1 : -1
      this.state = y < FLOOR ? 'fall' : 'walk'
      this.t = 0
      this.vx = 0
      this.vy = 0
      this.anim = Math.random() * 10
      this.speed = rand(7, 11)
      this.floater = Math.random() < 0.6
      this.climber = Math.random() < 0.5
      this.think = rand(1.5, 5)
      this.on = null
      this.role = null
      this.carry = false
      this.grabbable = true
      this.lastZ = 0
      this.restZ = 0
      this.cool = 0 // turn-around cooldown (s)
      this.chatCool = rand(4, 12)
      this.fuse = 0
    }
    get moving() {
      return !['sleep', 'sit', 'lean', 'idle', 'block'].includes(this.state)
    }
    get asleep() {
      return ['sleep', 'sit', 'lean'].includes(this.state)
    }
    hit(px, py) {
      return px >= this.x - 3 && px <= this.x + 9 && py >= this.y - 12 && py <= this.y + 3
    }
    set(state, t = 0) {
      this.state = state
      this.t = t
    }
    say(k) {
      this.s.particle({ img: BUBBLE[k], x: this.x + 3, y: this.y - 17, life: 1.3, vy: -2 })
    }
    grab() {
      if (this.state === 'ohno') return
      this.set('held')
      this.on = null
      this.role = null
      this.carry = false
      this.say('!')
    }
    drag(p) {
      if (this.state === 'held') {
        this.x = p.x - 3
        this.y = p.y + 8
      }
    }
    drop() {
      if (this.state !== 'held') return
      this.vy = 0
      this.vx = 0
      this.set('fall')
    }
    onClick() {
      if (this.asleep) {
        this.set('walk')
        this.say('!')
      } else if (this.state === 'walk') {
        this.set('wave', 1)
      }
    }
    onDblClick() {
      this.arm()
    }
    arm(delay = 0) {
      if (this.fuse || this.dead) return
      this.fuse = 5 + delay
      if (this.asleep) this.set('walk')
    }
    onBusy() {
      if (this.asleep) {
        this.set('walk')
        this.say('!')
      }
      const builder = this.s.actors.some((a) => a.role === 'builder' || a.role === 'building')
      this.role = !builder && Math.random() < 0.4 ? 'builder' : 'carrier'
    }
    onDone(ran) {
      this.role = null
      this.carry = false
      if (['held', 'ohno', 'fall'].includes(this.state)) return
      if (ran > 1500) {
        this.set('cheer', rand(1.2, 1.9))
        this.y = this.on ? this.on.y : this.y
      }
    }
    onNap() {
      if (['held', 'fall', 'ohno'].includes(this.state)) return
      this.role = null
      this.carry = false
      this.rest()
    }
    bonked(r) {
      const cx = this.x + 3
      const over = cx >= r.x - 4 && cx <= r.x + r.w + 4
      if ((this.on && over) || (!this.on && Math.abs(cx - (r.x + r.w / 2)) < 9)) {
        this.on = null
        this.vy = -38
        this.vx = rand(-12, 12)
        this.set('fall')
        this.say('!')
      }
    }
    /** Pick a resting pose for where we are. */
    rest() {
      this.restZ = performance.now()
      if (!this.on && this.bed === undefined) {
        // curl up next to someone already asleep, if there's one nearby
        const pal = this.s.actors.find((o) => o !== this && o.state === 'sleep' && Math.abs(o.x - this.x) < 45)
        if (pal) {
          this.bed = clamp(pal.x + (this.x < pal.x ? -10 : 10), 3, this.s.W - 12)
          this.set('walk')
          return
        }
      }
      this.bed = undefined
      if (this.on) this.set('sit')
      else if (this.x < 10 || this.x > this.s.W - 18) {
        this.dir = this.x < 10 ? 1 : -1
        this.set('lean')
      } else this.set('sleep')
    }

    update(dt, now, s) {
      this.t -= dt
      this.anim += dt
      this.cool = Math.max(0, this.cool - dt)
      this.chatCool = Math.max(0, this.chatCool - dt)
      const cx = this.x + 3
      const cur = s.cursor
      const near = cur && Math.hypot(cur.x - cx, cur.y - (this.y - 4)) < 26

      // a lit fuse keeps counting whatever else is going on
      if (this.fuse && this.state !== 'ohno') {
        this.fuse -= dt
        if (this.fuse <= 0 && ['walk', 'idle', 'wave', 'sit', 'lean', 'cheer', 'block', 'chat', 'land'].includes(this.state)) {
          this.y = this.on ? this.on.y : Math.min(this.y, FLOOR)
          this.set('ohno', 1.1)
          s.say('Oh no!', cx, this.y - 17, { life: 1.1, color: '#ffffff' })
        }
      }

      switch (this.state) {
        case 'held':
          return FAST
        case 'ohno':
          if (this.t <= 0) this.explode()
          return FAST
        case 'fall': {
          this.vy += 140 * dt
          if (this.floater && this.vy > 24) {
            this.vy = 24
            this.umbrella = true
          }
          this.y += this.vy * dt
          this.x = clamp(this.x + this.vx * dt, 2, s.W - 8)
          const g = s.groundAt(this.x + 1, this.x + 5, this.y - this.vy * dt, 2, s.data.bricks)
          if (this.y >= g && this.vy >= 0) {
            const hard = !this.umbrella && this.vy > 40
            this.y = g
            this.on = g < FLOOR ? s.fix.find((f) => f.y === g) || null : null
            this.umbrella = false
            this.vx = 0
            this.set(hard ? 'dizzy' : 'land', hard ? 1.4 : 0.25)
            if (hard) for (let i = 0; i < 2; i++) s.particle({ img: STAR, x: this.x + i * 4 - 1, y: this.y - 11, life: 1.2, vy: -3, fade: true })
          }
          return FAST
        }
        case 'land':
        case 'dizzy':
          if (this.t <= 0) this.set('walk')
          return FAST
        case 'cheer':
          this.y = (this.on ? this.on.y : FLOOR) - (Math.floor(this.anim * 5) % 2 ? 3 : 0)
          if (Math.random() < dt * 3) s.particle({ img: pix(pick(['r', 'y', 'b', 'G', 'p', 'c'])), x: cx + rand(-4, 4), y: this.y - 10, vx: rand(-14, 14), vy: rand(-30, -14), g: 70, life: 1.1 })
          if (this.t <= 0) {
            this.y = this.on ? this.on.y : FLOOR
            this.set('walk')
          }
          return FAST
        case 'sleep':
        case 'sit':
        case 'lean': {
          if (s.lively(now) && !s.napping) {
            // wake up one by one, not all in the same frame
            if (!this.wakeAt) this.wakeAt = now + rand(200, 2500)
            if (now >= this.wakeAt || (near && cur.speed > 200)) {
              this.wakeAt = 0
              this.set('walk')
              if (this.state === 'sleep') this.say('!')
              return FAST
            }
            if (near && cur.speed < 120 && this.state !== 'sleep') {
              this.set('wave', 1.2)
              this.dir = cur.x > cx ? 1 : -1
              return FAST
            }
          }
          // a few zzz after dozing off, then perfectly still
          if (this.state === 'sleep' && now - this.restZ < 10000) {
            if (now - this.lastZ > 1600) {
              this.lastZ = now
              s.particle({ img: ZZ, x: this.x + 1, y: this.y - 7, vx: 2, vy: -4, life: 2.6, fade: true })
            }
            return 1600
          }
          if (this.fuse) return FAST
          return s.lively(now) ? Math.max(0, this.wakeAt - now) || 2000 : Infinity
        }
        case 'climb': {
          // a Climber going up the window edge; the ceiling knocks him off
          // backwards, just like a low roof in the game
          this.x = this.dir > 0 ? s.W - 6 : 0
          this.y -= 6 * dt
          if (this.y - 9 <= 0) {
            this.dir *= -1
            this.x = clamp(this.x + this.dir * 3, 2, s.W - 8)
            this.vy = 0
            this.vx = this.dir * 6
            this.set('fall')
            this.say('!')
          }
          return FAST
        }
        case 'hang': {
          // caught the edge of a ledge on the way off: dangle, then let go
          const f = this.ledge && s.fixture(this.ledge.kind)
          if (f) this.y = f.y + 8
          if (this.t <= 0 || !f) {
            this.dir *= -1
            this.vy = 0
            this.vx = this.dir * 6
            this.set('fall')
          }
          return FAST
        }
        case 'reach':
          if (this.t <= 0) this.set('climb')
          return FAST
        case 'build': {
          if (!s.busy) {
            this.set('shrug', 0.9)
            return FAST
          }
          if (this.t <= 0) {
            if (this.built >= 8) {
              this.set('shrug', 1)
              this.role = 'built'
              return FAST
            }
            const bx = this.dir > 0 ? this.x + 5 : this.x - 2
            if (s.data.bricks.length >= 24) s.data.bricks.shift()
            s.data.bricks.push({ x: bx, y: this.y - 1, w: 3 })
            this.built++
            this.x += this.dir * 3
            this.y -= 1
            this.set('build', 0.55)
          }
          return FAST
        }
        case 'shrug':
          if (this.t <= 0) {
            this.set('fall')
            this.vy = -20
            this.vx = this.dir * 10
          }
          return FAST
        case 'block':
          if (this.t <= 0 || s.busy) this.set('walk')
          return FAST
        case 'five':
          if (this.t <= 0) this.set('walk')
          return FAST
        case 'idle':
        case 'wave':
        case 'chat':
          if (this.state !== 'wave' && near && cur.speed < 120) {
            this.set('wave', 1.2)
            this.dir = cur.x > cx ? 1 : -1
          }
          if (this.state === 'wave' && near) this.t = Math.max(this.t, 0.4)
          if (this.state === 'idle' && this.lookUp && cur && Math.abs(cur.x - cx) < 18) this.t = Math.max(this.t, 0.3)
          if (this.t <= 0) {
            this.lookUp = false
            this.set('walk')
          }
          return FAST
      }

      // ---- walking -------------------------------------------------------
      if (!s.lively(now) && !this.role && !this.fuse) {
        if (this.bed === undefined || Math.abs(this.x - this.bed) < 2) {
          this.bed = this.bed === undefined ? undefined : -1
          if (this.bed === -1) {
            this.bed = undefined
            this.set('sleep')
            this.restZ = now
          } else this.rest()
          return FAST
        }
        const want = this.bed > this.x ? 1 : -1
        if (want !== this.dir) this.dir = want
      }
      if (near && cur.speed > 220 && !this.flee) {
        this.flee = 1.2
        this.dir = cur.x > cx ? -1 : 1
        this.vy = -22
        this.set('fall')
        this.say('!')
        return FAST
      }
      if (near && cur.speed < 90 && !s.busy) {
        this.set('wave', 1.4)
        this.dir = cur.x > cx ? 1 : -1
        return FAST
      }
      // a cursor parked over the bar draws a little crowd that looks up at it
      if (cur && !s.busy && !this.on && now - cur.since > 1200) {
        const dx = cur.x - cx
        if (Math.abs(dx) < 160 && Math.abs(dx) > 14 && this.cool <= 0) {
          if (Math.sign(dx) !== this.dir) {
            this.dir = Math.sign(dx)
            this.cool = 1.5
          }
        } else if (Math.abs(dx) <= 14) {
          this.lookUp = true
          this.set('idle', 0.6)
          return FAST
        }
      }
      if (this.flee) this.flee = Math.max(0, this.flee - dt)

      const crouch = !this.on && !!s.fix.find((f) => cx + 3 > f.x && cx - 3 < f.x + f.w && f.y + f.h > FLOOR - 10)
      this.crouch = crouch
      const sp = this.speed * (crouch ? 0.55 : 1) * (this.flee ? 2.6 : 1) * (this.carry ? 0.85 : 1)
      const nx = this.x + this.dir * sp * dt

      // window edges
      if (nx < 2 || nx > s.W - 8) {
        this.x = clamp(nx, 2, s.W - 8)
        if (!this.role && this.climber && s.lively(now) && Math.random() < 0.5) {
          this.dir = nx < 2 ? -1 : 1
          this.set('reach', 0.5)
          return FAST
        }
        if (!this.role && Math.random() < 0.3) {
          this.dir = nx < 2 ? 1 : -1
          this.set('lean', rand(2.5, 5))
          this.restZ = now
          return FAST
        }
        this.dir *= -1
        this.cool = 1
        return FAST
      }
      // a Blocker is the one thing that turns walkers around
      for (const o of s.actors) {
        if (o === this || o.state !== 'block' || o.y !== this.y || this.cool > 0) continue
        const d = o.x - this.x
        if (Math.abs(d) < 6 && Math.sign(d) === this.dir) {
          this.dir *= -1
          this.cool = 1.2
          return FAST
        }
      }
      // walking off a ledge (furniture top or brick stairs)
      if (this.on || this.y < FLOOR) {
        const g = s.groundAt(nx + 1, nx + 5, this.y, 2, s.data.bricks)
        if (g > this.y + 2) {
          if (this.on && !this.role && Math.random() < 0.45) {
            this.set('sit', rand(3, 7))
            this.restZ = now
            this.wakeAt = now + rand(3000, 7000)
            return FAST
          }
          if (this.on && Math.random() < 0.35) {
            // grab the edge and hang off it, facing back at the ledge
            const f = this.on
            this.ledge = f
            this.on = null
            this.dir *= -1
            this.x = this.dir < 0 ? f.x + f.w - 1 : f.x - 5
            this.y = f.y + 8
            this.set('hang', rand(1.2, 2.6))
            return FAST
          }
          this.on = null
          this.vy = -12
          this.vx = this.dir * 8
          this.set('fall')
          return FAST
        }
        this.y = g
      } else {
        const g = s.groundAt(nx + 1, nx + 5, this.y, 2, s.data.bricks)
        if (g < this.y && this.y - g <= 2) this.y = g
      }
      this.x = nx

      // meeting someone: they walk past each other; now and then they stop
      // for a moment's chat and then carry on the way they were going
      if (this.chatCool <= 0 && !this.role) {
        for (const o of s.actors) {
          if (o === this || !(o instanceof Lem) || o.state !== 'walk' || o.role || o.chatCool > 0 || o.y !== this.y) continue
          const d = o.x - this.x
          if (Math.abs(d) >= 7 || Math.sign(d) !== this.dir) continue
          this.chatCool = o.chatCool = rand(12, 25)
          if (o.dir !== this.dir) {
            const r = Math.random()
            if (r < 0.3) {
              this.set('chat', 1.4)
              o.set('chat', 1.4)
              this.say(pick(['…', '♥', '…', '?']))
            } else if (r < 0.6) {
              // high five in passing, then on their way
              this.set('five', 0.45)
              o.set('five', 0.45)
              s.particle({ img: STAR, x: (this.x + o.x) / 2 + 2, y: this.y - 10, life: 0.4 })
            }
          } else if (Math.random() < 0.5 && !this.follow) {
            // tag along behind a friend for a while
            this.follow = o
            this.followFor = rand(8, 16)
          }
          break
        }
      }
      if (this.follow) {
        const o = this.follow
        this.followFor -= dt
        if (o.dead || o.y !== this.y || this.followFor <= 0 || o.state === 'fall') this.follow = null
        else {
          const gap = (o.x - this.x) * this.dir
          if (gap < 7 && gap > 0) this.x -= this.dir * sp * dt // keep a step behind
          if (gap < 0 && this.cool <= 0) {
            this.dir = o.dir
            this.cool = 1.5
          }
          if (Math.random() < dt * 0.15) o.say('♪')
        }
      }
      // a lit fuse nearby: get away from it
      for (const o of s.actors) {
        if (o === this || !o.fuse || o.fuse > 3 || o.dead || this.fled === o) continue
        if (Math.abs(o.x - this.x) < 30 && Math.abs(o.y - this.y) < 10) {
          this.fled = o
          this.dir = o.x > this.x ? -1 : 1
          this.flee = 2
          this.say('!')
        }
      }

      // jobs while the agent works
      if (s.busy && this.role === 'carrier' && !this.on) {
        const e = s.fixture('eyes')
        const g = s.fixture('glyph')
        const src = e.x + e.w + 6
        const dst = g.x - 20
        if (!this.carry && Math.abs(cx - src) < 3) this.carry = true
        if (this.carry && Math.abs(cx - dst) < 3) {
          this.carry = false
          s.data.pile = Math.min(15, s.data.pile + 1)
        }
        const want = this.carry ? (dst > cx ? 1 : -1) : src > cx ? 1 : -1
        if (want !== this.dir) this.dir = want
      }
      if (s.busy && this.role === 'builder' && !this.on && !crouch) {
        const t = s.fixture('title')
        const gapStart = s.fixture('eyes').x + s.fixture('eyes').w + 30
        if (cx > gapStart && cx + 30 < t.x) {
          this.built = 0
          this.set('build', 0.4)
          this.role = 'building'
          return FAST
        }
      }

      // spontaneous decisions
      this.think -= dt
      if (this.think <= 0 && !this.role) {
        this.think = rand(2.5, 6)
        const r = Math.random()
        if (r < 0.15) this.set('idle', rand(1, 3))
        else if (r < 0.22) {
          this.dir *= -1
          this.cool = 1
        } else if (r < 0.26 && !crouch && !this.on && !s.actors.some((a) => a.state === 'block')) this.set('block', rand(8, 14))
      }
      return FAST
    }

    explode() {
      const s = this.s
      const cx = this.x + 3
      for (const o of s.actors) {
        if (o === this || !(o instanceof Lem) || o.dead || o.state === 'held') continue
        const d = o.x + 3 - cx
        if (Math.abs(d) < 22 && Math.abs(o.y - this.y) < 12) {
          o.on = null
          o.vy = -34
          o.vx = Math.sign(d || 1) * rand(14, 26)
          o.set('fall')
          o.say('!')
        }
      }
      s.burst(cx, this.y - 5, 26, BOOM)
      s.particle({ img: STAR, x: cx - 1, y: this.y - 6, life: 0.25 })
      this.dead = true
      s.data.respawn.push(performance.now() + rand(2200, 3500))
      s.poke()
    }

    draw(c) {
      const d = this.dir
      const f = Math.floor(this.anim * 7)
      let sp
      switch (this.state) {
        case 'held': sp = L.held[f % 2]; break
        case 'fall': sp = this.umbrella ? L.fall[1] : L.fall[f % 2]; break
        case 'land': sp = L.crouch[0]; break
        case 'dizzy': sp = L.stand; break
        case 'cheer': sp = L.cheer[Math.floor(this.anim * 5) % 2]; break
        case 'sleep': sp = L.sleep[Math.floor(this.anim / 1.6) % 2]; break
        case 'climb': sp = L.climb[Math.floor(this.anim * 4) % 2]; break
        case 'hang': sp = L.hang[Math.floor(this.anim * 2.5) % 2]; break
        case 'reach': sp = L.reach; break
        case 'build': sp = L.build[this.t > 0.3 ? 1 : 0]; break
        case 'shrug': sp = L.shrug; break
        case 'sit': sp = L.sit; break
        case 'lean': sp = L.lean; break
        case 'block': sp = L.block; break
        case 'ohno': sp = L.ohno[Math.floor(this.anim * 6) % 2]; break
        case 'idle': sp = this.lookUp ? L.up : Math.floor(this.anim / 1.2) % 3 === 1 ? L.look : L.stand; break
        case 'wave': sp = L.wave[Math.floor(this.anim * 5) % 2]; break
        case 'chat': sp = L.stand; break
        case 'five': sp = L.five; break
        default: sp = this.crouch ? L.crouch[Math.floor(this.anim * 5) % 2] : L.walk[Math.floor(this.anim * 8) % 4]
      }
      const x = Math.round(this.x)
      const y = Math.round(this.y)
      if (this.state === 'sit') c.drawImage(sp[d], d > 0 ? x + 1 : x - 1, y - sp.h + 1)
      else c.drawImage(sp[d], x, y - sp.h)
      if (this.umbrella && this.state === 'fall') c.drawImage(UMBRELLA, x - 1, y - sp.h - 5)
      if (this.carry) c.drawImage(BLOCK, x + 2, y - sp.h - 2)
      if (this.fuse > 0 && this.state !== 'ohno') drawDigits(c, Math.ceil(this.fuse), x + 2, Math.max(0, y - sp.h - 6))
    }
  }

  function hatchX(s) {
    const e = s.fixture('eyes')
    const t = s.fixture('title')
    const spot = s.data.hatchAt
    if (spot === 'title') return Math.round(t.x + t.w / 2 - 6)
    if (spot === 'eyes') return Math.round(e.x + e.w / 2 - 6)
    return Math.round((e.x + e.w + t.x) / 2 - 6)
  }

  registerConcept({
    key: 'lemmings',
    title: 'Lemmings',
    sub: 'DMA Design, 1991',
    chosen: true,
    blurb:
      'They walk past each other like they do in the game. Only a Blocker, arms out, turns them around. They high-five or stop to chat when they meet, tag along behind a friend, run from a lit fuse, get knocked flying by a neighbour\'s blast, wave at newcomers from the hatch, and curl up next to each other to sleep. Climbers go up the window edge until the top knocks them off, and newcomers from the hatch sometimes land on the title or on Aico\'s eyes, sit on the edge or hang from it before dropping. They gather under your cursor to look up at it. <b>Double-click one</b> to light its fuse: it counts down 5…1, cries "Oh no!" and pops, and the hatch drops a replacement. Now and then one goes off on its own. While the agent works they haul blocks and build a staircase. When it\'s done they cheer, and when nothing is happening they doze.',
    setup(s) {
      s.data = { bricks: [], pile: 0, respawn: [], hatch: 0, nextBomb: performance.now() + rand(60000, 120000) }
      for (let i = 0; i < 6; i++) s.actors.push(new Lem(s, rand(20, s.W - 30)))
    },
    // Optional host hook (no button anywhere by default): set them all off.
    onNuke(s) {
      s.lastTouch = performance.now()
      s.actors.filter((a) => a instanceof Lem).forEach((a, i) => a.arm(i * 0.35))
      s.poke()
    },
    relayout(s) {
      for (const a of s.actors) {
        if (!(a instanceof Lem)) continue
        a.x = clamp(a.x, 2, s.W - 8)
        if (a.bed !== undefined && a.bed >= 0) a.bed = clamp(a.bed, 3, s.W - 12)
        // furniture moved or resized under someone standing on it: they fall
        if (a.on || a.y < FLOOR) {
          const f = a.on && s.fixture(a.on.kind)
          const still = f && a.x + 5 > f.x + 1 && a.x + 1 < f.x + f.w - 1 && Math.abs(f.y - a.y) < 1
          if (still) a.on = f
          else if (!['held', 'fall', 'climb', 'build', 'hang'].includes(a.state) && a.y < FLOOR) {
            a.on = null
            a.vy = 0
            a.vx = 0
            a.set('fall')
          }
        }
      }
      s.data.bricks = s.data.bricks.filter((b) => b.x > 0 && b.x < s.W - 3)
      s.poke()
    },
    update(s, dt, now) {
      const d = s.data
      // hatch: open, drop the queued replacements one by one, close
      if (d.respawn.length && now >= d.respawn[0]) {
        if (d.hatch === 0) d.hatchAt = pick(['gap', 'gap', 'title', 'eyes'])
        d.hatch = Math.min(2, d.hatch + dt * 6)
        if (d.hatch >= 2) {
          d.respawn.shift()
          s.actors.push(new Lem(s, hatchX(s) + 3, 11))
          const greeter = s.actors.find((a) => a instanceof Lem && a.state === 'walk' && Math.abs(a.x - hatchX(s)) < 70)
          if (greeter) {
            greeter.dir = hatchX(s) > greeter.x ? 1 : -1
            greeter.set('wave', 1.4)
          }
          if (d.respawn.length && d.respawn[0] < now + 600) d.respawn[0] = now + 600
        }
        return FAST
      }
      if (d.hatch > 0) {
        d.hatch = Math.max(0, d.hatch - dt * 4)
        return FAST
      }
      // the occasional spontaneous bomber, only while someone's around
      if (s.lively(now) && now > d.nextBomb) {
        d.nextBomb = now + rand(90000, 180000)
        const walkers = s.actors.filter((a) => a instanceof Lem && a.state === 'walk' && !a.fuse)
        if (walkers.length > 3) pick(walkers).arm()
      }
      return d.respawn.length ? Math.max(FAST, d.respawn[0] - now) : Infinity
    },
    drawBehind(s, c) {
      const d = s.data
      for (const b of d.bricks) c.drawImage(BRICK, Math.round(b.x), Math.round(b.y))
      if (d.hatch > 0 || d.respawn.length) c.drawImage(HATCH[Math.min(2, Math.floor(d.hatch))], hatchX(s), 0)
      if (d.pile) {
        const g = s.fixture('glyph')
        let n = 0
        for (let row = 0; n < d.pile && row < 5; row++)
          for (let i = 0; i < 5 - row && n < d.pile; i++, n++) c.drawImage(BLOCK, g.x - 16 + i * 2 + row, FLOOR - 2 - row * 2)
      }
    },
    onDone(s) {
      const d = s.data
      for (const b of d.bricks) s.particle({ img: BRICK, x: b.x, y: b.y, vx: rand(-8, 8), vy: rand(-20, -5), g: 90, life: 1 })
      for (let i = 0; i < d.pile; i++) s.particle({ img: BLOCK, x: s.fixture('glyph').x - 12 + rand(-4, 4), y: FLOOR - 4, vx: rand(-20, 20), vy: rand(-50, -25), g: 80, life: 1.4, fade: true })
      d.bricks = []
      d.pile = 0
    },
  })
})()
