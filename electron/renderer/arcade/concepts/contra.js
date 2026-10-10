;(() => {
  // Contra (Konami, 1987), big: Bill (blue) and Lance (red) hold the bar
  // against the Red Falcon army. Run-and-gun with 8-way aim, prone fire,
  // somersault jumps, falcon capsules with S/M/L/F weapons, the death flip and
  // respawn drop. Busy = waves ending at the Defense Wall with its sirens and
  // core; done = the base blows up in a chain and they high-five.

  // ---- palette -----------------------------------------------------------------
  const P = {
    E: '#140e0a', S: '#f8a870', l: '#ffd2a4', s: '#b8602e', d: '#7a3416', H: '#f8a870', // hair, skin, hands
    B: '#2f62f0', b: '#1a2c98', n: '#7aa2ff', // Bill's blue (pants, bandana)
    R: '#e2302a', r: '#8a1410', q: '#ff8a72', // Lance's red
    k: '#3a2618', K: '#7a5030', // boots, belt
    g: '#4c5058', G: '#b4b8c2', w: '#ffffff', // rifle
    U: '#9aa4ae', u: '#5a6470', c: '#3a4048', // running soldier grey
    V: '#6e8a3a', v: '#3e5420', o: '#a89060', // sniper olive / khaki
    T: '#c8b07a', t: '#8a7448', // sandbags
    y: '#fff27a', O: '#ff9a2c', F: '#e8302a', f: '#9a1810', // fire / falcon red
    A: '#e8ecf0', a: '#8a9098', M: '#6a7078', m: '#3c4048', // capsule / wall steel
    Z: '#ff3a2a', z: '#7a1a14', X: '#ffd0c0', // core, siren
  }

  // ---- pixel painter -------------------------------------------------------------
  const FW = 40 // character frame; feet on the last row, body centre on BC
  const FH = 34
  const BC = 15
  const UY = FH - 22 // head top in a standing frame
  const LY = FH - 9 // pants top
  const grid = (w = FW, h = FH) => Array.from({ length: h }, () => Array(w).fill('.'))
  const put = (g, x, y, ch) => {
    x = Math.round(x)
    y = Math.round(y)
    if (y >= 0 && y < g.length && x >= 0 && x < g[0].length && ch && ch !== '.') g[y][x] = ch
  }
  const stamp = (g, x, y, art) => art.forEach((r, j) => [...r].forEach((ch, i) => put(g, x + i, y + j, ch)))
  function line(g, x0, y0, x1, y1, ch) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++) put(g, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, ch)
  }
  const rowsOf = (g) => g.map((r) => r.join(''))
  // trim empty rows/columns isn't needed: frames share one anchor

  // ---- Bill / Lance -----------------------------------------------------------------
  // upper body (head + bare torso + belt), 13 rows, centre column 7, facing right
  const HEAD = [
    '.....EEEE.......',
    '...EEEEEEE......',
    '..bBBBBBBBB.....',
    '.b.EEESSESS.....',
    'b..EEsSSSSSS....',
    '.....sSSSs......',
  ]
  const TORSO = [
    '...sSSSSSSSs....',
    '..sSSlllSSSSs...',
    '..sSSSSdSSSSs...',
    '...sSSSdSSSs....',
    '...sSSdSdSSs....',
    '....sSSSSSs.....',
    '....kkKKkkk.....',
  ]
  // legs, 9 rows
  const LEGS = {
    stand: [
      '....BBBBBBB.....',
      '....BBBBbBBB....',
      '...BBBBb.BBB....',
      '...BBBb..BBBB...',
      '...BBB....BBB...',
      '...BBb....bBB...',
      '...BBb....bBB...',
      '..kkkk....kkkkk.',
      '..kkkkk...kkkkk.',
    ],
    a: [
      '.....BBBBBBB....',
      '....BBBBBBBBB...',
      '...BBBb..BBBBB..',
      '..BBBb....bBBB..',
      '.BBBb......BBB..',
      'kkBb.......bBBB.',
      'kkk.........BBB.',
      '.k.........kkkkk',
      '...........kkkkk',
    ],
    b: [
      '.....BBBBBBB....',
      '....BBBBBBBBB...',
      '...BBBBb.BBBB...',
      '..BBBb...bBBB...',
      '.kBBb....bBBB...',
      'kkkb.....BBB....',
      'kk.......BBB....',
      '.........kkkkk..',
      '.........kkkkk..',
    ],
    c: [
      '.....BBBBBBB....',
      '.....BBBBBBBB...',
      '.....BBBbBBBBB..',
      '......BBbbBBBB..',
      '......BBb.bBBB..',
      '.....BBBb..BBk..',
      '.....BBB...kkk..',
      '.....kkkkk......',
      '.....kkkkk......',
    ],
    wide: [
      '....BBBBBBBB....',
      '...BBBBbbBBBB...',
      '..BBBBb..bBBBB..',
      '..BBBb....bBBB..',
      '.BBBb......bBBB.',
      '.BBb........bBB.',
      '.BBb........bBB.',
      'kkkkk.......kkkkk',
      'kkkkk.......kkkkk',
    ],
  }
  // arms + rifle per pose: rifle drawn as lines (G top, g under), then the
  // arm pixels on top ('S' arm, 's' shade, 'H' hand). Coordinates are in the
  // upper-body box (row 0 = head top), so rows past 12 overlap the legs.
  const ARMS = {
    fwd: {
      gun: [[6, 8, 22, 8, 'G'], [6, 9, 15, 9, 'g'], [11, 10, 12, 10, 'g']],
      art: [
        [10, 7, 'SSSs'],
        [11, 8, 'sSHH'],
        [9, 9, 'HH'],
      ],
      muzzle: [23, 8],
    },
    updiag: {
      gun: [[8, 10, 18, 0, 'G'], [9, 10, 18, 1, 'g'], [7, 10, 9, 8, 'g']],
      art: [
        [10, 6, 'Ss'],
        [11, 5, 'SH'],
        [12, 4, 'H'],
        [9, 8, 'HH'],
      ],
      muzzle: [19, -1],
    },
    up: {
      gun: [[11, 9, 11, -6, 'G'], [12, 9, 12, -4, 'g'], [10, 9, 10, 6, 'g']],
      art: [
        [10, 6, 'S'],
        [10, 5, 'SH'],
        [11, 3, 'HH'],
        [9, 7, 'sHH'],
      ],
      muzzle: [11, -7],
    },
    down: {
      gun: [[7, 8, 17, 18, 'G'], [7, 9, 16, 18, 'g'], [6, 9, 8, 11, 'g']],
      art: [
        [10, 7, 'Ss'],
        [10, 8, 'sSS'],
        [11, 9, 'sHH'],
        [8, 10, 'HH'],
      ],
      muzzle: [18, 19],
    },
    five: {
      // high five: front arm straight up, rifle hangs from the rear hand
      gun: [[3, 10, 0, 19, 'G'], [4, 10, 1, 19, 'g']],
      art: [
        [10, 6, 'S'],
        [10, 5, 'S'],
        [11, 4, 'S'],
        [11, 3, 'S'],
        [11, 2, 'HH'],
        [11, 1, 'HH'],
        [3, 9, 'H'],
      ],
    },
    win: {
      // victory: rifle held up across the head with both hands
      gun: [[1, -3, 15, -3, 'G'], [2, -2, 13, -2, 'g']],
      art: [
        [10, 6, 'S'],
        [11, 5, 'S'],
        [12, 4, 'S'],
        [12, 3, 'S'],
        [12, 2, 'S'],
        [12, -1, 'HH'],
        [12, 0, 'S'],
        [12, 1, 'S'],
        [2, 6, 's'],
        [2, 5, 'S'],
        [2, 4, 'S'],
        [2, 3, 'S'],
        [2, 2, 'S'],
        [2, 1, 'S'],
        [2, 0, 'S'],
        [2, -1, 'HH'],
      ],
    },
  }

  function composeBody({ arms, legs, bob = 0, upper = null, armMap = null, legMap = null, extra = null }) {
    const g = grid()
    const ux = BC - 7
    const uy = UY + bob
    stamp(g, ux, LY, legMap ? recolor(LEGS[legs], legMap) : LEGS[legs])
    stamp(g, ux, uy, upper || HEAD)
    if (!upper) stamp(g, ux, uy + 6, TORSO)
    const a = ARMS[arms]
    if (a) {
      for (const [x0, y0, x1, y1, ch] of a.gun) line(g, ux + x0, uy + y0, ux + x1, uy + y1, ch)
      for (const [x, y, art] of a.art) stamp(g, ux + x, uy + y, armMap ? recolor([art], armMap) : [art])
    }
    if (extra) for (const [x, y, art] of extra) stamp(g, ux + x, uy + y, [art])
    return rowsOf(g)
  }

  // prone (lying on the belly, rifle forward) and the rest variant (head down)
  const PRONE = [
    '......................EEEEE.............',
    '.....................EEEEEEE............',
    '....................bBBBBBBBb...........',
    '...................b.EESSSES............',
    'kk..bBBBBBBBBkKKSSSSSSSSSSSSHGGGGGGGGGGw',
    'kkBBBBBBBBBBBBkKKSSlSSSSSSSHHgggg.......',
    'kk.....bBBBBBbkKksssssssssss............',
  ]
  const REST = [
    '........................................',
    '......................EEEE..............',
    '.....................EEEEEE.............',
    '....................bBBBBBBb............',
    'kk..bBBBBBBBBkKKSSSSEEESsSSS............',
    'kkBBBBBBBBBBBBkKKSSlSSSSSSSSHHGGGGGGGGGw',
    'kk.....bBBBBBbkKksssssssssssSHgggg......',
  ]
  // lying on the back after the death flip
  const DOWN = [
    '........................................',
    '...........ssSSS........................',
    '.kk.......sSSSSSSSs.........EEEEE.......',
    'kkkBBBBBBBkKKSSSdSSSSSSSsSSbBBBBEE......',
    'kkBBBBbBBBkKKSSSSSSdSSSSSSsSSESSSSEE.GGG',
    '.kk..bBBBBkKKsssssssssssssssSSSSsEE.gg..',
  ]
  // flung back by a hit, spun through 4 quarter turns
  const FLUNG = [
    '.......SS..........',
    '......SS...........',
    '..EEE.S....bBb.....',
    '.EEEEbBBb..BBBb....',
    'EEEbBBBBBbSBBBBb...',
    '.EESSSSSlSSSkBBBkk.',
    '..sSESSSdSSKkBBBkkk',
    '...sSSSdSSSK.bBb...',
    '....sSSdSSK..kkk...',
    '.....HSSSS.........',
    '.....GGHgg.........',
    '....GGg............',
  ]
  // the somersault ball: curled up, hugging the knees
  const BALL = [
    '.....EEEE.....',
    '...EEEEEEEb...',
    '..EEBBBBBBbb..',
    '..ESSEESSES...',
    '.sSSSSSSSSS...',
    '.sSSlSSSHHBB..',
    'sSSdSSSHHBBBB.',
    'sSSSSSSBBBBBBk',
    '.sSSSKKBBBBkkk',
    '..sSKKBBBBkkk.',
    '...ssBBBBkk...',
    '.....bbbb.....',
  ]

  // ---- sprite sets ------------------------------------------------------------------
  const rot = (c, q) => {
    const o = document.createElement('canvas')
    o.width = q & 1 ? c.height : c.width
    o.height = q & 1 ? c.width : c.height
    const x = o.getContext('2d')
    x.translate(o.width / 2, o.height / 2)
    x.rotate((q * Math.PI) / 2)
    x.drawImage(c, -c.width / 2, -c.height / 2)
    return o
  }
  const AIMS = ['fwd', 'down', 'up', 'updiag'] // index by AIM_POSE[k]
  const RUN = ['a', 'b', 'c', 'a', 'b', 'c']
  const RUN_BOB = [0, 1, 0, 0, 1, 0]
  function buildCommando(map) {
    const rc = (rows) => (map ? recolor(rows, map) : rows)
    const set = { stand: {}, run: {}, win: null }
    for (const a of AIMS) {
      set.stand[a] = pairOutlined(rc(composeBody({ arms: a, legs: 'stand' })), P)
      set.run[a] = RUN.map((l, i) => pairOutlined(rc(composeBody({ arms: a, legs: l, bob: RUN_BOB[i] })), P))
    }
    set.five = pairOutlined(rc(composeBody({ arms: 'five', legs: 'stand' })), P)
    set.win = pairOutlined(rc(composeBody({ arms: 'win', legs: 'wide' })), P)
    set.prone = pairOutlined(rc(PRONE), P)
    set.rest = pairOutlined(rc(REST), P)
    set.down = pairOutlined(rc(DOWN), P)
    const fl = sprite(rc(FLUNG), P)
    set.flung = [0, 1, 2, 3].map((q) => {
      const r = outline(rot(fl, q))
      return { 1: r, '-1': mirror(r) }
    })
    const bl = sprite(rc(BALL), P)
    set.ball = [0, 1, 2, 3].map((q) => {
      const r = outline(rot(bl, q))
      return { 1: r, '-1': mirror(r) }
    })
    return set
  }
  const SKINS = [buildCommando(null), buildCommando({ B: 'R', b: 'r', n: 'q' })]
  // muzzle points relative to (centre, feet) for a right-facing standing pose
  const MUZZLE = {}
  for (const a of AIMS) {
    const [mx, my] = ARMS[a].muzzle
    MUZZLE[a] = [mx - 7, UY + my - FH]
  }

  // ---- Red Falcon soldiers -------------------------------------------------------------
  const SOLDIER_UP = [
    '......ccc.......',
    '....ccccccc.....',
    '....cccccccccc..',
    '....cSSSSES.....',
    '....cSSSSSSS....',
    '.....uSSSs......',
    '...uUUUUUUUu....',
    '..uUUUUUUUUUu...',
    '..uUUUuUUUUUu...',
    '...uUUuUUUUu....',
    '...uUUuUUUUu....',
    '....uUUUUUu.....',
    '....KKKKKKK.....',
  ]
  const SNIPER_UP = [
    '.....vvvv.......',
    '....vVVVVVv.....',
    '...vVVVVVVVvv...',
    '....SSSSESS.....',
    '....SSSSSSSS....',
    '.....sSSSs......',
    '...vVVVVVVVv....',
    '..vVVVVVVVVVv...',
    '..vVVVvVVVVVv...',
    '...vVVvVVVVv....',
    '...vVVvVVVVv....',
    '....vVVVVVv.....',
    '....KKKKKKK.....',
  ]
  const SLEEVE = { S: 'U', s: 'u', H: 'S' }
  const OLIVE = { S: 'V', s: 'v', H: 'S' }
  const SOL_LEGS = { B: 'u', b: 'c' }
  const SNI_LEGS = { B: 'o', b: 't' }
  // arms pumping while running
  const PUMP = [
    [[10, 7, 'UU'], [11, 8, 'UUU'], [13, 7, 'S'], [2, 8, 'u'], [1, 9, 'u'], [0, 10, 'S']],
    [[9, 8, 'U'], [8, 9, 'UU'], [7, 10, 'S'], [11, 8, 'uu'], [12, 9, 'S']],
  ]
  const FLINCH = [[10, 6, 'U'], [11, 5, 'U'], [11, 4, 'U'], [10, 3, 'SS']]
  const FLUNG_UP = [[3, 5, 'u'], [2, 4, 'u'], [2, 3, 'u'], [1, 2, 'S'], [11, 5, 'U'], [12, 4, 'U'], [12, 3, 'U'], [13, 2, 'S']]
  const solBody = (o) => composeBody({ upper: SOLDIER_UP, armMap: SLEEVE, legMap: SOL_LEGS, ...o })
  const whiteOut = (rows) => rows.map((r) => r.replace(/[^.]/g, 'w'))
  const SOLDIER = {
    run: RUN.map((l, i) => pairOutlined(solBody({ legs: l, bob: RUN_BOB[i], extra: PUMP[i % 3 === 1 ? 1 : i >= 3 ? 1 : 0] }), P)),
    aim: pairOutlined(solBody({ arms: 'fwd', legs: 'stand' }), P),
    flinch: pairOutlined(solBody({ legs: 'stand', bob: 1, extra: FLINCH }), P),
    die: pairOutlined(solBody({ legs: 'wide', bob: -1, extra: FLUNG_UP }), P),
    flash: pairOutlined(whiteOut(solBody({ legs: 'wide', bob: -1, extra: FLUNG_UP })), P),
  }
  const sniBody = (o) => composeBody({ upper: SNIPER_UP, armMap: OLIVE, legMap: SNI_LEGS, legs: 'stand', ...o })
  const SNIPER = {
    fwd: pairOutlined(sniBody({ arms: 'fwd' }), P),
    updiag: pairOutlined(sniBody({ arms: 'updiag' }), P),
    down: pairOutlined(sniBody({ arms: 'down' }), P),
    die: pairOutlined(sniBody({ legs: 'wide', bob: -1, extra: FLUNG_UP.map(([x, y, a]) => [x, y, a.replace(/U/g, 'V').replace(/u/g, 'v')]) }), P),
  }

  // sandbag bunker the sniper hides behind
  const BUNKER = (() => {
    const g = grid(22, 10)
    const bag = (x, y) => {
      stamp(g, x, y, ['.TTTTT.', 'TTTTTTt', 'tTTTTtt', '.ttttt.'])
    }
    bag(7, 0)
    bag(2, 3)
    bag(9, 3)
    bag(14, 3)
    bag(0, 6)
    bag(6, 6)
    bag(12, 6)
    bag(16, 6)
    return outline(sprite(rowsOf(g), P))
  })()

  // ---- falcon capsule and weapon pickups ----------------------------------------------
  const CAPSULE = [
    sprite(['ww...........ww', '.wwa.......aww.', '..aAAAAAAAAAa..', '.aAAaFFwFFaAAa.', 'aAAAaFFFFFaAAAa', '.aAAaaFFFaaAAa.', '..aaaaaaaaaaa..', '....mm...mm....'], P),
    sprite(['...............', '...............', 'wwaAAAAAAAAAaww', '.aAAaFFwFFaAAa.', 'aAAAaFFFFFaAAAa', '.aAAaaFFFaaAAa.', '.waaaaaaaaaaaw.', 'ww..mm...mm..ww'], P),
  ].map((c) => outline(c))
  const LETTERS = {
    S: ['.FFF.', 'F....', '.FFF.', '....F', '.FFF.'],
    M: ['F...F', 'FF.FF', 'F.F.F', 'F...F', 'F...F'],
    L: ['.F...', '.F...', '.F...', '.F...', '.FFFF'],
    F: ['.FFFF', '.F...', '.FFF.', '.F...', '.F...'],
  }
  const PICKUP = {}
  for (const k in LETTERS) {
    const g = grid(17, 9)
    // falcon wings either side of a white badge
    stamp(g, 0, 0, ['FF...............', 'FFF.............F', '.FFf...........FF', '..FFf.........FF.', '...Ff........fF..', '....f.........f..'].map((r) => r.padEnd(17, '.')))
    stamp(g, 0, 0, ['...............FF'])
    stamp(g, 4, 0, ['.wwwwwww.', 'wwwwwwwww', 'wwwwwwwww', 'wwwwwwwww', 'wwwwwwwww', 'wwwwwwwww', '.wwwwwww.', '...fFf...', '....f....'])
    stamp(g, 6, 1, LETTERS[k])
    PICKUP[k] = outline(sprite(rowsOf(g), P))
  }

  // ---- explosions (NES-style fire puffs, built once) ------------------------------------
  const hash = (x, y, k) => {
    const h = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453
    return h - Math.floor(h)
  }
  function puff(r, k, stage) {
    const n = r * 2 + 3
    const g = grid(n, n)
    const c = (n - 1) / 2
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x - c, y - c) + (hash(x, y, k) - 0.5) * 2.2
        if (d > r) continue
        const u = d / r
        let ch
        if (stage === 0) ch = u < 0.5 ? 'w' : u < 0.8 ? 'y' : 'O'
        else if (stage === 1) ch = u < 0.35 ? 'y' : u < 0.7 ? 'O' : 'F'
        else if (stage === 2) ch = u < 0.45 ? (hash(x, y, k + 1) < 0.5 ? '.' : 'F') : u < 0.8 ? 'O' : 'f'
        else ch = u < 0.6 ? '.' : hash(x, y, k + 2) < 0.55 ? 'f' : '.'
        put(g, x, y, ch)
      }
    return sprite(rowsOf(g), P)
  }
  const BOOM = {
    small: [puff(3, 1, 0), puff(5, 2, 1), puff(6, 3, 2), puff(7, 4, 3)],
    big: [puff(5, 5, 0), puff(8, 6, 1), puff(10, 7, 2), puff(11, 8, 3)],
  }

  // ---- the Defense Wall (stage 1 boss), facing left ---------------------------------------
  const WALL_W = 30
  const WALL_H = 32
  function wallArt(core, lamps, broken) {
    const g = grid(WALL_W, WALL_H)
    // steel body
    for (let y = 4; y < WALL_H; y++) for (let x = 8; x < WALL_W; x++) put(g, x, y, (x + y * 3) % 11 === 0 ? 'm' : 'M')
    for (let x = 8; x < WALL_W; x++) {
      put(g, x, 4, 'a')
      put(g, x, 13, 'm')
      put(g, x, 20, 'm')
    }
    for (let y = 4; y < WALL_H; y++) {
      put(g, 8, y, 'a')
      put(g, 18, y, 'm')
      put(g, WALL_W - 1, y, 'm')
    }
    for (const [x, y] of [[10, 6], [16, 6], [21, 6], [27, 6], [10, 15], [27, 15], [21, 15]]) put(g, x, y, 'A')
    // roof with the two siren lamps
    for (let x = 7; x < WALL_W; x++) put(g, x, 3, 'm')
    const L = lamps ? ['.XZX.', 'ZZZZZ', 'zZZZz'] : ['.zzz.', 'zzzzz', 'mmmmm']
    stamp(g, 10, 0, L)
    stamp(g, 22, 0, L)
    // two cannons sticking out to the left
    for (const cy of [8, 16]) {
      stamp(g, 4, cy - 2, ['.mmmmm', 'mMMMMMm', 'mMAMMMm', '.mmmmm'])
      line(g, 0, cy, 5, cy, 'a')
      line(g, 0, cy - 1, 5, cy - 1, 'A')
      put(g, 0, cy, 'm')
    }
    // the core: a big red sensor in an armoured frame
    stamp(g, 9, 18, ['..mmmmmmm..', '.mmaaaaamm.', 'mmazzzzzamm', 'mazZZZZZzam', 'mazZXXZZzam', 'mazZXZZZzam', 'mazZZZZZzam', 'mmazzzzzamm', '.mmaaaaamm.', '..mmmmmmm..'])
    if (core === 1) stamp(g, 12, 20, ['ZZZZZ', 'ZXXXZ', 'ZXwXZ', 'ZXXXZ', 'ZZZZZ'])
    if (core === 2) stamp(g, 12, 20, ['wwwww', 'wwwww', 'wwwww', 'wwwww', 'wwwww'])
    if (broken) {
      stamp(g, 11, 19, ['.mmmmmmm.', 'mmEEEEEmm', 'mEEzEEEEm', 'mEEEEzEEm', 'mEzEEEEEm', 'mEEEEEzEm', 'mmEEEEEmm', '.mmmmmmm.'])
      for (let i = 0; i < 26; i++) put(g, 8 + Math.floor(hash(i, 4, 9) * 22), 4 + Math.floor(hash(i, 5, 9) * 28), hash(i, 6, 9) < 0.5 ? 'E' : 'z')
    }
    if (broken) for (let i = 0; i < 40; i++) put(g, 8 + Math.floor(hash(i, 1, 9) * 22), 4 + Math.floor(hash(i, 2, 9) * 28), hash(i, 3, 9) < 0.5 ? 'm' : '.')
    return rowsOf(g)
  }
  const WALL = {}
  for (const [k, core, lamps, broken] of [['dim', 0, 0, 0], ['lit', 0, 1, 0], ['pulse', 1, 1, 0], ['pulseDim', 1, 0, 0], ['hit', 2, 1, 0], ['wreck', 0, 0, 1]]) WALL[k] = pairOutlined(wallArt(core, lamps, broken), P)

  // ---- bullets -----------------------------------------------------------------------------
  const SHOT = {
    n: sprite(['ww', 'ww'], P),
    M: sprite(['.y.', 'ywy', '.y.'], P),
    S: sprite(['.FF.', 'FwwF', 'FwwF', '.FF.'], P),
    F: [sprite(['.OO.', 'OyyO', 'OyyO', '.OO.'], P), sprite(['.FF.', 'FOOF', 'FOOF', '.FF.'], P)],
    en: sprite(['.F.', 'FwF', '.F.'], { ...P, F: '#ff7a8a' }),
    flash: [sprite(['.y.', 'ywy', '.y.'], P), sprite(['y.y', '.w.', 'y.y'], P)],
  }
  const MEDAL = { 0: sprite(['.BB.', 'bBBb', '.yy.', 'yyyy', '.yy.'], P), 1: sprite(['.RR.', 'rRRr', '.yy.', 'yyyy', '.yy.'], P) }

  // ---- helpers -----------------------------------------------------------------------------
  const dir8 = (dx, dy) => (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8
  const poseOf = (k) => (k === 6 ? 'up' : k === 0 || k === 4 ? 'fwd' : k === 5 || k === 7 ? 'updiag' : 'down')
  const KX = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2]
  const KY = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2]
  /** Draw an outlined pair so that grid column `ax` sits on cx and the last row on feet line fy. */
  function drawAt(c, sp, dir, cx, fy, ax) {
    const w = sp.w - 2
    const x = dir === 1 ? cx - ax - 1 : cx - (w - 1 - ax) - 1
    c.drawImage(sp[dir], Math.round(x), Math.round(fy - sp.h + 1))
  }
  const drawMid = (c, img, cx, cy) => c.drawImage(img, Math.round(cx - img.width / 2), Math.round(cy - img.height / 2))
  // nearest x whose span [x-hw, x+hw] stays clear of the furniture (and `avoid` spans)
  function openSpot(s, x, hw, avoid = []) {
    const blocks = s.fix.map((f) => [f.x - 3, f.x + f.w + 3]).concat(avoid)
    const ok = (c) => c - hw >= 3 && c + hw <= s.W - 3 && blocks.every(([a, b]) => c + hw <= a || c - hw >= b)
    for (let d = 0; d < s.W; d += 2) {
      if (ok(x - d)) return x - d
      if (ok(x + d)) return x + d
    }
    return clamp(x, hw + 3, s.W - hw - 3)
  }
  const GUNS = {
    n: { cool: 0.34, speed: 210, dmg: 1 },
    M: { cool: 0.13, speed: 230, dmg: 1 },
    S: { cool: 0.5, speed: 190, dmg: 1, spread: 5 },
    L: { cool: 0.62, speed: 330, dmg: 3, pierce: true },
    F: { cool: 0.45, speed: 150, dmg: 2 },
  }
  const LETTER_COLOR = { S: '#ff5a4a', M: '#ffe36a', L: '#9fd8ff', F: '#ff9a2c' }
  const lively = (s, now) => s.lively(now)

  // ---- bullets ------------------------------------------------------------------------------
  class Bullet {
    constructor(x, y, vx, vy, kind) {
      Object.assign(this, { x, y, vx, vy, kind })
      this.t = 0
      this.z = 7
      this.hits = null
      this.dodge = null
      this.g = kind === 'lob' ? 240 : 0
    }
    get friendly() {
      return this.kind !== 'en' && this.kind !== 'lob'
    }
    update(dt, now, s) {
      this.t += dt
      this.vy += this.g * dt
      // sub-step so a fast shot can't skip over a body between frames
      const n = Math.max(1, Math.ceil((Math.hypot(this.vx, this.vy) * dt) / 3))
      for (let i = 0; i < n && !this.dead; i++) {
        this.x += (this.vx * dt) / n
        this.y += (this.vy * dt) / n
        this.collide(s, now)
      }
      if (this.kind === 'lob' && this.y >= FLOOR - 2 && !this.dead) {
        this.dead = true
        s.spawn(new Boom(this.x, FLOOR - 6, false))
        for (const c of s.data.team) if (c.vulnerable(now) && Math.abs(c.cx - this.x) < 5) c.die(Math.sign(c.cx - this.x) || 1, now)
      }
      if (this.x < -12 || this.x > s.W + 12 || this.y < -12 || this.y > FLOOR + 2) this.dead = true
      return this.dead ? Infinity : FAST
    }
    collide(s, now) {
      if (!this.friendly) {
        for (const c of s.data.team) {
          if (c.vulnerable(now) && c.contains(this.x, this.y)) {
            this.dead = true
            c.die(Math.sign(this.vx) || 1, now)
            return
          }
        }
        return
      }
      for (const a of s.actors) {
        if (a.dead || !a.shootable || !a.shootable(this.x, this.y)) continue
        if (GUNS[this.kind]?.pierce) {
          this.hits = this.hits || []
          if (this.hits.includes(a)) continue
          this.hits.push(a)
          a.shot(this, now)
          continue
        }
        this.dead = true
        a.shot(this, now)
        return
      }
    }
    draw(c) {
      const x = Math.round(this.x)
      const y = Math.round(this.y)
      if (this.kind === 'L') {
        // the laser: a long white-blue beam
        const sp = Math.hypot(this.vx, this.vy)
        const ux = this.vx / sp
        const uy = this.vy / sp
        for (let i = 0; i < 12; i++) {
          c.drawImage(pix(i < 3 ? 'w' : i < 8 ? 'c' : 'b'), Math.round(this.x - ux * i), Math.round(this.y - uy * i))
          c.drawImage(pix(i < 8 ? 'c' : 'b'), Math.round(this.x - ux * i - uy), Math.round(this.y - uy * i + ux))
        }
        return
      }
      if (this.kind === 'F') {
        // fire: a corkscrewing fireball
        const sp = Math.hypot(this.vx, this.vy) || 1
        const w = Math.sin(this.t * 22) * 3
        drawMid(c, SHOT.F[Math.floor(this.t * 12) & 1], this.x - (this.vy / sp) * w, this.y + (this.vx / sp) * w)
        return
      }
      const img = this.kind === 'lob' ? SHOT.en : SHOT[this.kind] || SHOT.n
      drawMid(c, img, x, y)
    }
  }

  // ---- explosions ---------------------------------------------------------------------------------
  class Boom {
    constructor(x, y, big, delay = 0) {
      Object.assign(this, { x, y, big })
      this.t0 = performance.now() + delay
      this.z = 8
      this.k = -1
    }
    update(dt, now) {
      if (now < this.t0) return this.t0 - now
      this.k = Math.floor((now - this.t0) / (this.big ? 110 : 85))
      if (this.k >= 4) this.dead = true
      return FAST
    }
    draw(c) {
      if (this.k < 0 || this.k > 3) return
      drawMid(c, (this.big ? BOOM.big : BOOM.small)[this.k], this.x, this.y)
    }
  }

  // ---- running soldier --------------------------------------------------------------------------------
  class Soldier {
    constructor(s, side, lag = 0) {
      this.s = s
      this.dir = -side
      this.cx = side === 1 ? s.W + 12 + lag : -12 - lag
      this.y = FLOOR
      this.speed = rand(40, 50)
      this.state = 'run'
      this.dist = 0
      this.t = 0
      this.fired = Math.random() < 0.35
      this.flinchUntil = 0
      this.z = 3
      this.enemy = true
    }
    get x() {
      return this.cx - 3
    }
    get moving() {
      return this.state !== 'die'
    }
    get alive() {
      return this.state !== 'die'
    }
    shootable(x, y) {
      return this.alive && Math.abs(x - this.cx) <= 5 && y >= FLOOR - 22 && y <= FLOOR
    }
    hit(x, y) {
      return this.alive && Math.abs(x - this.cx) <= 6 && y >= FLOOR - 23 && y <= FLOOR
    }
    aimPoint() {
      return { x: this.cx, y: FLOOR - 14 }
    }
    onClick() {
      for (const c of this.s.data.team) c.burstAt(this)
    }
    shot(b, now) {
      this.die(b ? Math.sign(b.vx) || -this.dir : -this.dir, now)
    }
    die(push, now) {
      if (!this.alive) return
      const s = this.s
      this.state = 'die'
      this.t = 0
      this.vy = -95
      this.vx = push * 34
      s.data.kills++
      // the ones running behind him flinch
      for (const a of s.actors) if (a instanceof Soldier && a !== this && a.alive && Math.abs(a.cx - this.cx) < 56) a.flinchUntil = now + rand(500, 800)
    }
    update(dt, now, s) {
      if (this.state === 'die') {
        this.t += dt
        this.vy += 300 * dt
        this.cx += this.vx * dt
        this.y = Math.min(FLOOR, this.y + this.vy * dt)
        if (this.t > 0.6) {
          this.dead = true
          s.spawn(new Boom(this.cx, FLOOR - 10, false))
        }
        return FAST
      }
      if (now < this.flinchUntil) return Math.min(FAST * 2, this.flinchUntil - now)
      const awake = lively(s, now)
      if (this.state === 'aim') {
        this.t += dt
        if (this.t > 0.45 && !this.fired) {
          this.fired = true
          const [mx, my] = MUZZLE.fwd
          s.spawn(new Bullet(this.cx + mx * this.dir, FLOOR + my, this.dir * 95, 0, 'en'))
        }
        if (this.t > 0.95 || !awake) this.state = 'run'
        return FAST
      }
      this.cx += this.dir * this.speed * dt
      this.dist += this.speed * dt
      if (!this.fired && awake) {
        for (const c of s.data.team) {
          const d = (c.cx - this.cx) * this.dir
          if (c.onField && d > 60 && d < 170 && Math.random() < 0.03) {
            this.state = 'aim'
            this.t = 0
          }
        }
      }
      // running into a commando is deadly in Contra
      for (const c of s.data.team) if (c.vulnerable(now) && c.grounded && Math.abs(c.cx - this.cx) < 5) c.die(this.dir, now)
      if (this.cx < -16 || this.cx > s.W + 16) this.dead = true
      return FAST
    }
    draw(c) {
      const now = performance.now()
      let sp
      if (this.state === 'die') sp = this.t < 0.12 || (this.t > 0.3 && Math.floor(this.t * 14) & 1) ? SOLDIER.flash : SOLDIER.die
      else if (now < this.flinchUntil) sp = SOLDIER.flinch
      else if (this.state === 'aim') sp = SOLDIER.aim
      else sp = SOLDIER.run[Math.floor(this.dist / 4) % 6]
      drawAt(c, sp, this.dir, this.cx, this.y, BC)
    }
  }

  // ---- sandbags and the sniper behind them ------------------------------------------------------------
  class Bunker {
    constructor(s) {
      this.s = s
      this.prop = true
      this.z = 2
      this.place(s)
    }
    place(s) {
      const team = s.data.team || []
      const mid = team.length ? (team[0].cx + team[1].cx) / 2 : s.W * 0.3
      const pref = mid < s.W / 2 ? s.W * 0.78 : s.W * 0.22
      this.cx = openSpot(s, Math.round(pref), 12)
    }
    update() {
      return Infinity
    }
    draw(c) {
      c.drawImage(BUNKER, Math.round(this.cx - BUNKER.width / 2), FLOOR - BUNKER.height + 1)
    }
  }

  class Sniper {
    constructor(s, bunker) {
      this.s = s
      this.bunker = bunker
      this.rise = 0
      this.state = 'hide'
      this.next = performance.now() + rand(1200, 2500)
      this.z = 1
      this.dir = -1
      this.pose = 'fwd'
      this.shots = 0
      this.enemy = true
    }
    get cx() {
      return this.bunker.cx + 1
    }
    get x() {
      return this.cx - 3
    }
    get y() {
      return FLOOR - 10
    }
    get asleep() {
      return this.state === 'hide'
    }
    get moving() {
      return this.state === 'rise' || this.state === 'lower'
    }
    get alive() {
      return this.state !== 'die'
    }
    get exposed() {
      return this.alive && this.rise > 0.6
    }
    shootable(x, y) {
      return this.exposed && Math.abs(x - this.cx) <= 5 && y >= FLOOR - 23 && y <= FLOOR - 9
    }
    hit(x, y) {
      return this.exposed && Math.abs(x - this.cx) <= 6 && y >= FLOOR - 24 && y <= FLOOR - 8
    }
    aimPoint() {
      return { x: this.cx, y: FLOOR - 16 }
    }
    onClick() {
      for (const c of this.s.data.team) c.burstAt(this)
    }
    shot(b, now) {
      if (!this.alive) return
      this.state = 'die'
      this.t = 0
      this.vy = -80
      this.yo = 0
      this.s.data.kills++
      this.s.data.sniperAt = now + rand(9000, 16000)
    }
    target(s) {
      let best = null
      for (const c of s.data.team) if (c.onField && (!best || Math.abs(c.cx - this.cx) < Math.abs(best.cx - this.cx))) best = c
      return best
    }
    update(dt, now, s) {
      if (this.state === 'die') {
        this.t += dt
        this.vy += 300 * dt
        this.yo += this.vy * dt
        if (this.t > 0.7) {
          this.dead = true
          s.data.sniper = null
          s.spawn(new Boom(this.cx, FLOOR - 14, false))
        }
        return FAST
      }
      const awake = lively(s, now)
      if (this.state === 'hide') {
        if (!awake) return Infinity
        if (now < this.next) return this.next - now
        const t = this.target(s)
        if (!t) {
          this.next = now + 1500
          return 1500
        }
        this.dir = t.cx < this.cx ? -1 : 1
        this.state = 'rise'
      }
      if (this.state === 'rise') {
        this.rise = Math.min(1, this.rise + dt * 3.5)
        if (this.rise >= 1) {
          this.state = 'up'
          this.duck = null
          this.t = 0
          this.shots = Math.random() < 0.4 ? 2 : 1
        }
        return FAST
      }
      if (this.state === 'up') {
        this.t += dt
        const t = this.target(s)
        if (t) {
          const dx = t.cx - this.cx
          const dy = t.y - (t.prone ? 4 : 14) - (FLOOR - 16)
          this.dir = dx < 0 ? -1 : 1
          this.pose = dy < -Math.abs(dx) * 0.45 ? 'updiag' : 'fwd'
          if (this.t > 0.55 && this.shots > 0 && awake) {
            this.shots--
            this.t = 0.2
            const [mx, my] = MUZZLE[this.pose]
            const x0 = this.cx + mx * this.dir
            const y0 = FLOOR + my
            // he fires along a fixed line at chest height: going prone beats him
            const a = Math.atan2(t.y - 14 - y0, t.cx - x0)
            s.spawn(new Bullet(x0, y0, Math.cos(a) * 90, Math.sin(a) * 90, 'en'))
          }
        }
        if ((this.shots <= 0 && this.t > 0.5) || !awake || !t) this.state = 'lower'
        return FAST
      }
      if (this.state === 'lower') {
        this.rise = Math.max(0, this.rise - dt * 3)
        if (this.rise <= 0) {
          this.state = 'hide'
          this.next = now + rand(2200, 4200)
          return awake ? this.next - now : Infinity
        }
        return FAST
      }
      return Infinity
    }
    draw(c) {
      const sp = this.state === 'die' ? SNIPER.die : SNIPER[this.pose]
      const off = this.state === 'die' ? this.yo : Math.round((1 - this.rise) * 13)
      if (this.state === 'hide' || off > 15) {
        // just the helmet over the sandbags
        drawAt(c, sp, this.dir, this.cx, FLOOR + 13, BC)
        return
      }
      drawAt(c, sp, this.dir, this.cx, FLOOR + off, BC)
    }
  }

  // ---- falcon capsule and pickups ----------------------------------------------------------------------
  class Capsule {
    constructor(s) {
      this.s = s
      this.dir = Math.random() < 0.6 ? 1 : -1
      this.cx = this.dir === 1 ? -10 : s.W + 10
      this.ph = rand(0, 6)
      this.y = 6
      this.z = 6
      this.moving = true
      this.enemy = true
      this.capsule = true
    }
    get x() {
      return this.cx - 3
    }
    get alive() {
      return !this.dead
    }
    shootable(x, y) {
      return Math.abs(x - this.cx) <= 8 && Math.abs(y - this.y) <= 5
    }
    hit(x, y) {
      return Math.abs(x - this.cx) <= 9 && Math.abs(y - this.y) <= 6
    }
    aimPoint() {
      return { x: this.cx, y: this.y }
    }
    onClick() {
      for (const c of this.s.data.team) c.burstAt(this)
    }
    shot() {
      if (this.dead) return
      this.dead = true
      const s = this.s
      s.spawn(new Boom(this.cx, this.y, false))
      const pool = ['S', 'S', 'M', 'L', 'F']
      s.spawn(new Pickup(s, this.cx, this.y, pick(pool)))
    }
    update(dt, now, s) {
      this.ph += dt * 2.6
      this.cx += this.dir * 30 * dt
      this.y = 7 + Math.sin(this.ph) * 4
      if (this.cx < -14 || this.cx > s.W + 14) this.dead = true
      return FAST
    }
    draw(c) {
      drawMid(c, CAPSULE[Math.floor(this.ph * 2) & 1], this.cx, this.y)
    }
  }

  class Pickup {
    constructor(s, x, y, letter) {
      this.s = s
      this.cx = clamp(x, 10, s.W - 10)
      this.y = y
      this.vx = rand(-18, 18)
      this.vy = -70
      this.letter = letter
      this.bounce = 1
      this.landed = false
      this.z = 1
      // at most two lying around: the oldest one goes
      const old = s.actors.filter((a) => a instanceof Pickup && !a.dead)
      if (old.length >= 2) old[0].dead = true
    }
    get prop() {
      return this.landed
    }
    hit(x, y) {
      return Math.abs(x - this.cx) <= 9 && y >= this.y - 6 && y <= this.y + 6
    }
    onClick() {
      const t = this.s.data.team.filter((c) => c.onField)
      if (t.length) t.sort((a, b) => Math.abs(a.cx - this.cx) - Math.abs(b.cx - this.cx))[0].wantItem = this
    }
    update(dt, now, s) {
      if (this.landed) return Infinity
      this.vy += 260 * dt
      this.cx = clamp(this.cx + this.vx * dt, 10, s.W - 10)
      this.y += this.vy * dt
      if (this.y >= FLOOR - 5) {
        this.y = FLOOR - 5
        if (this.bounce-- > 0) {
          this.vy = -55
          this.vx *= 0.6
        } else {
          this.landed = true
          this.cx = openSpot(s, this.cx, 9)
          return Infinity
        }
      }
      return FAST
    }
    draw(c) {
      drawMid(c, PICKUP[this.letter], this.cx, this.y)
    }
  }

  // ---- the Defense Wall ------------------------------------------------------------------------------------
  class Wall {
    constructor(s, cx, face) {
      this.s = s
      this.cx = cx
      this.face = face // -1: cannons point left
      this.state = 'rise'
      this.since = performance.now()
      this.off = WALL_H
      this.hp = 32
      this.hitUntil = 0
      this.nextShot = this.since + 3500
      this.nextLob = this.since + 4800
      this.z = 0
      this.enemy = true
      this.boss = true
    }
    get x() {
      return this.cx - 3
    }
    get moving() {
      return this.state === 'rise' || this.state === 'sink'
    }
    get alive() {
      return this.state === 'fight'
    }
    col(gx) {
      // grid column -> screen x
      const x0 = this.cx - WALL_W / 2
      return this.face === -1 ? x0 + gx : x0 + (WALL_W - 1 - gx)
    }
    row(gy) {
      return FLOOR - WALL_H + gy + this.off
    }
    coreBox() {
      const a = this.col(10)
      const b = this.col(18)
      return [Math.min(a, b), this.row(19), Math.max(a, b), this.row(27)]
    }
    shootable(x, y) {
      if (this.state !== 'fight') return false
      const [x0, y0, x1, y1] = this.coreBox()
      return x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1
    }
    hit(x, y) {
      return this.state === 'fight' && Math.abs(x - this.cx) <= WALL_W / 2 && y >= this.row(4) && y <= FLOOR
    }
    aimPoint() {
      const [x0, y0, x1, y1] = this.coreBox()
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
    }
    onClick() {
      for (const c of this.s.data.team) c.burstAt(this)
    }
    shot(b, now) {
      if (this.state !== 'fight') return
      this.hp -= GUNS[b.kind]?.dmg ?? 1
      this.hitUntil = now + 90
      if (this.hp <= 0) this.destroy(now)
    }
    destroy(now) {
      if (this.state === 'dying' || this.state === 'sink') return
      this.state = 'dying'
      this.since = now
      const s = this.s
      s.data.kills += 5
      // a chain of blasts climbing the wall
      for (let i = 0; i < 12; i++) {
        s.spawn(new Boom(this.cx + rand(-12, 12), FLOOR - rand(4, WALL_H - 4), i % 3 === 0, i * 170))
      }
      s.spawn(new Boom(this.cx, this.row(26), true, 0))
    }
    sink(now) {
      if (this.state === 'sink') return
      this.state = 'sink'
      this.since = now
    }
    update(dt, now, s) {
      if (this.state === 'rise') {
        this.off = Math.max(0, WALL_H * (1 - (now - this.since) / 2600))
        if (this.off <= 0) {
          this.state = 'fight'
          this.since = now
        }
        return FAST
      }
      if (this.state === 'fight') {
        if (now > this.nextShot && lively(s, now)) {
          // lower cannon: a straight shot at chest height
          this.nextShot = now + rand(1500, 2400)
          s.spawn(new Bullet(this.col(0), this.row(16), this.face * 85, 0, 'en'))
        }
        if (now > this.nextLob && lively(s, now)) {
          // upper cannon: lobs a shell at the nearest commando
          this.nextLob = now + rand(3200, 4800)
          const t = s.data.team.filter((c) => c.onField).sort((a, b) => Math.abs(a.cx - this.cx) - Math.abs(b.cx - this.cx))[0]
          if (t) {
            const x0 = this.col(0)
            const y0 = this.row(8)
            const T = 1.15
            const tx = t.cx + rand(-6, 6)
            s.spawn(new Bullet(x0, y0, (tx - x0) / T, (FLOOR - 2 - y0 - 0.5 * 240 * T * T) / T, 'lob'))
          }
        }
        return Math.max(FAST, Math.min(250, this.hitUntil - now > 0 ? FAST : 250))
      }
      if (this.state === 'dying') {
        if (now - this.since > 2300) this.sink(now)
        return FAST
      }
      if (this.state === 'sink') {
        this.off = Math.min(WALL_H + 2, (WALL_H * (now - this.since)) / 1300)
        if (this.off >= WALL_H + 2) {
          this.dead = true
          if (s.data.boss === this) s.data.boss = null
        }
        return FAST
      }
      return Infinity
    }
    draw(c, s) {
      const now = performance.now()
      const flash = Math.floor(now / 220) & 1
      let k
      if (this.state === 'dying' || this.state === 'sink') k = 'wreck'
      else if (now < this.hitUntil) k = 'hit'
      else if (this.state === 'rise') k = flash ? 'lit' : 'dim'
      else k = Math.floor(now / 400) & 1 ? (flash ? 'pulse' : 'pulseDim') : flash ? 'lit' : 'dim'
      const sp = WALL[k]
      const shake = this.state === 'dying' ? (Math.floor(now / 60) & 1 ? 1 : -1) : 0
      const x0 = Math.round(this.cx - WALL_W / 2) - 1 + shake
      c.drawImage(sp[this.face === -1 ? 1 : -1], x0, Math.round(FLOOR - WALL_H - 1 + this.off))
    }
  }

  // ---- Bill and Lance --------------------------------------------------------------------------------------
  class Commando {
    constructor(s, idx) {
      this.s = s
      this.idx = idx
      this.sk = SKINS[idx]
      this.cx = Math.round(openSpot(s, s.W * (idx ? 0.42 : 0.2), 8))
      this.y = FLOOR
      this.vx = 0
      this.vy = 0
      this.dir = 1
      this.aim = 0
      this.state = 'stand'
      this.dist = 0
      this.spin = 0
      this.cool = 0
      this.inv = 0
      this.weapon = 'n'
      this.weaponUntil = 0
      this.post = null
      this.postAt = performance.now() + rand(1500, 4000)
      this.aimAt = 0
      this.turnAt = 0
      this.queue = null
      this.flashUntil = 0
      this.coverUntil = 0
      this.proneUntil = 0
      this.wantItem = null
      this.idleLook = 0
      this.safeUntil = 0
      this.z = 5 - idx
    }
    get partner() {
      return this.s.data.team[1 - this.idx]
    }
    get x() {
      return this.cx - 3
    }
    get moving() {
      return ['run', 'jump', 'die', 'drop'].includes(this.state)
    }
    get asleep() {
      return this.state === 'rest'
    }
    get grounded() {
      return !['jump', 'die', 'drop', 'gone'].includes(this.state)
    }
    get prone() {
      return this.state === 'prone' || this.state === 'rest'
    }
    get onField() {
      return !['die', 'down', 'gone', 'drop'].includes(this.state)
    }
    vulnerable(now) {
      return this.onField && now > this.inv && now > this.safeUntil && this.state !== 'rest'
    }
    contains(x, y) {
      if (this.prone) return Math.abs(x - this.cx) <= 16 && y >= this.y - 6 && y <= this.y
      if (this.state === 'jump') return Math.abs(x - this.cx) <= 5 && Math.abs(y - (this.y - 9)) <= 6
      return Math.abs(x - this.cx) <= 4 && y >= this.y - 21 && y <= this.y
    }
    hit(x, y) {
      if (!this.onField) return false
      if (this.prone) return Math.abs(x - this.cx) <= 17 && y >= this.y - 8 && y <= this.y + 1
      return Math.abs(x - this.cx) <= 6 && y >= this.y - 23 && y <= this.y + 1
    }
    onClick() {
      const now = performance.now()
      if (!this.onField) return
      if (this.state === 'rest' || this.state === 'prone' || this.state === 'win') this.state = 'stand'
      if (this.grounded) this.jump(this.dir * 40)
      this.partner.glance(this.cx, now)
    }
    onDblClick() {
      // hit the dirt and keep firing
      if (!this.onField || !this.grounded) return
      this.state = 'prone'
      this.proneUntil = performance.now() + 2500
    }
    glance(x, now) {
      if (this.grounded && this.state !== 'rest' && this.state !== 'meet') this.face(x > this.cx ? 1 : -1, now, 800, true)
    }
    muzzle() {
      if (this.prone) return { x: this.cx + 19 * this.dir, y: this.y - 3 }
      if (this.state === 'jump') return { x: this.cx, y: this.y - 9 }
      const [mx, my] = MUZZLE[poseOf(this.aim)]
      return { x: this.cx + mx * this.dir, y: this.y + my }
    }
    jump(vx) {
      this.state = 'jump'
      this.vy = -140
      this.vx = vx
      this.y -= 1
    }
    face(want, now, hold = 500, force = false) {
      if (want !== this.dir && (force || now > this.turnAt)) {
        this.dir = want
        this.turnAt = now + hold
        this.aim = want === 1 ? 0 : 4
      }
    }
    setAim(dx, dy, now, force = false) {
      const want = dx > 3 ? 1 : dx < -3 ? -1 : this.dir
      this.face(want, now, 550, force)
      let k = dir8(dx, dy)
      if (this.state !== 'jump') {
        // never aim behind; on the ground there's no straight down
        if (this.dir === 1 && k >= 3 && k <= 5) k = k === 5 ? 6 : k === 3 ? 1 : 0
        if (this.dir === -1 && (k === 7 || k <= 1)) k = k === 7 ? 6 : k === 1 ? 3 : 4
        if (k === 2) k = this.dir === 1 ? 1 : 3
      }
      if (k !== this.aim && (force || now > this.aimAt)) {
        this.aim = k
        this.aimAt = now + 220
      }
    }
    fire(now, angle) {
      const s = this.s
      const g = GUNS[this.weapon]
      const o = this.muzzle()
      let a = angle ?? (this.prone ? (this.dir === 1 ? 0 : Math.PI) : Math.atan2(KY[this.aim], KX[this.aim]))
      const n = g.spread || 1
      for (let i = 0; i < n; i++) {
        const aa = a + (i - (n - 1) / 2) * 0.16
        s.spawn(new Bullet(o.x, o.y, Math.cos(aa) * g.speed, Math.sin(aa) * g.speed, this.weapon))
      }
      this.cool = g.cool
      this.flashUntil = now + 70
    }
    burstAt(target) {
      const now = performance.now()
      if (!this.onField) return
      if (this.state === 'rest' || this.state === 'win' || this.state === 'meet') this.state = 'stand'
      this.queue = { target, n: 3 }
      this.cool = Math.min(this.cool, 0.05 + this.idx * 0.12)
      const p = target.aimPoint()
      const o = this.muzzle()
      this.setAim(p.x - o.x, p.y - o.y, now, true)
    }
    die(push, now) {
      if (!this.vulnerable(now)) return
      const s = this.s
      this.state = 'die'
      this.vx = push * 42
      this.vy = -120
      this.spin = 0
      this.queue = null
      this.weapon = 'n'
      s.data.deaths++
      s.data.lives[this.idx] = s.data.lives[this.idx] > 1 ? s.data.lives[this.idx] - 1 : 3
      // his buddy covers the spot he went down at
      const p = this.partner
      p.coverUntil = now + 6000
      p.coverX = this.cx
      if (p.onField) s.particle({ img: BUBBLE['!'], x: p.cx - 2, y: p.y - 33, vy: -4, life: 0.8 })
    }
    pickTarget(s, now) {
      const p = this.partner
      const covering = now < this.coverUntil || !p.onField
      const bx = p.onField ? p.cx : this.coverX ?? p.cx
      let best = null
      let bs = 1e9
      for (const a of s.actors) {
        if (!a.enemy || a.capsule || !a.alive || (a instanceof Sniper && !a.exposed) || (a instanceof Soldier && (a.cx < 0 || a.cx > s.W))) continue
        const me = Math.abs(a.cx - this.cx)
        if (me > (a.boss ? 420 : 230)) continue
        const bud = Math.abs(a.cx - bx)
        // the partner first: whatever is closing in on his buddy
        let score = Math.min(me, bud * 0.6)
        if (covering && bud < 70) score -= 80
        if (a.boss) score += 40
        if (score < bs) {
          bs = score
          best = a
        }
      }
      return best
    }
    threat(s, now) {
      for (const a of s.actors) {
        if (!(a instanceof Bullet) || a.friendly || a.dead) continue
        if (a.kind === 'lob') {
          if (a.vy > -30) {
            const tLand = Math.max(0, (FLOOR - a.y) / Math.max(30, a.vy))
            const lx = a.x + a.vx * tLand
            if (Math.abs(lx - this.cx) < 10 && tLand < 0.9) return { b: a, lob: true, lx }
          }
          continue
        }
        const dx = this.cx - a.x
        if (Math.sign(dx) === Math.sign(a.vx) && Math.abs(dx) < 66 && a.y < this.y - 8 && a.y > this.y - 24) return { b: a }
      }
      // the sniper is up and drawing a bead: some days you just hit the dirt
      const sn = s.data.sniper
      if (sn && sn.state === 'up' && sn.t > 0.3 && Math.abs(sn.cx - this.cx) < 150 && Math.sign(this.cx - sn.cx) === sn.dir) {
        sn.duck = sn.duck || [Math.random() < 0.55, Math.random() < 0.55]
        if (sn.duck[this.idx]) return { b: { dodge: [0, 0], x: sn.cx, vx: sn.dir * 90 } }
      }
      return null
    }
    update(dt, now, s) {
      this.cool -= dt
      if (this.weapon !== 'n' && now > this.weaponUntil) this.weapon = 'n'
      switch (this.state) {
        case 'die':
          return this.tumble(dt, now, s)
        case 'down':
          if (now > this.t) {
            this.state = 'gone'
            this.t = now + 700
          }
          return FAST
        case 'gone':
          if (now < this.t) return this.t - now
          this.respawn(s, now)
          return FAST
        case 'drop':
          this.vy += 320 * dt
          this.y += this.vy * dt
          if (this.y >= FLOOR) {
            this.y = FLOOR
            this.state = 'stand'
          }
          return FAST
        case 'jump':
          return this.air(dt, now, s)
      }
      const awake = lively(s, now)
      if (this.state === 'rest') {
        if (!awake) return Infinity
        this.state = 'stand'
        this.post = null
      }
      if (!awake) return this.settle(dt, now, s)
      if (this.state === 'meet') return this.meet(dt, now, s)
      if (this.state === 'win') {
        if (now < this.t) return Math.min(this.t - now, 400)
        this.state = 'stand'
      }
      const d = s.data
      if (d.finaleUntil > now) {
        // watch the base go up
        this.state = 'stand'
        this.setAim(d.finaleX - this.cx, -6, now)
        return SLOW
      }

      // incoming fire: hit the dirt, or somersault over it
      const th = this.threat(s, now)
      if (th && this.state !== 'prone') {
        const b = th.b
        b.dodge = b.dodge || [Math.random(), Math.random()]
        const r = b.dodge[this.idx]
        if (th.lob) {
          if (r < 0.92) {
            this.dodgeTo = clamp(this.cx + (this.cx >= th.lx ? 1 : -1) * 22, 8, s.W - 8)
            this.dodgeUntil = now + 900
          }
        } else if (r < 0.93) {
          // somersault only when the shot would pass under the top of the jump
          const tArr = Math.abs(this.cx - b.x) / Math.max(1, Math.abs(b.vx))
          if (r < 0.75 || tArr < 0.2 || tArr > 0.38) {
            this.state = 'prone'
            this.proneUntil = now + rand(700, 1100)
          } else {
            this.jump(0)
            return FAST
          }
        }
      }
      if (this.dodgeUntil > now && Math.abs(this.dodgeTo - this.cx) > 1) return this.runTo(this.dodgeTo, dt, now, s, true)

      // a soldier about to run into us: somersault over him
      {
        for (const a of s.actors) {
          if (a instanceof Soldier && a.alive && a.dir === Math.sign(this.cx - a.cx) && Math.abs(a.cx - this.cx) < (this.state === 'prone' ? 22 : 16)) {
            this.jump(-a.dir * 55)
            return FAST
          }
        }
      }

      if (this.queue) {
        const q = this.queue
        if (q.target.dead || !q.target.alive) this.queue = null
        else {
          this.state = this.state === 'prone' ? 'prone' : 'stand'
          const p = q.target.aimPoint()
          const o = this.muzzle()
          if (this.cool <= 0) {
            this.setAim(p.x - o.x, p.y - o.y, now, true)
            this.fire(now, this.prone ? undefined : Math.atan2(p.y - o.y, p.x - o.x))
            this.cool = 0.13
            if (--q.n <= 0) this.queue = null
          }
          return FAST
        }
      }

      const tgt = this.pickTarget(s, now)
      if (this.state === 'prone') {
        if (tgt && this.cool <= 0 && (tgt.cx - this.cx) * this.dir > 0 && tgt instanceof Soldier) this.fire(now)
        if (now > this.proneUntil && !this.threat(s, now)) this.state = 'stand'
        return FAST
      }

      // weapon lying around: the nearer one (or the one sent) goes for it
      const item = this.wantItem && !this.wantItem.dead ? this.wantItem : s.actors.find((a) => a instanceof Pickup && a.landed && !a.dead)
      if (item && (this.wantItem === item || Math.abs(item.cx - this.cx) <= Math.abs(item.cx - this.partner.cx) || !this.partner.onField) && !(tgt && Math.abs(tgt.cx - this.cx) < 70)) {
        if (Math.abs(item.cx - this.cx) < 3 && item.landed) {
          item.dead = true
          this.wantItem = null
          this.weapon = item.letter
          this.weaponUntil = now + 90000
          s.say(item.letter, this.cx, this.y - 34, { life: 1.1, color: LETTER_COLOR[item.letter], vy: -6, size: 8 })
          this.state = 'stand'
          return FAST
        }
        if (item.landed) return this.runTo(item.cx, dt, now, s)
      }

      if (tgt) {
        const p = tgt.aimPoint()
        if (tgt.boss) {
          const range = Math.abs(tgt.cx - this.cx)
          if (range > 260) {
            const face = Math.sign(tgt.cx - this.cx) || 1
            return this.runTo(clamp(tgt.cx - face * (200 + this.idx * 30), 10, s.W - 10), dt, now, s, false)
          }
        }
        const o = this.muzzle()
        this.setAim(p.x - o.x, p.y - o.y, now)
        if (this.cool <= 0 && (p.x - this.cx) * this.dir >= 0) this.fire(now)
        // covering a buddy who's down: move up beside his spot
        if (now < this.coverUntil && this.coverX !== undefined && Math.abs(this.coverX - this.cx) > 30 && !s.busy) return this.runTo(this.coverX - Math.sign(this.coverX - this.cx) * 20, dt, now, s, true)
        if (s.busy && this.post && Math.abs(this.post - this.cx) > 4) return this.runTo(this.post, dt, now, s, true)
        this.state = 'stand'
        return FAST
      }

      // falcon capsule overhead: one of them goes after it
      const cap = s.actors.find((a) => a instanceof Capsule && !a.dead && a.cx > 4 && a.cx < s.W - 4)
      if (cap && (this.idx === 0 || !this.partner.onField || Math.abs(cap.cx - this.cx) < Math.abs(cap.cx - this.partner.cx))) {
        const dx = cap.cx - this.cx
        const rise = this.y - 24 - cap.y
        if (Math.abs(dx) < 7) {
          this.state = 'stand'
          this.aim = 6
          if (this.cool <= 0) this.fire(now)
          return FAST
        }
        if (Math.abs(Math.abs(dx) - rise) < 6 && Math.sign(dx) === Math.sign(cap.dir * -dx) * -1) {
          this.state = 'stand'
          this.face(Math.sign(dx), now, 300, true)
          this.aim = dx > 0 ? 7 : 5
          if (this.cool <= 0) this.fire(now)
          return FAST
        }
        return this.runTo(clamp(cap.cx + cap.dir * 16, 8, s.W - 8), dt, now, s)
      }

      // posts: busy = a defensive line away from the enemy side; idle = patrol
      if (now > this.postAt || this.post === null) this.choosePost(s, now)
      if (Math.abs(this.post - this.cx) > 2) {
        if (!s.busy && Math.abs(this.post - this.cx) > 60 && this.state === 'run' && Math.random() < 0.012) {
          this.jump(Math.sign(this.post - this.cx) * 50)
          return FAST
        }
        return this.runTo(this.post, dt, now, s)
      }
      this.state = 'stand'
      // aim at the cursor while waiting (the cursor updates coarsely: aim holds 220 ms)
      const c = s.cursor
      if (c && c.y < H + 16) {
        const o = this.muzzle()
        this.setAim(c.x - o.x, c.y - o.y, now)
        return SLOW
      }
      if (!s.busy && now > this.idleLook) {
        // look the other way now and then
        this.idleLook = now + rand(3500, 7000)
        if (Math.random() < 0.4) this.face(-this.dir, now, 1200, true)
      }
      return Math.max(SLOW, Math.min(this.postAt, s.busy ? Infinity : this.idleLook) - now)
    }
    choosePost(s, now) {
      const p = this.partner
      const d = s.data
      const enemyRight = d.enemySide === 1
      let x
      for (let i = 0; i < 8; i++) {
        if (s.busy) {
          // the defensive line: 120-380 px back from the wall or the enemy edge
          const front = d.boss ? d.boss.cx : enemyRight ? s.W : 0
          const k = enemyRight ? -1 : 1
          const a = clamp(front + k * 380, 12, s.W - 12)
          const b = clamp(front + k * 120, 12, s.W - 12)
          x = rand(Math.min(a, b), Math.max(a, b) + 1)
        } else x = rand(14, s.W - 14)
        x = openSpot(s, x, 6)
        if (Math.abs(x - (p.post ?? p.cx)) > 34) break
      }
      const other = p.post ?? p.cx
      if (Math.abs(x - other) <= 34) {
        // a narrow bar: take the spot beside him instead of on top of him
        const side = other < s.W / 2 ? 1 : -1
        x = openSpot(s, clamp(other + side * 38, 12, s.W - 12), 6, [[other - 30, other + 30]])
      }
      this.post = Math.round(x)
      this.postAt = now + (s.busy ? rand(7000, 12000) : rand(6000, 11000))
    }
    runTo(x, dt, now, s, gunning = false) {
      const dx = x - this.cx
      if (!gunning) this.face(dx > 0 ? 1 : -1, now, 300)
      if (this.state === 'prone') this.state = 'stand'
      this.state = 'run'
      const st = 46 * dt
      if (Math.abs(dx) <= st) {
        this.cx = x
        this.state = 'stand'
      } else {
        this.cx += Math.sign(dx) * st
        this.dist += st
      }
      if (!gunning && this.aim !== 6) this.aim = this.dir === 1 ? 0 : 4
      return FAST
    }
    air(dt, now, s) {
      this.vy += 480 * dt
      this.cx = clamp(this.cx + this.vx * dt, 8, s.W - 8)
      this.y += this.vy * dt
      this.spin += dt * 14 * (this.vx >= 0 ? 1 : -1) * (this.dir || 1)
      // fire from the ball in any of the 8 directions
      const tgt = lively(s, now) ? this.pickTarget(s, now) : null
      if (tgt && this.cool <= 0) {
        const p = tgt.aimPoint()
        this.setAim(p.x - this.cx, p.y - (this.y - 9), now, true)
        this.fire(now)
      }
      if (this.y >= FLOOR) {
        this.y = FLOOR
        this.state = 'stand'
        this.vx = 0
        if (this.aim === 2) this.aim = this.dir === 1 ? 1 : 3
      }
      return FAST
    }
    tumble(dt, now, s) {
      // the death flip: thrown back, spinning, onto his back
      this.vy += 330 * dt
      this.cx = clamp(this.cx + this.vx * dt, 10, s.W - 10)
      this.y = Math.min(FLOOR, this.y + this.vy * dt)
      this.spin += dt * 10
      if (this.y >= FLOOR && this.vy > 0) {
        this.state = 'down'
        this.t = now + 1700
        this.vx = 0
      }
      return FAST
    }
    respawn(s, now) {
      const p = this.partner
      const boss = s.data.boss
      let x = p.onField ? p.cx - (s.data.enemySide || 1) * 30 : s.W * 0.25
      if (boss) x = Math.min(x, boss.cx - 60 * boss.face * -1)
      this.cx = clamp(openSpot(s, clamp(x, 12, s.W - 12), 6), 10, s.W - 10)
      this.y = -2
      this.vy = 0
      this.state = 'drop'
      this.dir = (s.data.enemySide || 1) === 1 ? 1 : -1
      this.aim = this.dir === 1 ? 0 : 4
      this.inv = now + 2800
      this.medalsUntil = now + 2200
    }
    startMeet() {
      if (!this.onField) {
        this.meetLater = true
        return
      }
      this.state = 'meet'
      this.meetSince = performance.now()
      this.fived = 0
      this.queue = null
    }
    meet(dt, now, s) {
      const p = this.partner
      if (!p.onField) return SLOW
      const mid = openSpot(s, (this.cx + p.cx) / 2, 10)
      const left = this.idx === 0 ? this.cx <= p.cx : this.cx < p.cx
      const spot = left ? mid - 6 : mid + 6
      if (!this.fived) {
        const dx = spot - this.cx
        if (Math.abs(dx) > 1.5 && now - this.meetSince < 4000) {
          this.dir = dx > 0 ? 1 : -1
          this.cx += Math.sign(dx) * Math.min(Math.abs(dx), 52 * dt)
          this.dist += 52 * dt
          return FAST
        }
        if (Math.abs(dx) <= 1.5) this.cx = spot
        this.dir = left ? 1 : -1
        if ((p.state === 'meet' && Math.abs(p.cx - this.cx) <= 15) || now - this.meetSince > 4000) {
          this.fived = now
          if (left) s.particle({ img: STAR, x: mid - 1, y: this.y - 28, vy: -10, life: 0.7, fade: true })
        }
        return FAST
      }
      if (now - this.fived > 700) {
        // step apart for the victory pose
        this.cx = clamp(this.cx + (left ? -4 : 4), 10, s.W - 10)
        this.state = 'win'
        this.dir = this.cx < s.W / 2 ? 1 : -1
        this.t = now + 2800
      }
      return FAST
    }
    settle(dt, now, s) {
      // nothing going on: lie prone side by side in an open stretch
      const d = s.data
      this.queue = null
      if (d.restX === undefined) d.restX = openSpot(s, clamp(d.team[0].cx, 40, s.W - 40), 32)
      const spot = d.restX + (this.idx ? 11 : -11) * (d.restX < s.W / 2 ? 1 : -1)
      if (Math.abs(this.cx - spot) > 1.5) {
        if (this.state === 'prone') this.state = 'stand'
        return this.runTo(spot, dt, now, s)
      }
      this.cx = spot
      this.dir = d.restX < s.W / 2 ? 1 : -1
      this.aim = this.dir === 1 ? 0 : 4
      this.state = 'rest'
      this.post = null
      if (this.idx === 1) s.particle({ img: ZZ, x: this.cx + this.dir * 8, y: this.y - 14, vy: -5, life: 2.2, fade: true })
      return Infinity
    }
    draw(c) {
      if (this.state === 'gone') return
      const now = performance.now()
      if (now < this.inv && Math.floor(now / 70) & 1) return
      const sk = this.sk
      const d = this.dir
      const cx = Math.round(this.cx)
      const fy = Math.round(this.y)
      if (now < (this.medalsUntil || 0)) {
        const n = this.s.data.lives[this.idx]
        for (let i = 0; i < n; i++) c.drawImage(MEDAL[this.idx], cx - n * 3 + i * 6, 1)
      }
      if (this.state === 'jump') {
        const q = ((Math.floor(this.spin) % 4) + 4) % 4
        drawMid(c, sk.ball[q][d], cx, fy - 9)
        if (now < this.flashUntil) drawMid(c, SHOT.flash[0], cx + KX[this.aim] * 9, fy - 9 + KY[this.aim] * 9)
        return
      }
      if (this.state === 'die') {
        const q = ((Math.floor(this.spin) % 4) + 4) % 4
        drawMid(c, sk.flung[q][d], cx, fy - 10)
        return
      }
      if (this.state === 'down') {
        drawAt(c, sk.down, d, cx, fy, 20)
        return
      }
      if (this.state === 'prone' || this.state === 'rest') {
        drawAt(c, this.state === 'rest' ? sk.rest : sk.prone, d, cx, fy - (this.state === 'rest' && this.idx ? 4 : 0), 20)
        if (now < this.flashUntil) drawMid(c, SHOT.flash[Math.floor(now / 40) & 1], cx + 21 * d, fy - 3)
        return
      }
      if (this.state === 'meet') {
        if (this.fived) drawAt(c, sk.five, d, cx, fy, BC)
        else drawAt(c, sk.run.fwd[Math.floor(this.dist / 4) % 6], d, cx, fy, BC)
        return
      }
      if (this.state === 'win') {
        drawAt(c, sk.win, d, cx, fy, BC)
        return
      }
      const pose = poseOf(this.aim)
      const sp = this.state === 'run' ? sk.run[pose][Math.floor(this.dist / 4) % 6] : sk.stand[pose]
      drawAt(c, sp, d, cx, fy, BC)
      if (now < this.flashUntil) {
        const [mx, my] = MUZZLE[pose]
        drawMid(c, SHOT.flash[Math.floor(now / 40) & 1], cx + (mx + 1) * d, fy + my)
      }
    }
  }

  // ---- the bar ---------------------------------------------------------------------------------------------
  function spawnWave(s, now, n) {
    const d = s.data
    const side = Math.random() < 0.18 ? -d.enemySide : d.enemySide
    for (let i = 0; i < n; i++) s.spawn(new Soldier(s, side, i * rand(14, 22)))
  }
  function bossSpot(s) {
    const d = s.data
    const pref = d.enemySide === 1 ? s.W - 50 : 50
    const b = d.bunker.cx
    return openSpot(s, pref, WALL_W / 2 + 2, [[b - 14, b + 14]])
  }
  function finale(s, now) {
    // done: everything on the enemy side goes up in a chain
    const d = s.data
    let t = 0
    let fx = 0
    let n = 0
    for (const a of s.actors) {
      if (a instanceof Soldier && a.alive) {
        const who = a
        d.booms.push({ at: now + t, x: a.cx, y: FLOOR - 12, big: false, kill: who })
        fx += a.cx
        n++
        t += 140
      }
      if (a instanceof Sniper && a.alive) {
        d.booms.push({ at: now + t, x: a.cx, y: FLOOR - 14, big: false, kill: a })
        t += 140
      }
    }
    if (d.boss && d.boss.state !== 'sink') {
      if (d.boss.state === 'rise') d.boss.state = 'fight'
      d.boss.off = 0
      d.boss.destroy(now)
      fx += d.boss.cx * 3
      n += 3
      t = Math.max(t, 600)
    }
    {
      // the base itself: a run of blasts across the enemy side
      const span = Math.min(s.W * 0.4, 220)
      const x0 = d.enemySide === 1 ? s.W - 12 : 12
      for (let i = 0; i < 9; i++) {
        const x = x0 - d.enemySide * (i / 8) * span + rand(-6, 6)
        d.booms.push({ at: now + t + i * 150, x, y: FLOOR - rand(6, 22), big: i % 3 === 1 })
      }
      fx += (x0 - (d.enemySide * span) / 2) * 3
      n += 3
      t += 9 * 150
    }
    d.booms.sort((a, b) => a.at - b.at)
    d.finaleX = n ? fx / n : s.W / 2
    d.finaleUntil = now + t + 500
  }

  registerConcept({
    key: 'contra',
    title: 'Contra',
    sub: 'Konami, 1987',
    blurb:
      'Bill and Lance hold the bar against the Red Falcon army: they run and gun in eight directions, hit the dirt under fire, somersault over soldiers and pick off the sniper behind the sandbags when he pops up. Each one covers the other and shoots first at whatever is closing in on his buddy; soldiers flinch when a mate goes down. Shoot the falcon capsule and one of them runs for the S, M, L or F weapon it drops. Get hit and it is the death flip and a respawn drop. They aim at your <b>cursor</b>; click a commando to make him jump, double-click to send him prone, click an enemy or the capsule for a covering burst from both. While the agent works the waves build up until the sirens bring up the Defense Wall; done blows the base up in a chain, then a high five and a victory pose. Left alone they lie prone side by side.',
    setup(s) {
      s.data = { team: [], booms: [], kills: 0, deaths: 0, lives: [3, 3], enemySide: 1, boss: null, sniper: null, W: s.W }
      const d = s.data
      d.team = [new Commando(s, 0), new Commando(s, 1)]
      d.team[1].cx = openSpot(s, d.team[0].cx + 40, 8)
      d.bunker = new Bunker(s)
      s.actors.push(d.bunker, ...d.team)
      const now = performance.now()
      d.nextEnemy = now + rand(5000, 9000)
      d.nextCapsule = now + rand(9000, 15000)
      d.sniperAt = now + rand(12000, 20000)
      d.finaleUntil = 0
    },
    relayout(s) {
      const d = s.data
      if (!d.team) return
      for (const c of d.team) {
        c.cx = clamp(c.cx, 10, s.W - 10)
        c.post = null
      }
      d.restX = undefined
      if (d.team.some((c) => c.state === 'rest')) {
        // keep the pair together and off the furniture after a resize
        d.restX = openSpot(s, clamp((d.team[0].cx + d.team[1].cx) / 2, 40, s.W - 40), 32)
        const k = d.restX < s.W / 2 ? 1 : -1
        d.team[0].cx = d.restX - 11 * k
        d.team[1].cx = d.restX + 11 * k
        for (const c of d.team) c.dir = k
      }
      d.bunker.place(s)
      if (d.boss) d.boss.cx = bossSpot(s)
      for (const a of s.actors) if (a instanceof Pickup && a.landed) a.cx = openSpot(s, clamp(a.cx, 10, s.W - 10), 9)
      d.W = s.W
    },
    onBarClick(s, p) {
      // mockup extra (Aico has no empty-bar clicks): a burst toward the spot
      const t = { cx: p.x, alive: true, aimPoint: () => ({ x: p.x, y: p.y }) }
      for (const c of s.data.team) c.burstAt(t)
    },
    onBusy(s) {
      const d = s.data
      const now = performance.now()
      d.finaleUntil = 0
      d.booms.length = 0
      d.nextEnemy = now + 600
      d.nextCapsule = now + rand(6000, 10000)
      d.bossAt = now + rand(26000, 38000)
      d.sniperAt = Math.min(d.sniperAt, now + rand(3000, 7000))
      for (const c of d.team) {
        c.post = null
        if (c.state === 'win' || c.state === 'meet') c.state = 'stand'
      }
    },
    onDone(s) {
      const now = performance.now()
      const d = s.data
      // enemy fire in the air fizzles out; nobody dies during the celebration
      for (const a of s.actors) if (a instanceof Bullet && !a.friendly) a.dead = true
      for (const c of d.team) {
        c.queue = null
        c.post = null
        if (c.state === 'prone') c.state = 'stand'
      }
      finale(s, now)
      for (const c of d.team) c.safeUntil = d.finaleUntil + 4500
      d.nextEnemy = Math.max(d.nextEnemy, d.finaleUntil + rand(9000, 14000))
      d.sniperAt = Math.max(d.sniperAt === Infinity ? 0 : d.sniperAt, d.finaleUntil + rand(9000, 14000))
    },
    onNap(s) {
      const d = s.data
      for (const a of s.actors) if (a instanceof Bullet || a instanceof Capsule) a.dead = true
      if (d.boss) d.boss.sink(performance.now())
      d.booms.length = 0
      d.finaleUntil = 0
      for (const c of d.team) if (c.state === 'meet' || c.state === 'win') c.state = 'stand'
    },
    update(s, dt, now) {
      const d = s.data
      let wait = Infinity
      // the finale's chain of blasts
      while (d.booms.length && d.booms[0].at <= now) {
        const b = d.booms.shift()
        if (b.kill && !b.kill.dead) b.kill.shot(null, now)
        s.spawn(new Boom(b.x, b.y, b.big))
      }
      if (d.booms.length) wait = Math.min(wait, d.booms[0].at - now)
      if (d.finaleUntil) {
        if (now >= d.finaleUntil) {
          d.finaleUntil = 0
          for (const c of d.team) c.startMeet()
        } else wait = Math.min(wait, d.finaleUntil - now)
      }
      for (const c of d.team)
        if (c.meetLater && c.onField && c.grounded) {
          c.meetLater = false
          c.startMeet()
        }
      if (d.boss && d.boss.dead) d.boss = null
      const awake = s.lively(now)
      if (!awake) {
        d.nextEnemy = Math.max(d.nextEnemy, now + 4000)
        if (d.boss && d.boss.state !== 'dying') d.boss.sink(now)
        return wait
      }
      d.restX = undefined
      if (d.finaleUntil) return Math.min(wait, SLOW)
      const soldiers = s.actors.reduce((n, a) => n + (a instanceof Soldier && a.alive ? 1 : 0), 0)
      if (s.busy) {
        if (!d.boss && now > (d.bossAt || Infinity)) {
          // sirens: the Defense Wall comes up out of the ground
          d.boss = s.spawn(new Wall(s, bossSpot(s), -d.enemySide))
          for (const c of d.team) c.postAt = 0
          d.alarmUntil = now + 2600
          d.bossAt = Infinity
        }
        if (d.boss === null && d.bossAt === Infinity) d.bossAt = now + rand(30000, 45000)
        if (now > d.nextEnemy) {
          if (soldiers < 7) spawnWave(s, now, d.boss ? Math.floor(rand(1, 3)) : Math.floor(rand(2, 4.5)))
          d.nextEnemy = now + (d.boss ? rand(6000, 9000) : rand(3200, 5600))
        }
      } else if (now > d.nextEnemy) {
        if (soldiers < 2) spawnWave(s, now, 1)
        d.nextEnemy = now + rand(9000, 16000)
      }
      if (!d.sniper && now > d.sniperAt) {
        d.bunker.place(s)
        d.sniper = s.spawn(new Sniper(s, d.bunker))
        d.sniperAt = Infinity
      }
      if (now > d.nextCapsule) {
        if (!s.actors.some((a) => a instanceof Capsule)) s.spawn(new Capsule(s))
        d.nextCapsule = now + (s.busy ? rand(14000, 22000) : rand(24000, 38000))
      }
      return Math.min(wait, Math.max(SLOW, Math.min(d.nextEnemy, d.nextCapsule, d.sniperAt, d.bossAt ?? Infinity) - now))
    },
    drawBehind(s, c) {
      // the siren: a pulsing red wash while the wall comes up
      const now = performance.now()
      if (now < (s.data.alarmUntil || 0) && Math.floor(now / 260) & 1) {
        c.fillStyle = 'rgba(255,40,30,0.13)'
        c.fillRect(0, 0, s.W, H)
      }
    },
  })
})()
