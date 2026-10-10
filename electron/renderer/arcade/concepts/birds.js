;(() => {
  // Birds on the wire: sparrows on the furniture. Calm, mostly still.
  const BP = { ...PAL, n: '#9a7b5c', N: '#e2d2bb', E: '#151515', O: '#f08a2c', h: '#6e5440' }
  const BIRD = {
    perch: pair(['....nn.', '...nEnO', 'nnnnNN.', '.nnNNn.', '...O...'], BP),
    peck: pair(['.......', '.......', 'nnnnnn.', '.nnNNnn', '...O.EO'], BP),
    preen: pair(['....nn.', '.n.nEnO', 'nnnNNN.', '.nnNNn.', '...O...'], BP),
    look: pair(['...nn..', '..OnEn.', '.nnNNn.', 'nnNNNn.', '...O...'], BP),
    puff: pair(['.......', '..nnnn.', '.nNNNnn', '.nNNNn.', '...O...'], BP),
    sing: pair(['....nn.', '...nEnO', 'nnnnNNO', '.nnNNn.', '...O...'], BP),
    fly: [
      pair(['...n...', '...nn..', '.nnnnEO', 'nnNNNn.', '.......'], BP),
      pair(['.......', '.......', '.nnnnEO', 'nnNNNn.', '..nn...'], BP),
    ],
  }
  const CRUMB = sprite(['K'])
  const BUG = [sprite(['c.c', '.E.'], { c: '#cfe6ff', E: '#151515' }), sprite(['...', 'cEc'], { c: '#cfe6ff', E: '#151515' })]
  const FEATHER = sprite(['n'], BP)

  class Bird {
    constructor(s, arrive = false) {
      this.s = s
      this.dir = Math.random() < 0.5 ? 1 : -1
      this.state = 'perch'
      this.t = rand(1, 3)
      this.anim = 0
      this.grabbable = true
      this.pose = 'perch'
      this.lastZ = 0
      this.spot = this.freeSpot()
      this.x = this.spot.x
      this.y = this.spot.y
      this.socialCool = rand(5, 15)
      if (arrive) {
        this.x = Math.random() < 0.5 ? -8 : s.W + 2
        this.y = 6
        this.flyTo(this.spot)
      }
    }
    get moving() {
      return this.state === 'fly'
    }
    get asleep() {
      return this.state === 'sleep'
    }
    hit(px, py) {
      return px >= this.x - 3 && px <= this.x + 10 && py >= this.y - 8 && py <= this.y + 3
    }
    grab() {
      this.state = 'held'
      this.s.particle({ img: BUBBLE['!'], x: this.x + 3, y: this.y - 14, life: 1, vy: -2 })
      for (const o of this.s.actors) if (o !== this && o instanceof Bird && Math.abs(o.x - this.x) < 60) o.scare(this)
    }
    drag(p) {
      this.x = p.x - 3
      this.y = clamp(p.y + 3, 5, FLOOR)
    }
    drop() {
      this.flyTo(this.freeSpot(), true)
    }
    onClick() {
      this.flyTo(this.freeSpot(), true)
    }
    spots() {
      const out = []
      for (const f of this.s.fix) for (let x = f.x; x <= f.x + f.w - 7; x += 7) out.push({ x, y: f.y })
      for (let x = 6; x < this.s.W - 12; x += 23) out.push({ x, y: FLOOR })
      return out
    }
    taken(p) {
      return this.s.actors.some((a) => a !== this && a.spot && Math.abs(a.spot.x - p.x) < 8 && a.spot.y === p.y)
    }
    freeSpot(awayFrom, near) {
      let spots = this.spots().filter((p) => !this.taken(p))
      if (awayFrom) spots = spots.sort((a, b) => Math.abs(b.x - awayFrom.x) - Math.abs(a.x - awayFrom.x)).slice(0, 4)
      if (near) spots = spots.sort((a, b) => Math.abs(a.x - near.x) + Math.abs(a.y - near.y) - (Math.abs(b.x - near.x) + Math.abs(b.y - near.y))).slice(0, 2)
      return pick(spots) || { x: Math.round(rand(6, this.s.W - 12)), y: FLOOR }
    }
    flyTo(spot, fast) {
      this.hunt = null
      this.spot = spot
      this.from = { x: this.x, y: this.y }
      this.state = 'fly'
      const d = Math.hypot(spot.x - this.x, spot.y - this.y)
      this.dur = Math.max(0.35, d / (fast ? 120 : 70))
      this.ft = 0
      this.arc = Math.min(12, 4 + d / 12)
      this.dir = spot.x >= this.x ? 1 : -1
      this.s.poke()
    }
    scare(by) {
      if (this.state === 'fly' || this.state === 'held') return
      if (this.state === 'sleep' || Math.random() < 0.7) this.flyTo(this.freeSpot(by), true)
    }
    onBusy() {
      if (this.state === 'sleep') this.wake()
    }
    onDone() {
      if (this.state === 'held') return
      this.flyTo(this.freeSpot(), true)
      this.s.particle({ img: BUBBLE['♪'], x: this.x + 3, y: this.y - 12, life: 1.4, vy: -5, fade: true })
    }
    onNap() {
      if (this.state === 'perch') this.t = 0.2
    }
    bonked(r) {
      if (this.spot && this.spot.x >= r.x - 7 && this.spot.x <= r.x + r.w && this.state !== 'fly') this.flyTo(this.freeSpot(), true)
    }
    wake() {
      this.state = 'perch'
      this.t = rand(0.5, 1.5)
      this.pose = 'look'
    }
    update(dt, now, s) {
      this.anim += dt
      this.socialCool = Math.max(0, this.socialCool - dt)
      const cur = s.cursor
      const d = cur ? Math.hypot(cur.x - (this.x + 3), cur.y - (this.y - 2)) : 1e9
      if (this.state === 'held') return FAST
      if (this.replyAt && now >= this.replyAt) {
        this.replyAt = 0
        if (this.state === 'perch') {
          this.pose = 'sing'
          s.particle({ img: BUBBLE['♪'], x: this.x + 4, y: this.y - 11, life: 1.2, vy: -5, fade: true })
        }
      }
      if (this.state === 'fly') {
        this.ft += dt
        const k = Math.min(1, this.ft / this.dur)
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
        if (this.hunt && !this.hunt.dead) {
          // home in on the bug as it drifts
          this.spot.x = this.hunt.x - 3
          this.spot.y = this.hunt.y + 3
        }
        this.x = this.from.x + (this.spot.x - this.from.x) * e
        this.y = Math.max(5, this.from.y + (this.spot.y - this.from.y) * e - Math.sin(Math.PI * k) * this.arc)
        if (k >= 1 && this.hunt) {
          const b = this.hunt
          this.hunt = null
          if (!b.dead && Math.abs(b.x - (this.x + 3)) < 5 && Math.abs(b.y - (this.y - 3)) < 5) {
            b.dead = true
            s.particle({ img: BUBBLE['♪'], x: this.x + 4, y: this.y - 11, life: 1, vy: -5, fade: true })
          } else s.particle({ img: FEATHER, x: this.x + 3, y: this.y - 3, vx: rand(-6, 6), vy: 4, life: 1.2, fade: true })
          this.flyTo(this.freeSpot(null, { x: this.x, y: this.y }), true)
          return FAST
        }
        if (k >= 1) {
          this.state = 'perch'
          this.t = rand(0.6, 2)
          this.pose = 'perch'
          this.x = this.spot.x
          this.y = this.spot.y
          if (this.leaving) this.dead = true
        }
        return FAST
      }
      if (d < 34 && (cur.speed > 60 || d < 14)) {
        // one startled bird sets off its neighbours
        this.flyTo(this.freeSpot(cur), true)
        for (const o of s.actors) if (o !== this && o instanceof Bird && Math.abs(o.x - this.x) < 30) o.scare(cur)
        return FAST
      }
      if (this.state === 'sleep') {
        if (s.lively(now) && !s.napping && Math.random() < 0.3) {
          this.wake()
          return FAST
        }
        if (now - this.restAt < 10000) {
          if (now - this.lastZ > 2200) {
            this.lastZ = now
            s.particle({ img: ZZ, x: this.x + 4, y: this.y - 8, vx: 2, vy: -3, life: 2.4, fade: true })
          }
          return 2200
        }
        return Infinity
      }
      // a bug drifting nearby: dart out and snap it up
      if (this.state === 'perch' && now > (this.huntCool || 0)) {
        for (const b of s.data.bugs) {
          if (b.dead || b.chased || Math.abs(b.x - this.x) > 90) continue
          b.chased = true
          this.huntCool = now + rand(2500, 5000)
          this.flyTo({ x: b.x - 3, y: b.y + 3 }, true)
          this.hunt = b
          this.dur = Math.max(0.3, this.dur * 0.8)
          return FAST
        }
      }
      // crumbs on the bar: hop or fly over, squabble, peck
      const crumbs = s.data.crumbs
      if (crumbs.length) {
        const c = crumbs.reduce((b, k) => (Math.abs(k.x - this.x) < Math.abs(b.x - this.x) ? k : b))
        if (c.landed && Math.abs(c.x - this.x) < 80) {
          if (Math.abs(c.x - (this.x + 3)) > 3 || Math.abs(c.y - this.y) > 2) {
            if (!this.goingFor || this.goingFor !== c) {
              this.goingFor = c
              this.flyTo({ x: c.x - 3, y: c.y }, true)
              return FAST
            }
          } else {
            this.pose = 'peck'
            if (Math.random() < dt * 3) {
              crumbs.splice(crumbs.indexOf(c), 1)
              this.goingFor = null
              // a rival nearby that missed out chirps about it
              const rival = s.actors.find((o) => o !== this && o instanceof Bird && o.goingFor === c)
              if (rival) {
                rival.goingFor = null
                rival.pose = 'sing'
                s.particle({ img: BUBBLE['!'], x: rival.x + 3, y: rival.y - 13, life: 0.9, vy: -2 })
              }
            }
            return FAST
          }
        }
      }
      this.t -= dt
      if (this.t > 0) return Math.max(FAST, Math.min(this.t * 1000, 1500))
      if (!s.lively(now)) {
        // huddle: settle on a spot next to another bird, puff up, doze
        const pal = s.actors.find((o) => o !== this && o instanceof Bird && o.state === 'sleep')
        if (pal && !this.huddled) {
          this.huddled = true
          const sp = { x: clamp(pal.spot.x + (Math.random() < 0.5 ? -7 : 7), 2, s.W - 9), y: pal.spot.y }
          if (!this.taken(sp)) {
            this.flyTo(sp)
            return FAST
          }
        }
        this.state = 'sleep'
        this.pose = 'puff'
        this.restAt = now
        this.lastZ = now
        return 2200
      }
      this.huddled = false
      const r = Math.random()
      // social: answer a neighbour, or fly over to sit beside a friend
      const friend = s.actors.find((o) => o !== this && o instanceof Bird && o.state === 'perch' && Math.abs(o.x - this.x) < 40 && o.spot?.y === this.spot.y)
      if (friend && this.socialCool <= 0 && r < 0.35) {
        this.socialCool = rand(8, 18)
        this.dir = friend.x > this.x ? 1 : -1
        friend.dir = -this.dir
        this.pose = 'sing'
        friend.pose = 'look'
        friend.t = 0.8
        s.particle({ img: BUBBLE['♪'], x: this.x + 4, y: this.y - 11, life: 1.2, vy: -5, fade: true })
        friend.replyAt = now + 700
        this.t = rand(1, 2)
        return FAST
      }
      if (r < 0.14) {
        const pal = s.actors.find((o) => o !== this && o instanceof Bird && o.state === 'perch' && Math.abs(o.x - this.x) > 60)
        this.flyTo(pal ? this.freeSpot(null, pal.spot) : this.freeSpot())
        return FAST
      }
      if (r < 0.34) {
        this.pose = 'peck'
        this.t = 0.25
      } else if (r < 0.46) {
        this.pose = 'preen'
        this.t = 0.6
      } else if (r < 0.62) {
        this.dir *= -1
        this.pose = 'perch'
        this.t = rand(0.8, 2)
      } else if (r < 0.74) {
        this.pose = 'sing'
        this.t = rand(0.4, 1)
        s.particle({ img: BUBBLE['♪'], x: this.x + 4, y: this.y - 11, life: 1.2, vy: -5, fade: true })
      } else if (r < 0.88) {
        this.pose = 'look'
        this.t = rand(0.6, 1.4)
      } else {
        this.x = clamp(this.x + this.dir * 2, this.spot.x - 2, this.spot.x + 2)
        this.pose = 'perch'
        this.t = 0.3
      }
      if (s.busy) this.t *= 0.6
      return FAST
    }
    draw(c) {
      let sp
      if (this.state === 'fly' || this.state === 'held') sp = BIRD.fly[Math.floor(this.anim * 10) % 2]
      else sp = BIRD[this.state === 'sleep' ? 'puff' : this.pose] || BIRD.perch
      c.drawImage(sp[this.dir], Math.round(this.x), Math.round(this.y) - sp.h)
    }
  }

  /** Somewhere near the birds, preferring an open stretch of floor. */
  function crumbSpot(s) {
    const birds = s.actors.filter((a) => a instanceof Bird && !a.leaving)
    const near = birds.length ? pick(birds).x + rand(-40, 40) : rand(20, s.W - 20)
    return clamp(near, 8, s.W - 10)
  }
  function dropCrumbs(s, x, y, n) {
    const now = performance.now()
    for (let i = 0; i < n; i++) s.data.crumbs.push({ x: clamp(x + rand(-6, 6), 2, s.W - 3), y: y - rand(0, 4), vy: rand(0, 10), landed: false, at: now })
    s.poke()
  }

  registerConcept({
    key: 'birds',
    title: 'Birds on the wire',
    sub: 'calm, all-day',
    chosen: true,
    blurb:
      'Sparrows on the eyes, the title and the window dots. They hop, peck, preen and sing back and forth to each other. One flies over to sit beside a friend, and a startled bird sets off its neighbours. Now and then someone drops crumbs from above, and a finished run earns a handful: they swoop in and squabble, and the one that misses out complains. While the agent works, gnats drift across and the birds dart out to snap them up. Get close and they flutter away. Pick one up and the others scatter. Click a dot under one and it flies off. They come and go on their own, and when it\'s quiet they huddle together, puff up and doze.',
    setup(s) {
      const now = performance.now()
      s.data = { crumbs: [], bugs: [], nextVisit: now + rand(20000, 40000), nextCrumbs: now + rand(15000, 35000), nextBug: 0 }
      for (let i = 0; i < 4; i++) s.actors.push(new Bird(s))
    },
    // Mockup extra (the bar is a drag region in Aico): a click scatters crumbs there.
    onBarClick(s, p) {
      dropCrumbs(s, p.x, clamp(p.y, 0, FLOOR - 2), 4)
    },
    onDone(s, ran) {
      // a good run of work earns a handful of crumbs from above
      if (ran > 1500) dropCrumbs(s, crumbSpot(s), 0, 5)
    },
    relayout(s) {
      for (const a of s.actors) {
        if (!(a instanceof Bird) || a.state === 'held') continue
        if (a.leaving) {
          a.spot.x = a.spot.x < 0 ? -10 : s.W + 4
          a.from.x = clamp(a.from.x, -10, s.W + 4)
          continue
        }
        if (a.state === 'fly') {
          a.spot.x = clamp(a.spot.x, 2, s.W - 9)
          continue
        }
        a.x = clamp(a.x, 2, s.W - 9)
        // the perch moved (title renamed, window resized): find a new one
        const onIt = a.spot.y === FLOOR ? a.spot.x < s.W - 9 : s.fix.some((f) => f.y === a.spot.y && a.spot.x >= f.x - 1 && a.spot.x <= f.x + f.w - 6)
        if (!onIt) {
          a.flyTo(a.freeSpot(null, a.spot), true)
          if (a.state === 'sleep') a.restAt = 0
        }
      }
      s.data.crumbs = s.data.crumbs.filter((c) => c.x < s.W - 2)
      s.poke()
    },
    update(s, dt, now) {
      const d = s.data
      let falling = false
      // someone up there drops crumbs now and then
      if (s.lively(now) && now > d.nextCrumbs) {
        d.nextCrumbs = now + rand(40000, 90000)
        dropCrumbs(s, crumbSpot(s), 0, Math.round(rand(3, 6)))
      }
      // the agent's work stirs up gnats; the birds go after them
      if (s.busy && now > d.nextBug && d.bugs.length < 3) {
        d.nextBug = now + rand(2500, 6000)
        const left = Math.random() < 0.5
        d.bugs.push({ x: left ? -3 : s.W, y: rand(6, FLOOR - 8), vx: (left ? 1 : -1) * rand(8, 14), ph: rand(0, 6), age: 0, dead: false, chased: false })
      }
      for (const b of d.bugs) {
        b.age += dt
        b.ph += dt * 5
        b.x += (b.vx + Math.sin(b.ph * 0.7) * 10) * dt
        b.y = clamp(b.y + Math.cos(b.ph) * 14 * dt, 4, FLOOR - 4)
        if (b.x < -6 || b.x > s.W + 4 || b.age > 30) b.dead = true
        // a bug nobody caught gets chased again after a while
        if (b.chased && !s.actors.some((a) => a.hunt === b)) b.chased = false
      }
      d.bugs = d.bugs.filter((b) => !b.dead)
      // crumbs nobody wants go stale
      if (d.crumbs.length > 24) d.crumbs.splice(0, d.crumbs.length - 24)
      d.crumbs = d.crumbs.filter((c) => now - c.at < 120000)
      for (const c of d.crumbs) {
        if (c.landed) continue
        c.vy += 120 * dt
        c.y += c.vy * dt
        const g = s.groundAt(c.x, c.x + 1, c.y - c.vy * dt)
        if (c.y >= g) {
          c.y = g
          c.landed = true
        } else falling = true
      }
      // visitors arrive and regulars leave, while someone's around
      if (s.lively(now) && now > d.nextVisit) {
        d.nextVisit = now + rand(25000, 50000)
        const birds = s.actors.filter((a) => a instanceof Bird)
        if (birds.length < 6 && Math.random() < 0.6) s.spawn(new Bird(s, true))
        else if (birds.length > 3) {
          const b = pick(birds.filter((x) => x.state === 'perch'))
          if (b) {
            b.leaving = true
            b.flyTo({ x: Math.random() < 0.5 ? -10 : s.W + 4, y: 4 }, true)
          }
        }
      }
      if (falling || d.bugs.length) return FAST
      return s.lively(now) ? Math.max(FAST, Math.min(d.nextCrumbs, s.busy ? d.nextBug : Infinity) - now) : Infinity
    },
    drawBehind(s, c) {
      for (const k of s.data.crumbs) c.drawImage(CRUMB, Math.round(k.x), Math.round(k.y) - 1)
    },
    drawFront(s, c) {
      for (const b of s.data.bugs) c.drawImage(BUG[Math.floor(b.ph * 2) % 2], Math.round(b.x) - 1, Math.round(b.y) - 1)
    },
  })
})()
