;(() => {
  // Mega Man (Capcom, 1987). Big version: a ~24 px blue bomber beams in and
  // plays the Met game along the floor of the bar; Mets duck under their hard
  // hats when he or the cursor comes close and peek out to fire 3-way shots.
  // While the agent works a Robot Master (Cut Man or Ice Man) drops in for a
  // boss fight with health meters; Done is the "weapon get" moment.

  // capture-only: keep the bar lively in headless long runs (?t=…&awake)
  const KEEP_AWAKE = (() => {
    try {
      const q = new URLSearchParams(location.search)
      return q.has('t') && q.has('awake')
    } catch {
      return false
    }
  })()

  // capture-only: always run this watch-mode episode (?t=…&mmep=joe)
  const FORCE_EP = (() => {
    try {
      const q = new URLSearchParams(location.search)
      return q.has('t') ? q.get('mmep') : null
    } catch {
      return null
    }
  })()

  // ---- palette (NES-ish) ----------------------------------------------------
  const MP = {
    b: '#0070ec', c: '#3cbcfc', S: '#fcd8a8', s: '#e0a070', w: '#fcfcfc', E: '#101010',
    C: '#a4e4fc', g: '#00a844', G: '#b8f818', x: '#7c7c7c', X: '#bcbcbc', B: '#0040b8',
    y: '#f8e050', Y: '#fffbd0', o: '#e45c10', O: '#fca044',
    // Met
    M: '#f8b800', m: '#a86800', h: '#fce4a0', k: '#282830', K: '#4c4c60',
    // Cut Man
    R: '#d82800', r: '#881400', L: '#fc7460', W: '#f8f8f8',
    // Ice Man
    P: '#2c8cf8', p: '#0048b0', I: '#dcf4fc',
    // E-tank / meters
    e: '#f8f8b0', n: '#202024',
    // Sniper Joe
    j: '#58d854', J: '#005800',
  }
  /** overlay: write str into rows[r] at column c ('_' keeps what is there) */
  function ov(rows, r, c, str) {
    const out = rows.slice()
    const row = (out[r] || '').padEnd(c + str.length, '.')
    out[r] = row.slice(0, c) + [...str].map((ch, i) => (ch === '_' ? row[c + i] : ch)).join('') + row.slice(c + str.length)
    return out
  }

  // ---- Mega Man frames: head + body rows, facing right ---------------------
  // 24 wide; body centre on column 10.
  const HEAD = [
    '........bbbbbb..........',
    '......bbbbbbcbbb........',
    '.....bbbbbbbbccbb.......',
    '....bbbbbbbbbbccbb......',
    '....bbbbbbbbbbbbbb......',
    '...bbccbbbbSSSSSSSb.....',
    '...bcwccbbSwwSSwwS......',
    '...bbccbbSSwESSwES......',
    '....bbbbbSSwESSwES......',
    '.....bbbbSSSSSSSSS......',
    '......bbbSSSSEESSs......',
    '........bSSSSSSSs.......',
  ]
  const blinkHead = HEAD.map((r, i) => (i === 6 ? r.replace('SwwSSwwS', 'SSSSSSSS') : i === 7 || i === 8 ? r.replace('SwESSwES', i === 7 ? 'SEESSEES' : 'SSSSSSSS') : r))
  const hurtHead = HEAD.map((r, i) => (i === 6 ? r.replace('SwwSSwwS', 'SESSSSES') : i === 7 ? r.replace('SwESSwES', 'SSEESSEE') : i === 8 ? r.replace('SwESSwES', 'SESSSSES') : i === 10 ? r.replace('SSSSEESSs', 'SSSEEEESs') : r))
  const UP = {
    stand: [
      '.......ccccccccc........',
      '.....bbccccccccccb......',
      '....bbbcccccccccbbb.....',
      '....bbbcccccccccbbb.....',
      '....bbb.ccccccc.bbb.....',
      '....bb..bbbbbbb..bb.....',
    ],
    shoot: [
      '.......ccccccccc........',
      '.....bbccccccccccbbbbbb.',
      '....bbbcccccccccbbbbbbbb',
      '....bbbcccccccccbbbbbbb.',
      '....bbb.ccccccc.........',
      '....bb..bbbbbbb.........',
    ],
    run: [
      '.......ccccccccc........',
      '......cccccccccccbb.....',
      '....bbccccccccccbbb.....',
      '...bbb.ccccccc.bbb......',
      '...bb..ccccccc..........',
      '.......bbbbbbb..........',
    ],
    jump: [
      '...bb..ccccccccc........',
      '...bbbcccccccccccbb.....',
      '....bbccccccccccbbb.....',
      '.......ccccccc..bbb.....',
      '.......ccccccc..........',
      '.......bbbbbbb..........',
    ],
    hurt: [
      '.bb....ccccccccc....bb..',
      '..bb..ccccccccccc..bb...',
      '...bbbccccccccccccbb....',
      '.......ccccccccc........',
      '.......ccccccccc........',
      '.......bbbbbbbbb........',
    ],
  }
  const LEG = {
    stand: [
      '........ccc..ccc........',
      '.......cccc..cccc.......',
      '.......bbbb..bbbb.......',
      '......bbbbb..bbbbb......',
      '.....bbbbbb..bbbbbb.....',
      '.....bbbbbb..bbbbbb.....',
    ],
    run0: [
      '......cccc..cccc........',
      '.....cccc....ccccc......',
      '...bbbbb......bbbbb.....',
      '..bbbbbb.......bbbbbb...',
      '.bbbbbb........bbbbbbb..',
      '..bbbb..................',
    ],
    run1: [
      '........cccccc..........',
      '........ccccc...........',
      '.......bbbbbbb..........',
      '.......bbbbbbbb.........',
      '.......bbbbbbbbb........',
      '.......bbbbbbbb.........',
    ],
    run2: [
      '.......cccc..cccc.......',
      '......cccc....ccccc.....',
      '.....bbbb......bbbbb....',
      '....bbbbb.......bbbbbb..',
      '...bbbbbb.......bbbbbbb.',
      '...bbbbb................',
    ],
    jump: [
      '......cccc..cccc........',
      '.....bbbbc...ccccc......',
      '....bbbbbb....bbbbb.....',
      '....bbbbbb...bbbbbbb....',
      '.....bbbb....bbbbbbb....',
      '........................',
    ],
    hurt: [
      '......ccc.....ccc.......',
      '.....ccc.......ccc......',
      '....bbbb.......bbbb.....',
      '...bbbbb.......bbbbb....',
      '...bbbbb.......bbbbb....',
      '........................',
    ],
  }
  const SLIDE = [
    '.............bbbbbb.......',
    '...........bbbbbbcbbb.....',
    '..........bbbbbbbbccbb....',
    '.........bbbbbbbbbbbccb...',
    '.........bccbbbbSSSSSSb...',
    '........bcwcbbSwwSSwwS....',
    '........bbccbbSwESSwES....',
    '.........bbbbbSSSSSSSs....',
    '...bb..cccccccbbSSSs......',
    '..bbbcccccccccc...........',
    '..bb..ccccccccccbbb.......',
    '.......bbbbbbbcccccbbbbb..',
    '....cccbbbb.....cccbbbbbb.',
    '..bbbbbb.........bbbbbbbb.',
    '.bbbbbbb..................',
  ]
  const WARP0 = ['......bbbbbbbb..........', '....bbccwwwwccbb........', '...bbbccccccccbbb.......', '....bb........bb........']
  const WARP1 = [
    '........bbbbbb..........',
    '......bbbbbbcbbb........',
    '.....bbbbbbbbccbb.......',
    '....bbbbbbbbbbbbbb......',
    '...bbccbbbbbbbbbccbb....',
    '....bbbbccccccbbbb......',
    '...bbbbb......bbbbb.....',
  ]
  const BEAM = ['.bccb.', '.bwcb.', 'bcwwcb', '.bwcb.', '.bccb.', '.bwcb.', '.bcwb.', '.bccb.']

  const FRAMES = {
    stand: [HEAD, UP.stand, LEG.stand],
    blink: [blinkHead, UP.stand, LEG.stand],
    shoot: [HEAD, UP.shoot, LEG.stand],
    run0: [HEAD, UP.run, LEG.run0],
    run1: [HEAD, UP.run, LEG.run1],
    run2: [HEAD, UP.run, LEG.run2],
    rshoot0: [HEAD, UP.shoot, LEG.run0],
    rshoot1: [HEAD, UP.shoot, LEG.run1],
    rshoot2: [HEAD, UP.shoot, LEG.run2],
    jump: [HEAD, UP.jump, LEG.jump],
    jshoot: [HEAD, UP.shoot, LEG.jump],
    hurt: [hurtHead, UP.hurt, LEG.hurt],
  }
  const PALS = {
    n: null,
    half: { c: 'C' },
    fa: { b: 'E', c: 'b' },
    fb: { b: 'g', c: 'G' },
    white: { b: 'w', c: 'w', S: 'w', s: 'C', E: 'C' },
    cut: { b: 'x', c: 'W' },
    ice: { b: 'B', c: 'W' },
    proto: { b: 'r', c: 'R' },
  }
  const MMS = {}
  for (const [pk, map] of Object.entries(PALS)) {
    const set = {}
    const tr = (rows) => (map ? recolor(rows, map) : rows)
    for (const [k, parts] of Object.entries(FRAMES)) set[k] = { sp: pairOutlined(tr([].concat(...parts)), MP), ax: 10 }
    set.slide = { sp: pairOutlined(tr(SLIDE), MP), ax: 12 }
    set.warp0 = { sp: pairOutlined(tr(WARP0), MP), ax: 10 }
    set.warp1 = { sp: pairOutlined(tr(WARP1), MP), ax: 10 }
    MMS[pk] = set
  }
  const BEAM_SP = sprite(BEAM, MP)
  const BEAM_RED = sprite(recolor(BEAM, { b: 'r', c: 'R' }), MP)
  const RUN = ['run0', 'run1', 'run2', 'run1']

  // ---- shots, effects -------------------------------------------------------
  const ring = (r, cols) => {
    const n = r * 2 + 1
    const rows = []
    for (let y = 0; y < n; y++) {
      let row = ''
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x - r, y - r)
        row += d > r + 0.3 ? '.' : d > r - 1.2 ? cols[0] : d > r - 2.4 ? cols[1] : cols[2]
      }
      rows.push(row)
    }
    return rows
  }
  const PELLET = sprite(['.yyyy.', 'yyYYyy', 'yyYYyy', '.yyyy.'], MP)
  const HALF = [sprite(ring(3, 'yGY'), MP), sprite(ring(3, 'GyY'), MP)]
  const CHARGED = [
    sprite(['....yyyyy...', '..yyGGGGGyy.', '.yGGYYYYYGGy', 'yGYYwwwwYYGy', 'yGYwwwwwwYGy', 'yGYYwwwwYYGy', '.yGGYYYYYGGy', '..yyGGGGGyy.', '....yyyyy...'], MP),
    sprite(['....GGGGG...', '..GGyyyyyGG.', '.GyyYYYYYyyG', 'GyYYwwwwYYyG', 'GyYwwwwwwYyG', 'GyYYwwwwYYyG', '.GyyYYYYYyyG', '..GGyyyyyGG.', '....GGGGG...'], MP),
  ]
  const MET_SHOT = sprite(['.OO.', 'OyyO', 'OyyO', '.OO.'], MP)
  const ORB = [sprite(ring(3, 'cwY'), MP), sprite(ring(2, 'cwY'), MP)]
  const ORB_B = { cut: [sprite(ring(3, 'RLW'), MP), sprite(ring(2, 'RLW'), MP)], ice: [sprite(ring(3, 'PIW'), MP), sprite(ring(2, 'PIW'), MP)] }
  const CUTTER = [
    pairOutlined(['X.......X', 'xX.....Xx', '.xX...Xx.', '..xXRXx..', '...RrR...', '..xXRXx..', '.xX...Xx.', 'xX.....Xx', 'X.......X'], MP),
    pairOutlined(['....X....', '....X....', '....X....', '...xRx...', 'XXXRrRXXX', '...xRx...', '....X....', '....X....', '....X....'], MP),
  ]
  const ICE = pairOutlined(['..IIII....', '.IWWWWII..', 'IWWWWWWWII', '.IWWWWII..', '..IIII....'], MP)
  const ETANK = sprite(['.nnnnnnn.', 'nbbbbbbbn', 'nbcccccbn', 'nbcbbbbbn', 'nbcccbbbn', 'nbcbbbbbn', 'nbcccccbn', 'nbbbbbbbn', '.nnnnnnn.'], MP)
  const ETANK_ICON = sprite(['nnnnn', 'nwwwn', 'nwnnn', 'nwwnn', 'nwnnn', 'nwwwn', 'nnnnn'], MP)

  // ---- Met -------------------------------------------------------------------
  const MET = {
    hide: pairOutlined(['....mmmm....', '..mmMMMMmm..', '.mMMhhMMMMm.', '.mMhhMMMMMm.', 'mMMMMMMMMMMm', 'mMMMMmmMMMMm', 'mmmmmmmmmmmm', 'mmmmmmmmmmmm'], MP),
    peek: pairOutlined([
      '....mmmm....', '..mmMMMMmm..', '.mMMhhMMMMm.', '.mMhhMMMMMm.', 'mMMMMMMMMMMm', 'mmmmmmmmmmmm',
      '.kkkkkkkkkk.', '.kkwwkkkwwk.', '.kkwEkkkwEk.', '.kKkkkkkkKk.', '..oo....oo..', '.ooo....ooo.',
    ], MP),
    hop: pairOutlined([
      '....mmmm....', '..mmMMMMmm..', '.mMMhhMMMMm.', '.mMhhMMMMMm.', 'mMMMMMMMMMMm', 'mmmmmmmmmmmm',
      '.kkkkkkkkkk.', '.kkwwkkkwwk.', '.kkEEkkkEEk.', '.kKkkkkkkKk.', 'oo........oo', 'o..........o',
    ], MP),
  }

  // ---- Sniper Joe: green, one red eye, a big shield ----------------------------------
  const JOE_BASE = [
    '.....jjjjjj.......',
    '....jjGGjjjj......',
    '...jjGjjjjjjj.....',
    '...jjjjjjjjjj.....',
    '...jjEEEEEEEE.....',
    '...jjEEEEERwE.....',
    '...jjjjjjjjjj.....',
    '....JJJJJJJJ......',
    '...jjjjjjjjjj.....',
    '..jjjGjjjjjjjj....',
    '..jjGjjjjjjjjj....',
    '..jjjjjjjjjjjj....',
    '..JjjjjjjjjjjJ....',
    '...JJJJJJJJJJ.....',
    '...jjjj..jjjj.....',
    '...jjjj..jjjj.....',
    '...jjjj..jjjj.....',
    '..jjjjj..jjjjj....',
    '..JJJJJ..JJJJJ....',
  ]
  const SHIELD = ['_XXXX_', 'XXwXXx', 'XwXXXx', 'XwXXXx', 'XXXXXx', 'XXXXXx', 'XXXjXx', 'XXjjXx', 'XXXjXx', 'XXXXXx', 'XXXXXx', 'XXXXXx', 'XXXXxx', '_xxxx_']
  const joeGuard = SHIELD.reduce((r, line, i) => ov(r, 3 + i, 11, line), JOE_BASE)
  const joeFire = [['jjjjEE', 9], ['JJJJEE', 10]].reduce((r, [str, row]) => ov(r, row, 12, str), [5, 6, 7, 8, 9, 10, 11, 12, 13].reduce((r, row) => ov(r, row, 0, row === 5 || row === 13 ? '_x' : 'Xx'), JOE_BASE))
  const joeJump = joeGuard.slice(0, 14).concat(['..jjjjjjjjjj......', '.jjjj....jjjj.....', '.JJJJ....JJJJ.....'])
  const JOE = { guard: pairOutlined(joeGuard, MP), fire: pairOutlined(joeFire, MP), jump: pairOutlined(joeJump, MP) }

  // ---- Blader: a flying helmet with a propeller (Cut Man's stage) ------------------
  const BLADER_BODY = ['......xx......', '....oooooo....', '...oOOooooo...', '..oOooooooooo.', '..ooooooooooo.', '..oEEEEEEEEEo.', '..oEwwEEEwwEo.', '..ooooooooooo.', '...ooo...ooo..']
  const BLADER = [pairOutlined(['xXXXXXXXXXXXXx', ...BLADER_BODY], MP), pairOutlined(['....xXXXXx....', ...BLADER_BODY], MP)]

  // ---- Dr. Wily's saucer and Wily himself ---------------------------------------------
  const saucerRows = (lit, wily) => [
    '..........CCCCCC..........',
    wily ? '........CCXXSSXXCC........' : '........CCCCCCCCCC........',
    wily ? '.......CCXSSSSSSXCC.......' : '.......CCCCCCCCCCCC.......',
    wily ? '.......CCSwESSwESCC.......' : '.......CCCCCCCCCCCC.......',
    wily ? '.......CCSSXXXXSSCC.......' : '.......CCCCCCCCCCCC.......',
    '...' + 'x'.repeat(20) + '...',
    '.xx' + 'X'.repeat(20) + 'xx.',
    'x' + [...Array(24)].map((_, i) => (i % 4 === 2 ? lit : 'X')).join('') + 'x',
    '.' + 'x'.repeat(24) + '.',
    '....xxx' + 'X'.repeat(12) + 'xxx....',
    '.......' + 'x'.repeat(12) + '.......',
  ]
  const SAUCER = [pairOutlined(saucerRows('y', true), MP), pairOutlined(saucerRows('O', true), MP)]
  const SAUCER_EMPTY = pairOutlined(saucerRows('o', false), MP)
  const WILY = {
    kneel: pairOutlined(['..XX....XX..', '.XXXSSSSXXX.', '.XXSSSSSSXX.', '..SwESSwES..', '..SSXXXXSS..', '...SSSSSS...', '..WWWWWWWW..', '.WWWWXXWWWW.', '.WWWSSSSWWW.', '.WWWWWWWWWW.', '.WWWWWWWWWW.', '..nnnnnnnnn.', '.nnnnnnnnnn.', '.kk.....kkk.'], MP),
    bow: pairOutlined(['............', '............', '..XX....XX..', '.XXXSSSSXXX.', '.XXSSSSSSXX.', '..SSSSSSSS..', '.WWWWWWWWWW.', 'WWWWWWWWWWWW', 'SWWWWWWWWWWS', '.WWWWWWWWWW.', '.WWWWWWWWWW.', '..nnnnnnnnn.', '.nnnnnnnnnn.', '.kk.....kkk.'], MP),
  }

  // ---- Rush, the robot dog -----------------------------------------------------------------
  const RUSH_ROWS = [
    '..............rR....',
    '.............rRR....',
    '............RRRRRR..',
    '............RRwERRR.',
    '............RRRRRRRE',
    'R...........RRRRRRR.',
    'RR..........RRRWWW..',
    '.RRRRRRRRRRRRRRR....',
    '..RRRRRRRRRRRRRR....',
    '..RRRRRRRRRRRRR.....',
    '..RRWRRRRRRRRRR.....',
    '...RR.RR...RR.RR....',
    '...RR.RR...RR.RR....',
    '..xxx.xxx.xxx.xxx...',
  ]
  const rushWag = ov(ov(ov(RUSH_ROWS, 4, 0, 'R'), 5, 0, '.R'), 6, 0, '.R')
  const RUSH = {
    sit: pairOutlined(RUSH_ROWS, MP),
    wag: pairOutlined(rushWag, MP),
    coil: pairOutlined(RUSH_ROWS.slice(0, 11).concat(['......XxX...........', '.....xXxXx..........', '......XxX...........', '.....xXxXx..........', '....xxxxxxx.........']), MP),
  }

  // ---- Robot Masters -----------------------------------------------------------
  const CUT_BASE = [
    '.......xX..Xx.......',
    '.......xX..Xx.......',
    '......xXX..XXx......',
    '......xX....Xx......',
    '.......xXrrXx.......',
    '......RRRRRRRR......',
    '.....RRLLRRRRRR.....',
    '....RRRRRRRRRRRR....',
    '....RRSSSSSSSSRR....',
    '....RSSwwSSwwSSR....',
    '....RSSwESSwESS.....',
    '.....SSSSSSSSSs.....',
    '......SSSEESSs......',
    '....LLLRRRRRLLL.....',
    '...RRRRRRRRRRRRR....',
    '..RR.RRRRRRRRR.RR...',
    '..WW.RRRRRRRRR.WW...',
    '.....rrrrrrrrr......',
    '.....RRRR..RRRR.....',
    '.....RRR....RRR.....',
    '....rrrr....rrrr....',
    '...rrrrr....rrrrr...',
  ]
  const cutThrow = CUT_BASE.map((r, i) =>
    i < 5 ? '.'.repeat(20) : i === 14 ? '...RRRRRRRRRRRRRRWW.' : i === 15 ? '..RR.RRRRRRRRRRR....' : i === 16 ? '..WW.RRRRRRRRR......' : r,
  )
  const cutJump = CUT_BASE.slice(0, 18).concat(['....RRRR..RRRR......', '...rrrr....rrrr.....', '..rrrrr....rrrrr....'])
  const ICE_BASE = [
    '.......PPPPPP.......',
    '.....PPPPPPPPPP.....',
    '....PPIIIIIIIIPP....',
    '...PPIISSSSSSIIPP...',
    '...PPISwwSSwwSIPP...',
    '...PPISwESSwESIPP...',
    '...PPIISSEESSIIPP...',
    '....PPIIIIIIIIPP....',
    '.....PPPPPPPPPP.....',
    '....PPPPPPPPPPPP....',
    '...PPPPPpPPPPPPPP...',
    '...PP.PPpPPPPP.PP...',
    '...II.PPpPPPPP.II...',
    '......PPPPPPPPP.....',
    '......IIIIIIIII.....',
    '.......PPP..PPP.....',
    '.......ppp..ppp.....',
    '......pppp..pppp....',
  ]
  const iceThrow = ICE_BASE.map((r, i) => (i === 11 ? '...PP.PPpPPPPPPPPII.' : i === 12 ? '...II.PPpPPPPP......' : r))
  const iceJump = ICE_BASE.slice(0, 15).concat(['......PPP...PPP.....', '.....ppp.....ppp....', '....ppp.......ppp...'])
  const bossSet = (rows, white) => ({ n: pairOutlined(rows, MP), w: pairOutlined(recolor(rows, white), MP) })
  const WHITE_CUT = { R: 'W', r: 'X', L: 'W', S: 'W', x: 'W', X: 'W', E: 'X' }
  const WHITE_ICE = { P: 'W', p: 'X', I: 'W', S: 'W', E: 'X' }
  const BOSSES = {
    cut: {
      name: 'CUT MAN', weapon: 'ROLLING CUTTER', color: '#fc7460', pal: 'cut',
      stand: bossSet(CUT_BASE, WHITE_CUT), throw: bossSet(cutThrow, WHITE_CUT), jump: bossSet(cutJump, WHITE_CUT),
    },
    ice: {
      name: 'ICE MAN', weapon: 'ICE SLASHER', color: '#a4e4fc', pal: 'ice',
      stand: bossSet(ICE_BASE, WHITE_ICE), throw: bossSet(iceThrow, WHITE_ICE), jump: bossSet(iceJump, WHITE_ICE),
    },
  }
  const MAX_HP = 28
  // jumps may leave the top of the bar a little (the stage reaches SPILL_UP px into the frame)
  const SPILL = typeof SPILL_UP === 'number' ? SPILL_UP : 0
  const JV = -Math.sqrt(1000 * Math.max(8, H - 25 + Math.min(6, SPILL)))
  const BJV = -Math.sqrt(840 * Math.max(8, H - 23 + Math.min(4, SPILL)))
  // Rush Coil: the big one, his head clears the bar's top edge
  const COILV = -Math.sqrt(1000 * Math.max(10, H - 24 + SPILL))
  const keying = (s, now) => now - (s.keyAt ?? -1e9) < 9000
  const engaged = (s, now) => keying(s, now) || now - (s.data.clickAt || -1e9) < 9000 || now - (s.data.grabAt || -1e9) < 9000 || (s.cursor && now - s.cursor.since < 2500)
  const keyDir = (s) => (s.keys && s.keys.has('left') !== s.keys.has('right') ? (s.keys.has('left') ? -1 : 1) : 0)
  const KRUN = 52
  const touched = (s) => (s.data.clickAt = performance.now())

  // ---- helpers -------------------------------------------------------------------
  const live = (s, now) => s.lively(now) || KEEP_AWAKE
  const now0 = () => performance.now()
  function openSpot(s, x, hw, avoid = []) {
    const blocks = s.fix.map((f) => [f.x - 3, f.x + f.w + 3]).concat(avoid)
    const ok = (c) => c - hw >= 18 && c + hw <= s.W - 4 && blocks.every(([a, b]) => c + hw <= a || c - hw >= b)
    for (let d = 0; d < s.W; d += 2) {
      if (ok(x - d)) return x - d
      if (ok(x + d)) return x + d
    }
    return clamp(x, hw + 18, s.W - hw - 4)
  }
  const deathRings = (s, x, y, imgs) => {
    // the famous expanding rings: eight orbs fast, eight slow
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4
      for (const [v, img] of [[70, imgs[0]], [36, imgs[1]]]) s.particle({ img, x: x - img.width / 2, y: y - img.height / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.55, life: 1.4 })
    }
  }

  // ---- projectiles ------------------------------------------------------------------
  class Shot {
    constructor(s, x, y, vx, vy, kind, owner) {
      Object.assign(this, { s, x, y, vx, vy, kind, owner })
      this.f = 0
      this.t = 0
      this.moving = true
      this.z = 6
    }
    get img() {
      const k = this.kind
      if (k === 'c') return CHARGED[(this.f >> 1) & 1]
      if (k === 'h') return HALF[(this.f >> 1) & 1]
      if (k === 'm') return MET_SHOT
      if (k === 'cut' || k === 'bcut') return CUTTER[(this.f >> 1) & 1][1]
      if (k === 'ice' || k === 'bice') return ICE[this.vx < 0 ? -1 : 1]
      return PELLET
    }
    get dmg() {
      return { p: 1, h: 2, c: 3, cut: 2, ice: 2, m: 2, bcut: 4, bice: 3 }[this.kind] ?? 0
    }
    update(dt, now, s) {
      this.f++
      this.t += dt
      // boomerangs: the cutter flies out and curls back to its thrower
      if ((this.kind === 'cut' || this.kind === 'bcut') && this.home) {
        const h = this.home
        if (this.t > 0.55 && !h.dead) {
          const dx = h.cx - (this.x + 5)
          const dy = h.y - 16 - (this.y + 5)
          const d = Math.hypot(dx, dy) || 1
          this.vx += (dx / d) * 520 * dt
          this.vy += (dy / d) * 520 * dt
          const sp = Math.hypot(this.vx, this.vy)
          if (sp > 150) {
            this.vx *= 150 / sp
            this.vy *= 150 / sp
          }
          if (d < 8) {
            this.dead = true
            h.caught?.()
            return Infinity
          }
        }
        if (this.t > 3.5) this.dead = true
      }
      const n = Math.max(1, Math.ceil((Math.hypot(this.vx, this.vy) * dt) / 3))
      for (let i = 0; i < n && !this.dead; i++) {
        this.x += (this.vx * dt) / n
        this.y += (this.vy * dt) / n
        this.collide(s)
      }
      const im = this.img
      if (this.x < -im.width - 4 || this.x > s.W + 4 || this.y < -im.height - 4 || this.y > FLOOR + 2) this.dead = true
      return this.dead ? Infinity : FAST
    }
    collide(s) {
      const im = this.img
      const cx = this.x + im.width / 2
      const cy = this.y + im.height / 2
      if (this.kind === 'd') return
      if (this.owner === 'enemy') {
        const mm = s.data.mm
        if (mm.contains(cx, cy)) {
          if (this.kind === 'm') this.dead = true
          mm.hurt(this.dmg, Math.sign(this.vx) || 1)
        }
        return
      }
      for (const f of s.data.foes) {
        if (f.dead || !f.contains(cx, cy)) continue
        const r = f.onShot(this)
        if (r === 'pass') continue
        if (r === 'tink') {
          this.kind = 'd'
          this.vx = -this.vx * 0.7
          this.vy = -120
          s.particle({ img: pix('w'), x: cx, y: cy - 1, life: 0.15 })
        } else if (this.kind !== 'c' && this.kind !== 'cut') this.dead = true
        return
      }
      const boss = s.data.boss
      if (boss && boss.contains(cx, cy)) {
        if (boss.inv <= 0) boss.damage(this.dmg)
        if (this.kind !== 'c' && this.kind !== 'cut') this.dead = true
        return
      }
      for (const m of s.data.mets) {
        if (m.dead || !m.contains(cx, cy)) continue
        if (m.state === 'hide' && this.kind !== 'c' && this.kind !== 'cut') {
          // tink: bounces off the hard hat
          this.kind = 'd'
          this.vx = -this.vx * 0.7
          this.vy = -120
          s.particle({ img: pix('w'), x: cx, y: cy - 1, life: 0.15 })
        } else {
          m.destroy()
          if (this.kind === 'p' || this.kind === 'h' || this.kind === 'ice') this.dead = true
        }
        return
      }
    }
    draw(c) {
      if (this.kind === 'd' && this.f & 1) return
      c.drawImage(this.img, Math.round(this.x), Math.round(this.y))
    }
  }

  class Item {
    constructor(s, x) {
      this.s = s
      this.x = clamp(x, 20, s.W - 12)
      this.y = FLOOR - 26
      this.vy = -30
      this.landed = false
      this.z = 1
      this.born = now0()
    }
    hit(x, y) {
      return x >= this.x - 4 && x <= this.x + 13 && y >= this.y - 4 && y <= this.y + 10
    }
    onClick() {
      touched(this.s)
      this.s.data.mm.goGet(this)
    }
    update(dt, now, s) {
      if (now - this.born > 60000) this.dead = true
      if (this.landed) return Infinity
      this.vy += 220 * dt
      this.y += this.vy * dt
      if (this.y >= FLOOR - 9) {
        this.y = FLOOR - 9
        this.landed = true
      }
      return FAST
    }
    draw(c) {
      c.drawImage(ETANK, Math.round(this.x), Math.round(this.y))
    }
  }

  // ---- Met ------------------------------------------------------------------------
  class Met {
    constructor(s, x, drop = false) {
      this.s = s
      this.cx = x
      this.y = drop ? FLOOR - 30 : FLOOR
      this.vy = 0
      this.falling = drop
      this.state = 'hide'
      this.dir = -1
      this.safe = 0
      this.t = 0
      this.alarm = 0
      this.z = 2
    }
    get asleep() {
      return this.state === 'hide' && !this.falling
    }
    contains(x, y) {
      const top = this.y - (this.state === 'hide' ? 8 : 12)
      return x >= this.cx - 6 && x <= this.cx + 6 && y >= top - 1 && y <= this.y
    }
    hit(x, y) {
      return x >= this.cx - 10 && x <= this.cx + 10 && y >= this.y - 16 && y <= this.y + 1
    }
    onClick() {
      touched(this.s)
      this.s.data.mm.attack(this)
    }
    // pick a Met up by the hard hat: its little feet kick; let go and it lands angry
    get grabbable() {
      return !this.dead && !this.falling
    }
    grab(p) {
      this.s.data.grabAt = performance.now()
      this.held = true
      this.state = 'hop'
      this.t = 0.25
      this.drag(p)
    }
    drag(p) {
      this.s.data.grabAt = performance.now()
      if (!this.held) return
      this.cx = clamp(p.x, 10, this.s.W - 10)
      this.y = clamp(p.y + 8, 8, FLOOR)
    }
    drop() {
      this.s.data.grabAt = performance.now()
      if (!this.held) return
      this.held = false
      this.falling = true
      this.vy = 0
      this.mad = true
    }
    destroy() {
      const s = this.s
      this.dead = true
      s.burst(this.cx, this.y - 5, 12, ['y', 'w', 'O', 'c'])
      s.particle({ digits: '200', x: this.cx - 6, y: Math.max(0, this.y - 20), vy: -10, life: 0.9, fade: true })
      s.data.mets = s.data.mets.filter((m) => m !== this)
      // the others duck and stay down a while
      for (const m of s.data.mets) {
        if (Math.abs(m.cx - this.cx) < 140) {
          m.state = 'hide'
          m.alarm = now0() + rand(2500, 4000)
          s.say('!', m.cx, Math.max(0, m.y - 22), { life: 0.7, color: '#f8b800' })
        }
      }
      if (Math.random() < 0.12 && s.data.mm.tanks < 4) s.spawn(new Item(s, this.cx - 4))
      s.data.respawnAt = now0() + (s.busy ? rand(1500, 3000) : s.data.mets.length <= 1 ? rand(3000, 6000) : rand(8000, 14000))
    }
    danger(s) {
      const mm = s.data.mm
      const c = s.cursor
      const dm = mm.visible ? Math.abs(mm.cx - this.cx) : 999
      const dc = c && c.y < H + 6 ? Math.abs(c.x - this.cx) : 999
      // hysteresis: duck inside 36 px, only feel safe beyond 50 px
      if (dm < 36 || dc < 26) return 2
      if (dm < 50 || dc < 36) return 1
      return 0
    }
    update(dt, now, s) {
      if (this.held) return FAST
      if (this.falling) {
        this.vy += 300 * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR) {
          this.y = FLOOR
          this.falling = false
          this.vy = 0
          s.burst(this.cx, FLOOR - 1, 4, ['x', 'X'])
          if (this.mad) {
            // dropped: it comes up shooting, no ducking for a moment
            this.mad = false
            this.state = 'peek'
            this.t = 0.2
            this.fired = false
            this.madUntil = now + 1200
            s.say('!', this.cx, Math.max(0, this.y - 22), { life: 0.6, color: '#f8b800' })
          }
        }
        return FAST
      }
      const mm = s.data.mm
      if (mm.visible && Math.abs(mm.cx - this.cx) > 4) this.dir = mm.cx < this.cx ? -1 : 1
      if (this.state === 'hop') {
        this.t += dt
        if (this.t > 0.5) {
          this.state = 'hide'
          this.fired = false
          this.safe = 0
        }
        return FAST
      }
      if (s.data.boss && s.data.boss.state !== 'die') {
        // a Robot Master is in the room: keep your head down
        this.state = 'hide'
        return live(s, now) ? SLOW : Infinity
      }
      if (!live(s, now) || s.data.party) {
        if (s.data.party && !mm.visible) {
          // he's gone: the Mets come out and bounce around
          if (this.state === 'hide' && Math.random() < 0.1) {
            this.state = 'hop'
            this.t = 0
          }
          return FAST
        }
        this.state = 'hide'
        return live(s, now) ? SLOW : Infinity
      }
      const d = now < (this.madUntil || 0) ? 0 : this.danger(s)
      if (d === 2 || now < this.alarm) {
        this.state = 'hide'
        this.safe = 0
        return SLOW
      }
      if (d === 0) this.safe += dt
      else this.safe = 0
      if (this.state === 'hide') {
        if (this.safe > 1.4 && Math.random() < (s.busy ? 0.25 : 0.08)) {
          this.state = 'peek'
          this.t = 0
        }
        return SLOW
      }
      this.t += dt
      if (this.t > 0.5 && !this.fired && mm.visible) {
        this.fired = true
        for (const a of [0, -0.33, -0.66]) s.spawn(new Shot(s, this.cx + this.dir * 5 - 1, this.y - 7, Math.cos(a) * 75 * this.dir, Math.sin(a) * 75, 'm', 'enemy'))
      }
      if (this.t > 1.4) {
        this.state = 'hide'
        this.fired = false
        this.safe = 0
      }
      return FAST
    }
    draw(c) {
      const img = MET[this.held ? 'hop' : this.state === 'hide' || this.falling ? 'hide' : this.state === 'hop' ? 'hop' : 'peek'][this.dir]
      const lift = this.state === 'hop' && !this.held && !this.falling ? Math.round(Math.sin(Math.min(1, this.t / 0.5) * Math.PI) * 5) : 0
      c.drawImage(img, Math.round(this.cx - 7), Math.round(this.y - img.height + 1 - lift))
    }
  }

  // ---- Robot Master ------------------------------------------------------------------
  class Boss {
    constructor(s, type) {
      this.s = s
      this.type = type
      this.def = BOSSES[type]
      this.cx = Math.round(s.W * 0.78)
      this.y = FLOOR - 40
      this.vy = 0
      this.vx = 0
      this.dir = -1
      this.hp = 0
      this.shownHp = 0
      this.state = 'enter'
      this.t = 0
      this.f = 0
      this.inv = 0
      this.next = 0
      this.cutterOut = false
      this.z = 4
      this.moving = true
    }
    contains(x, y) {
      return this.state !== 'die' && this.state !== 'enter' && Math.abs(x - this.cx) <= 8 && y >= this.y - 20 && y <= this.y
    }
    hit(x, y) {
      return this.state !== 'die' && Math.abs(x - this.cx) <= 12 && y >= this.y - 25 && y <= this.y + 1
    }
    onClick() {
      touched(this.s)
      this.s.data.mm.attack(this)
    }
    caught() {
      this.cutterOut = false
    }
    damage(dmg) {
      if (this.state === 'die' || this.state === 'enter' || this.state === 'fill') return false
      this.hp = Math.max(0, this.hp - dmg)
      this.inv = 0.6
      if (this.hp <= 0) this.die()
      return true
    }
    die() {
      const s = this.s
      this.state = 'die'
      this.t = 0
      deathRings(s, this.cx, this.y - 11, ORB_B[this.type])
      s.data.beaten = this.type
      s.data.respawnAt = now0() + rand(9000, 14000)
    }
    jump(vx, vy = BJV) {
      this.vx = vx
      this.vy = vy
      this.air = true
    }
    update(dt, now, s) {
      this.f++
      if (this.inv > 0) this.inv -= dt
      this.tickWalk(dt, s)
      if (this.shownHp < this.hp) this.shownHp = Math.min(this.hp, this.shownHp + 1)
      else this.shownHp = this.hp
      const mm = s.data.mm
      // touching a Robot Master hurts
      if (this.state === 'fight' && mm.contains(clamp(mm.cx, this.cx - 8, this.cx + 8), this.y - 10)) mm.hurt(4, mm.cx < this.cx ? -1 : 1)
      if (this.air || this.state === 'enter') {
        this.vy += 420 * dt
        this.y += this.vy * dt
        this.cx = clamp(this.cx + this.vx * dt, 22, s.W - 10)
        if (this.y >= FLOOR) {
          this.y = FLOOR
          this.vy = 0
          this.vx = 0
          this.air = false
          if (this.state === 'enter') {
            this.state = 'fill'
            s.say(this.def.name, this.cx, 1, { color: this.def.color, life: 2 })
          }
        }
      }
      switch (this.state) {
        case 'enter':
          return FAST
        case 'fill':
          // the boss meter ticks up before the fight starts
          this.hp = Math.min(MAX_HP, this.hp + 1)
          if (this.hp >= MAX_HP && this.shownHp >= MAX_HP) {
            this.state = 'fight'
            this.next = now + 600
          }
          return FAST
        case 'die':
          this.t += dt
          if (this.t > 1.6) this.dead = true
          if (this.dead) s.data.boss = null
          return FAST
      }
      if (mm.visible) this.dir = mm.cx < this.cx ? -1 : 1
      if (this.air) return FAST
      if (now < this.next) return FAST
      const d = Math.abs(mm.cx - this.cx)
      if (this.type === 'cut') {
        // Cut Man: hop around and throw the scissors off his head
        if (!this.cutterOut && mm.visible && d > 30 && Math.random() < 0.6) {
          this.cutterOut = true
          this.throwT = 0.35
          const tx = mm.cx - this.cx
          const sh = new Shot(s, this.cx + this.dir * 6 - 4, this.y - 24, Math.sign(tx) * 130, rand(-20, 25), 'bcut', 'enemy')
          sh.home = this
          s.spawn(sh)
          this.next = now + rand(700, 1100)
        } else {
          const away = d < 50 ? -this.dir : Math.random() < 0.6 ? this.dir : -this.dir
          this.jump(away * rand(30, 60), BJV * rand(0.85, 1))
          this.next = now + rand(400, 900)
        }
      } else {
        // Ice Man: three Ice Slashers at different heights, then a little walk or hop
        if (mm.visible && d > 26 && (this.volley ?? 0) < 3 && Math.random() < 0.7) {
          const hy = [FLOOR - 6, FLOOR - 13, FLOOR - 20][this.volley ?? 0]
          s.spawn(new Shot(s, this.cx + this.dir * 8 - 5, hy - 2, this.dir * 120, 0, 'bice', 'enemy'))
          this.throwT = 0.25
          this.volley = (this.volley ?? 0) + 1
          this.next = now + 380
        } else {
          this.volley = 0
          if (Math.random() < 0.5) this.jump((Math.random() < 0.5 ? 1 : -1) * 40, BJV * 0.9)
          else {
            this.walkT = 0.8
            this.walkDir = d < 60 ? -this.dir : pick([1, -1])
          }
          this.next = now + rand(700, 1300)
        }
      }
      return FAST
    }
    tickWalk(dt, s) {
      if (this.walkT > 0) {
        this.walkT -= dt
        this.cx = clamp(this.cx + this.walkDir * 26 * dt, 22, s.W - 10)
      }
      if (this.throwT > 0) this.throwT -= dt
    }
    draw(c) {
      if (this.state === 'die') return
      const def = this.def
      const white = this.inv > 0 && this.f & 1
      let set = this.air || this.state === 'enter' ? def.jump : this.throwT > 0 ? def.throw : def.stand
      // Cut Man without his scissors while the cutter is out
      if (this.type === 'cut' && this.cutterOut && set === def.stand) set = def.throw
      const sp = (white ? set.w : set.n)[this.dir]
      c.drawImage(sp, Math.round(this.cx - sp.width / 2), Math.round(this.y - sp.height + 1))
    }
  }

  // ---- Mega Man -------------------------------------------------------------------------
  class MegaMan {
    constructor(s) {
      this.s = s
      this.cx = openSpot(s, Math.round(s.W * 0.25), 12)
      this.y = FLOOR
      this.vy = 0
      this.vx = 0
      this.dir = 1
      this.state = 'warpin'
      this.beamY = -10
      this.t = 0
      this.f = 0
      this.cool = 0
      this.inv = 0
      this.shootT = 0
      this.blinkAt = now0() + rand(2500, 5000)
      this.blink = 0
      this.turnAt = 0
      this.next = 0
      this.charge = -1
      this.hp = MAX_HP
      this.shownHp = 0
      this.tanks = 1
      this.z = 3
      this.clicks = []
      this.restSince = 0
    }
    get visible() {
      return !['warpin', 'warpout', 'away', 'dead'].includes(this.state)
    }
    get moving() {
      return ['run', 'jump', 'slide', 'warpin', 'warpout', 'hurt', 'held'].includes(this.state)
    }
    get asleep() {
      return this.state === 'rest'
    }
    get top() {
      return this.state === 'slide' ? this.y - 15 : this.y - 24
    }
    contains(x, y) {
      return this.visible && this.inv <= 0 && this.state !== 'getweapon' && Math.abs(x - this.cx) <= 7 && y >= this.top + 1 && y <= this.y
    }
    hit(x, y) {
      return this.visible && Math.abs(x - this.cx) <= 11 && y >= this.top - 3 && y <= this.y + 1
    }
    onClick() {
      const s = this.s
      const now = performance.now()
      touched(s)
      this.clicks = this.clicks.filter((t) => now - t < 2500)
      this.clicks.push(now)
      // easter egg: five quick clicks and his brother whistles in
      if (this.clicks.length >= 5 && !s.data.proto) {
        this.clicks.length = 0
        const x = openSpot(s, this.cx + (this.cx < s.W / 2 ? 70 : -70), 12)
        s.data.proto = s.spawn(new Proto(s, x))
      }
      // a click charges the buster; a click while charged lets it go
      if (!this.visible || this.state === 'hurt' || this.state === 'getweapon' || this.state === 'held') return
      if (this.state === 'rest') this.state = 'stand'
      if (this.charge > 0.5) this.release()
      else if (this.charge < 0) {
        this.charge = 0
        this.autoRelease = true
      }
    }
    onDblClick() {
      touched(this.s)
      if (this.state === 'stand' || this.state === 'run' || this.state === 'rest') this.slide(this.dir)
    }
    // pick him up and put him down somewhere else; he lands on his feet
    get grabbable() {
      return ['stand', 'run', 'rest', 'jump', 'slide', 'etank'].includes(this.state)
    }
    grab(p) {
      this.s.data.grabAt = performance.now()
      this.state = 'held'
      this.charge = -1
      this.vx = 0
      this.vy = 0
      this.restX = undefined
      this.drag(p)
    }
    drag(p) {
      this.s.data.grabAt = performance.now()
      if (this.state !== 'held') return
      const nx = clamp(p.x, 20, this.s.W - 12)
      if (Math.abs(nx - this.cx) > 1.5) this.dir = nx > this.cx ? 1 : -1
      this.cx = nx
      this.y = clamp(p.y + 18, 24 - SPILL, FLOOR)
    }
    drop() {
      this.s.data.grabAt = performance.now()
      if (this.state !== 'held') return
      this.state = 'jump'
      this.vx = 0
      this.vy = 0
    }
    weapon() {
      const w = this.s.data.weapon
      return w && now0() < w.until ? w.kind : null
    }
    pal() {
      if (this.state === 'hurt' && this.f & 1) return 'white'
      const w = this.weapon()
      if (this.state === 'getweapon') return this.f & 2 ? this.s.data.weapon.kind : 'n'
      if (w) return w
      if (this.charge > 1.3) return ['n', 'fa', 'fb'][(this.f >> 1) % 3]
      if (this.charge > 0.5) return this.f & 2 ? 'half' : 'n'
      return 'n'
    }
    jump(vx, vy = JV) {
      this.state = 'jump'
      this.vy = vy
      this.vx = vx
    }
    slide(dir) {
      this.state = 'slide'
      this.dir = dir
      this.t = 0
      this.s.particle({ img: pix('w'), x: this.cx - dir * 8, y: FLOOR - 2, vx: -dir * 10, life: 0.3, fade: true })
    }
    hurt(dmg, dir) {
      if (this.inv > 0 || !this.visible || this.state === 'getweapon') return
      this.hp = Math.max(0, this.hp - dmg)
      if (this.hp <= 0) return this.die()
      this.state = 'hurt'
      this.t = 0
      this.inv = 1.5
      this.vx = dir * 26
      this.charge = -1
      // the Mets that saw it hop for joy
      for (const m of this.s.data.mets) if (m.state === 'peek') Object.assign(m, { state: 'hop', t: 0 })
    }
    die() {
      const s = this.s
      this.state = 'dead'
      this.t = now0() + 2600
      this.charge = -1
      deathRings(s, this.cx, this.y - 12, ORB)
      for (const m of s.data.mets) Object.assign(m, { state: 'hop', t: 0 })
    }
    shots() {
      let n = 0
      for (const a of this.s.actors) if (a instanceof Shot && a.owner === 'mm' && !a.dead && a.kind !== 'd') n++
      return n
    }
    fire(kind = 'p') {
      const s = this.s
      const w = this.weapon()
      if (w && kind === 'p') kind = w
      // the famous three-on-screen limit
      if (kind !== 'c' && this.shots() >= 3) return false
      const d = this.dir
      const by = this.y - 14
      const mx = this.cx + d * 14
      let sh
      if (kind === 'c') sh = new Shot(s, mx - 6 + d * 2, by - 4, d * 150, 0, 'c', 'mm')
      else if (kind === 'h') sh = new Shot(s, mx - 3, by - 3, d * 160, 0, 'h', 'mm')
      else if (kind === 'cut') {
        sh = new Shot(s, mx - 5, by - 6, d * 140, -20, 'cut', 'mm')
        sh.home = this
      } else if (kind === 'ice') sh = new Shot(s, mx - 5, by - 2, d * 150, 0, 'ice', 'mm')
      else sh = new Shot(s, mx - 3, by - 1, d * 165, 0, 'p', 'mm')
      s.spawn(sh)
      this.shootT = 0.3
      this.cool = 0.24
      return true
    }
    release() {
      const c = this.charge
      this.charge = -1
      this.autoRelease = false
      this.fire(c > 1.3 ? 'c' : c > 0.5 ? 'h' : 'p')
    }
    attack(m) {
      if (!this.visible || this.state === 'hurt' || this.state === 'getweapon' || this.state === 'held') return
      if (this.state === 'rest') this.state = 'stand'
      this.dir = m.cx > this.cx ? 1 : -1
      this.turnAt = now0() + 1500
      // something up high: jump and shoot at the top of the jump
      if (m.fy !== undefined && m.fy < FLOOR - 18) {
        if (this.state === 'stand' || this.state === 'run') {
          this.jump(0)
          this.shootJ = true
        }
        return
      }
      if (this.charge > 0.5) this.release()
      else this.fire()
    }
    goGet(item) {
      if (this.visible && this.state !== 'getweapon') this.item = item
    }
    target(s) {
      let best = null
      for (const m of s.data.mets) if (!m.falling && (!best || Math.abs(m.cx - this.cx) < Math.abs(best.cx - this.cx))) best = m
      return best
    }
    physics(dt, s) {
      this.cx = clamp(this.cx + this.vx * dt, 20, s.W - 12)
      this.y += this.vy * dt + 250 * dt * dt
      this.vy += 500 * dt
      if (this.y >= FLOOR && this.vy > 0) {
        this.y = FLOOR
        this.vy = 0
        return true
      }
      return false
    }
    runToward(x, dt, speed = 44) {
      const dx = x - this.cx
      if (Math.abs(dx) < 2) return true
      this.dir = Math.sign(dx)
      this.state = 'run'
      this.cx += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt)
      return false
    }
    // an enemy shot heading his way: jump it, slide under it, or take it
    dodge(s) {
      if (this.state !== 'stand' && this.state !== 'run') return false
      for (const a of s.actors) {
        if (!(a instanceof Shot) || a.owner !== 'enemy' || a.dead) continue
        const im = a.img
        const ax = a.x + im.width / 2
        const ay = a.y + im.height / 2
        const toward = Math.sign(this.cx - ax) === Math.sign(a.vx)
        const dist = Math.abs(this.cx - ax)
        if (!toward || dist > 46 || dist < 10) continue
        if (ay > FLOOR - 11) {
          this.jump(0)
          return true
        }
        if (ay < FLOOR - 17 && ay > FLOOR - 27 && Math.random() < 0.7) {
          this.slide(Math.sign(a.vx) === 1 ? -1 : 1)
          this.dir = -Math.sign(a.vx) || this.dir
          return true
        }
      }
      return false
    }
    update(dt, now, s) {
      this.f++
      this.cool -= dt
      if (this.shootT > 0) this.shootT -= dt
      if (this.inv > 0) this.inv -= dt
      // the health meter ticks up one notch at a time, down at once
      if (this.shownHp < this.hp) this.shownHp = Math.min(this.hp, this.shownHp + 1)
      else this.shownHp = this.hp
      const ticking = this.shownHp < this.hp
      if (this.charge >= 0) {
        this.charge += dt
        if (this.charge > 0.5 && this.f % 2 === 0) s.particle({ img: pix(this.f & 2 ? 'G' : 'w'), x: this.cx + rand(-9, 9), y: this.y - rand(2, 22), vx: 0, vy: -16, life: 0.25 })
        if (this.autoRelease && this.charge > 1.6) this.release()
      }
      const lively = live(s, now)
      switch (this.state) {
        case 'away':
        case 'dead':
          if (now > this.t) this.warpIn(s)
          return this.state === 'warpin' ? FAST : Math.max(FAST, this.t - now)
        case 'warpin':
          this.beamY += 300 * dt
          if (this.beamY >= this.y - 8) {
            this.state = 'materialize'
            this.t = 0
          }
          return FAST
        case 'materialize':
          if (++this.t > 3) {
            this.state = 'stand'
            this.next = now + 600
          }
          return FAST
        case 'dematerialize':
          if (++this.t > 3) {
            this.state = 'warpout'
            this.beamY = this.y - 8
          }
          return FAST
        case 'warpout':
          this.beamY -= 320 * dt
          if (this.beamY < -14) {
            this.state = 'away'
            this.t = now + 1500
          }
          return FAST
        case 'hurt':
          this.t += dt
          this.cx = clamp(this.cx + this.vx * dt, 20, s.W - 12)
          if (this.y < FLOOR) this.physics(dt, s)
          if (this.t > 0.5) this.state = 'stand'
          return FAST
        case 'jump': {
          if (this.shootJ && this.vy > -25) {
            this.shootJ = false
            this.fire()
          }
          const kd = keyDir(s)
          if (kd) {
            // steer in the air
            this.dir = kd
            this.vx = kd * KRUN
          } else if (this.kjump) this.vx = 0
          if (this.physics(dt, s)) {
            this.kjump = false
            this.state = 'stand'
            this.vx = 0
          }
          return FAST
        }
        case 'slide':
          this.t += dt
          this.cx = clamp(this.cx + this.dir * 95 * dt, 20, s.W - 12)
          if (this.t > 0.42 || this.cx <= 20 || this.cx >= s.W - 12) {
            this.state = 'stand'
            this.next = now + 250
          }
          return FAST
        case 'getweapon':
          if (now > this.t) {
            this.state = 'stand'
            s.data.weapon.until = now + 60000
            // show off the new weapon, then beam out and back in
            this.fire()
            this.byeAt = now + 1600
          }
          return FAST
        case 'etank':
          if (this.hp >= MAX_HP && !ticking) this.state = 'stand'
          return FAST
        case 'held':
          this.doBlink(now)
          return FAST
      }
      if (this.byeAt && now > this.byeAt) {
        this.byeAt = 0
        this.beamOut(s)
        return FAST
      }

      if (!lively && this.charge < 0) return this.rest(now, s)
      if (this.state === 'rest') this.state = 'stand'
      this.restSince = 0
      const user = engaged(s, now)

      // use an E-tank when the meter runs low and it's calm enough
      if (this.hp <= 8 && this.tanks > 0 && !this.dangerNear(s)) {
        this.tanks--
        this.hp = MAX_HP
        this.state = 'etank'
        s.particle({ img: ETANK, x: this.cx - 4, y: Math.max(0, this.y - 36), vy: -6, life: 1.2, fade: true })
        return FAST
      }
      const keys = keying(s, now)
      if (!keys && this.dodge(s)) return FAST

      // walk over and pick up a dropped E-tank (on his own only when nobody is playing)
      const item = this.item && !this.item.dead ? this.item : user ? null : s.actors.find((a) => a instanceof Item && a.landed && !s.data.boss)
      if (item && item.landed) {
        if (this.runToward(item.x + 4, dt)) {
          item.dead = true
          this.item = null
          this.tanks = Math.min(4, this.tanks + 1)
          s.particle({ digits: '+', x: this.cx - 1, y: Math.max(0, this.y - 32), vy: -8, life: 0.8, fade: true })
          this.state = 'stand'
        }
        return FAST
      }

      const d = s.data
      // the keyboard: A/D run, W jump, S slide, Space shoots (hold to charge)
      if (keys) return this.keyMode(dt, now, s)
      if (d.rush && !d.rush.dead && (this.goRush || !user)) return this.rushPlay(d.rush, dt, now, s)
      // the user is playing: he faces the cursor, follows it along the floor, shoots what they click
      if (user) return this.userMode(dt, now, s)
      const boss = d.boss
      if (boss && boss.state !== 'die') return this.fightBoss(boss, dt, now, s)
      const foe = this.nearFoe(s)
      if (foe) return this.fightFoe(foe, dt, now, s)
      const tgt = this.target(s)
      if (s.busy && tgt) return this.runAndGun(tgt, dt, now, s)
      return this.metGame(tgt, dt, now, s)
    }
    keyMode(dt, now, s) {
      this.doBlink(now)
      const kd = keyDir(s)
      if (kd) {
        this.dir = kd
        this.state = 'run'
        this.cx = clamp(this.cx + kd * KRUN * dt, 20, s.W - 12)
      } else this.state = 'stand'
      return FAST
    }
    onKey(key, down) {
      const s = this.s
      if (!this.visible || ['hurt', 'getweapon', 'held', 'materialize', 'dematerialize'].includes(this.state)) {
        if (key === 'fire' && !down) this.charge = -1
        return
      }
      if (this.state === 'rest') this.state = 'stand'
      const ground = this.state === 'stand' || this.state === 'run' || this.state === 'etank'
      if (key === 'fire') {
        if (down) {
          this.fire()
          this.charge = 0
          this.autoRelease = false
        } else if (this.charge > 0.5) this.release()
        else this.charge = -1
        return
      }
      if (!down) return
      if (key === 'left' || key === 'right') {
        const kd = key === 'left' ? -1 : 1
        this.dir = kd
        if (ground) {
          // the first step happens now
          this.state = 'run'
          this.cx = clamp(this.cx + kd * 4, 20, s.W - 12)
        } else if (this.state === 'jump') this.vx = kd * KRUN
      } else if (key === 'up' && ground) {
        this.jump(keyDir(s) * KRUN, JV)
        this.kjump = true
      } else if (key === 'down' && ground) this.slide(this.dir)
    }
    userMode(dt, now, s) {
      const c = s.cursor
      this.doBlink(now)
      if (c && c.y <= H) {
        const dx = c.x - this.cx
        // the cursor down along the floor and moving: he runs after it
        if (c.y >= 20 && Math.abs(dx) > 44 && now - c.since < 2500) {
          this.runToward(clamp(c.x - Math.sign(dx) * 34, 20, s.W - 12), dt, 50)
          return FAST
        }
        if (Math.abs(dx) > 6 && now > this.turnAt) this.dir = Math.sign(dx)
      }
      this.state = 'stand'
      return FAST
    }
    nearFoe(s) {
      let best = null
      for (const f of s.data.foes) if (!f.dead && f.target && (!best || Math.abs(f.cx - this.cx) < Math.abs(best.cx - this.cx))) best = f
      return best
    }
    fightFoe(f, dt, now, s) {
      const want = f.cx > this.cx ? 1 : -1
      const gap = Math.abs(f.cx - this.cx)
      this.doBlink(now)
      if (f.kind === 'joe') {
        // keep a firing distance; wait out the shield, then shoot when it drops
        if ((gap < 50 || gap > 120) && now > this.next) {
          const goal = clamp(f.cx - want * 80, 20, s.W - 12)
          if (Math.abs(goal - this.cx) > 3) {
            this.runToward(goal, dt, 46)
            return FAST
          }
          this.next = now + 800
        }
        this.state = 'stand'
        this.dir = want
        if (f.state === 'guard' || f.air) {
          if (this.charge < 0 && !this.weapon() && Math.random() < 0.03) this.charge = 0
          if (this.charge > 1.4) this.release()
        } else if (this.cool <= 0) {
          if (this.charge > 0.5) this.release()
          else this.fire()
          this.cool = 0.3
        }
        return FAST
      }
      if (f.kind === 'blader') {
        if (gap > 90) {
          this.runToward(f.cx - want * 60, dt, 46)
          return FAST
        }
        this.state = 'stand'
        this.dir = want
        if (this.cool <= 0) {
          if (f.fy > FLOOR - 20) {
            this.fire()
            this.cool = 0.3
          } else if (gap < 60 && Math.random() < 0.25) {
            this.jump(0)
            this.shootJ = true
            this.cool = 0.5
          }
        }
        return FAST
      }
      // Wily's saucer: stand off a little and jump-shoot
      if (f.state === 'fly' && (gap < 25 || gap > 70)) {
        if (!this.runToward(clamp(f.cx - want * 42, 20, s.W - 12), dt, 50)) return FAST
      }
      this.state = 'stand'
      this.dir = want
      if (f.state === 'fly' && this.cool <= 0 && Math.random() < 0.3) {
        this.jump(0)
        this.shootJ = true
        this.cool = 0.9
      }
      return FAST
    }
    rushPlay(r, dt, now, s) {
      this.doBlink(now)
      if (r.state === 'sit' || r.state === 'wait') {
        const side = this.cx < r.cx ? -1 : 1
        if (!this.runToward(clamp(r.cx + side * 12, 20, s.W - 12), dt, 46)) return FAST
        this.state = 'stand'
        this.dir = r.cx > this.cx ? 1 : -1
        if (r.state === 'wait' && !r.ready) {
          // a pat on the head
          r.ready = true
          s.particle({ img: BUBBLE['♥'], x: r.cx - 3, y: FLOOR - 26, vy: -6, life: 1.1, fade: true })
        }
        return FAST
      }
      this.goRush = false
      if (this.state !== 'jump') this.state = 'stand'
      return FAST
    }
    dangerNear(s) {
      return s.actors.some((a) => a instanceof Shot && a.owner === 'enemy' && Math.abs(a.x - this.cx) < 70)
    }
    fightBoss(boss, dt, now, s) {
      const want = boss.cx > this.cx ? 1 : -1
      const gap = Math.abs(boss.cx - this.cx)
      if (boss.state === 'fill') {
        this.state = 'stand'
        this.dir = want
        return FAST
      }
      // keep a firing distance, charge while he's in the air
      if (gap < 54) {
        const back = this.cx - want * 30
        if (back > 22 && back < s.W - 14 && now > this.next) {
          if (Math.random() < 0.4) this.slide(-want)
          else {
            this.runToward(back, dt, 50)
            this.dir = want
          }
          this.next = now + 500
          return FAST
        }
        if (Math.random() < 0.06) {
          this.jump(want * 70)
          return FAST
        }
      } else if (gap > 120) {
        this.runToward(boss.cx - want * 90, dt, 50)
        if (this.cool <= 0 && Math.random() < 0.3) this.fire()
        return FAST
      }
      this.state = 'stand'
      if (now > this.turnAt) {
        this.dir = want
        this.turnAt = now + 300
      }
      if (this.charge < 0 && boss.air && Math.random() < 0.2 && !this.weapon()) this.charge = 0
      if (this.charge > 1.3 && !boss.air) this.release()
      else if (this.charge < 0 && this.cool <= 0) {
        if (boss.air && boss.y < FLOOR - 10 && Math.random() < 0.4) {
          this.jump(0)
          this.shootJ = true
        } else this.fire()
        this.cool = 0.3
      }
      return FAST
    }
    runAndGun(tgt, dt, now, s) {
      const want = tgt.cx > this.cx ? 1 : -1
      if (now > this.turnAt) {
        this.dir = want
        this.turnAt = now + 600
      }
      const gap = Math.abs(tgt.cx - this.cx)
      if (gap > 60) {
        this.state = 'run'
        this.cx += this.dir * 46 * dt
      } else this.state = 'stand'
      if (this.cool <= 0) {
        // charge a shot through the hard hat now and then
        if (tgt.state === 'hide' && Math.random() < 0.12 && this.charge < 0 && !this.weapon()) this.charge = 0
        if (this.charge > 1.4) this.release()
        else if (this.charge < 0 && (tgt.state !== 'hide' || Math.random() < 0.12)) this.fire()
        this.cool = Math.max(this.cool, 0.3)
      }
      return FAST
    }
    metGame(tgt, dt, now, s) {
      // calm: wait at a respectful distance for a Met to peek
      if (tgt && now > this.next) {
        const want = tgt.cx > this.cx ? 1 : -1
        const gap = Math.abs(tgt.cx - this.cx)
        if (gap < 48 || gap > 110) {
          const goal = clamp(tgt.cx - want * 72, 20, s.W - 12)
          if (Math.abs(goal - this.cx) > 2) {
            this.runToward(goal, dt, 42)
            this.turnAt = 0
            return FAST
          }
          this.next = now + rand(800, 1600)
        }
        this.state = 'stand'
        if (now > this.turnAt && want !== this.dir) {
          this.dir = want
          this.turnAt = now + 1200
        }
        // charge up while it hides; let go when it peeks (or crack the hat)
        if (tgt.state === 'hide' && this.charge < 0 && Math.random() < 0.02 && !this.weapon()) this.charge = 0
        if (this.dir === want && this.cool <= 0) {
          if (tgt.state === 'peek' && tgt.t > 0.15) {
            if (this.charge > 0.5) this.release()
            else this.fire()
            this.cool = 0.35
          } else if (this.charge > 3.5) this.release()
        }
      } else this.state = 'stand'
      if (!tgt && s.cursor && now > this.turnAt) {
        const want = s.cursor.x > this.cx ? 1 : -1
        if (want !== this.dir && Math.abs(s.cursor.x - this.cx) > 12) {
          this.dir = want
          this.turnAt = now + 900
        }
      }
      this.doBlink(now)
      if (this.charge >= 0 || this.shootT > 0 || this.blink > now || this.shownHp < this.hp) return FAST
      return tgt && tgt.state !== 'hide' ? FAST : SLOW
    }
    doBlink(now) {
      if (now > this.blinkAt) {
        this.blink = now + 160
        this.blinkAt = now + rand(2800, 5500)
      }
    }
    rest(now, s) {
      // settle in an open stretch, never on the title or the window dots
      if (this.restX === undefined) this.restX = openSpot(s, this.cx, 12)
      if (Math.abs(this.restX - this.cx) > 2) {
        this.runToward(this.restX, 1 / 12, 40)
        return FAST
      }
      this.state = 'rest'
      this.shootT = 0
      if (!this.restSince) this.restSince = now
      if (this.shownHp < this.hp) return FAST
      // a few blinks, then he holds still and the bar can park
      if (now - this.restSince > 6000) {
        this.blink = 0
        return Infinity
      }
      this.doBlink(now)
      if (this.blink > now) return this.blink - now + 5
      return Math.min(this.blinkAt - now, this.restSince + 6001 - now)
    }
    warpIn(s) {
      this.state = 'warpin'
      this.beamY = -12
      this.cx = openSpot(s, this.landX ?? this.cx, 12, s.data.mets.map((m) => [m.cx - 50, m.cx + 50]))
      this.landX = undefined
      this.y = FLOOR
      if (this.hp <= 0) {
        this.hp = MAX_HP
        this.shownHp = 0
      }
      s.data.party = false
      this.restX = undefined
    }
    beamOut(s) {
      this.state = 'dematerialize'
      this.t = 0
      this.charge = -1
      s.data.party = true
    }
    getWeapon(s, kind) {
      const now = now0()
      this.state = 'getweapon'
      this.t = now + 3200
      this.charge = -1
      this.vx = 0
      this.y = FLOOR
      s.data.weapon = { kind: BOSSES[kind].pal, until: now + 65000 }
      s.say(`YOU GOT ${BOSSES[kind].weapon}`, this.cx, 1, { color: BOSSES[kind].color, life: 3.4 })
      // energy streams in from the edges of the bar
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2
        const r = rand(40, 70)
        s.particle({ img: pix(i & 1 ? 'w' : 'c'), x: this.cx + Math.cos(a) * r, y: this.y - 12 + Math.sin(a) * r * 0.25, vx: -Math.cos(a) * r * 1.1, vy: -Math.sin(a) * r * 0.27, life: 0.9, fade: true })
      }
    }
    draw(c, s) {
      const d = this.dir
      const x = Math.round(this.cx)
      const y = Math.round(this.y)
      if (this.state === 'away' || this.state === 'dead') return
      if (this.state === 'warpin' || this.state === 'warpout') {
        const by = Math.round(this.beamY)
        for (let yy = by - 16; yy < by; yy += 8) c.drawImage(BEAM_SP, x - 3, yy)
        return
      }
      if (this.inv > 0 && this.state !== 'hurt' && this.f & 1) return
      const set = MMS[this.pal()]
      let k = 'stand'
      const sh = this.shootT > 0
      if (this.state === 'materialize' || this.state === 'dematerialize') k = this.t < 2 ? 'warp0' : 'warp1'
      else if (this.state === 'run') k = sh ? `rshoot${[0, 1, 2, 1][(this.f >> 1) & 3]}` : RUN[(this.f >> 1) & 3]
      else if (this.state === 'jump' || this.state === 'held') k = sh ? 'jshoot' : 'jump'
      else if (this.state === 'slide') k = 'slide'
      else if (this.state === 'hurt') k = 'hurt'
      else if (sh) k = 'shoot'
      else if (this.blink > now0()) k = 'blink'
      const fr = set[k]
      const sp = fr.sp[d]
      const ax = d === 1 ? fr.ax : sp.width - 2 - fr.ax - 1
      c.drawImage(sp, x - ax - 1, y - sp.height + 1)
      if (this.state === 'hurt' && this.f & 1) {
        // the little shock sparks
        c.drawImage(pix('w'), x - 9, y - 26)
        c.drawImage(pix('w'), x + 8, y - 25)
        c.drawImage(pix('y'), x - 10, y - 18)
        c.drawImage(pix('y'), x + 10, y - 17)
      }
    }
  }

  // ---- watch-mode visitors: Sniper Joe, Bladers, Dr. Wily, Rush, Proto Man ------------------
  const pop = (s, x, y, pts, cols = ['y', 'w', 'O', 'g']) => {
    s.burst(x, y, 14, cols)
    if (pts) s.particle({ digits: pts, x: x - 8, y: Math.max(0, y - 14), vy: -10, life: 0.9, fade: true })
  }
  const enemyShot = (s, x, y, vx, vy = 0) => {
    if (s.actors.length < 60) s.spawn(new Shot(s, x, y, vx, vy, 'm', 'enemy'))
  }

  class Joe {
    constructor(s, cx) {
      this.s = s
      this.kind = 'joe'
      this.target = true
      this.cx = cx
      this.y = FLOOR - 30 - SPILL
      this.vy = 0
      this.air = true
      this.state = 'guard'
      this.t = 0
      this.hp = 6
      this.inv = 0
      this.dir = -1
      this.z = 2
      this.f = 0
      this.next = now0() + rand(1400, 2200)
      this.shots = 0
      this.moving = true
    }
    get fy() {
      return this.y - 10
    }
    contains(x, y) {
      return Math.abs(x - this.cx) <= 8 && y >= this.y - 19 && y <= this.y
    }
    hit(x, y) {
      return Math.abs(x - this.cx) <= 12 && y >= this.y - 23 && y <= this.y + 1
    }
    onClick() {
      touched(this.s)
      // knock on the shield: he turns to face you
      if (this.state === 'guard') this.s.say('tink', this.cx, Math.max(0, this.y - 26), { life: 0.5, size: 6, color: '#bcbcbc' })
      this.s.data.mm.attack(this)
    }
    onShot(sh) {
      if (this.inv > 0) return sh.kind === 'c' || sh.kind === 'cut' ? 'pass' : 'hit'
      const front = Math.sign(sh.vx) === -this.dir
      if (this.state === 'guard' && front && !this.air) {
        if (sh.kind !== 'c') return 'tink'
        // a charged shot knocks the shield aside
        this.state = 'stun'
        this.t = 0
        this.damage(2)
        return 'hit'
      }
      this.damage(sh.dmg)
      return 'hit'
    }
    damage(n) {
      this.hp -= n
      this.inv = 0.35
      if (this.hp <= 0) {
        this.dead = true
        pop(this.s, this.cx, this.y - 10, '1000', ['j', 'G', 'w', 'y'])
      }
    }
    leave() {
      if (this.dead) return
      this.dead = true
      this.s.burst(this.cx, this.y - 10, 8, ['X', 'x', 'w'])
    }
    update(dt, now, s) {
      this.f++
      if (this.inv > 0) this.inv -= dt
      const mm = s.data.mm
      const c = s.cursor
      // the cursor coming close: shield up, facing it
      const threat = c && c.y <= H && Math.abs(c.x - this.cx) < 30 && now - c.since < 2500
      if (threat && !this.air) {
        this.dir = c.x > this.cx ? 1 : -1
        if (this.state === 'fire') this.state = 'guard'
        this.next = Math.max(this.next, now + 700)
      } else if (mm.visible && Math.abs(mm.cx - this.cx) > 4 && this.state !== 'fire') this.dir = mm.cx < this.cx ? -1 : 1
      if (this.air) {
        this.vy += 420 * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR) {
          this.y = FLOOR
          this.vy = 0
          this.air = false
          s.burst(this.cx, FLOOR - 1, 4, ['x', 'X'])
        }
        return FAST
      }
      this.t += dt
      if (this.state === 'stun') {
        if (this.t > 0.7) {
          this.state = 'guard'
          this.next = now + 600
        }
      } else if (this.state === 'guard') {
        if (now > this.next && mm.visible) {
          this.state = 'fire'
          this.t = 0
          this.shots = 0
        }
      } else if (this.state === 'fire') {
        if ((this.t > 0.35 && this.shots < 1) || (this.t > 0.8 && this.shots < 2)) {
          this.shots++
          enemyShot(s, this.cx + this.dir * 10 - 2, this.y - 12, this.dir * 95)
        }
        if (this.t > 1.25) {
          this.state = 'guard'
          this.next = now + rand(1500, 2600)
          if (Math.random() < 0.35) {
            // a hop on the spot, shield up
            this.air = true
            this.vy = -115
          }
        }
      }
      return FAST
    }
    draw(c) {
      if (this.inv > 0 && this.f & 1) return
      const k = this.air ? 'jump' : this.state === 'fire' ? 'fire' : 'guard'
      const sp = JOE[k][this.dir]
      const sx = this.state === 'stun' && this.f & 2 ? -this.dir : 0
      c.drawImage(sp, Math.round(this.cx - sp.width / 2 + sx), Math.round(this.y - sp.height + 1))
    }
  }

  class Blader {
    constructor(s, side, delay = 0) {
      this.s = s
      this.kind = 'blader'
      this.target = true
      this.dir = -side
      this.cx = side > 0 ? s.W + 12 : -12
      this.base = rand(9, 20)
      this.y = this.base
      this.ph = rand(0, 6)
      this.vx = 0
      this.vy = 0
      this.state = 'fly'
      this.t = -delay
      this.f = 0
      this.passes = 0
      this.z = 5
      this.moving = true
    }
    get fy() {
      return this.y
    }
    contains(x, y) {
      return Math.abs(x - this.cx) <= 7 && Math.abs(y - this.y) <= 6
    }
    hit(x, y) {
      return Math.abs(x - this.cx) <= 11 && Math.abs(y - this.y) <= 10
    }
    onClick() {
      touched(this.s)
      this.s.data.mm.attack(this)
    }
    onShot() {
      this.dead = true
      pop(this.s, this.cx, this.y, '500', ['o', 'O', 'w', 'y'])
      return 'hit'
    }
    leave() {
      this.state = 'away'
    }
    update(dt, now, s) {
      this.f++
      this.t += dt
      if (this.t < 0) return FAST
      const mm = s.data.mm
      const W = s.W
      if (this.t > 25) this.state = 'away'
      if (this.state === 'away') {
        this.y -= 60 * dt
        this.cx += this.dir * 30 * dt
        if (this.y < -14 - SPILL) this.dead = true
        return FAST
      }
      if (this.state === 'fly') {
        this.cx += this.dir * 42 * dt
        // startled by the cursor: it swerves away from it
        const c = s.cursor
        if (c && c.y <= H && Math.abs(c.x - this.cx) < 18 && Math.abs(c.y - this.y) < 14) this.base = clamp(this.base + (c.y > this.y ? -40 : 40) * dt, 4 - SPILL, 24)
        this.y = this.base + Math.sin(this.t * 4 + this.ph) * 4
        if (mm.visible && Math.abs(mm.cx - this.cx) < 46 && Math.sign(mm.cx - this.cx) === this.dir && Math.random() < 0.04) {
          // dive at him
          this.state = 'dive'
          this.t2 = 0
          const dx = mm.cx - this.cx
          const dy = FLOOR - 14 - this.y
          const d = Math.hypot(dx, dy) || 1
          this.vx = (dx / d) * 95
          this.vy = (dy / d) * 95
        }
        if ((this.dir > 0 && this.cx > W - 14) || (this.dir < 0 && this.cx < 14)) {
          if (++this.passes < 3) this.dir = -this.dir
        }
        if (this.cx < -20 || this.cx > W + 20) this.dead = true
      } else if (this.state === 'dive') {
        this.t2 += dt
        this.cx += this.vx * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR - 12 || this.t2 > 1) {
          this.state = 'climb'
          this.vy = -55
        }
      } else if (this.state === 'climb') {
        this.cx += this.dir * 36 * dt
        this.y += this.vy * dt
        if (this.y <= this.base) this.state = 'fly'
      }
      if (mm.contains(this.cx, this.y)) mm.hurt(3, this.cx < mm.cx ? 1 : -1)
      return FAST
    }
    draw(c) {
      if (this.t < 0) return
      const sp = BLADER[(this.f >> 1) & 1][this.dir]
      c.drawImage(sp, Math.round(this.cx - sp.width / 2), Math.round(this.y - 6))
    }
  }

  const WILY_TAUNT = ['Mwahahaha! Get him, my Mets!', 'You cannot stop me, Mega Man!', 'The world will be MINE!', 'Behold my genius!']
  const WILY_BEG = ['Please forgive me, Mega Man!', 'I am so sorry! Truly!', "It was all Bass's idea!", 'I will never do it again! Probably!']
  const WILY_FLEE = ["I'll be back, Mega Man!", 'Next time! NEXT TIME!', 'You have not seen the last of me!']
  const wilySays = (s, t, x) => s.say(t, x, 1, { color: '#fcfcfc', life: 2.6 })
  class Saucer {
    constructor(s, side, beg = false) {
      this.s = s
      this.kind = 'saucer'
      this.target = !beg
      this.dir = -side
      this.cx = side > 0 ? s.W + 16 : -16
      this.y = 3
      this.tx = clamp(s.W / 2 + rand(-80, 80), 40, s.W - 40)
      this.state = beg ? 'land' : 'fly'
      this.hp = 4
      this.inv = 0
      this.t = 0
      this.f = 0
      this.drops = 0
      this.until = now0() + 15000
      this.z = 5
      this.moving = true
      wilySays(s, beg ? 'Wait! Wait, Mega Man!' : pick(WILY_TAUNT), clamp(this.cx, 40, s.W - 40))
    }
    get fy() {
      return this.y + 6
    }
    get wx() {
      return clamp(this.cx + 18, 8, this.s.W - 8)
    }
    contains(x, y) {
      return this.state === 'fly' && Math.abs(x - this.cx) <= 13 && y >= this.y && y <= this.y + 11
    }
    hit(x, y) {
      if (this.state === 'beg') return (Math.abs(x - this.wx) <= 9 && y >= FLOOR - 16) || (Math.abs(x - this.cx) <= 14 && y >= this.y - 2)
      return Math.abs(x - this.cx) <= 15 && y >= this.y - 3 && y <= this.y + 14
    }
    onClick() {
      const s = this.s
      touched(s)
      if (this.state === 'beg') {
        // poke the begging doctor and he bolts
        wilySays(s, 'Eek! Not the face!', this.wx)
        this.state = 'flee'
        return
      }
      if (this.state === 'fly') s.data.mm.attack(this)
    }
    onShot(sh) {
      if (this.state !== 'fly') return 'pass'
      if (this.inv > 0) return sh.kind === 'c' || sh.kind === 'cut' ? 'pass' : 'hit'
      this.hp -= sh.dmg
      this.inv = 0.4
      this.s.burst(this.cx, this.y + 6, 5, ['w', 'y'])
      if (this.hp <= 0) {
        this.state = 'crash'
        this.target = false
        pop(this.s, this.cx, this.y + 6, '5000', ['y', 'O', 'x', 'w'])
        wilySays(this.s, 'Nooo! My beautiful saucer!', this.cx)
      }
      return 'hit'
    }
    leave() {
      if (this.state === 'fly' || this.state === 'land') this.state = 'flee'
    }
    update(dt, now, s) {
      this.f++
      this.t += dt
      if (this.inv > 0) this.inv -= dt
      const W = s.W
      switch (this.state) {
        case 'fly': {
          const c = s.cursor
          if (c && c.y < 18 && Math.abs(c.x - this.cx) < 22 && now - c.since < 2500) this.tx = clamp(this.cx + (c.x > this.cx ? -70 : 70), 30, W - 30)
          const dx = this.tx - this.cx
          if (Math.abs(dx) < 3) this.tx = clamp(rand(40, W - 40), 30, W - 30)
          else {
            this.dir = Math.sign(dx)
            this.cx += this.dir * Math.min(Math.abs(dx), 46 * dt)
          }
          this.y = 3 + Math.sin(this.t * 3) * 2
          // drops a Met now and then
          if (this.t > 2 && this.drops < 2 && s.data.mets.length < 4 && Math.random() < 0.012 && this.cx > 30 && this.cx < W - 20) {
            this.drops++
            dropMet(s, this.cx)
          }
          if (now > this.until) {
            wilySays(s, pick(WILY_FLEE), this.cx)
            this.state = 'flee'
          }
          return FAST
        }
        case 'land':
        case 'crash':
          if (this.state === 'land') {
            const dx = this.tx - this.cx
            if (Math.abs(dx) > 3) {
              this.dir = Math.sign(dx)
              this.cx += this.dir * Math.min(Math.abs(dx), 70 * dt)
              return FAST
            }
          } else if (this.f % 3 === 0) s.particle({ img: pix(this.f & 4 ? 'x' : 'X'), x: this.cx + rand(-8, 8), y: this.y + 4, vx: rand(-6, 6), vy: -18, life: 0.7, fade: true })
          this.y += 22 * dt
          if (this.y >= FLOOR - 11) {
            this.y = FLOOR - 11
            this.state = 'beg'
            this.t = 0
            s.burst(this.cx, FLOOR - 1, 6, ['x', 'X'])
            wilySays(s, pick(WILY_BEG), this.wx)
          }
          return FAST
        case 'beg':
          if (this.t > 3.4) {
            wilySays(s, pick(WILY_FLEE), this.cx)
            this.state = 'flee'
          }
          return FAST
        case 'flee':
          this.y -= 30 * dt
          this.cx += this.dir * 110 * dt
          if (this.cx < -30 || this.cx > W + 30 || this.y < -20 - SPILL) this.dead = true
          return FAST
      }
      return FAST
    }
    draw(c) {
      if (this.inv > 0 && this.f & 1) return
      const beg = this.state === 'beg'
      const sp = (beg ? SAUCER_EMPTY : SAUCER[(this.f >> 2) & 1])[this.dir]
      c.drawImage(sp, Math.round(this.cx - sp.width / 2), Math.round(this.y))
      if (beg) {
        const w = WILY[Math.floor(this.t / 0.4) % 2 ? 'bow' : 'kneel'][this.cx > this.wx ? 1 : -1]
        c.drawImage(w, Math.round(this.wx - w.width / 2), FLOOR - w.height + 1)
      }
    }
  }

  class Rush {
    constructor(s, cx) {
      this.s = s
      this.cx = cx
      this.beamY = -12 - SPILL
      this.state = 'beam'
      this.t = 0
      this.f = 0
      this.dir = s.data.mm.cx > cx ? 1 : -1
      this.z = 2
      this.ready = false
      this.barkAt = 0
      this.moving = true
    }
    hit(x, y) {
      return this.state !== 'beam' && this.state !== 'leave' && Math.abs(x - this.cx) <= 13 && y >= FLOOR - 18
    }
    onClick() {
      const s = this.s
      touched(s)
      this.bark(s, true)
      const mm = s.data.mm
      if (this.state === 'sit' || this.state === 'wait') {
        this.state = 'wait'
        if (Math.abs(mm.cx - this.cx) < 30 && mm.state === 'stand') this.ready = true
        else mm.goRush = true
      } else if (this.state === 'dig') this.t = Math.max(this.t, 1)
    }
    bark(s, force = false) {
      const now = now0()
      if (!force && now < this.barkAt) return
      this.barkAt = now + 5000
      s.say(pick(['ARF!', 'Arf arf!', 'Woof!']), this.cx + this.dir * 8, FLOOR - 24, { life: 0.9, size: 6, color: '#fc7460', vy: -4 })
    }
    leave() {
      if (this.state !== 'leave') {
        this.state = 'leave'
        this.beamY = FLOOR - 14
      }
    }
    update(dt, now, s) {
      this.f++
      this.t += dt
      const mm = s.data.mm
      const c = s.cursor
      if (this.state !== 'beam' && this.state !== 'leave') {
        // he watches the cursor, or his master
        if (c && c.y <= H && Math.abs(c.x - this.cx) < 50) {
          if (Math.abs(c.x - this.cx) > 4) this.dir = c.x > this.cx ? 1 : -1
          if (now - c.since < 1500) this.bark(s)
        } else if (mm.visible && Math.abs(mm.cx - this.cx) > 4) this.dir = mm.cx > this.cx ? 1 : -1
      }
      switch (this.state) {
        case 'beam':
          this.beamY += 300 * dt
          if (this.beamY >= FLOOR - 14) {
            this.state = 'sit'
            this.t = 0
            this.bark(s, true)
          }
          break
        case 'sit':
          if (this.t > 1) {
            this.state = 'wait'
            this.t = 0
          }
          break
        case 'wait':
          if (this.ready || this.t > 8) {
            this.state = this.ready ? 'coil' : 'dig'
            this.t = 0
            if (this.ready && mm.visible && ['stand', 'run'].includes(mm.state)) {
              // Rush Coil: the spring fires and up he goes, past the top of the bar
              const away = mm.cx < this.cx ? 1 : -1
              mm.jump(clamp(away * 75, -75, 75), COILV)
              mm.goRush = false
              s.say('BOING', this.cx, FLOOR - 20, { life: 0.7, size: 6, color: '#bcbcbc', vy: -6 })
            }
          }
          break
        case 'coil':
          if (this.t > 0.7) {
            this.state = 'dig'
            this.t = 0
          }
          break
        case 'dig':
          if (this.f % 2 === 0) s.particle({ img: pix(this.f & 2 ? 'm' : 'x'), x: this.cx - this.dir * 8, y: FLOOR - 3, vx: -this.dir * rand(10, 30), vy: rand(-30, -10), g: 120, life: 0.6 })
          if (this.t > 1.4) {
            // he digs something up
            if (mm.tanks < 4 && !s.actors.some((a) => a instanceof Item && !a.dead)) s.spawn(new Item(s, this.cx + this.dir * 10 - 4))
            else s.particle({ digits: '1000', x: this.cx - 8, y: FLOOR - 22, vy: -8, life: 0.9, fade: true })
            this.bark(s, true)
            this.leave()
          }
          break
        case 'leave':
          this.beamY -= 320 * dt
          if (this.beamY < -14 - SPILL) this.dead = true
          break
      }
      return FAST
    }
    draw(c) {
      const x = Math.round(this.cx)
      if (this.state === 'beam' || this.state === 'leave') {
        const by = Math.round(this.beamY)
        for (let yy = by - 16; yy < by; yy += 8) c.drawImage(BEAM_RED, x - 3, yy)
        return
      }
      const wag = (this.f >> 1) & 1
      const sp = (this.state === 'coil' ? RUSH.coil : wag ? RUSH.wag : RUSH.sit)[this.dir]
      c.drawImage(sp, x - Math.round(sp.width / 2), FLOOR - sp.height + 1)
    }
  }

  // Proto Man: whistles in, stands with his scarf blowing, whistles out (an easter egg)
  class Proto {
    constructor(s, cx) {
      this.s = s
      this.cx = cx
      this.y = FLOOR
      this.beamY = -12 - SPILL
      this.state = 'beam'
      this.t = 0
      this.f = 0
      this.dir = s.data.mm.cx > cx ? 1 : -1
      this.z = 2
      this.moving = true
    }
    hit(x, y) {
      return this.state === 'stand' && Math.abs(x - this.cx) <= 10 && y >= FLOOR - 26
    }
    onClick() {
      const s = this.s
      touched(s)
      // he answers with a shot of his own at whatever is nearest
      const m = s.data.mets[0]
      if (m) this.dir = m.cx > this.cx ? 1 : -1
      s.spawn(new Shot(s, this.cx + this.dir * 14 - 3, this.y - 15, this.dir * 165, 0, 'p', 'mm'))
      this.shootT = 0.3
    }
    leave() {
      if (this.state !== 'leave') {
        this.state = 'leave'
        this.beamY = this.y - 8
      }
    }
    update(dt, now, s) {
      this.f++
      this.t += dt
      if (this.shootT > 0) this.shootT -= dt
      if (this.state === 'beam') {
        this.beamY += 300 * dt
        if (this.beamY >= this.y - 8) {
          this.state = 'stand'
          this.t = 0
        }
      } else if (this.state === 'stand') {
        if (this.f % 6 === 0 && this.t < 3) s.particle({ img: BUBBLE['♪'], x: this.cx + rand(-10, 6), y: this.y - 30, vx: rand(-4, 4), vy: -8, life: 1, fade: true })
        if (this.t > 1.2 && !this.said) {
          this.said = true
          s.say('...', this.cx, Math.max(0, this.y - 32), { life: 1.4, color: '#fc7460' })
        }
        if (this.t > 4.5 || !live(s, now)) this.leave()
      } else {
        this.beamY -= 320 * dt
        if (this.beamY < -14 - SPILL) {
          this.dead = true
          s.data.proto = null
        }
      }
      return FAST
    }
    draw(c) {
      const x = Math.round(this.cx)
      if (this.state !== 'stand') {
        const by = Math.round(this.beamY)
        for (let yy = by - 16; yy < by; yy += 8) c.drawImage(BEAM_RED, x - 3, yy)
        return
      }
      const fr = MMS.proto[this.shootT > 0 ? 'shoot' : 'stand']
      const sp = fr.sp[this.dir]
      const ax = this.dir === 1 ? fr.ax : sp.width - 2 - fr.ax - 1
      c.drawImage(sp, x - ax - 1, this.y - sp.height + 1)
      // the yellow scarf, flapping behind him
      const fl = (this.f >> 1) & 1
      for (let i = 0; i < 4; i++) c.drawImage(pix('y'), x - this.dir * (5 + i), this.y - 13 + (i > 1 ? fl : 0) - (i === 3 ? fl : 0))
    }
  }

  function dropMet(s, x) {
    const m = new Met(s, openSpot(s, clamp(Math.round(x), 26, s.W - 12), 7), true)
    m.y = Math.min(m.y, 6)
    s.data.mets.push(m)
    s.spawn(m)
  }
  const farX = (s, mm) => openSpot(s, mm.cx < s.W / 2 ? Math.min(s.W - 30, mm.cx + 150) : Math.max(30, mm.cx - 150), 12)
  const EPISODES = ['joe', 'bladers', 'wily', 'rush', 'ambush']
  function runEpisode(s, now, k) {
    const d = s.data
    const mm = d.mm
    if (!k && FORCE_EP) k = FORCE_EP
    if (!k) {
      if (!d.epBag.length) d.epBag = EPISODES.slice().sort(() => Math.random() - 0.5)
      k = d.epBag.pop()
    }
    const side = mm.cx < s.W / 2 ? 1 : -1
    if (k === 'joe') d.foes.push(s.spawn(new Joe(s, farX(s, mm))))
    else if (k === 'bladers') {
      const n = s.W < 500 ? 2 : 3
      for (let i = 0; i < n; i++) d.foes.push(s.spawn(new Blader(s, side, i * 0.7)))
    } else if (k === 'wily') d.foes.push(s.spawn(new Saucer(s, side)))
    else if (k === 'rush') d.rush = s.spawn(new Rush(s, openSpot(s, clamp(mm.cx + side * 60, 30, s.W - 20), 12)))
    else if (k === 'ambush') {
      // a Met ambush: three drop in around him, one after another
      for (let i = 0; i < 3; i++) d.q.push({ at: now + 300 + i * 650, fn: () => d.mets.length < 5 && dropMet(s, mm.cx + (i % 2 ? -1 : 1) * rand(55, 110)) })
    }
  }

  // ---- HUD: health meters and E-tanks --------------------------------------------------
  function meter(c, x, hp, color) {
    const n = Math.max(8, Math.floor((H - 9) / 2))
    const top = H - 4 - n * 2
    c.fillStyle = '#000000'
    c.fillRect(x, top - 1, 6, n * 2 + 1)
    const lit = Math.round((hp / MAX_HP) * n)
    for (let i = 0; i < n; i++) {
      const on = i < lit
      c.fillStyle = on ? color : '#202024'
      c.fillRect(x + 1, top + (n - 1 - i) * 2, 4, 1)
    }
  }

  function setup(s) {
    s.data = {
      W: s.W, mets: [], respawnAt: 0, boss: null, bossAt: 0, beaten: null, nextBoss: pick(['cut', 'ice']), party: false, weapon: null,
      foes: [], q: [], rush: null, proto: null, epAt: 0, epBag: [], waveAt: 0, clickAt: -1e9, grabAt: -1e9, wasLive: true,
    }
    s.data.mm = new MegaMan(s)
    for (const fx of [0.55, 0.8]) s.data.mets.push(new Met(s, openSpot(s, Math.round(s.W * fx), 7, [[s.data.mm.cx - 60, s.data.mm.cx + 60]])))
    s.actors.push(...s.data.mets, s.data.mm)
  }

  function spawnMet(s) {
    const mm = s.data.mm
    let x = 0
    for (let i = 0; i < 10; i++) {
      x = Math.round(rand(26, s.W - 12))
      if (Math.abs(x - mm.cx) > 70 && s.data.mets.every((m) => Math.abs(m.cx - x) > 30)) break
    }
    x = openSpot(s, x, 7)
    const m = new Met(s, x, true)
    s.data.mets.push(m)
    s.spawn(m)
  }

  function spawnBoss(s) {
    const type = s.data.nextBoss
    s.data.nextBoss = type === 'cut' ? 'ice' : 'cut'
    const b = new Boss(s, type)
    const mm = s.data.mm
    // drop in on the far side from him
    b.cx = mm.cx < s.W / 2 ? clamp(mm.cx + 140, 30, s.W - 14) : clamp(mm.cx - 140, 30, s.W - 14)
    s.data.boss = b
    s.spawn(b)
  }

  registerConcept({
    key: 'megaman',
    title: 'Mega Man',
    sub: 'Capcom, 1987',
    blurb:
      'Mega Man beams in and plays the Met game: the Mets duck under their hard hats when he or your cursor gets close, peek out when it feels safe and fire a 3-way shot, and pellets bounce off a closed helmet. Between rounds visitors drop by: Sniper Joe hides behind his shield and only drops it to shoot (a charged shot knocks it aside), a squadron of Bladers swoops in and dives, Dr. Wily flies over in his saucer dropping Mets until he is shot down and begs for forgiveness, three Mets ambush him at once, or Rush beams in for a pat, a Rush Coil leap off the top of the bar and a dig for an E-tank. Mega Man faces your <b>cursor</b>; sweep it along the floor and he runs after it. Click him to charge, click again to fire, double-click to slide, drag him and let go; click any enemy and he turns and shoots (jump-shoots at flyers). Pick a Met up by its hard hat and drop it: it comes up shooting. Click Rush for a bark and a Coil jump, poke Wily while he begs and he bolts, and click Mega Man five times fast for a whistle from his brother. While you play he waits on you; leave him and he carries on. While the agent works a Robot Master drops in, Cut Man or Ice Man, between waves of Bladers and Joes; he jumps and slides under shots and drinks an E-tank when low. On done the boss goes down and it is weapon get (or Wily crash-lands to grovel), then he beams out while the Mets hop. Left alone he stands, blinks and holds still.',
    setup,
    update(s, dt, now) {
      const d = s.data
      const mm = d.mm
      // the finishing shot needs a moment before the weapon-get screen
      if (mm.weaponAt && now > mm.weaponAt) {
        mm.weaponAt = 0
        if (d.beaten && mm.visible) {
          mm.getWeapon(s, d.beaten)
          d.beaten = null
        }
      }
      if (mm.weaponAt) return Math.max(FAST, mm.weaponAt - now)
      d.foes = d.foes.filter((f) => !f.dead)
      if (d.rush && d.rush.dead) d.rush = null
      if (d.proto && d.proto.dead) d.proto = null
      if (!live(s, now)) {
        // everyone goes home; the bar settles
        if (d.wasLive) {
          d.wasLive = false
          d.q.length = 0
          for (const f of d.foes) f.leave()
          d.rush?.leave()
          d.proto?.leave()
          mm.goRush = false
        }
        return Infinity
      }
      d.wasLive = true
      while (d.q.length && d.q[0].at <= now) d.q.shift().fn()
      let soon = d.q.length ? d.q[0].at - now : Infinity
      const user = engaged(s, now)
      if (s.busy) {
        // between Robot Masters, waves of Bladers and Sniper Joes
        if (!d.boss && d.foes.length < 2 && mm.visible && now > d.waveAt) {
          runEpisode(s, now, Math.random() < 0.6 ? 'bladers' : 'joe')
          d.waveAt = now + rand(7000, 11000)
        }
        if (!d.boss) soon = Math.min(soon, Math.max(SLOW, d.waveAt - now))
      } else {
        // watch mode: one visitor at a time, a breather between them
        const quiet = !d.boss && !d.foes.length && !d.rush && !d.q.length && mm.visible && mm.state !== 'getweapon' && !mm.byeAt
        if (quiet && !user) {
          if (!d.epAt) d.epAt = now + rand(3500, 7000)
          if (now > d.epAt) {
            d.epAt = 0
            runEpisode(s, now)
          } else soon = Math.min(soon, d.epAt - now)
        } else if (!quiet) d.epAt = 0
      }
      // the Robot Master arrives a few seconds into the work, then again later
      if (s.busy && !d.boss && mm.visible && mm.state !== 'getweapon' && now > d.bossAt) {
        spawnBoss(s)
        d.bossAt = Infinity
      }
      const want = d.boss ? 0 : s.busy ? 4 : d.foes.length ? 1 : 3
      if (d.mets.length < want && now > d.respawnAt && mm.visible) {
        spawnMet(s)
        d.respawnAt = now + (s.busy ? rand(1500, 2800) : rand(8000, 14000))
      }
      if (s.busy && !d.boss && d.bossAt === Infinity) d.bossAt = now + rand(15000, 25000)
      let wait = d.mets.length < want ? Math.max(SLOW, d.respawnAt - now) : Infinity
      if (s.busy && !d.boss) wait = Math.min(wait, Math.max(SLOW, d.bossAt - now))
      return Math.min(wait, soon, user ? SLOW : Infinity)
    },
    drawFront(s, c) {
      const mm = s.data.mm
      meter(c, 3, mm.shownHp, '#fcfcb0')
      const b = s.data.boss
      if (b && b.state !== 'die' && b.state !== 'enter') meter(c, 10, b.shownHp, b.def.color)
      for (let i = 0; i < mm.tanks; i++) c.drawImage(ETANK_ICON, (b ? 17 : 10) + i * 6, 1)
    },
    // mockup extra (Aico never delivers empty-bar clicks): shoot that way
    onBarClick(s, p) {
      touched(s)
      const mm = s.data.mm
      if (!mm.visible || mm.state === 'hurt' || mm.state === 'getweapon') return
      mm.dir = p.x > mm.cx ? 1 : -1
      mm.turnAt = now0() + 1500
      if (mm.state === 'rest') mm.state = 'stand'
      if (mm.charge > 0.5) mm.release()
      else mm.fire()
    },
    onKey(s, key, down) {
      s.data.mm?.onKey(key, down)
      s.poke()
    },
    onBusy(s) {
      s.data.waveAt = now0() + rand(6000, 9000)
      s.data.epAt = 0
      s.data.bossAt = now0() + rand(2500, 4500)
      s.data.respawnAt = now0() + 800
      s.data.beaten = null
    },
    onDone(s) {
      const d = s.data
      const mm = d.mm
      const b = d.boss
      if (!mm.visible) return
      mm.charge = -1
      mm.byeAt = 0
      const won = () => {
        if (!mm.visible || mm.state === 'getweapon') return
        mm.getWeapon(s, d.beaten)
        d.beaten = null
      }
      if (b && b.state !== 'die') {
        // the finishing charged shot
        mm.dir = b.cx > mm.cx ? 1 : -1
        mm.state = 'stand'
        mm.fire('c')
        b.hp = 0
        b.die()
        mm.weaponAt = now0() + 1700
      } else if (d.beaten) won()
      else {
        // no Robot Master to finish: Dr. Wily crash-lands and grovels, then he beams out
        for (const f of d.foes)
          if (f.kind !== 'saucer') {
            f.dead = true
            pop(s, f.cx, f.fy, '1000')
          }
        if (!d.foes.some((f) => f.kind === 'saucer' && !f.dead)) d.foes.push(s.spawn(new Saucer(s, mm.cx < s.W / 2 ? 1 : -1, true)))
        mm.byeAt = now0() + 7500
      }
      d.bossAt = Infinity
    },
    onNap(s) {
      const d = s.data
      const mm = d.mm
      mm.charge = -1
      mm.byeAt = 0
      if (d.boss) {
        d.boss.dead = true
        d.boss = null
      }
      for (const a of s.actors) if (a instanceof Shot) a.dead = true
      for (const f of d.foes) f.dead = true
      d.foes = []
      d.q.length = 0
      if (d.rush) d.rush.dead = true
      if (d.proto) d.proto.dead = true
      d.rush = d.proto = null
      if (['away', 'warpout', 'dematerialize', 'dead'].includes(mm.state)) mm.t = 0
      if (mm.state === 'getweapon') mm.t = 0
      d.party = false
    },
    relayout(s) {
      const d = s.data
      const k = s.W / (d.W || s.W)
      d.W = s.W
      const mm = d.mm
      mm.cx = clamp(Math.round(mm.cx * k), 20, s.W - 12)
      mm.restX = undefined
      for (const m of d.mets) m.cx = openSpot(s, clamp(Math.round(m.cx * k), 26, s.W - 12), 7)
      if (d.boss) d.boss.cx = clamp(Math.round(d.boss.cx * k), 22, s.W - 10)
      for (const a of s.actors) if (a instanceof Item) a.x = clamp(a.x, 20, s.W - 12)
      for (const f of d.foes) {
        f.cx = clamp(Math.round(f.cx * k), 14, s.W - 14)
        if (f.tx !== undefined) f.tx = clamp(f.tx, 30, Math.max(30, s.W - 30))
      }
      for (const a of [d.rush, d.proto]) if (a) a.cx = clamp(Math.round(a.cx * k), 20, s.W - 20)
    },
  })

})()
