/* Word Cypher game core. Pure rules and state, no DOM.
   Runs on whoever owns the game: the solo player, or the host of an online room.
   Guests never run this; they get a filtered view from the host. */

const MAX_SEATS = 4;
const STALL_TURNS = n => Math.max(6, 2 * n);   // consecutive scoreless turns that end the game

function cleanName(n) {
  return String(n == null ? '' : n).replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Guest';
}

function tileValue(ch) { return ch === '?' ? 0 : VALUES[ch]; }

/* seats: [{name, kind: 'human'|'cpu', level?, token?}] */
function createGame({ seats, slang = true }, rng = Math.random) {
  const S = {
    v: 1,
    gameId: Math.random().toString(36).slice(2, 10),
    board: Array.from({ length: N }, () => Array(N).fill(null)),
    bag: newBag(rng),
    nextId: 1,
    players: seats.map(s => ({ name: cleanName(s.name), kind: s.kind, level: s.level || null, token: s.token || null, rack: [], score: 0 })),
    turn: 0, log: [], zeroRun: 0, over: false, slang, last: [], moveNo: 0,
    live: {},   // words accepted through live Urban Dictionary checks this game
  };
  S.players.forEach(p => drawTiles(S, p));
  return S;
}

function drawTiles(S, p) {
  while (p.rack.length < RACK_SIZE && S.bag.length) p.rack.push({ id: S.nextId++, ch: S.bag.pop() });
}

function isInt(x, lo, hi) { return Number.isInteger(x) && x >= lo && x <= hi; }

/* Apply one action for one seat. Every field is checked because guests' messages are untrusted.
   a = {type:'play', tiles:[{id, r, c, ch}]} | {type:'swap', ids:[...]} | {type:'pass'} */
function act(S, seat, a, lex) {
  if (!S || S.over) return { ok: false, error: 'The game is over.' };
  if (seat !== S.turn) return { ok: false, error: "It's not your turn." };
  if (!a || typeof a !== 'object') return { ok: false, error: 'Unknown move.' };
  const p = S.players[seat];
  lex.slang = S.slang;

  if (a.type === 'play') {
    const tiles = a.tiles;
    if (!Array.isArray(tiles) || tiles.length < 1 || tiles.length > RACK_SIZE) return { ok: false, error: 'Place some tiles first.' };
    const seen = new Set(), pl = [];
    for (const t of tiles) {
      if (!t || seen.has(t.id)) return { ok: false, error: 'Those tiles are not in your rack.' };
      seen.add(t.id);
      const own = p.rack.find(x => x.id === t.id);
      if (!own || !isInt(t.r, 0, N - 1) || !isInt(t.c, 0, N - 1)) return { ok: false, error: 'Those tiles are not in your rack.' };
      if (own.ch === '?') {
        if (typeof t.ch !== 'string' || !/^[a-z]$/.test(t.ch)) return { ok: false, error: 'Pick a letter for the blank tile.' };
        pl.push({ r: t.r, c: t.c, ch: t.ch, blank: true });
      } else pl.push({ r: t.r, c: t.c, ch: own.ch, blank: false });
    }
    const keys = new Set(pl.map(x => x.r * N + x.c));
    if (keys.size !== pl.length) return { ok: false, error: 'Two tiles on one square.' };
    const res = scoreMove(S.board, pl, lex);
    if (!res.valid) return { ok: false, error: res.error };
    for (const x of pl) S.board[x.r][x.c] = { ch: x.ch, blank: x.blank, by: seat };
    p.rack = p.rack.filter(t => !seen.has(t.id));
    p.score += res.total;
    S.last = pl.map(x => [x.r, x.c]);
    S.log.push({ p: seat, type: 'play', words: res.words.map(w => ({ w: w.w, pts: w.pts, kind: w.kind })), total: res.total, bingo: res.bingo, cred: res.cred });
    S.zeroRun = 0; S.moveNo++;
    drawTiles(S, p);
    if (!p.rack.length && !S.bag.length) { finish(S, seat); return { ok: true, res }; }
    S.turn = (S.turn + 1) % S.players.length;
    return { ok: true, res };
  }

  if (a.type === 'swap') {
    const ids = a.ids;
    if (S.bag.length < RACK_SIZE) return { ok: false, error: 'You can only swap while 7 or more tiles are left in the bag.' };
    if (!Array.isArray(ids) || !ids.length || ids.length > RACK_SIZE || new Set(ids).size !== ids.length) return { ok: false, error: 'Pick tiles to swap.' };
    if (!ids.every(id => p.rack.some(t => t.id === id))) return { ok: false, error: 'Those tiles are not in your rack.' };
    const out = p.rack.filter(t => ids.includes(t.id));
    p.rack = p.rack.filter(t => !ids.includes(t.id));
    drawTiles(S, p);
    for (const t of out) S.bag.splice(Math.floor(Math.random() * (S.bag.length + 1)), 0, t.ch);
    S.log.push({ p: seat, type: 'swap', n: out.length });
    return endScoreless(S);
  }

  if (a.type === 'pass') {
    S.log.push({ p: seat, type: 'pass' });
    return endScoreless(S);
  }
  return { ok: false, error: 'Unknown move.' };
}

function endScoreless(S) {
  S.zeroRun++; S.last = []; S.moveNo++;
  if (S.zeroRun >= STALL_TURNS(S.players.length)) { finish(S, -1); return { ok: true }; }
  S.turn = (S.turn + 1) % S.players.length;
  return { ok: true };
}

/* outSeat: the player who used their last tile, or -1 when the game stalled */
function finish(S, outSeat) {
  const sums = S.players.map(p => p.rack.reduce((a, t) => a + tileValue(t.ch), 0));
  const parts = [];
  S.players.forEach((p, i) => {
    if (i === outSeat) return;
    p.score -= sums[i];
    if (sums[i]) parts.push(`${p.name} −${sums[i]}`);
  });
  if (outSeat >= 0) {
    const bonus = sums.reduce((a, b) => a + b, 0) - sums[outSeat];
    S.players[outSeat].score += bonus;
    S.log.push({ p: outSeat, type: 'end', text: `${S.players[outSeat].name} went out and collects +${bonus}${parts.length ? '. Left on racks: ' + parts.join(', ') : ''}.` });
  } else {
    S.log.push({ p: -1, type: 'end', text: `Nobody scored for ${STALL_TURNS(S.players.length)} turns, so the game ends.${parts.length ? ' Left on racks: ' + parts.join(', ') + '.' : ''}` });
  }
  S.over = true;
}

/* What the CPU in this seat wants to do */
function cpuAction(S, seat, lex, rng = Math.random) {
  const p = S.players[seat];
  lex.slang = S.slang;
  const all = generateMoves(S.board, p.rack.map(t => t.ch), lex);
  // the CPU sticks to dictionary words and well-known slang so its plays read like real words
  const moves = all.filter(m => m.score.words.every(w => w.known && !cpuAvoids(w.w)));
  if (!moves.length) {
    if (S.bag.length >= RACK_SIZE) {
      const keep = new Set('aeinrst?');
      let ids = p.rack.filter(t => !keep.has(t.ch)).map(t => t.id);
      if (!ids.length) ids = p.rack.map(t => t.id);
      return { type: 'swap', ids };
    }
    return { type: 'pass' };
  }
  let pick;
  if (p.level === 'hard') pick = moves[0];
  else {
    const lo = p.level === 'easy' ? 0.15 : 0.02, hi = p.level === 'easy' ? 0.5 : 0.12;
    const a = Math.floor(moves.length * lo), b = Math.max(a + 1, Math.ceil(moves.length * hi));
    pick = moves[Math.min(moves.length - 1, a + Math.floor(rng() * (b - a)))];
  }
  const pool = [...p.rack], tiles = [];
  for (const x of pick.placements) {
    const i = pool.findIndex(t => (x.blank ? t.ch === '?' : t.ch === x.ch));
    tiles.push({ id: pool[i].id, r: x.r, c: x.c, ch: x.ch });
    pool.splice(i, 1);
  }
  return { type: 'play', tiles };
}

/* The slice of the game one seat is allowed to see. seat = -1 for a spectator. */
function viewFor(S, seat) {
  return {
    board: S.board, bag: S.bag.length, turn: S.turn, log: S.log, over: S.over, slang: S.slang,
    last: S.last, moveNo: S.moveNo, seat, live: S.live || {}, gameId: S.gameId,
    players: S.players.map(p => ({ name: p.name, kind: p.kind, level: p.level, score: p.score, tiles: p.rack.length })),
    rack: seat >= 0 && S.players[seat] ? S.players[seat].rack : [],
  };
}

if (typeof module !== 'undefined') module.exports = { createGame, act, cpuAction, viewFor, cleanName, MAX_SEATS };
