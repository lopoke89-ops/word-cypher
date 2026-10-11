/* ===== Word Cypher engine: lexicon trie, scoring, move generation ===== */
const N = 15, CENTER = 7, RACK_SIZE = 7, BINGO = 50, CRED = 5;
const VALUES = {a:1,b:3,c:3,d:2,e:1,f:4,g:2,h:4,i:1,j:8,k:5,l:1,m:3,n:1,o:1,p:3,q:10,r:1,s:1,t:1,u:1,v:4,w:4,x:8,y:4,z:10};
const COUNTS = {a:9,b:2,c:2,d:4,e:12,f:2,g:3,h:2,i:9,j:1,k:1,l:4,m:2,n:6,o:8,p:2,q:1,r:6,s:4,t:6,u:4,v:2,w:2,x:1,y:2,z:1,'?':2};
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/* premium squares from one quadrant, mirrored */
const PREMIUM = (() => {
  const g = Array.from({length:N}, () => Array(N).fill(''));
  const q = { TW:[[0,0],[0,7]], DW:[[1,1],[2,2],[3,3],[4,4],[7,7]], TL:[[1,5],[5,5],[5,1]],
              DL:[[0,3],[2,6],[3,0],[3,7],[6,2],[6,6],[7,3]] };
  for (const [k, list] of Object.entries(q)) for (const [r, c] of list)
    for (const [rr, cc] of [[r,c],[c,r],[N-1-r,c],[r,N-1-c],[N-1-r,N-1-c],[c,N-1-r],[N-1-c,r],[N-1-c,N-1-r]]) g[rr][cc] = k;
  return g;
})();

/* ---- Trie in typed arrays. term: 0 none, 1 dictionary, 2 Urban Dictionary only ---- */
class Lexicon {
  constructor() {
    this.cap = 1 << 20; this.n = 1;
    this.child = new Int32Array(this.cap).fill(-1);
    this.sib = new Int32Array(this.cap).fill(-1);
    this.ch = new Uint8Array(this.cap);
    this.term = new Uint8Array(this.cap);
    this.slang = true; this.count = [0, 0];
  }
  grow() {
    const cap = this.cap * 2, g = (A, fill) => { const b = new A.constructor(cap); if (fill !== undefined) b.fill(fill); b.set(A); return b; };
    this.child = g(this.child, -1); this.sib = g(this.sib, -1); this.ch = g(this.ch); this.term = g(this.term); this.cap = cap;
  }
  add(word, kind) {
    let node = 0;
    for (let i = 0; i < word.length; i++) {
      const L = word.charCodeAt(i) - 97;
      let k = this.child[node], prev = -1;
      while (k !== -1 && this.ch[k] !== L) { prev = k; k = this.sib[k]; }
      if (k === -1) {
        if (this.n >= this.cap) this.grow();
        k = this.n++; this.ch[k] = L;
        if (prev === -1) this.child[node] = k; else this.sib[prev] = k;
      }
      node = k;
    }
    if (!this.term[node]) this.count[Math.min(kind, 2) - 1]++;
    this.term[node] = kind;
  }
  load(text) {
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start); if (end === -1) end = text.length;
      let w = text.slice(start, end).trim();
      if (w) { if (w[0] === '*') this.add(w.slice(1), 2); else if (w[0] === '!') this.add(w.slice(1), 3); else this.add(w, 1); }
      start = end + 1;
    }
  }
  next(node, L) { let k = this.child[node]; while (k !== -1 && this.ch[k] !== L) k = this.sib[k]; return k; }
  ok(node) { const t = this.term[node]; return t === 1 || (t > 1 && this.slang); }
  /* 0 = not a word, 1 = dictionary, 2 = Urban Dictionary */
  raw(word) {
    let node = 0;
    for (let i = 0; i < word.length; i++) { node = this.next(node, word.charCodeAt(i) - 97); if (node === -1) return 0; }
    const t = this.term[node];
    return t > 1 && !this.slang ? 0 : t;
  }
  /* 1 = dictionary, 2 = Urban Dictionary (3 internally marks well-known slang) */
  kind(word) { return Math.min(this.raw(word), 2); }
}

function newBag(rng = Math.random) {
  const bag = [];
  for (const [ch, n] of Object.entries(COUNTS)) for (let i = 0; i < n; i++) bag.push(ch);
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  return bag;
}

/* board[r][c] = null | {ch, blank}. placements: [{r,c,ch,blank}] */
function scoreMove(board, placements, lex) {
  const res = { valid: false, error: '', words: [], total: 0 };
  if (!placements.length) { res.error = 'Place some tiles first.'; return res; }
  const at = (r, c) => {
    if (r < 0 || c < 0 || r >= N || c >= N) return null;
    if (board[r][c]) return board[r][c];
    return placements.find(p => p.r === r && p.c === c) || null;
  };
  const isNew = (r, c) => placements.some(p => p.r === r && p.c === c);
  for (const p of placements) if (board[p.r][p.c]) { res.error = 'That square is already taken.'; return res; }
  const rows = new Set(placements.map(p => p.r)), cols = new Set(placements.map(p => p.c));
  if (rows.size > 1 && cols.size > 1) { res.error = 'Tiles must be in one row or one column.'; return res; }
  let across;
  if (placements.length > 1) across = rows.size === 1;
  else { const {r, c} = placements[0]; across = !!(at(r, c - 1) || at(r, c + 1)); }
  const [dr, dc] = across ? [0, 1] : [1, 0];
  const sorted = [...placements].sort((a, b) => across ? a.c - b.c : a.r - b.r);
  const first = sorted[0], last = sorted[sorted.length - 1];
  for (let r = first.r, c = first.c; r <= last.r && c <= last.c; r += dr, c += dc)
    if (!at(r, c)) { res.error = 'Leave no gaps between your tiles.'; return res; }

  const readWord = (r, c, dr, dc) => {
    while (at(r - dr, c - dc)) { r -= dr; c -= dc; }
    const cells = [];
    while (at(r, c)) { cells.push([r, c]); r += dr; c += dc; }
    return cells;
  };
  const scoreCells = cells => {
    let sum = 0, mult = 1, w = '';
    for (const [r, c] of cells) {
      const t = at(r, c); w += t.ch;
      let v = t.blank ? 0 : VALUES[t.ch];
      if (isNew(r, c)) {
        const p = PREMIUM[r][c];
        if (p === 'DL') v *= 2; else if (p === 'TL') v *= 3; else if (p === 'DW') mult *= 2; else if (p === 'TW') mult *= 3;
      }
      sum += v;
    }
    return { w, pts: sum * mult, cells };
  };

  const groups = [];
  const main = readWord(first.r, first.c, dr, dc);
  if (main.length >= 2) groups.push(main);
  for (const p of placements) {
    const cross = readWord(p.r, p.c, dc, dr);
    if (cross.length >= 2) groups.push(cross);
  }
  if (!groups.length) { res.error = 'A word needs at least two letters.'; return res; }

  const boardEmpty = board.every(row => row.every(x => !x));
  if (boardEmpty) {
    if (!isNew(CENTER, CENTER)) { res.error = 'The first word must cover the center star.'; return res; }
  } else {
    const touches = groups.some(g => g.some(([r, c]) => !isNew(r, c)));
    if (!touches) { res.error = 'Connect to tiles already on the board.'; return res; }
  }

  let bad = [];
  for (const g of groups) {
    const s = scoreCells(g);
    const raw = lex.raw(s.w), k = Math.min(raw, 2);
    s.kind = k; s.known = raw !== 2; if (!k) bad.push(s.w.toUpperCase());
    res.words.push(s);
  }
  let total = res.words.reduce((a, s) => a + s.pts, 0);
  res.bingo = placements.length === RACK_SIZE;
  if (res.bingo) total += BINGO;
  res.cred = res.words.filter(s => s.kind === 2).length * CRED;
  total += res.cred;
  res.total = total;
  if (bad.length) { res.error = `${bad.join(', ')} ${bad.length > 1 ? "aren't words" : "isn't a word"} in either dictionary.`; return res; }
  res.valid = true;
  return res;
}

/* ---- Appel–Jacobson move generator. rack: array of letters, '?' = blank ---- */
function generateMoves(board, rack, lex, limit = 60000) {
  const counts = new Array(27).fill(0);
  for (const t of rack) counts[t === '?' ? 26 : t.charCodeAt(0) - 97]++;
  const empty = board.every(row => row.every(x => !x));
  const found = new Map();

  for (const across of [true, false]) {
    const get = across ? (r, c) => board[r][c] : (r, c) => board[c][r];
    const map = across ? (r, c) => [r, c] : (r, c) => [c, r];
    for (let r = 0; r < N; r++) {
      const cross = new Array(N).fill(0x3ffffff), anchor = new Array(N).fill(false);
      for (let c = 0; c < N; c++) {
        if (get(r, c)) continue;
        const above = r > 0 && get(r - 1, c), below = r < N - 1 && get(r + 1, c);
        if (above || below) {
          let up = '', dn = '';
          for (let k = r - 1; k >= 0 && get(k, c); k--) up = get(k, c).ch + up;
          for (let k = r + 1; k < N && get(k, c); k++) dn += get(k, c).ch;
          let mask = 0;
          for (let L = 0; L < 26; L++) if (lex.kind(up + LETTERS[L] + dn)) mask |= 1 << L;
          cross[c] = mask; anchor[c] = true;
        }
        if ((c > 0 && get(r, c - 1)) || (c < N - 1 && get(r, c + 1))) anchor[c] = true;
        if (empty && r === CENTER && c === CENTER) anchor[c] = true;
      }
      for (let a = 0; a < N; a++) {
        if (!anchor[a] || found.size > limit) continue;
        const left = [], right = [];
        const record = () => {
          const pl = [];
          const base = a - left.length;
          left.forEach((t, i) => { const [rr, cc] = map(r, base + i); pl.push({r: rr, c: cc, ch: t.ch, blank: t.blank}); });
          for (const t of right) { const [rr, cc] = map(r, t.c); pl.push({r: rr, c: cc, ch: t.ch, blank: t.blank}); }
          const key = pl.map(p => `${p.r},${p.c},${p.ch}${p.blank ? '?' : ''}`).sort().join('|');
          if (!found.has(key)) found.set(key, pl);
        };
        const take = L => { if (counts[L] > 0) { counts[L]--; return false; } if (counts[26] > 0) { counts[26]--; return true; } return null; };
        const give = (L, blank) => { if (blank) counts[26]++; else counts[L]++; };
        const extend = (node, sq) => {
          if (sq >= N) { if (sq > a && lex.ok(node)) record(); return; }
          const t = get(r, sq);
          if (t) { const nx = lex.next(node, t.ch.charCodeAt(0) - 97); if (nx !== -1) extend(nx, sq + 1); return; }
          if (sq > a && lex.ok(node)) record();
          for (let k = lex.child[node]; k !== -1; k = lex.sib[k]) {
            const L = lex.ch[k];
            if (!(cross[sq] & (1 << L))) continue;
            const blank = take(L); if (blank === null) continue;
            right.push({c: sq, ch: LETTERS[L], blank});
            extend(k, sq + 1);
            right.pop(); give(L, blank);
          }
        };
        if (a > 0 && get(r, a - 1)) {
          let s = a - 1; while (s > 0 && get(r, s - 1)) s--;
          let node = 0;
          for (let k = s; k < a && node !== -1; k++) node = lex.next(node, get(r, k).ch.charCodeAt(0) - 97);
          if (node !== -1) extend(node, a);
        } else {
          let lim = 0; for (let k = a - 1; k >= 0 && !get(r, k) && !anchor[k]; k--) lim++;
          const leftPart = (node, lim) => {
            extend(node, a);
            if (lim <= 0) return;
            for (let k = lex.child[node]; k !== -1; k = lex.sib[k]) {
              const L = lex.ch[k];
              const blank = take(L); if (blank === null) continue;
              left.push({ch: LETTERS[L], blank});
              leftPart(k, lim - 1);
              left.pop(); give(L, blank);
            }
          };
          leftPart(0, Math.min(lim, rack.length - 1));
        }
      }
    }
  }
  const moves = [];
  for (const pl of found.values()) {
    const s = scoreMove(board, pl, lex);
    if (s.valid) moves.push({ placements: pl, score: s });
  }
  moves.sort((x, y) => y.score.total - x.score.total);
  return moves;
}
