;(() => {
  // Girder platformer, big version. A giant ape stands on a red girder stub
  // just left of the window buttons with a captive lady beside him and rolls
  // barrels down the floor toward the oil drum by Aico's eyes. A carpenter hero
  // marches up from the drum, hops barrels (100), grabs the hammer and smashes
  // them, dodges the drum's fireballs and gets flattened now and then. When he
  // reaches the ape it grabs the lady and climbs off the top of the bar, comes
  // back, and every third round (or when the agent finishes) the rivets pop,
  // the girder drops and the ape lands on his head under a heart.

  // ---- palette ----------------------------------------------------------------
  const P = {
    ...PAL,
    // the ape
    F: '#5a2408', f: '#a4521c', T: '#f4b878', t: '#c8844c', E: '#141414', w: '#ffffff', r: '#c8302a',
    // the hero
    R: '#e8322a', q: '#981c16', B: '#3c5ee8', S: '#fcb890', s: '#d08860', H: '#4a2410', y: '#ffd93d', k: '#6a3410',
    // the captive
    P: '#ff7fb6', p: '#c4407a', O: '#e0602a', o: '#8a3010',
    // barrels, drum, girder, ladder, fire
    K: '#d68a46', j: '#8a4e1c', L: '#f6cc78', C: '#4ab4f0', c: '#2462c0',
    D: '#1a3c8c', b: '#3a6ef0', G: '#e83860', g: '#8c1838', Y: '#ffd640', l: '#58e0f0',
    Z: '#ffe060', z: '#f08a2c', x: '#e83820', n: '#9a6a3a', N: '#e2b070', h: '#ff5a7a', '#': '#7a7a80',
  }
  const SP = (rows) => pairOutlined(rows, P)
  const SPR = (rows) => sprite(rows, P)
  const OUT = (rows) => outline(sprite(rows, P))

  // ---- grid helpers -----------------------------------------------------------
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
  const flipH = (rows) => pad(rows).map((r) => [...r].reverse().join(''))
  const flipV = (rows) => rows.slice().reverse()
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
  const blit = (c, sp, dir, x, y) => c.drawImage(sp[dir], Math.round(x) - 1, Math.round(y) - 1)

  // ---- the ape: 44 × 30, body on a 36 grid offset by 4 -------------------
  const HEAD = [
    '....FFFFFFFF....',
    '..FFffffffffFF..',
    '.FffffffffffffF.',
    'FfffFFFffFFFfffF',
    'FffTwETffTwETffF',
    'FfTTTTTTTTTTTTfF',
    'FfTTTTtTTtTTTTfF',
    '.FTTTTTTTTTTTTF.',
    '.FTTEEEEEEEETTF.',
    '.FfTTTTTTTTTTfF.',
    '..FFTTTTTTTTFF..',
    '....FFFFFFFF....',
  ]
  const headVar = (rep) => HEAD.map((r, i) => rep[i] ?? r)
  const HEADS = {
    n: HEAD,
    blink: headVar({ 4: 'FffTEETffTEETffF' }),
    grin: headVar({ 7: '.FTEwwwwwwwwETF.', 8: '.FTEwEwEwEwEETF.', 9: '.FfTEwwwwwwETfF.', 10: '..FFTTEEEETTFF..' }),
    roar: headVar({ 3: 'FffFFFFffFFFFffF', 7: '.FTTTEEEEEETTTF.', 8: '.FTTEwrrrrwETTF.', 9: '.FfTErrrrrrETfF.', 10: '..FFTEwwwwETFF..' }),
    sleep: headVar({ 4: 'FffTTTTffTTTTffF', 5: 'FfTEEETTTTEEETfF', 8: '.FTTTTEEEETTTTF.' }),
    daze: headVar({ 4: 'FffTEwTffTwETffF', 8: '.FTTTTEEEETTTTF.', 9: '.FfTTTEwwETTTfF.' }),
    back: HEAD.map((r) => r.replace(/[TtwEr]/g, 'f')),
  }
  const TORSO = [
    '......FFFFF..............FFFFF......',
    '....FFfffffFF..........FFfffffFF....',
    '...FffffffffFFF......FFFffffffffF...',
    '...FffffffffffFFFFFFFFffffffffffF...',
    '....FffffffffTTTTTTTTTTfffffffF.....',
    '......FffffTTTTTTTTTTTTTTffffF......',
    '........FfTTTTTtTTTTtTTTTTfF........',
    '........FfTTTTTTTTTTTTTTTTfF........',
    '........FfTTTTTtTTTTtTTTTTfF........',
    '........FffTTTTTTTTTTTTTTffF........',
    '.........FfffTTTTTTTTTTfffF.........',
    '.........FffffffffffffffffF.........',
    '..........FffffffffffffffF..........',
    '..........FfffFFFFFFFFfffF..........',
    '.........FffffF......FffffF.........',
    '........FfffffF......FfffffF........',
    '........FffffF........FffffF........',
    '.......FfffffF........FfffffF.......',
    '......FTTTTTF..........FTTTTTF......',
    '......FFFFFFF..........FFFFFFF......',
  ]
  const ARM_DOWN = ['..Fffff', '.Ffffff', '.Fffff.', 'Ffffff.', 'FffffF.', 'FffffF.', 'FffffF.', 'FffffF.', 'FffffF.', 'FfffF..', 'FTTTTF.', 'FTTTTTF', '.FFFFF.']
  const ARM_CHEST = ['...Ffff.........', '..Ffffff........', '.Ffffffff.......', '.FffffffFF......', 'FfffF.FffFFF....', 'FfffF..FfffTTF..', 'FfffF...FfTTTTF.', '.FfffF..FTTTTTF.', '..FfffFFfFTTTF..', '...FffffffFFF...', '....FFFFFF......']
  const ARM_PUSH = ['.......Fffff', '......Ffffff', '.....Fffff..', '....Fffff...', '...Fffff....', '..Fffff.....', '.Fffff......', 'FTTTF.......', 'FTTTTF......', '.FFFF.......']
  const ARM_UP = ['...FTTF', '..FTTTF', '..FfffF', '..FfffF', '..FfffF', '.FffffF', '.FffffF', '.FfffF.', 'FffffF.', 'FffffF.', 'FfffffF', 'FffffffF', '.Fffffff', '..Ffffff']
  const ROLL_ROWS = (a) => {
    // an end-on barrel, 10 × 10, with its staves turned to angle a
    const out = []
    for (let y = 0; y < 10; y++) {
      let r = ''
      for (let x = 0; x < 10; x++) {
        const dx = x - 4.5
        const dy = y - 4.5
        const d = Math.hypot(dx, dy)
        if (d > 5.1) r += '.'
        else if (d > 4.1) r += 'j'
        else {
          const along = Math.abs(dx * Math.sin(a) - dy * Math.cos(a))
          const across = Math.abs(dx * Math.cos(a) + dy * Math.sin(a))
          r += along < 0.8 ? 'L' : across < 0.6 ? 'j' : 'K'
        }
      }
      out.push(r)
    }
    return out
  }
  const ROLL = [0, 1, 2, 3].map((i) => ROLL_ROWS((i * Math.PI) / 4))
  const blueRows = (rows) => recolor(rows, { K: 'C', j: 'c', L: 'w' })
  function apeRows(o) {
    const g = grid(44, 30)
    stamp(g, o.back ? TORSO.map((r) => r.replace(/[Tt]/g, 'f')) : TORSO, 4, 10)
    if (o.barrel) stamp(g, o.barrel, 17, 15)
    const arm = (k, side) => {
      if (k === 'down') side < 0 ? stamp(g, ARM_DOWN, 4, 13) : stamp(g, flipH(ARM_DOWN), 33, 13)
      if (k === 'chest') side < 0 ? stamp(g, ARM_CHEST, 4, 12) : stamp(g, flipH(ARM_CHEST), 24, 12)
      if (k === 'push') side < 0 ? stamp(g, ARM_PUSH, 0, 13) : stamp(g, flipH(ARM_PUSH), 32, 13)
      if (k === 'up') side < 0 ? stamp(g, ARM_UP, 8, 0) : stamp(g, flipH(ARM_UP), 29, 0)
    }
    arm(o.l, -1)
    arm(o.r, 1)
    stamp(g, HEADS[o.head || 'n'], 14, o.headY ?? 0)
    return rowsOf(g)
  }
  const sitRows = (() => {
    const r = apeRows({ l: 'chest', r: 'chest', head: 'sleep' }).slice(0, 24)
    return [...r, '....FTTTTTTFfffffffffffffffFTTTTTTF....', '....FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF....']
  })()
  const KR = {
    stand: apeRows({ l: 'down', r: 'down' }),
    blink: apeRows({ l: 'down', r: 'down', head: 'blink' }),
    beatA: apeRows({ l: 'chest', r: 'down', head: 'roar' }),
    beatB: apeRows({ l: 'down', r: 'chest', head: 'roar' }),
    grin: apeRows({ l: 'down', r: 'down', head: 'grin' }),
    reach: apeRows({ l: 'down', r: 'push' }),
    hold: apeRows({ l: 'chest', r: 'chest', barrel: ROLL[0] }),
    holdBlue: apeRows({ l: 'chest', r: 'chest', barrel: blueRows(ROLL[0]) }),
    push: apeRows({ l: 'push', r: 'down', head: 'roar' }),
    climbA: apeRows({ l: 'up', r: 'down', head: 'back', back: true }),
    climbB: apeRows({ l: 'down', r: 'up', head: 'back', back: true }),
    daze: apeRows({ l: 'down', r: 'down', head: 'daze' }),
  }
  const APE = {}
  for (const [k, rows] of Object.entries(KR)) APE[k] = OUT(rows)
  APE.roar = APE.beatA
  APE.sit = OUT(sitRows)
  APE.fall = OUT(flipV(apeRows({ l: 'up', r: 'up', head: 'roar' })))
  APE.head = [OUT(flipV(apeRows({ l: 'push', r: 'push', head: 'daze' }))), OUT(flipV(apeRows({ l: 'up', r: 'up', head: 'daze' })))]
  const KW = 44
  const KH = 30

  // ---- the hero, 16 × 21, faces right ------------------------------------------
  const JHEAD = [
    '....RRRRRR......',
    '...RRRRRRRRRR...',
    '..qRRRRRRRRRRRR.',
    '..HHHHSSSESS....',
    '.HSSHSSSSESSSS..',
    '.HSSHHSSSSSSSSS.',
    '.HHSSSSSSHHHHHH.',
    '..HHSSSSHHHHHH..',
    '...SSSSSSSSSs...',
  ]
  const JB = {
    stand: ['...BBRBBBRB.....', '..BBBRBBBBRBB...', '.BBBBRRRRRRBBB..', 'SSBBRyRRRRyRBBSS', 'SSSRRRRRRRRRRSSS', 'SSRRRRRRRRRRRRSS', '..RRRRRRRRRRRR..'],
    runA: ['...BBRBBBRB.....', '..BBBRBBBBRBSS..', '.SBBBRRRRRRBSS..', 'SSBBRyRRRRyR....', 'SSRRRRRRRRRRR...', '..RRRRRRRRRRRR..', '.RRRRRRRRRRRRR..'],
    runB: ['...BBRBBBRB.....', '..BBBRBBBBRB....', '..BBBRRRRRRB....', '..BBRyRRRRSS....', '...RRRRRRRSS....', '...RRRRRRRRR....', '...RRRRRRRRR....'],
    jump: ['...BBRBBBRBBSS..', '..BBBRBBBBRBSS..', '.BBBBRRRRRRBB...', 'SSBBRyRRRRyR....', 'SSRRRRRRRRRRR...', '..RRRRRRRRRRRR..', '.RRRRRRRRRRRRRR.'],
    hamUp: ['...BBRBBBRB.....', '..BBBRBBBBRB....', '.BBBBRRRRRRB....', '..BBRyRRRRyR....', '...RRRRRRRRR....', '..RRRRRRRRRRR...', '..RRRRRRRRRRR...'],
    hamDn: ['...BBRBBBRB.....', '..BBBRBBBBRBB...', '.BBBBRRRRRRBBBB.', '..BBRyRRRRyRBSSS', '...RRRRRRRRRRSSS', '..RRRRRRRRRRR...', '..RRRRRRRRRRR...'],
  }
  const JL = {
    stand: ['..RRRRR..RRRRR..', '..RRRR....RRRR..', '..RRR......RRR..', '..kkkk.....kkkk.', '.kkkkkk...kkkkkk'],
    runA: ['RRRRRR...RRRRR..', 'RRRR......RRRRR.', 'kkk.........RRR.', 'kkkk........kkkk', '.k.........kkkkk'],
    runB: ['....RRRRRRR.....', '....RRRRRRR.....', '.....RRRkkk.....', '....kkkkkkk.....', '....kkkkk.......'],
    runC: ['..RRRRR.RRRRR...', '.RRRR.....RRRR..', 'kRRR.......RRRk.', 'kkkk.......kkkk.', 'kkk.........kkk.'],
    jump: ['RRRRR....RRRRRR.', 'RRRR.......RRRRR', 'kkk.........kkkk', 'kkkk.........kkk', '................'],
  }
  const jm = (b, l, head = JHEAD) => [...head, ...JB[b], ...JL[l]]
  const JUP_HEAD = JHEAD.map((r, i) => (i === 0 ? '....RRRRRR..SS..' : i === 1 ? '...RRRRRRRRRSS..' : r))
  const JM = {
    stand: SP(jm('stand', 'stand')),
    run: [SP(jm('runA', 'runA')), SP(jm('runB', 'runB')), SP(jm('runA', 'runC')), SP(jm('runB', 'runB'))],
    jump: SP(jm('jump', 'jump', JUP_HEAD)),
    hamUp: SP(jm('hamUp', 'stand', JHEAD.map((r, i) => (i < 2 ? r.slice(0, 8) + 'SS' + r.slice(10) : r)))),
    hamDn: SP(jm('hamDn', 'stand')),
    sit: SP([...JHEAD, ...JB.stand.slice(0, 6), '..RRRRRRRRRRRRk.', '..RRRRRRRRRRRkkk', '...........kkkkk']),
    dead: SP(rot90(jm('stand', 'stand')).reverse()),
    back: SP([...JHEAD.map((r) => r.replace(/[SE]/g, 'H').replace('q', 'R')), ...JB.stand, ...JL.stand]),
  }
  const JW = 16
  const JH = 21
  const JUMP_H = 15
  const JUMP_G = 200
  const JUMP_V = Math.sqrt(2 * JUMP_G * JUMP_H)

  // ---- the captive, 14 × 23, faces right -------------------------------------------
  const PAUL_ROWS = [
    '....OOOOO.....',
    '...OOOOOOOO...',
    '..OOOOOOSSO...',
    '..OOOOOSSSS...',
    '.OOOOOSSESS...',
    '.OOoOOSSSSSS..',
    '.OOoOOSSSrS...',
    '.OOoOOOSSS....',
    '.OOOOOOwSw....',
    '.OOOOPPPPPP...',
    '..OoPPPPPPPS..',
    '...PPPPPPPSS..',
    '...PPPPPPP....',
    '...PpPPPPP....',
    '..PPPPpPPPP...',
    '..PPPPPPPPP...',
    '.PPPpPPPPpPP..',
    '.PPPPPPPPPPP..',
    'PPpPPPPPPPpPP.',
    'PPPPPPPPPPPPP.',
    '...SS...SS....',
    '...SS...SS....',
    '..www..www....',
  ]
  const PAUL_WAVE = PAUL_ROWS.map((r, i) => {
    const arm = { 4: '..SS', 5: '.SS.', 6: 'SS..', 7: 'S...', 8: 'S...', 9: 'P...' }[i]
    if (i === 10) return '..OoPPPPPPP...'
    if (i === 11) return '...PPPPPPPP...'
    return arm ? r.slice(0, 10) + arm : r
  })
  const LADY = {
    stand: SP(PAUL_ROWS),
    wave: SP(PAUL_WAVE),
    flutter: SP(PAUL_ROWS.map((r, i) => (i === 18 ? '.PpPPPPPPPpPPP' : i === 19 ? 'PPPPPPPPPPPPPP' : r))),
    kick: SP([...PAUL_ROWS.slice(0, 20), '..SS....SS....', '.SS......SS...', 'ww........ww..']),
  }
  const PW = 14
  const PH = 23

  // ---- props -------------------------------------------------------------------
  const BARREL = ROLL.map((r) => SPR(r))
  const BLUE = ROLL.map((r) => SPR(blueRows(r)))
  const BW = 10
  const UPRIGHT = SPR(['.jjjjjj.', 'jKKKKKKj', 'LLLLLLLL', 'jKKjKKKj', 'jKKjKKKj', 'jKKjKKKj', 'jKKjKKKj', 'LLLLLLLL', 'jKKKKKKj', '.jjjjjj.'])
  const DRUM = SPR([
    'DDDDDDDDDDDDDD',
    'DbbbbbbbbbbbbD',
    'wwwwwwwwwwwwww',
    'DbbbbbbbbbbbbD',
    'DbwwwbwbwbbbbD',
    'DbwbwbwbwbbbbD',
    'DbwbwbwbwbbbbD',
    'DbwbwbwbwbbbbD',
    'DbwwwbwbwwwbbD',
    'DbbbbbbbbbbbbD',
    'wwwwwwwwwwwwww',
    'DbbbbbbbbbbbbD',
    'DbbbbbbbbbbbbD',
    'DDDDDDDDDDDDDD',
  ])
  const DW = 14
  const DH = 14
  const FLAME = [
    SPR(['....Z.......', '...ZZ...Z...', '..ZzZ..ZZ...', '..zxzZZzZ.Z.', '.ZzxxzzxzZZ.', 'ZzxxxxxxxzZ.']),
    SPR(['.......Z....', '...Z...ZZ...', '..ZZ..ZzZ...', '.Z.zZZzxzZ..', '.ZZzxxzzxzZ.', 'ZzxxxxxxxxzZ']),
  ]
  const FIRE_ROWS = ['....Z.....', '...ZZ..Z..', '..ZzZ.ZZ..', '.ZzzzZzZ..', '.ZzxzzzzZ.', 'ZzwEzzwEzZ', 'ZzwEzzwEzZ', 'Zzzzzzzzz.', '.ZzzzzzzZ.', '..ZZZZZZ..']
  const FIRE = [SP(FIRE_ROWS), SP(FIRE_ROWS.map((r, i) => (i < 3 ? r.split('').reverse().join('') : r)))]
  const HAM_V = SPR(['.nnnnnn.', 'NNNNNNNN', 'NnnnnnnN', '.nnnnnn.', '...kk...', '...kk...', '...kk...', '...kk...', '...kk...'])
  const HAM_H = { 1: SPR(['......nNn', '......NNn', 'kkkkkkNNn', 'kkkkkkNNn', '......NNn', '......nNn']), '-1': SPR(['nNn......', 'nNN......', 'nNNkkkkkk', 'nNNkkkkkk', 'nNN......', 'nNn......']) }
  const HAM_ITEM = outline(HAM_V)
  const HEART = OUT(['.hhh...hhh.', 'hhwhh.hhhhh', 'hwhhhhhhhhh', 'hhhhhhhhhhh', '.hhhhhhhhh.', '..hhhhhhh..', '...hhhhh...', '....hhh....', '.....h.....'])
  const BROKEN = [OUT(['.hhh.', 'hhwhh', 'hwhhh', 'hhhh.', '.hhh.', '..hh.', '...h.', '....h']), OUT(['..hhh.', '.hhhhh', 'hhhhhh', '.hhhhh', 'hhhhh.', 'hhhh..', 'hhh...', 'h.....'])]
  const RIVET = SPR(['YY', 'YY', 'YY'])
  const GIRDER = SPR(['GGGGGGGG', 'g.gGG.g.', '.g.GGg.g', 'GGGGGGGG'])
  const LADDER_RUNG = SPR(['llllllllll'])

  const STUB_H = 4

  // ---- layout (cheap; recomputed each tick so it follows the title) ------------
  function layout(s) {
    const d = s.data
    const title = s.fixture('title')
    const eyes = s.fixture('eyes')
    const tc = title.x + title.w / 2
    const rights = s.fix.filter((f) => f !== title && f.kind !== 'eyes' && f.x > Math.min(tc, eyes.x + eyes.w + 40)).map((f) => f.x)
    const R = Math.min(s.W - 2, ...rights) - 4
    const eyesR = eyes.x + eyes.w
    d.stack = R - eyesR > 300
    const stubW = 2 + 36 + 2 + (d.stack ? 18 : 0) + PW + 2
    d.stubR = R
    d.stubL = R - stubW
    d.apeX = d.stubL + 2
    d.stackX = d.apeX + 38
    d.captiveHome = d.stubR - PW - 2
    d.stubTop = FLOOR - STUB_H
    d.drumX = Math.max(eyesR + 4, d.stubL - 640)
    d.startX = d.drumX + DW + 4
    d.endX = Math.max(d.startX + 20, d.stubL - JW + 1)
    d.len = d.endX - d.startX
    d.title = title
  }
  const hazards = (s) => s.actors.filter((a) => a.hazard && !a.dead)
  const onFloor = (h) => h.y + h.h >= FLOOR - 1.5
  /** Someone has been clicking or steering in the last few seconds. */
  const keyed = (s, now) => now - s.keyAt < 9000
  const keyDir = (s) => (s.keys.has('right') ? 1 : 0) - (s.keys.has('left') ? 1 : 0)
  const engaged = (s, now) => keyed(s, now) || now < s.data.engagedUntil || (s.cursor && s.cursor.y < H + 4 && now - s.cursor.t < 1200 && s.cursor.speed > 12)
  const handsOn = (s, now) => keyed(s, now) || now < s.data.manualUntil
  function engage(s, manual = false) {
    const now = performance.now()
    s.data.engagedUntil = now + 9000
    if (manual) s.data.manualUntil = now + 9000
  }
  /** Clear spot on the floor (not in front of the title or the eyes). */
  function openSpot(s, x, w) {
    const bad = (xx) => s.fix.some((f) => f.kind !== 'controls' && f.kind !== 'glyph' && xx + w > f.x - 4 && xx < f.x + f.w + 4)
    const d = s.data
    const lo = d.startX
    const hi = d.endX - 8
    for (let r = 0; r < s.W; r += 4)
      for (const xx of [x - r, x + r]) if (xx >= lo && xx <= hi && !bad(xx)) return xx
    return clamp(x, lo, hi)
  }

  // ---- the ape ----------------------------------------------------------------
  class Ape {
    constructor(s) {
      this.s = s
      this.seq = []
      this.pose = 'stand'
      this.t = 0
      this.dy = 0 // lift above the girder (climbing, falling)
      this.blinkAt = performance.now() + 3000
      this.blink = 0
      this.rageCd = 0
      this.clicks = []
      this.z = 1
    }
    get x() {
      return this.s.data.apeX
    }
    get y() {
      return this.s.data.stubTop - KH - this.dy
    }
    get busyPose() {
      return this.seq.length > 0
    }
    get moving() {
      return this.seq.length > 0 && this.pose !== 'sit'
    }
    get asleep() {
      return this.pose === 'sit'
    }
    hit(px, py) {
      if (this.pose === 'gone') return false
      return px >= this.x + 2 && px <= this.x + 34 && py >= this.y - 1 && py <= this.y + KH + 1
    }
    onClick() {
      const s = this.s
      const d = s.data
      const now = performance.now()
      engage(s)
      this.clicks = this.clicks.filter((t) => now - t < 3000)
      this.clicks.push(now)
      if (d.phase === 'rest') {
        // poke a sleeping ape: he grumbles awake
        this.go([['blink', 0.4], ['stand', 0.3], ['beatA', 0.18], ['beatB', 0.18], ['beatA', 0.18], ['beatB', 0.18], ['stand', 0.2]])
        return
      }
      if (d.phase !== 'play' || this.seq.length) return
      if (this.clicks.length >= 5) {
        // the tantrum: five pokes and he hurls everything he has
        this.clicks = []
        s.say('GRRR!', this.x + 18, 0, { color: '#f4b878', life: 1.2, size: 7 })
        this.beat(4, () => this.throwBarrel({ lob: true }), () => this.throwBarrel({ kind: 'blue' }), () => this.throwBarrel({}))
        return
      }
      this.beat(2, () => this.throwBarrel({ lob: Math.random() < 0.6 }))
    }
    go(list) {
      this.seq = list.map(([pose, dur, fn]) => ({ pose, dur, fn }))
      this.pose = this.seq[0].pose
      this.t = this.seq[0].dur
      this.s.poke()
    }
    then(list) {
      if (!this.seq.length) return this.go(list)
      for (const [pose, dur, fn] of list) this.seq.push({ pose, dur, fn })
    }
    beat(n = 3, ...after) {
      const l = []
      for (let i = 0; i < n; i++) l.push(['beatA', 0.16], ['beatB', 0.16])
      l.push(['stand', 0.2])
      this.go(l)
      for (const f of after) f()
    }
    rage() {
      const now = performance.now()
      if (now < this.rageCd || this.seq.length || this.s.data.phase !== 'play') return
      this.rageCd = now + 5000
      this.beat(3)
    }
    laugh() {
      if (this.seq.length) return
      this.go([['grin', 0.25], ['stand', 0.12], ['grin', 0.25], ['stand', 0.12], ['grin', 0.6], ['stand', 0.1]])
    }
    throwBarrel(o) {
      const kind = o.kind || (Math.random() < (this.s.busy ? 0.3 : 0.18) ? 'blue' : 'n')
      const steps = [
        ['reach', 0.35],
        [kind === 'blue' ? 'holdBlue' : 'hold', 0.5],
      ]
      if (o.lob) steps.push(['beatA', 0.3, () => this.s.spawn(new Barrel(this.s, kind, true))])
      else steps.push(['push', 0.4, () => this.s.spawn(new Barrel(this.s, kind, false))])
      steps.push(['stand', 0.15])
      this.then(steps)
    }
    update(dt, now, s) {
      const d = s.data
      if (this.seq.length) {
        this.t -= dt
        while (this.seq.length && this.t <= 0) {
          const cur = this.seq.shift()
          cur.fn?.()
          if (this.seq.length) {
            this.pose = this.seq[0].pose
            this.t += this.seq[0].dur
          } else {
            this.t = 0
          }
        }
        // climbing / falling drive dy from the director
        return FAST
      }
      if (this.pose === 'gone' || this.pose === 'climb' || this.pose === 'fall' || this.pose === 'head' || this.pose === 'daze') return d.apeTick ?? FAST
      if (d.phase === 'rest') {
        this.pose = 'sit'
        return Infinity
      }
      // the finale and the climbs are paced by the director
      if (d.phase !== 'play') return Infinity
      if (this.pose === 'sit') this.pose = 'stand'
      if (this.pose !== 'stand' && this.pose !== 'blink') this.pose = 'stand'
      // blink now and then
      if (now >= this.blinkAt) {
        this.pose = this.pose === 'blink' ? 'stand' : 'blink'
        this.blinkAt = now + (this.pose === 'blink' ? 140 : rand(2500, 6000))
      }
      // the cursor hovering over him: he grins down at it
      const c = s.cursor
      if (c && c.y < H + 4 && Math.abs(c.x - this.x - 18) < 22 && now - c.t < 800 && this.pose === 'stand' && now > (this.grinCd || 0)) {
        this.grinCd = now + 6000
        this.go([['grin', 0.8], ['stand', 0.1]])
        return FAST
      }
      return Math.max(FAST, this.blinkAt - now)
    }
    draw(c, s) {
      const d = s.data
      if (this.pose === 'gone') return
      const x = Math.round(this.x) - 4
      let y = Math.round(this.y)
      const p = this.pose
      let img = APE[p] || APE.stand
      if (p === 'climb') img = Math.floor(this.dy / 4) & 1 ? APE.climbA : APE.climbB
      else if (p === 'sit') {
        img = APE.sit
        y = d.stubTop - 26
      } else if (p === 'fall') img = APE.fall
      else if (p === 'head') img = APE.head[Math.floor(performance.now() / 160) & 1]
      else if (p === 'daze') img = APE.head[0]
      if (p === 'grin') y -= Math.floor(this.t * 8) & 1
      if (p === 'fall' || p === 'head' || p === 'daze') y = Math.round(FLOOR - KH - this.dy)
      c.drawImage(img, x - 1, y - 1)
      // The captive under his arm on the way up and down
      if (d.carried && (p === 'climb' || p === 'gone')) {
        const kick = Math.floor(this.dy / 3) & 1
        c.drawImage((kick ? LADY.kick : LADY.flutter)['-1'], x + 32, y + 6)
      }
      if (p === 'sit') c.drawImage(ZZ, x + 36, y - 2)
      if (p === 'daze' || p === 'head') {
        const a = performance.now() / 200
        for (let i = 0; i < 3; i++) c.drawImage(STAR, Math.round(x + 20 + Math.cos(a + i * 2.1) * 10), Math.round(FLOOR - 6 + Math.sin(a + i * 2.1) * 2))
      }
    }
  }

  // ---- barrels -------------------------------------------------------------------
  class Barrel {
    constructor(s, kind, lob) {
      const d = s.data
      this.s = s
      this.hazard = true
      this.barrel = true
      this.kind = kind
      this.w = BW
      this.h = BW
      this.z = 3
      this.moving = true
      this.speed = (s.busy ? rand(31, 36) : rand(25, 29)) * (kind === 'blue' ? 1.08 : 1)
      this.miss = Math.random() < (s.busy ? 0.04 : 0.035) // he will misjudge this one
      this.jumped = false
      this.spin = 0
      if (lob) {
        // tossed from his hands toward a spot well ahead of the hero
        this.x = d.apeX + 13
        this.y = d.stubTop - 21
        const target = Math.max(d.startX + 10, Math.min(d.endX - 30, d.jm.x + rand(50, 110)))
        const tAir = 0.85
        this.vx = (target - this.x) / tAir
        this.vy = -60
        this.air = true
      } else {
        this.x = d.apeX - 6
        this.y = d.stubTop - BW
        this.vx = -this.speed
        this.vy = 0
        this.air = false
      }
    }
    hit(px, py) {
      return px > this.x - 4 && px < this.x + BW + 4 && py > this.y - 5 && py < this.y + BW + 3
    }
    onClick() {
      const s = this.s
      engage(s, true)
      // The hero deals with the one you point at: hammer it, or hop it
      const jm = s.data.jm
      if (jm.hammer > 0 && Math.abs(this.x - jm.x - 6) < 50) {
        jm.dir = this.x > jm.x ? 1 : -1
        smash(s, this, '800')
      } else if (Math.abs(this.x - jm.x) < 40) jm.jump()
      else smash(s, this, '300')
    }
    get grabbable() {
      return true
    }
    grab() {
      engage(this.s, true)
      this.held = true
      this.hazard = false
    }
    drag(p) {
      this.x = clamp(p.x - BW / 2, 0, this.s.W - BW)
      this.y = clamp(p.y - BW / 2, 0, FLOOR - BW)
      this.px = this.lx ?? p.x
      this.lx = p.x
    }
    drop(p) {
      const s = this.s
      const d = s.data
      this.held = false
      this.hazard = true
      this.air = true
      this.vy = -30
      // flung at the ape? it bounces off his head and he sees stars
      if (p.x > d.apeX - 30) {
        this.toApe = true
        this.vx = 120
      } else this.vx = clamp((p.x - (this.px ?? p.x)) * 8, -80, 80)
    }
    update(dt, now, s) {
      const d = s.data
      if (this.held) return FAST
      if (!s.lively(now) && d.phase !== 'rivets') this.speed = Math.min(120, this.speed + 60 * dt)
      if (this.air) {
        this.vy += 240 * dt
        this.x += this.vx * dt
        this.y += this.vy * dt
        if (this.toApe && this.x + BW > d.apeX + 8 && this.y < d.stubTop - 8 && d.ape.pose !== 'gone') {
          this.dead = true
          s.burst(this.x + 5, this.y + 5, 12, ['K', 'j', 'L'])
          s.particle({ digits: '800', x: this.x, y: Math.max(0, this.y - 6), vy: -8, life: 1 })
          s.say('OOF', d.apeX + 18, 0, { color: '#f4b878', life: 1.2 })
          d.ape.go([['daze', 0.9], ['blink', 0.3], ['beatA', 0.18], ['beatB', 0.18], ['beatA', 0.18], ['stand', 0.2]])
          d.captive.react('cheer', true)
          return FAST
        }
        const ground = this.x + BW / 2 > d.stubL && this.x + BW / 2 < d.stubR && !d.dropped ? d.stubTop : FLOOR
        if (this.y + BW >= ground) {
          this.y = ground - BW
          if (this.vy > 50) {
            this.vy = -this.vy * 0.35
            s.burst(this.x + 5, ground - 1, 3, ['N', 'n'])
          } else {
            this.vy = 0
            this.air = false
            this.toApe = false
            this.vx = -this.speed
          }
        }
        if (this.x < -BW || this.x > s.W) this.dead = true
        this.spin += Math.abs(this.vx) * dt
        return FAST
      }
      this.vx = -this.speed
      this.x += this.vx * dt
      this.spin += this.speed * dt
      // off the end of the girder: drop to the floor
      const ground = this.x + BW / 2 > d.stubL && !d.dropped ? d.stubTop : FLOOR
      if (this.y + BW < ground - 0.5) {
        this.air = true
        this.vy = 0
      }
      if (this.x < d.drumX + DW - 6) {
        this.dead = true
        d.drum.flare(s, this.kind === 'blue')
      }
      return FAST
    }
    draw(c) {
      const f = Math.floor(this.spin / 3) & 3
      c.drawImage((this.kind === 'blue' ? BLUE : BARREL)[f], Math.round(this.x), Math.round(this.y))
    }
  }

  class Fireball {
    constructor(s) {
      const d = s.data
      this.s = s
      this.hazard = true
      this.fire = true
      this.w = 10
      this.h = 10
      this.x = d.drumX + 2
      this.y = FLOOR - DH - 10
      this.vy = -40
      this.vx = 22
      this.air = true
      this.life = rand(14, 22)
      this.turnCd = 0
      this.phase = 0
      this.z = 3
      this.moving = true
      this.miss = false
    }
    hit(px, py) {
      return px > this.x - 4 && px < this.x + 14 && py > this.y - 4 && py < FLOOR
    }
    onClick() {
      engage(this.s, true)
      smash(this.s, this, '500')
    }
    update(dt, now, s) {
      const d = s.data
      this.phase += dt * 8
      this.life -= dt
      if (this.life <= 0 || (!s.lively(now) && d.phase !== 'rivets') || d.phase === 'grab' || d.phase === 'climb') {
        this.dead = true
        s.burst(this.x + 5, this.y + 5, 8, ['Z', 'z', 'x'])
        return FAST
      }
      if (this.air) {
        this.vy += 200 * dt
        this.x += this.vx * dt
        this.y += this.vy * dt
        if (this.y + this.h >= FLOOR) {
          this.y = FLOOR - this.h
          this.air = false
          this.vx = 13
        }
        return FAST
      }
      // creep after the hero; turn only with a cooldown and some distance
      const jm = d.jm
      this.turnCd -= dt
      const want = jm.state === 'dead' ? -1 : Math.sign(jm.x + 3 - this.x) || 1
      if (want !== Math.sign(this.vx) && this.turnCd <= 0 && Math.abs(jm.x + 3 - this.x) > 18) {
        this.vx = want * (s.busy ? 16 : 13)
        this.turnCd = 2
      }
      this.x = clamp(this.x + this.vx * dt, d.drumX + DW, d.endX + 8)
      return FAST
    }
    draw(c) {
      blit(c, FIRE[Math.floor(this.phase / 2) & 1], this.vx < 0 ? -1 : 1, this.x, this.y - (Math.floor(this.phase) & 1))
    }
  }

  function smash(s, h, pts) {
    if (!h || h.dead) return
    h.dead = true
    s.burst(h.x + 5, h.y + 5, 12, h.fire ? ['Z', 'z', 'x'] : h.kind === 'blue' ? ['C', 'c', 'w'] : ['K', 'j', 'L', 'w'])
    s.particle({ digits: pts, x: h.x, y: Math.max(0, h.y - 7), vy: -8, life: 1 })
    s.data.ape.rage()
    s.data.captive.react('cheer')
  }

  class Drum {
    constructor(s) {
      this.s = s
      this.prop = true
      this.flame = 0
      this.z = 2
    }
    get x() {
      return this.s.data.drumX
    }
    hit(px, py) {
      return px > this.x - 2 && px < this.x + DW + 2 && py > FLOOR - DH - 6
    }
    onClick() {
      engage(this.s)
      this.flare(this.s, true)
    }
    flare(s, spawn) {
      this.flame = 1.6
      const fires = hazards(s).filter((h) => h.fire).length
      const max = s.busy ? 2 : 1
      if (s.lively() && fires < max && (spawn || Math.random() < (s.busy ? 0.25 : 0.12)) && s.data.phase === 'play') s.spawn(new Fireball(s))
      s.poke()
    }
    update(dt) {
      if (this.flame <= 0) return Infinity
      this.flame -= dt
      return FAST
    }
    draw(c) {
      const x = Math.round(this.x)
      c.drawImage(DRUM, x, FLOOR - DH)
      if (this.flame > 0) c.drawImage(FLAME[Math.floor(this.flame * 8) & 1], x + 1, FLOOR - DH - 6)
    }
  }

  class HammerItem {
    constructor(s, x) {
      this.s = s
      this.x = x
      this.y = FLOOR - JH - 13
      this.pickup = true
      this.z = 2
      this.t = 0
    }
    hit(px, py) {
      return px > this.x - 4 && px < this.x + 12 && py < this.y + 14
    }
    onClick() {
      // point at it and he goes for it
      engage(this.s)
      this.s.data.jm.wantHammer = this
    }
    update(dt, now, s) {
      if (!s.lively(now) || s.data.phase !== 'play') this.dead = true
      this.t += dt
      return Math.floor(this.t * 3) !== Math.floor((this.t - dt) * 3) ? FAST : SLOW
    }
    draw(c) {
      c.drawImage(HAM_ITEM, Math.round(this.x) - 1, Math.round(this.y) - 1 + (Math.floor(this.t * 3) & 1))
    }
  }

  class Pop {
    // a heart (or a broken one) rising over the couple, a short-lived prop
    constructor(x, y, kind, life) {
      this.x = x
      this.y = y
      this.kind = kind
      this.life = life
      this.age = 0
      this.prop = true
      this.z = 6
    }
    update(dt) {
      this.age += dt
      if (this.age >= this.life) this.dead = true
      return this.age < 1.2 ? FAST : SLOW
    }
    draw(c) {
      const k = Math.min(1, this.age / 1.2)
      const y = Math.round(this.y - k * 3)
      if (this.kind === 'heart') c.drawImage(HEART, Math.round(this.x), y)
      else {
        const sp = Math.round(k * 3)
        c.drawImage(BROKEN[0], Math.round(this.x) - sp, y + sp)
        c.drawImage(BROKEN[1], Math.round(this.x) + 6 + sp, y + sp)
      }
    }
  }

  // ---- the captive ------------------------------------------------------------------
  class Captive {
    constructor(s) {
      this.s = s
      this.anim = null
      this.t = 0
      this.next = performance.now() + rand(2500, 5000)
      this.cd = 0
      this.hop = 0
      this.z = 1
      this.dx = 0
    }
    get x() {
      return this.s.data.captiveHome + this.dx
    }
    get y() {
      return this.s.data.stubTop - PH
    }
    get hidden() {
      return this.s.data.carried
    }
    hit(px, py) {
      return !this.hidden && px > this.x - 2 && px < this.x + PW + 2 && py > this.y - 2 && py < this.y + PH
    }
    onClick() {
      engage(this.s)
      const d = this.s.data
      if (d.phase === 'rest') {
        this.s.particle({ img: BUBBLE['♥'], x: this.x - 8, y: this.y - 8, life: 1.4 })
        return
      }
      this.react(Math.random() < 0.5 ? 'help' : 'love', true)
      d.jm.glance(this.x)
    }
    react(kind, force = false) {
      const s = this.s
      const now = performance.now()
      if (this.hidden || (!force && now < this.cd)) return
      this.cd = now + 4000
      if (kind === 'help') {
        this.anim = 'wave'
        this.t = 1.6
        s.say(pick(['HELP!', 'HELP!', 'HELP!', 'HELP ME!']), this.x + PW / 2, 0, { color: '#ff9fc8', life: 1.6, size: 7 })
      } else if (kind === 'love') s.particle({ img: BUBBLE['♥'], x: this.x - 8, y: this.y - 8, vy: -2, life: 1.3 })
      else if (kind === 'gasp') s.particle({ img: BUBBLE['!'], x: this.x - 6, y: this.y - 8, life: 1.2 })
      else if (kind === 'cheer') {
        this.hop = 0.7
        this.anim = 'wave'
        this.t = 0.7
      }
      s.poke()
    }
    update(dt, now, s) {
      const d = s.data
      if (this.t > 0 || this.hop > 0) {
        this.t -= dt
        this.hop -= dt
        if (this.t <= 0) this.anim = null
        return FAST
      }
      if (!s.lively(now) || d.phase !== 'play') return Infinity
      const c = s.cursor
      if (c && c.y < H + 4 && Math.abs(c.x - this.x - PW / 2) < 20 && now - c.t < 800) this.react('help')
      if (now >= this.next) {
        this.react(d.jm.x > d.startX + d.len * 0.6 ? pick(['help', 'love']) : 'help')
        this.next = now + (s.busy ? rand(7000, 11000) : rand(10000, 16000))
      }
      return Math.max(FAST, this.next - now)
    }
    draw(c) {
      if (this.hidden) return
      let img = LADY.stand
      if (this.anim === 'wave') img = Math.floor(this.t * 6) & 1 ? LADY.wave : LADY.flutter
      const y = this.y - (this.hop > 0 && Math.floor(this.hop * 8) & 1 ? 2 : 0)
      blit(c, img, -1, this.x, y)
    }
  }

  // ---- the hero ------------------------------------------------------------------
  class Hero {
    constructor(s) {
      this.s = s
      this.x = s.data.startX
      this.jy = 0
      this.vx = 0
      this.dir = 1
      this.state = 'stand'
      this.t = 0
      this.leg = 0
      this.hammer = 0
      this.swing = 0
      this.turnCd = 0
      this.blink = 0
      this.z = 4
    }
    get y() {
      return FLOOR - JH - this.jy
    }
    get moving() {
      return this.state === 'run' || this.state === 'jump'
    }
    get asleep() {
      return this.state === 'sit'
    }
    hit(px, py) {
      return px > this.x - 1 && px < this.x + JW + 1 && py > this.y - 2 && py < this.y + JH + 1
    }
    onClick() {
      engage(this.s, true)
      if (this.state === 'sit') {
        this.state = 'stand'
        this.s.particle({ img: BUBBLE['?'], x: this.x + 10, y: this.y - 8, life: 1 })
        return
      }
      this.jump()
    }
    onDblClick() {
      // a little easter egg: a double-click summons the hammer right over him
      const s = this.s
      if (s.data.phase !== 'play' || this.hammer > 0 || s.actors.some((a) => a.pickup)) return
      s.spawn(new HammerItem(s, clamp(this.x + 3, s.data.startX, s.data.endX)))
    }
    glance(x) {
      if (this.state === 'stand') {
        this.dir = x > this.x ? 1 : -1
        this.turnCd = 1
      }
    }
    jump(vx = null) {
      if (this.state === 'dead' || this.state === 'jump' || this.hammer > 0) return
      if (this.state === 'sit') this.state = 'stand'
      this.state = 'jump'
      this.jt = 0
      this.vx = vx ?? (this.walking ? this.dir * this.speed() : 0)
      this.s.poke()
    }
    speed() {
      return this.s.busy ? 24 : 21
    }
    die() {
      const s = this.s
      const d = s.data
      this.state = 'dead'
      this.t = 3.2
      this.hammer = 0
      this.jy = 0
      d.ape.laugh()
      d.captive.react('gasp', true)
      d.prog = Math.max(0, d.prog - d.len * 0.3)
    }
    /** Feet box. */
    get fx0() {
      return this.x + 4
    }
    get fx1() {
      return this.x + 12
    }
    update(dt, now, s) {
      const d = s.data
      const lively = s.lively(now)
      this.turnCd -= dt
      if (this.state === 'dead') {
        this.t -= dt
        if (this.t > 0) return FAST
        if (hazards(s).some((h) => !h.fire && onFloor(h) && h.x < d.startX + 40)) return FAST
        this.state = 'stand'
        this.x = d.startX
        this.dir = 1
        this.blink = 1.6
        return FAST
      }
      if (this.blink > 0) this.blink -= dt
      if (this.hammer > 0) {
        this.hammer -= dt
        this.swing += dt
        const down = Math.floor(this.swing * 5) & 1
        for (const h of hazards(s)) {
          if (!onFloor(h)) continue
          const reach = this.dir > 0 ? [this.x + 8, this.x + JW + 10] : [this.x - 10, this.x + 8]
          if (down && h.x + h.w > reach[0] && h.x < reach[1]) smash(s, h, h.fire ? '500' : pick(['300', '300', '500', '800']))
        }
        if (Math.floor(this.hammer * 2) !== Math.floor((this.hammer + dt) * 2) && Math.random() < 0.4) s.particle({ img: BUBBLE['♪'], x: this.x + 8, y: Math.max(0, this.y - 16), vy: -6, life: 1 })
      }
      // airborne: an exact arc, the same at any frame rate
      if (this.state === 'jump') {
        this.jt += dt
        this.jy = Math.max(0, JUMP_V * this.jt - (JUMP_G * this.jt * this.jt) / 2)
        this.x = clamp(this.x + this.vx * dt, d.startX - 8, d.endX)
        const ham = s.actors.find((a) => a.pickup && !a.dead)
        if (ham && this.x + JW > ham.x + 1 && this.x < ham.x + 7 && this.y < ham.y + 9) {
          ham.dead = true
          this.hammer = s.busy ? 10 : 8
          this.swing = 0
          this.wantHammer = null
          s.particle({ img: BUBBLE['♪'], x: this.x + 12, y: Math.max(0, this.y - 8), vy: -6, life: 1.2 })
        }
        if (this.jy <= 0 && this.jt > 0.05) {
          this.jy = 0
          this.state = 'stand'
        }
      }
      // what is on the floor around me?
      const hz = hazards(s).filter(onFloor)
      for (const h of hz) {
        const hx0 = h.x + 1
        const hx1 = h.x + h.w - 1
        if (hx1 > this.fx0 && hx0 < this.fx1) {
          const top = h.fire ? h.y + 3 : h.y + 2
          if (FLOOR - this.jy > top + 0.5) {
            if (this.hammer > 0 || this.blink > 0) continue
            this.die()
            return FAST
          }
          if (!h.jumped) {
            h.jumped = true
            s.particle({ digits: '100', x: h.x, y: Math.max(0, this.y - 7), vy: -8, life: 0.9 })
            d.prog = Math.min(d.len, d.prog + d.len / (s.busy ? 7 : 8))
            if (Math.random() < 0.3) d.captive.react('love')
          }
        }
      }
      const manual = handsOn(s, now)
      // plan a hop over whatever is coming (unless you are doing the jumping)
      this.hold = false
      if (this.state !== 'jump' && this.hammer <= 0 && !manual) {
        const disc = (cl) => Math.sqrt(Math.max(0, JUMP_V * JUMP_V - 2 * JUMP_G * cl))
        for (const h of hz) {
          if (h.miss || h.jumped) continue
          const right = h.x + h.w / 2 > this.x + JW / 2
          const gap = right ? h.x + 1 - this.fx1 : this.fx0 - (h.x + h.w - 1)
          if (gap < -1 || gap > 60) continue
          const hv = right ? -h.vx : h.vx // its speed toward me
          const mine = this.state === 'run' && this.dir === (right ? 1 : -1) ? this.speed() : 0
          const cl = h.fire ? 7 : 8
          const t1 = (JUMP_V - disc(cl)) / JUMP_G
          const t2 = (JUMP_V + disc(cl)) / JUMP_G
          const over = 8 + h.w - 2
          for (const vm of [mine, 0]) {
            const cv = hv + vm
            if (cv < 4) break
            if ((gap + over) / cv > t2 - 0.03) {
              // can't clear it at this speed: stand still and try again
              if (vm > 0) {
                this.hold = true
                continue
              }
              break
            }
            if (gap / cv <= t1 + 0.04) this.jump(vm ? this.dir * vm : 0)
            break
          }
          if (this.state === 'jump') break
        }
      }
      if (this.state === 'jump') return FAST
      // A/D: you run him (no auto-hops while the keyboard has him: jumping is your job)
      const kd = lively && this.state !== 'sit' && d.phase === 'play' ? keyDir(s) : 0
      if (kd) {
        this.dir = kd
        this.turnCd = 0.3
        this.state = 'run'
        this.walking = true
        this.x = clamp(this.x + kd * this.speed() * 1.3 * dt, d.startX - 8, d.endX)
        this.leg += dt * 9
        d.prog = clamp(Math.max(d.prog, this.x - d.startX), 0, d.len)
        return FAST
      }
      this.walking = false
      if (s.keys.size) {
        if (this.state === 'run') this.state = 'stand'
        return FAST
      }
      // where to go
      const c = s.cursor
      let goal = null
      const ham = s.actors.find((a) => a.pickup && !a.dead)
      if (!lively && d.phase !== 'rivets' && d.phase !== 'fallen') goal = this.restX ?? (this.restX = openSpot(s, this.x, JW))
      else {
        this.restX = null
        if (this.state === 'sit') this.state = 'stand'
        if (d.phase === 'play') {
          if (keyed(s, now)) goal = null
          else if (engaged(s, now) && c && c.y < H + 6) goal = clamp(c.x - JW / 2, d.startX, d.endX)
          else if (ham && this.hammer <= 0 && (this.wantHammer === ham || ham.x > this.x - 30)) goal = clamp(ham.x - 4, d.startX, d.endX)
          else goal = d.startX + d.prog
        } else if (d.phase === 'reset') goal = d.startX
        else if (d.phase === 'rivets' || d.phase === 'fallen') goal = d.endX
      }
      if (goal !== null) goal = clamp(goal, d.startX - 8, d.endX)
      // under the hammer: hop up and take it
      if (ham && this.hammer <= 0 && Math.abs(this.x - (ham.x - 4)) < 2.5 && d.phase === 'play' && !this.hold) {
        this.jump(0)
        return FAST
      }
      this.walking = false
      if (goal !== null && Math.abs(goal - this.x) > 1.5 && !this.hold) {
        const want = Math.sign(goal - this.x)
        if (want !== this.dir && this.turnCd > 0) {
          this.state = 'stand'
          return FAST
        }
        if (want !== this.dir) this.turnCd = 0.6
        this.dir = want
        this.state = 'run'
        this.walking = true
        const sp = d.phase === 'rivets' || d.phase === 'fallen' ? 44 : d.phase === 'reset' ? 32 : this.speed()
        this.x = clamp(this.x + want * sp * dt, d.startX - 8, d.endX)
        this.leg += dt * 9
        return FAST
      }
      if (this.state === 'run') this.state = 'stand'
      // face the action
      if (this.turnCd <= 0 && (d.phase !== 'play' || !hz.length)) this.dir = 1
      if (!lively && d.phase !== 'rivets' && d.phase !== 'fallen' && this.restX !== null && Math.abs(this.x - this.restX) <= 1.5 && this.hammer <= 0) {
        this.state = 'sit'
        return Infinity
      }
      if (this.hammer > 0 || this.blink > 0 || hz.length || this.hold) return FAST
      if (c && engaged(s, now)) {
        this.dir = c.x > this.x + JW / 2 ? 1 : -1
        return FAST
      }
      return d.phase === 'play' && lively ? SLOW : Infinity
    }
    draw(c, s) {
      if (this.blink > 0 && Math.floor(this.blink * 10) & 1) return
      const x = this.x
      const y = this.y
      if (this.state === 'dead') {
        if (this.t > 2.3) {
          const k = Math.floor(this.t * 12) & 3
          blit(c, k === 0 ? JM.stand : k === 2 ? JM.back : JM.stand, k === 1 ? -1 : 1, x, y)
        } else {
          blit(c, JM.dead, 1, x - 2, FLOOR - JW)
          if (this.t < 1.8) c.drawImage(STAR, Math.round(x + 8), FLOOR - JW - 6 + (Math.floor(this.t * 4) & 1))
        }
        return
      }
      if (this.state === 'sit') return blit(c, JM.sit, this.dir, x, FLOOR - 18)
      if (this.hammer > 0) {
        const flash = this.hammer < 1.5 && Math.floor(this.hammer * 10) & 1
        const down = Math.floor(this.swing * 5) & 1
        if (this.state === 'jump') blit(c, JM.jump, this.dir, x, y)
        else blit(c, down ? JM.hamDn : JM.hamUp, this.dir, x, y)
        if (!flash) {
          if (down) c.drawImage(HAM_H[this.dir], Math.round(this.dir > 0 ? x + 14 : x - 7), Math.round(y + 9))
          else c.drawImage(HAM_V, Math.round(x + 5), Math.round(y - 8))
        }
        return
      }
      if (this.state === 'jump') blit(c, JM.jump, this.dir, x, y)
      else if (this.state === 'run') blit(c, JM.run[Math.floor(this.leg) & 3], this.dir, x, y)
      else blit(c, JM.stand, this.dir, x, y)
    }
  }

  // ---- director ------------------------------------------------------------------
  // phases: play → (grab → climb → away → reset → descend) → play
  //         play → rivets → fallen → recover → play;   rest when the bar is quiet
  function setPhase(s, p, ms = 0) {
    const d = s.data
    d.phase = p
    d.phaseAt = performance.now()
    d.phaseEnd = d.phaseAt + ms
    s.poke()
  }
  function startRivets(s) {
    const d = s.data
    d.pendingDone = false
    for (const h of hazards(s)) {
      h.dead = true
      s.burst(h.x + 5, h.y + 5, 6, ['K', 'j', 'L'])
    }
    for (const a of s.actors) if (a.pickup) a.dead = true
    d.ape.seq = []
    d.ape.pose = 'stand'
    d.ape.beat(3)
    d.rivetsLeft = 3
    d.nextRivet = 0
    setPhase(s, 'rivets')
  }
  function endRound(s) {
    const d = s.data
    d.round++
    if (d.pendingDone || d.round % 3 === 0) return startRivets(s)
    // he snatches her and climbs off the top of the bar
    for (const h of hazards(s)) {
      h.dead = true
      s.burst(h.x + 5, h.y + 5, 6, ['K', 'j', 'L'])
    }
    d.ape.go([
      ['roar', 0],
      ['beatA', 0.2],
      ['beatB', 0.2],
      ['reach', 0.4, () => {
        d.carried = true
        d.captive.anim = null
      }],
      ['climb', 0.01],
    ])
    d.ape.pose = 'beatA'
    setPhase(s, 'grab')
  }

  registerConcept({
    key: 'girderclimb',
    title: 'Girder climb',
    blurb:
      'A giant ape stands on his girder by the window buttons with a captive lady and rolls barrels down the bar toward the oil drum, where blue ones light fireballs. A carpenter hero marches up from the drum, hops barrels for 100, grabs the hammer to smash them, and gets flattened now and then while the ape grins. Reach the ape and he climbs off the top with the lady; every third round the rivets pop and he lands on his head under a heart. <b>Click</b> the hero to jump, a barrel to have him hop or hammer it, the ape to make him throw (five quick pokes for a tantrum), the lady, the drum or the hammer; drag a barrel and fling it back at the ape. Move over the bar and the hero follows you. Work speeds it all up, Done brings the rivet finale, and when it is quiet everyone sits down.',
    setup(s) {
      s.data = { phase: 'play', round: 0, prog: 0, engagedUntil: 0, manualUntil: 0, carried: false, dropped: 0, rivetsLeft: 3, apeTick: FAST }
      layout(s)
      const d = s.data
      d.drum = new Drum(s)
      d.ape = new Ape(s)
      d.captive = new Captive(s)
      d.jm = new Hero(s)
      d.nextThrow = performance.now() + 1500
      d.hammerAt = performance.now() + rand(12000, 20000)
      setPhase(s, 'play')
      s.actors.push(d.drum, d.ape, d.captive, d.jm)
    },
    relayout(s) {
      layout(s)
      const d = s.data
      d.jm.x = clamp(d.jm.x, d.startX - 8, d.endX)
      d.prog = clamp(d.prog, 0, d.len)
      d.jm.restX = null
      for (const a of s.actors) if (a.pickup) a.x = clamp(a.x, d.startX + 4, d.endX - 4)
      for (const h of hazards(s)) h.x = clamp(h.x, 0, s.W - 10)
    },
    onBarClick(s) {
      engage(s, true)
      s.data.jm.jump()
    },
    // keyboard: A/D run, W or Space jump (carrying his run), S stands him still
    onKey(s, k, down) {
      const jm = s.data.jm
      if (!down || !jm) return
      if (jm.state === 'sit') jm.state = 'stand'
      if (k === 'fire' || k === 'up') {
        const kd = keyDir(s)
        jm.jump(kd ? kd * jm.speed() * 1.3 : 0)
      } else if (k === 'down' && jm.state === 'run') jm.state = 'stand'
    },
    onBusy(s) {
      const d = s.data
      d.nextThrow = Math.min(d.nextThrow, performance.now() + 500)
      if (d.phase === 'play' && !d.ape.seq.length) d.ape.beat(3)
    },
    onDone(s) {
      const d = s.data
      d.pendingDone = true
      if (d.phase === 'play' || d.phase === 'rest') startRivets(s)
    },
    onNap(s) {
      for (const a of s.actors) if (a.pickup || a.fire) a.dead = true
      s.data.jm.hammer = 0
    },
    onBonk(s) {
      s.data.ape.rage()
    },
    drawBehind(s, c) {
      const d = s.data
      // girder stub: the ape's half drops away at the rivet finale
      const drop = d.dropped || 0
      for (let x = d.stubL; x < d.stubR; x += 8) {
        const apeSide = x < d.stackX - 1
        const yy = d.stubTop + (apeSide ? drop : 0)
        if (yy < FLOOR) c.drawImage(GIRDER, Math.round(x), Math.round(yy), Math.min(8, d.stubR - x), STUB_H)
      }
      if (!drop) for (let i = 0; i < d.rivetsLeft; i++) c.drawImage(RIVET, Math.round(d.apeX + [0, 17, 34][i]), d.stubTop)
      // the barrel stack
      if (d.stack) {
        const sx = Math.round(d.stackX)
        c.drawImage(UPRIGHT, sx, d.stubTop - 10)
        c.drawImage(UPRIGHT, sx + 8, d.stubTop - 10)
        c.drawImage(UPRIGHT, sx + 4, d.stubTop - 20)
      }
      // the ladder he climbs off the top on
      if (['grab', 'climb', 'away', 'descend', 'reset'].includes(d.phase) || d.ape.pose === 'climb') {
        const lx = Math.round(d.apeX + 13)
        c.fillStyle = P.l
        c.fillRect(lx, 0, 1, d.stubTop)
        c.fillRect(lx + 9, 0, 1, d.stubTop)
        for (let y = d.stubTop - 3; y > 0; y -= 4) c.drawImage(LADDER_RUNG, lx, y)
      }
    },
    update(s, dt, now) {
      layout(s)
      const d = s.data
      const lively = s.lively(now)
      const k = d.ape
      d.apeTick = FAST
      switch (d.phase) {
        case 'rest':
          if (lively || d.pendingDone) {
            if (d.pendingDone) startRivets(s)
            else {
              setPhase(s, 'play')
              k.pose = 'stand'
              k.beat(2)
              d.nextThrow = now + 2000
            }
          }
          return Infinity
        case 'play': {
          if (d.pendingDone) {
            startRivets(s)
            return FAST
          }
          if (!lively) {
            // let the last barrels roll home, then sit down
            if (!hazards(s).length && !k.seq.length && d.jm.state !== 'dead') setPhase(s, 'rest')
            return SLOW
          }
          const jm = d.jm
          // The hero creeps forward on his own too
          if (jm.state !== 'dead' && !engaged(s, now)) d.prog = Math.min(d.len, d.prog + dt * 1.6)
          if (jm.state !== 'dead' && jm.x >= d.endX - 3 && d.prog >= d.len - 2 && !k.seq.length && !engaged(s, now)) {
            endRound(s)
            return FAST
          }
          // close to the ape: he gets nervous
          if (jm.x > d.endX - 60 && Math.random() < dt * 0.25) k.rage()
          // throw schedule
          const barrels = hazards(s).filter((h) => h.barrel).length
          if (now >= d.nextThrow && !k.seq.length) {
            if (jm.state !== 'dead' && barrels < (s.busy ? 4 : 2) && jm.x < d.endX - 30) {
              const lob = jm.x < d.endX - 140 && Math.random() < (s.busy ? 0.2 : 0.12)
              k.throwBarrel({ lob })
              d.nextThrow = now + (s.busy ? rand(1500, 2600) : rand(3200, 5600))
            } else d.nextThrow = now + 700
          }
          if (now >= d.hammerAt) {
            d.hammerAt = now + (s.busy ? rand(11000, 17000) : rand(18000, 28000))
            if (!s.actors.some((a) => a.pickup) && jm.hammer <= 0 && jm.state !== 'dead') {
              const hx = clamp(jm.x + rand(50, 110), d.startX + 20, d.endX - 20)
              if (hx > jm.x + 20) s.spawn(new HammerItem(s, hx))
            }
          }
          return Math.max(FAST, Math.min(d.nextThrow, d.hammerAt) - now)
        }
        case 'grab':
          if (!k.seq.length) {
            k.pose = 'climb'
            setPhase(s, 'climb')
            s.spawn(new Pop(d.captiveHome - 1, d.stubTop - PH - 2, 'broken', 2.4))
          }
          return FAST
        case 'climb':
          k.dy += dt * 16
          if (d.stubTop - KH - k.dy < -KH - 4) {
            k.pose = 'gone'
            setPhase(s, 'away', 2500)
          }
          return FAST
        case 'away':
          if (now >= d.phaseEnd) setPhase(s, 'reset')
          return Math.max(FAST, d.phaseEnd - now)
        case 'reset':
          if (Math.abs(d.jm.x - d.startX) < 2 || !lively) {
            d.prog = 0
            if (d.skipDescend || k.pose !== 'gone') {
              d.skipDescend = false
              d.carried = false
              k.dy = 0
              if (k.pose === 'gone') k.pose = 'stand'
              setPhase(s, 'play')
              d.nextThrow = now + 2200
              return FAST
            }
            k.pose = 'climb'
            setPhase(s, 'descend')
          }
          return FAST
        case 'descend':
          k.dy = Math.max(0, k.dy - dt * 20)
          if (k.dy <= 0) {
            d.carried = false
            k.pose = 'stand'
            k.beat(3)
            s.burst(d.apeX + 18, d.stubTop, 8, ['N', 'n'])
            setPhase(s, 'play')
            d.nextThrow = now + 2200
            d.captive.react('help', true)
          }
          return FAST
        case 'rivets': {
          // the rivets pop one by one while the hero races up to the ape
          if (now < d.nextRivet) return Math.max(FAST, d.nextRivet - now)
          if (d.rivetsLeft > 0) {
            d.rivetsLeft--
            const rx = d.apeX + [0, 17, 34][d.rivetsLeft]
            s.particle({ img: RIVET, x: rx, y: d.stubTop, vx: rand(-20, 20), vy: -60, g: 160, life: 1.2 })
            s.particle({ digits: '100', x: rx - 4, y: d.stubTop - 10, vy: -8, life: 0.9 })
            k.seq = []
            k.go([['beatA', 0.15], ['beatB', 0.15], ['beatA', 0.15], ['stand', 0.05]])
            d.nextRivet = now + 700
            return FAST
          }
          // the girder drops away, he jumps, flips and lands on his head
          setPhase(s, 'fallen')
          d.dropped = 0.01
          k.seq = []
          k.pose = 'fall'
          k.dy = FLOOR - d.stubTop + 2
          k.vy = 40
          d.heartAt = 0
          d.heartBy = now + 5000
          return FAST
        }
        case 'fallen': {
          d.dropped = Math.min(STUB_H + 2, d.dropped + dt * 20)
          if (k.pose === 'fall') {
            k.vy -= 160 * dt
            k.dy += k.vy * dt
            if (k.dy <= 0) {
              k.dy = 0
              k.pose = 'head'
              s.burst(d.apeX + 18, FLOOR - 2, 14, ['N', 'n', 'w'])
              d.heartAt = 1
            }
            return FAST
          }
          // the heart once the hero gets there (or soon anyway)
          if (d.heartAt && (Math.abs(d.jm.x - d.endX) < 3 || now >= d.heartBy)) {
            d.heartAt = 0
            d.phaseEnd = now + 6500
            s.spawn(new Pop(d.apeX + 12, 1, 'heart', 5))
            d.captive.react('love', true)
            k.pose = 'daze'
          }
          if (!d.heartAt && k.pose === 'daze' && now >= d.phaseEnd) {
            // he shakes it off; a new girder slides up and he hops back on
            k.pose = 'stand'
            k.dy = 0
            d.dropped = 0
            d.rivetsLeft = 3
            d.round = 0
            setPhase(s, 'reset')
            k.go([['blink', 0.3], ['beatA', 0.18], ['beatB', 0.18], ['beatA', 0.18], ['stand', 0.3]])
            d.carried = false
            // after the reset walk, he does not need to climb down
            d.skipDescend = true
          }
          return k.pose === 'head' || d.heartAt ? FAST : Math.max(FAST, Math.min(d.phaseEnd - now, 160))
        }
      }
      return Infinity
    },
  })
})()
