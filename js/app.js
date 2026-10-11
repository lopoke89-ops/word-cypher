/* Word Cypher app: screens, board UI, solo play and peer-to-peer rooms.
   Online model: the host's browser owns the game (js/game.js) and sends each guest
   only what that guest may see. Guests send moves; the host checks every one. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const APP_VERSION = '1.3';
  const PROTO = 2;                          // bump when host and guest messages change shape
  const PREFIX = 'wordcypher-v1-';          // PeerJS id = PREFIX + room code
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const LEVEL_NAME = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
  const ADJ = ['Lowkey', 'Goated', 'Bussin', 'Salty', 'Drippy', 'Certified', 'Based', 'Lit', 'Sneaky', 'Cracked', 'Smooth', 'Fresh', 'Wavy', 'Iced', 'Clutch', 'Turnt', 'Chill', 'Elite', 'Spicy', 'Slick'];
  const NOUN = ['Goat', 'Rizzler', 'Speller', 'Homie', 'Legend', 'Scholar', 'Cypher', 'Rapper', 'Vowel', 'Bard', 'Menace', 'Champ', 'Sigma', 'Wizard', 'Hustler', 'Poet', 'Sage', 'Boss', 'Ace', 'Lyricist'];
  const pick = a => a[Math.floor(Math.random() * a.length)];
  function randomName() { let n; do { n = pick(ADJ) + pick(NOUN) + (10 + Math.floor(Math.random() * 90)); } while (n.length > 20); return n; }
  const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  const genCode = () => Array.from({ length: 5 }, () => pick(CODE_CHARS)).join('');

  let myToken = store.get('wc.token'); if (!myToken) { myToken = randomToken(); store.set('wc.token', myToken); }
  let myName = store.get('wc.name'); if (!myName) { myName = randomName(); store.set('wc.name', myName); }

  /* ---------- word lists ---------- */
  const lex = new Lexicon();
  let lexReady = false;
  fetch('words.txt?v=' + APP_VERSION).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }).then(t => {
    lex.load(t); lexReady = true; if (V) lex.slang = V.slang;
    $('loading').hidden = true; render(); scheduleCpu();
  }).catch(() => { $('loading').textContent = "Couldn't load the word lists. Reload the page to try again."; });

  /* ---------- live Urban Dictionary checks ----------
     Words not in words.txt are looked up on Urban Dictionary. A word counts when UD has
     LIVE_MIN_DEFS or more definitions for exactly that word. Results are cached; the host's
     answer is the one that decides a play, and accepted words are shared with everyone. */
  const liveDefs = new Map();     // word -> number of exact definitions found
  const liveInflight = new Map(); // word -> Promise
  let liveTimer = null;
  const liveFailed = new Map();   // word -> time of a failed request (network), retried after 10s
  function lookupUrban(word) {
    if (lex.live.has(word)) return Promise.resolve(lex.live.get(word) === 1);
    if (liveInflight.has(word)) return liveInflight.get(word);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 7000);
    const p = fetch('https://api.urbandictionary.com/v0/define?term=' + encodeURIComponent(word), { signal: ctl.signal })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => {
        const n = (j.list || []).filter(d => String(d.word || '').toLowerCase().trim() === word).length;
        liveDefs.set(word, n);
        const ok = n >= LIVE_MIN_DEFS && !UD_BLOCK.test(word);
        lex.live.set(word, ok ? 1 : 0); liveFailed.delete(word);
        return ok;
      })
      .catch(err => { liveFailed.set(word, Date.now()); throw err; })
      .finally(() => { clearTimeout(timer); liveInflight.delete(word); });
    liveInflight.set(word, p);
    return p;
  }
  // words in this play that still need a live check
  function liveCandidates(res) {
    if (!lex.slang || res.valid || !res.words) return [];
    return res.words.filter(w => !w.kind && w.w.length >= LIVE_MIN_LEN && !lex.live.has(w.w) && !UD_BLOCK.test(w.w)).map(w => w.w);
  }
  // check every unknown word in a play; resolves to null when done, or an error message
  async function resolveLive(board, placements) {
    const words = liveCandidates(scoreMove(board, placements, lex));
    if (!words.length) return null;
    try { await Promise.all(words.map(lookupUrban)); return null; }
    catch (e) { return `Couldn't reach Urban Dictionary to check ${words.map(w => w.toUpperCase()).join(', ')}. Try again in a moment.`; }
  }
  function rememberLive(res) {   // host/solo: share live-accepted words with everyone in this game
    if (!S || !res || !res.words) return;
    for (const w of res.words) if (w.kind === 2 && !lex.inList(w.w)) S.live[w.w] = 1;
  }
  const actionTiles = a => (S && a && a.type === 'play' && Array.isArray(a.tiles)) ? a.tiles : null;
  function placementsFor(seat, tiles) {   // best-effort placements for the pre-check; act() re-validates everything
    const rack = S.players[seat] ? S.players[seat].rack : [];
    return tiles.filter(t => t && Number.isInteger(t.r) && Number.isInteger(t.c) && t.r >= 0 && t.r < N && t.c >= 0 && t.c < N)
      .map(t => { const own = rack.find(x => x.id === t.id); return own ? { r: t.r, c: t.c, ch: own.ch === '?' ? String(t.ch || 'a') : own.ch, blank: own.ch === '?' } : null; })
      .filter(Boolean);
  }

  /* ---------- state ---------- */
  let mode = null;      // 'solo' | 'host' | 'guest'
  let S = null;         // the real game (solo and host only)
  let V = null;         // what this device shows
  let room = null;      // host: {code, phase, seats, slang, peer, conns}
  let guest = null;     // guest: {code, peer, conn, lobby, joined, lastSeen, closing}
  let pending = [], selected = null, cursor = null, swapMode = false, swapSel = new Set(), rackOrder = [];
  let waiting = false, passArmed = false, cpuTimer = null, freshKeys = new Set();

  const mySeat = () => (V ? V.seat : -1);
  const myTurn = () => !!V && !V.over && V.turn === V.seat;
  const online = () => mode === 'host' || mode === 'guest';

  /* ---------- screens ---------- */
  function show(screen) {
    document.body.dataset.screen = screen;
    $('home').hidden = screen !== 'home';
    $('lobby').hidden = screen !== 'lobby';
    $('game').hidden = screen !== 'game';
    $('btnLeave').hidden = screen === 'home';
    $('btnLeave').textContent = mode === 'host' ? 'Close room' : mode === 'solo' ? 'Home' : 'Leave';
    $('btnRename').hidden = !online();
    if (screen === 'home') { document.title = 'Word Cypher'; renderHome(); }
  }

  function goHome(msg, isErr) {
    clearTimeout(cpuTimer);
    mode = null; S = null; V = null; room = null; guest = null; pending = []; cursor = null; swapMode = false;
    show('home');
    setStatus('homeStatus', msg || '', isErr);
  }
  function setStatus(id, msg, isErr) { const el = $(id); el.textContent = msg || ''; el.classList.toggle('err', !!isErr); }

  /* ---------- home ---------- */
  function renderHome() {
    $('nameInput').value = myName;
    const h = store.get('wc.host'), g = store.get('wc.guest'), solo = store.get('wc.solo');
    const rb = $('resumeBox');
    if (h && h.code) {
      rb.hidden = false;
      rb.innerHTML = `<p>You were hosting room <b>${esc(h.code)}</b>${h.phase === 'game' ? ' mid-game' : ''}.</p><span class="inrow"><button class="btn spray" type="button" data-resume="host">Reopen room</button><button class="linkbtn" type="button" data-resume="drophost">Forget it</button></span>`;
    } else if (g && g.code) {
      rb.hidden = false;
      rb.innerHTML = `<p>You were in room <b>${esc(g.code)}</b>.</p><span class="inrow"><button class="btn spray" type="button" data-resume="guest">Rejoin</button><button class="linkbtn" type="button" data-resume="dropguest">Forget it</button></span>`;
    } else rb.hidden = true;
    const sr = $('soloResume');
    if (solo && solo.board && !solo.over) {
      sr.hidden = false;
      sr.innerHTML = `<p>Your game vs the CPU is ${solo.players[0].score}–${solo.players[1].score}.</p><button class="btn spray" type="button" data-resume="solo">Continue</button>`;
    } else sr.hidden = true;
  }

  function saveName(v) {
    myName = cleanName(v); store.set('wc.name', myName);
    if (mode === 'host') {
      const s = room.seats.find(x => x.token === myToken); if (s) s.name = myName;
      if (S) { const p = S.players.find(x => x.token === myToken); if (p) p.name = myName; }
      hostSync();
    } else if (mode === 'guest' && guest && guest.conn && guest.conn.open) guest.conn.send({ t: 'name', name: myName });
  }
  $('nameInput').addEventListener('change', e => { saveName(e.target.value); e.target.value = myName; });
  $('btnDice').onclick = () => { saveName(randomName()); $('nameInput').value = myName; };
  $('btnHost').onclick = () => { saveName($('nameInput').value); hostNew(); };
  $('joinForm').addEventListener('submit', e => {
    e.preventDefault(); saveName($('nameInput').value);
    const code = $('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5 || [...code].some(c => !CODE_CHARS.includes(c))) { setStatus('homeStatus', 'Room codes are 5 letters and numbers, like K7QXM.', true); return; }
    guestJoin(code);
  });
  document.querySelectorAll('[data-solo]').forEach(b => b.onclick = () => startSolo(b.dataset.solo, $('soloSlang').checked));
  $('home').addEventListener('click', e => {
    const r = e.target.closest('[data-resume]')?.dataset.resume; if (!r) return;
    if (r === 'host') hostResume(store.get('wc.host'));
    if (r === 'guest') guestJoin(store.get('wc.guest').code, true);
    if (r === 'solo') { mode = 'solo'; S = store.get('wc.solo'); show('game'); afterChange(); }
    if (r === 'drophost') { store.del('wc.host'); renderHome(); }
    if (r === 'dropguest') { store.del('wc.guest'); renderHome(); }
  });

  /* ---------- solo ---------- */
  function startSolo(level, slang) {
    mode = 'solo';
    S = createGame({ seats: [{ name: myName, kind: 'human', token: myToken }, { name: `CPU · ${LEVEL_NAME[level]}`, kind: 'cpu', level }], slang });
    show('game'); afterChange();
  }

  /* ---------- the real game changed (solo and host) ---------- */
  function afterChange() {
    if (mode === 'solo') store.set('wc.solo', S);
    if (mode === 'host') { saveHost(); broadcast(); }
    const v = viewFor(S, S.players.findIndex(p => p.token === myToken));
    v.online = onlineFlags();
    setView(v);
    scheduleCpu();
  }

  function scheduleCpu() {
    clearTimeout(cpuTimer);
    if (!S || S.over || !lexReady || (mode !== 'solo' && mode !== 'host')) return;
    if (mode === 'host' && room.phase !== 'game') return;
    if (S.players[S.turn].kind !== 'cpu') return;
    cpuTimer = setTimeout(() => {
      if (!S || S.over || S.players[S.turn].kind !== 'cpu') return;
      const seat = S.turn;
      const r = act(S, seat, cpuAction(S, seat, lex), lex);
      if (!r.ok) act(S, seat, { type: 'pass' }, lex);
      afterChange();
    }, 750);
  }

  function doAction(a) {
    if (mode === 'guest') {
      if (!guest.conn || !guest.conn.open) { flash('Not connected to the host right now.'); return; }
      waiting = true; guest.conn.send({ t: 'act', a, moveNo: V ? V.moveNo : -1 }); render();
      return;
    }
    const tiles = actionTiles(a);
    if (tiles) {
      waiting = true; render();
      const moveNo = S.moveNo;
      resolveLive(S.board, placementsFor(mySeat(), tiles)).then(netErr => {
        waiting = false;
        if (!S || S.moveNo !== moveNo) return;
        if (netErr) { flash(netErr); render(); return; }
        finishLocal(a);
      });
      return;
    }
    finishLocal(a);
  }
  function finishLocal(a) {
    const r = act(S, mySeat(), a, lex);
    if (!r.ok) { flash(r.error); render(); return; }
    rememberLive(r.res);
    afterChange();
  }

  let flashMsg = '';
  function flash(msg) { flashMsg = msg; renderPreview(); }

  function setView(v) {
    if (V && v.gameId !== V.gameId) { pending = []; rackOrder = []; cursor = null; V = null; }   // new game: tile ids restart
    const prev = V ? V.moveNo : -1;
    const wasMyTurn = myTurn();
    V = v; lex.slang = v.slang; waiting = false; flashMsg = '';
    for (const w of Object.keys(v.live || {})) if (/^[a-z]{2,15}$/.test(w)) lex.live.set(w, 1);
    if (v.moveNo !== prev) {
      selected = null; swapMode = false; swapSel.clear(); passArmed = false;
      if (prev >= 0 && v.last) freshKeys = new Set(v.last.map(([r, c]) => r + ',' + c));
    }
    // keep tiles you lined up while waiting, as long as the squares are still free
    pending = pending.filter(p => v.rack.some(t => t.id === p.id) && !v.board[p.r][p.c]);
    const ids = v.rack.map(t => t.id);
    rackOrder = rackOrder.filter(id => ids.includes(id)).concat(ids.filter(id => !rackOrder.includes(id)));
    document.title = online() && myTurn() ? '● Your turn · Word Cypher' : 'Word Cypher';
    if (online() && myTurn() && !wasMyTurn) { try { navigator.vibrate?.(60); } catch (e) {} }
    render();
  }

  /* ---------- PeerJS ---------- */
  function peerOpts() {
    const q = new URLSearchParams(location.search);
    const o = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };
    if (q.get('peerhost')) { // optional self-hosted signaling server, e.g. for local testing
      o.host = q.get('peerhost'); o.port = +q.get('peerport') || 9000; o.path = q.get('peerpath') || '/'; o.secure = q.get('peersecure') === '1';
    }
    return o;
  }
  function inviteLink(code) {
    const q = new URLSearchParams(location.search), out = new URLSearchParams();
    for (const k of ['peerhost', 'peerport', 'peerpath', 'peersecure']) if (q.get(k)) out.set(k, q.get(k));
    out.set('join', code);
    return location.origin + location.pathname + '?' + out.toString();
  }

  /* ---------- host ---------- */
  function hostNew() {
    mode = 'host';
    room = { code: genCode(), phase: 'lobby', seats: [{ name: myName, kind: 'human', token: myToken }], slang: true, conns: new Map(), fresh: true };
    S = null; show('lobby'); renderLobby(); openHostPeer(0);
  }
  function hostResume(saved) {
    if (!saved || !saved.code) return;
    mode = 'host';
    room = { code: saved.code, phase: saved.phase, seats: saved.seats, slang: saved.slang, conns: new Map(), fresh: false };
    S = saved.S || null;
    if (room.phase === 'game' && S) { show('game'); afterChange(); } else { room.phase = 'lobby'; show('lobby'); renderLobby(); }
    openHostPeer(0);
  }
  function saveHost() { if (room) store.set('wc.host', { code: room.code, phase: room.phase, seats: room.seats, slang: room.slang, S, at: Date.now() }); }

  function openHostPeer(attempt) {
    if (mode !== 'host') return;
    room.online = false; roomStatus(attempt ? `Reopening room ${room.code}…` : 'Opening the room…');
    const peer = new Peer(PREFIX + room.code, peerOpts());
    room.peer = peer;
    peer.on('open', () => { if (room && room.peer === peer) { room.online = true; room.fresh = false; roomStatus(''); hostSync(); } });
    peer.on('connection', conn => hostAccept(conn));
    peer.on('disconnected', () => { setTimeout(() => { if (room && room.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} } }, 2000); });
    peer.on('error', err => {
      if (!room || room.peer !== peer) return;
      const retry = (ms, msg) => { roomStatus(msg); try { peer.destroy(); } catch (e) {} setTimeout(() => { if (room && room.peer === peer) openHostPeer(attempt + 1); }, ms); };
      if (err.type === 'unavailable-id') {
        if (room.fresh) { room.code = genCode(); retry(0, 'Opening the room…'); renderLobby(); }
        else retry(4000, `Waiting for room ${room.code} to free up… (this can take a few seconds after a reload)`);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(err.type)) {
        retry(5000, "Can't reach the matchmaking server. Retrying…");
      } else if (err.type !== 'peer-unavailable') console.warn('peer error', err.type, err);
    });
  }
  function roomStatus(msg) {
    setStatus('lobbyStatus', msg, false);
    const b = $('banner');
    if (mode === 'host' && room && room.phase === 'game') { b.hidden = !msg; b.textContent = msg; }
  }

  function hostAccept(conn) {
    conn.on('data', d => hostMsg(conn, d));
    conn.on('close', () => hostDrop(conn));
    conn.on('error', () => hostDrop(conn));
  }
  const bye = (conn, msg) => { try { conn.send({ t: 'bye', msg }); } catch (e) {} setTimeout(() => { try { conn.close(); } catch (e) {} }, 300); };

  function hostMsg(conn, d) {
    if (mode !== 'host' || !d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      const token = typeof d.token === 'string' ? d.token.slice(0, 40) : '';
      if (conn.token && conn.token !== token) return;   // one connection can only ever be one player
      if (!token || token === myToken) return bye(conn, "Can't join your own room from the same browser.");
      if (d.v !== PROTO) return bye(conn, 'Your game is a different version. Refresh the page and try again.');
      const name = cleanName(d.name);
      if (room.phase === 'lobby') {
        let s = room.seats.find(x => x.token === token);
        if (!s) {
          if (room.seats.length >= MAX_SEATS) return bye(conn, 'That room is full.');
          s = { name, kind: 'human', token }; room.seats.push(s);
        } else s.name = name;
      } else {
        const p = S.players.find(x => x.token === token);
        if (!p) return bye(conn, 'That game already started. Ask the host to open a new room.');
        p.name = name; if (p.kind === 'cpu') { p.kind = 'human'; p.level = null; }  // takes their seat back from the CPU
        const s = room.seats.find(x => x.token === token); if (s) s.name = name;
      }
      const old = room.conns.get(token);
      if (old && old.conn !== conn) { try { old.conn.close(); } catch (e) {} }
      conn.token = token;
      room.conns.set(token, { conn, lastSeen: Date.now() });
      return hostSync();
    }
    const tok = conn.token; if (!tok) return;
    const entry = room.conns.get(tok); if (entry && entry.conn === conn) entry.lastSeen = Date.now();
    if (d.t === 'ping') { try { conn.send({ t: 'pong' }); } catch (e) {} return; }
    if (d.t === 'name') {
      const name = cleanName(d.name);
      const s = room.seats.find(x => x.token === tok); if (s) s.name = name;
      if (S) { const p = S.players.find(x => x.token === tok); if (p) p.name = name; }
      return hostSync();
    }
    if (d.t === 'leave') {
      room.conns.delete(tok);
      if (room.phase === 'lobby') room.seats = room.seats.filter(x => x.token !== tok);
      try { conn.close(); } catch (e) {}
      return hostSync();
    }
    if (d.t === 'act') {
      if (room.phase !== 'game' || !S) return;
      if (!lexReady) { try { conn.send({ t: 'err', msg: 'The host is still loading the word lists. Try again in a moment.' }); } catch (e) {} return; }
      const seat = S.players.findIndex(p => p.token === tok);
      const send = msg => { try { conn.send({ t: 'err', msg }); } catch (e) {} };
      if (Number.isInteger(d.moveNo) && d.moveNo !== S.moveNo) { send('The board changed before your move arrived. Check it and try again.'); return afterChange(); }
      const finish = () => {
        const r = act(S, seat, d.a, lex);
        if (!r.ok) return send(r.error);
        rememberLive(r.res);
        afterChange();
      };
      const tiles = actionTiles(d.a);
      if (!tiles || seat !== S.turn) return finish();
      const moveNo = S.moveNo;
      resolveLive(S.board, placementsFor(seat, tiles)).then(netErr => {
        if (mode !== 'host' || !S || S.moveNo !== moveNo) return;
        if (netErr) return send(netErr);
        finish();
      });
    }
  }

  function hostDrop(conn) {
    if (mode !== 'host' || !conn.token) return;
    const e = room.conns.get(conn.token);
    if (e && e.conn === conn) { room.conns.delete(conn.token); hostSync(); }
  }

  const isOnline = tok => { const e = room && room.conns.get(tok); return !!(e && e.conn.open); };
  function onlineFlags() {
    if (!S) return [];
    return S.players.map(p => p.kind === 'cpu' || p.token === myToken || mode !== 'host' || isOnline(p.token));
  }
  function lobbySeats(forTok) {
    return room.seats.map(s => ({ name: s.name, kind: s.kind, level: s.level || null, online: s.kind === 'cpu' || s.token === myToken || isOnline(s.token), you: s.token === forTok, host: s.token === myToken }));
  }

  function broadcast() {
    if (mode !== 'host') return;
    const flags = onlineFlags();
    for (const [tok, e] of room.conns) {
      if (!e.conn.open) continue;
      try {
        if (room.phase === 'lobby') e.conn.send({ t: 'lobby', code: room.code, seats: lobbySeats(tok), slang: room.slang });
        else e.conn.send({ t: 'game', code: room.code, view: viewFor(S, S.players.findIndex(p => p.token === tok)), online: flags });
      } catch (err) {}
    }
  }
  function hostSync() {
    if (mode !== 'host') return;
    if (room.phase === 'game' && S) afterChange();
    else { saveHost(); broadcast(); renderLobby(); }
  }

  // drop guests that went quiet (closed laptop, lost signal)
  setInterval(() => {
    if (mode !== 'host') return;
    let changed = false;
    for (const [tok, e] of room.conns) if (Date.now() - e.lastSeen > 16000 || !e.conn.open) { try { e.conn.close(); } catch (x) {} room.conns.delete(tok); changed = true; }
    if (changed) hostSync();
  }, 5000);

  function hostStart() {
    if (room.seats.length < 2) { setStatus('lobbyStatus', 'Wait for a friend to join, or add a CPU.', true); return; }
    S = createGame({ seats: room.seats, slang: $('lobbySlang').checked });
    S.turn = Math.floor(Math.random() * S.players.length);
    room.slang = S.slang; room.phase = 'game';
    show('game'); afterChange();
  }
  function hostBackToLobby() {
    room.seats = S.players.filter(p => p.kind === 'cpu' || p.token === myToken || isOnline(p.token))
      .map(p => ({ name: p.name, kind: p.kind, level: p.level, token: p.token }));
    S = null; V = null; room.phase = 'lobby'; clearTimeout(cpuTimer);
    show('lobby'); hostSync();
  }
  function hostRematch() {
    const seats = S.players.map(p => ({ name: p.name, kind: p.kind, level: p.level, token: p.token }));
    S = createGame({ seats, slang: room.slang });
    S.turn = Math.floor(Math.random() * S.players.length);
    afterChange();
  }
  function hostClose() {
    for (const [, e] of room.conns) bye(e.conn, 'The host closed the room.');
    const peer = room.peer;
    store.del('wc.host');
    setTimeout(() => { try { peer && peer.destroy(); } catch (e) {} }, 500);
    goHome('Room closed.');
  }

  /* ---------- guest ---------- */
  function guestJoin(code, rejoin) {
    mode = 'guest';
    guest = { code, peer: null, conn: null, lobby: null, joined: false, lastSeen: 0, closing: false, retry: null, rejoin: !!rejoin, started: Date.now() };
    store.set('wc.guest', { code, at: Date.now() });
    V = null; show('lobby'); renderLobby();
    setStatus('lobbyStatus', `Connecting to room ${code}…`);
    openGuestPeer();
  }
  function openGuestPeer() {
    const g = guest; if (!g) return;
    const peer = new Peer(undefined, peerOpts());
    g.peer = peer;
    peer.on('open', () => connectHost());
    peer.on('disconnected', () => { setTimeout(() => { if (guest === g && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} } }, 2000); });
    peer.on('error', err => {
      if (guest !== g || g.closing) return;
      if (err.type === 'peer-unavailable') {
        if (!g.joined && g.rejoin && Date.now() - g.started < 60000) guestRetry('Waiting for the host to reopen the room…');
        else if (!g.joined) { store.del('wc.guest'); try { peer.destroy(); } catch (e) {} goHome(`No open room with code ${g.code}. Check the code with the host, and make sure their game is open.`, true); }
        else guestRetry('The host is offline. Waiting for them to come back…');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        guestRetry("Can't reach the matchmaking server. Retrying…", true);
      } else console.warn('peer error', err.type, err);
    });
  }
  function connectHost() {
    const g = guest; if (!g || g.closing) return;
    const conn = g.peer.connect(PREFIX + g.code, { reliable: true, serialization: 'json' });
    g.conn = conn; g.lastSeen = Date.now();
    clearTimeout(g.openTimer);
    g.openTimer = setTimeout(() => {   // the host exists but a direct connection never formed
      if (guest !== g || g.closing || g.conn !== conn || conn.open) return;
      g.slowOpens = (g.slowOpens || 0) + 1;
      try { conn.close(); } catch (e) {}
      g.conn = null;
      guestRetry(g.slowOpens >= 2
        ? "Can't connect to the host. A network on one side may be blocking direct connections (some cell and work networks do). Try switching to Wi-Fi. Still trying…"
        : 'Still connecting to the host…');
    }, 15000);
    conn.on('open', () => { clearTimeout(g.openTimer); g.slowOpens = 0; g.lastSeen = Date.now(); conn.send({ t: 'hello', v: PROTO, token: myToken, name: myName }); });
    conn.on('data', d => { if (guest === g) guestMsg(d); });
    conn.on('close', () => { if (guest === g && g.conn === conn) guestLost(); });
    conn.on('error', () => { if (guest === g && g.conn === conn) guestLost(); });
  }
  function guestMsg(d) {
    if (!d || typeof d !== 'object') return;
    guest.lastSeen = Date.now();
    if (d.t === 'lobby') {
      guest.joined = true; guest.lobby = d; V = null;
      guestStatus(''); show('lobby'); renderLobby();
    } else if (d.t === 'game') {
      if (!guest.joined || Date.now() - (guest.savedAt || 0) > 60000) { guest.savedAt = Date.now(); store.set('wc.guest', { code: guest.code, at: Date.now() }); }
      guest.joined = true; guestStatus('');
      if ($('game').hidden) show('game');
      const v = d.view; v.online = d.online; v.code = d.code;
      setView(v);
    } else if (d.t === 'err') { waiting = false; flash(d.msg); render(); }
    else if (d.t === 'bye') { guest.closing = true; store.del('wc.guest'); try { guest.peer.destroy(); } catch (e) {} goHome(d.msg, true); }
  }
  function guestStatus(msg) {
    const b = $('banner'); b.hidden = !msg; b.textContent = msg;
    if (!$('lobby').hidden) setStatus('lobbyStatus', msg);
  }
  function guestLost() {
    if (!guest || guest.closing) return;
    guest.conn = null; waiting = false;
    guestRetry('Lost the connection to the host. Reconnecting…');
    render();
  }
  function guestRetry(msg, rebuildPeer) {
    const g = guest; if (!g || g.closing) return;
    guestStatus(msg);
    clearTimeout(g.retry);
    g.retry = setTimeout(() => {
      if (guest !== g || g.closing) return;
      if (rebuildPeer || g.peer.destroyed) { try { g.peer.destroy(); } catch (e) {} openGuestPeer(); }
      else if (g.peer.disconnected) { try { g.peer.reconnect(); } catch (e) { openGuestPeer(); } }
      else connectHost();
    }, 3500);
  }
  setInterval(() => {
    if (mode !== 'guest' || !guest) return;
    if (guest.conn && guest.conn.open) { try { guest.conn.send({ t: 'ping' }); } catch (e) {} }
    if (guest.conn && guest.conn.open && Date.now() - guest.lastSeen > 16000) { try { guest.conn.close(); } catch (e) {} guestLost(); }
  }, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (mode === 'guest' && guest && !guest.closing) {
      if (guest.conn && guest.conn.open) { try { guest.conn.send({ t: 'ping' }); } catch (e) {} }
      else if (guest.peer) { clearTimeout(guest.retry); guest.retry = null; guestRetryNow(); }
    }
    if (mode === 'host' && room && room.peer && room.peer.disconnected && !room.peer.destroyed) { try { room.peer.reconnect(); } catch (e) {} }
  });
  function guestRetryNow() {
    const g = guest; if (!g || g.closing) return;
    if (g.peer.destroyed) openGuestPeer();
    else if (g.peer.disconnected) { try { g.peer.reconnect(); } catch (e) { openGuestPeer(); } }
    else connectHost();
  }
  function guestLeave() {
    if (guest) {
      guest.closing = true; clearTimeout(guest.retry);
      try { guest.conn && guest.conn.open && guest.conn.send({ t: 'leave' }); } catch (e) {}
      const p = guest.peer; setTimeout(() => { try { p && p.destroy(); } catch (e) {} }, 400);
    }
    store.del('wc.guest');
    goHome('You left the room.');
  }

  /* ---------- lobby ---------- */
  function renderLobby() {
    if ($('lobby').hidden) return;
    const isHost = mode === 'host';
    const code = isHost ? room.code : guest.code;
    const seats = isHost ? lobbySeats(myToken) : (guest.lobby ? guest.lobby.seats : []);
    $('lobbyCode').textContent = code;
    $('lobbyLink').textContent = inviteLink(code);
    $('hostControls').hidden = !isHost;
    if (isHost) $('lobbySlang').checked = room.slang;
    const rows = seats.map((s, i) => {
      const sub = s.kind === 'cpu' ? `CPU · ${LEVEL_NAME[s.level] || ''}` : s.host ? 'Host' : s.online ? 'Ready' : 'Disconnected';
      const dot = s.kind === 'cpu' ? 'cpu' : s.online ? '' : 'off';
      const you = s.you ? ' <span class="you">YOU</span>' : '';
      const remove = isHost && !s.host ? `<button class="linkbtn" type="button" data-kick="${i}">Remove</button>` : '';
      const rename = s.you ? `<button class="linkbtn" type="button" data-rename>Rename</button>` : '';
      return `<li><span class="dot ${dot}"></span><span class="nm">${esc(s.name)}${you}</span><span class="sub">${sub}</span>${rename}${remove}</li>`;
    });
    for (let i = seats.length; i < MAX_SEATS; i++) rows.push(`<li class="open"><span class="dot off"></span><span class="nm">Open seat</span></li>`);
    $('seatList').innerHTML = rows.join('');
    document.querySelectorAll('[data-addcpu]').forEach(b => b.disabled = seats.length >= MAX_SEATS);
    $('btnStart').disabled = seats.length < 2;
    if (!isHost && guest.joined) setStatus('lobbyStatus', `Waiting for ${seats.find(s => s.host)?.name || 'the host'} to start the game.`);
    if (isHost && seats.length < 2 && room.online) setStatus('lobbyStatus', 'Send the code or invite link to your friends. They show up here when they join.');
    else if (isHost && room.online) setStatus('lobbyStatus', '');
  }
  $('lobby').addEventListener('click', e => {
    const k = e.target.closest('[data-kick]');
    if (k && mode === 'host') {
      const s = room.seats[+k.dataset.kick];
      if (s && s.token !== myToken) {
        if (s.kind === 'human') { const c = room.conns.get(s.token); if (c) bye(c.conn, 'The host removed you from the room.'); room.conns.delete(s.token); }
        room.seats.splice(+k.dataset.kick, 1); hostSync();
      }
      return;
    }
    const add = e.target.closest('[data-addcpu]');
    if (add && mode === 'host' && room.seats.length < MAX_SEATS) {
      const level = add.dataset.addcpu, n = room.seats.filter(s => s.kind === 'cpu').length + 1;
      room.seats.push({ name: `CPU ${n} · ${LEVEL_NAME[level]}`, kind: 'cpu', level, token: null }); hostSync();
      return;
    }
    if (e.target.closest('[data-rename]')) openRename();
  });
  $('lobbySlang').addEventListener('change', e => { if (mode === 'host') { room.slang = e.target.checked; hostSync(); } });
  $('btnStart').onclick = () => { if (mode === 'host') hostStart(); };
  async function copyText(text, btn) {
    const label = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch (e) { btn.textContent = 'Select and copy the link'; }
    setTimeout(() => { btn.textContent = label; }, 1800);
  }
  $('btnCopyLink').onclick = e => copyText(inviteLink(mode === 'host' ? room.code : guest.code), e.currentTarget);

  /* ---------- leave / rename ---------- */
  $('btnLeave').onclick = () => {
    if (mode === 'solo') { clearTimeout(cpuTimer); goHome(''); return; }
    if (mode === 'guest') { guestLeave(); return; }
    if (mode === 'host') confirmBox('Close the room?', 'Everyone gets disconnected and the game ends.', 'Close room', hostClose);
  };
  $('btnRename').onclick = () => openRename();

  function confirmBox(title, body, yes, onYes) {
    const ov = $('overlay');
    ov.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cfTitle"><h2 id="cfTitle">${esc(title)}</h2><p>${esc(body)}</p>
      <div class="row-end"><button class="btn" type="button" data-x="no">Cancel</button><button class="btn spray" type="button" data-x="yes">${esc(yes)}</button></div></div>`;
    ov.hidden = false; ov.querySelector('[data-x="no"]').focus();
    ov.onclick = e => { const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return; ov.hidden = true; ov.onclick = null; if (x === 'yes') onYes(); };
  }
  function openRename() {
    const ov = $('overlay');
    ov.innerHTML = `<form class="dialog" role="dialog" aria-modal="true" aria-labelledby="rnTitle" id="renameForm">
      <h2 id="rnTitle">Change your name</h2>
      <div class="inrow"><input class="text" id="renameInput" maxlength="20" value="${esc(myName)}" autocomplete="off"><button class="btn" type="button" data-x="dice">Random</button></div>
      <div class="row-end"><button class="btn" type="button" data-x="no">Cancel</button><button class="btn spray" type="submit">Save</button></div></form>`;
    ov.hidden = false;
    const inp = $('renameInput'); inp.focus(); inp.select();
    ov.onclick = e => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'dice') inp.value = randomName();
      if (x === 'no') { ov.hidden = true; ov.onclick = null; }
    };
    $('renameForm').onsubmit = e => { e.preventDefault(); saveName(inp.value); ov.hidden = true; ov.onclick = null; renderLobby(); render(); };
  }

  /* ---------- board ---------- */
  const boardEl = $('board');
  const cells = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cell'; b.dataset.r = r; b.dataset.c = c;
    const p = PREMIUM[r][c];
    if (r === CENTER && c === CENTER) b.classList.add('star', 'DW');
    else if (p) { b.classList.add(p); b.innerHTML = `<span class="lbl">${p}</span>`; }
    b.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}${p ? ', ' + { TW: 'triple word', DW: 'double word', TL: 'triple letter', DL: 'double letter' }[p] : ''}`);
    boardEl.appendChild(b); cells.push(b);
  }
  const tileHTML = (ch, blank, cls = '') => `<div class="tile ${blank ? 'blank' : ''} ${cls}">${ch.toUpperCase()}<small>${blank ? '' : VALUES[ch]}</small></div>`;

  function render() {
    if (!V || $('game').hidden) return;
    const lastSet = new Set((V.last || []).map(([r, c]) => r + ',' + c));
    for (const el of cells) {
      const r = +el.dataset.r, c = +el.dataset.c, key = r + ',' + c;
      const t = V.board[r][c], p = pending.find(x => x.r === r && x.c === c);
      el.querySelector('.tile')?.remove();
      el.classList.toggle('hasTile', !!(t || p));
      el.classList.toggle('cursor', !!(cursor && cursor.r === r && cursor.c === c && !t && !p));
      el.classList.toggle('down', !!(cursor && cursor.down));
      if (t) el.insertAdjacentHTML('beforeend', tileHTML(t.ch, t.blank, (lastSet.has(key) ? 'last ' : '') + (freshKeys.has(key) ? 'fresh' : '')));
      else if (p) el.insertAdjacentHTML('beforeend', tileHTML(p.ch, p.blank, 'pending'));
    }
    freshKeys = new Set();

    $('scores').innerHTML = V.players.map((p, i) => {
      const on = !V.online || V.online[i] !== false;
      const active = i === V.turn && !V.over;
      const dot = online() ? `<span class="dot ${p.kind === 'cpu' ? 'cpu' : on ? '' : 'off'}" title="${p.kind === 'cpu' ? 'CPU' : on ? 'Connected' : 'Disconnected'}"></span>` : '';
      return `<div class="player ${active ? 'active' : ''} ${i === V.seat ? 'me' : ''}">
        <div class="name">${active ? '<span class="turnmark"></span>' : ''}${dot}${esc(p.name)}${i === V.seat && online() ? ' <span class="you">YOU</span>' : ''}</div>
        <div class="pts">${p.score}${online() ? `<small>${p.tiles} tiles</small>` : ''}</div></div>`;
    }).join('') + `<div class="bagcount"><b>${V.bag}</b>tiles in the bag</div>`;

    const rb = $('roombar');
    if (online()) {
      const code = mode === 'host' ? room.code : guest.code;
      rb.hidden = false;
      rb.innerHTML = `<span>Room <b>${esc(code)}</b></span><button class="linkbtn" type="button" id="btnCopy2">Copy invite link</button>`;
      $('btnCopy2').onclick = e => copyText(inviteLink(code), e.currentTarget);
    } else rb.hidden = true;

    const byId = new Map(V.rack.map(t => [t.id, t]));
    const used = new Set(pending.map(p => p.id));
    $('rack').innerHTML = rackOrder.map(id => byId.get(id)).filter(Boolean).map(t => `
      <button type="button" class="rtile ${used.has(t.id) ? 'used' : ''} ${selected === t.id ? 'sel' : ''} ${swapSel.has(t.id) ? 'swap' : ''}"
        data-id="${t.id}" aria-label="${t.ch === '?' ? 'Blank tile' : t.ch.toUpperCase() + ', ' + VALUES[t.ch] + ' points'}">
        ${t.ch === '?' ? '' : t.ch.toUpperCase()}<small>${t.ch === '?' ? '0' : VALUES[t.ch]}</small></button>`).join('');

    const canAct = myTurn() && lexReady && !waiting;
    $('btnShuffle').disabled = !V.rack.length;
    $('btnRecall').disabled = !pending.length;
    $('btnPass').disabled = !canAct || swapMode;
    $('btnPass').textContent = passArmed ? 'Tap again to pass' : 'Pass';
    $('btnSwap').disabled = !canAct || (V.bag < RACK_SIZE && !swapMode);
    $('btnSwap').textContent = swapMode ? 'Cancel swap' : 'Swap';
    renderPreview();
    renderLog();
  }

  function standings() {
    const ranked = V.players.map((p, i) => ({ ...p, i })).sort((a, b) => b.score - a.score);
    const top = ranked.filter(p => p.score === ranked[0].score);
    if (top.length > 1) return `It's a tie at ${top[0].score} between ${top.map(p => esc(p.name)).join(' and ')}.`;
    const w = top[0];
    return w.i === V.seat ? `You win with ${w.score}.` : `${esc(w.name)} wins with ${w.score}.`;
  }

  function renderPreview() {
    const el = $('preview');
    if (!V) return;
    if (!lexReady) { el.innerHTML = `<div class="msg">Loading the dictionary and Urban Dictionary slang…</div>`; return; }
    if (V.over) {
      let btns = '';
      if (mode === 'solo') btns = `<button class="btn spray" type="button" data-act="again">Play again</button>`;
      if (mode === 'host') btns = `<button class="btn" type="button" data-act="lobby">Back to room</button><button class="btn spray" type="button" data-act="rematch">Rematch</button>`;
      const note = mode === 'guest' ? ' Waiting for the host to start the next game.' : '';
      el.innerHTML = `<div class="msg"><b>Game over.</b> ${standings()}${note}</div><div class="inrow">${btns}</div>`;
      return;
    }
    const err = flashMsg ? `<div class="msg err">${esc(flashMsg)}</div>` : '';
    if (!myTurn()) {
      const cur = V.players[V.turn];
      const off = V.online && V.online[V.turn] === false;
      let extra = '';
      if (off && mode === 'host') extra = `<button class="btn" type="button" data-act="cpuseat">Let the CPU play for ${esc(cur.name)}</button>`;
      el.innerHTML = `<div class="msg">${off ? `${esc(cur.name)} is disconnected. It's their turn.` : cur.kind === 'cpu' ? `${esc(cur.name)} is looking for a play…` : `Waiting on ${esc(cur.name)}…`}${V.seat >= 0 ? ' You can line up your next word in the meantime.' : ''}</div>${extra}`;
      return;
    }
    if (waiting) { el.innerHTML = `<div class="msg">${mode === 'guest' ? 'Sending your play to the host…' : 'Checking your words…'}</div>`; return; }
    if (swapMode) {
      el.innerHTML = `<div class="msg">Tap the tiles you want to throw back. You draw the same number and lose your turn.</div>
        <button class="btn primary" type="button" data-act="doswap" ${swapSel.size ? '' : 'disabled'}>Swap ${swapSel.size || ''} tile${swapSel.size === 1 ? '' : 's'}</button>`;
      return;
    }
    if (!pending.length) {
      const first = V.board.every(r => r.every(x => !x));
      el.innerHTML = err || `<div class="msg">${online() ? "<b>Your turn.</b> " : ''}${first ? 'First word goes across or down through the center star. ' : ''}Drag tiles onto the board, or tap a square and type.</div>`;
      return;
    }
    const res = scoreMove(V.board, pending.map(p => ({ r: p.r, c: p.c, ch: p.ch, blank: p.blank })), lex);
    const toCheck = liveCandidates(res).filter(w => !(liveFailed.get(w) > Date.now() - 10000));
    if (toCheck.length) {
      // wait until typing pauses so each keystroke doesn't trigger a lookup
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => Promise.allSettled(liveCandidates(scoreMove(V.board, pending.map(p => ({ r: p.r, c: p.c, ch: p.ch, blank: p.blank })), lex)).map(lookupUrban)).then(() => render()), 450);
      el.innerHTML = `<div class="words">${res.words.map(w => `<span class="chip">${w.w.toUpperCase()} <b>${w.kind ? w.pts : '…'}</b></span>`).join('')}</div><div class="msg">Checking ${toCheck.map(w => w.toUpperCase()).join(', ')} on Urban Dictionary…</div>`;
      return;
    }
    const failed = liveCandidates(res);
    if (failed.length) { el.innerHTML = `<div class="msg err">Couldn't reach Urban Dictionary to check ${failed.map(w => w.toUpperCase()).join(', ')}. Recall a tile and try again in a few seconds.</div>`; return; }
    const chips = res.words.map(w => `<span class="chip ${w.kind === 2 ? 'ud' : ''}">${w.w.toUpperCase()}${w.kind === 2 ? ' <span class="tag">UD</span>' : ''} <b>${w.pts}</b></span>`).join('');
    const extras = (res.bingo ? `<span class="chip">BINGO <b>+50</b></span>` : '') + (res.cred && res.valid ? `<span class="chip ud">STREET CRED <b>+${res.cred}</b></span>` : '');
    if (!res.valid) {
      let why = res.error;
      if (res.bad && lex.slang) {
        const parts = res.bad.map(W => { const w = W.toLowerCase(); const n = liveDefs.get(w);
          return n == null ? `${W} isn't a word` : `${W} isn't in the dictionary and has ${n} Urban Dictionary definition${n === 1 ? '' : 's'} (needs ${LIVE_MIN_DEFS})`; });
        why = parts.join('. ') + '.';
      }
      el.innerHTML = `<div class="words">${chips}</div><div class="msg err">${esc(why)}</div>`;
    }
    else el.innerHTML = `<div class="words">${chips}${extras}</div>${err}<button class="btn spray" type="button" data-act="play">Play for ${res.total}</button>`;
  }

  const lookup = (w, kind) => kind === 2
    ? `https://www.urbandictionary.com/define.php?term=${encodeURIComponent(w)}`
    : `https://www.merriam-webster.com/dictionary/${encodeURIComponent(w)}`;

  function renderLog() {
    const el = $('log');
    if (!V.log.length) { el.innerHTML = `<li><p class="empty-log">Every play lands here. Tap a word to look it up: slang goes to Urban Dictionary, the rest to Merriam-Webster.</p></li>`; return; }
    el.innerHTML = [...V.log].reverse().slice(0, 80).map(e => {
      const who = e.p >= 0 && V.players[e.p] ? esc(V.players[e.p].name) : '';
      if (e.type === 'play') {
        const ws = e.words.map(w => `<a href="${lookup(w.w, w.kind)}" target="_blank" rel="noopener" class="${w.kind === 2 ? 'ud' : ''}">${esc(String(w.w).toUpperCase())}</a>`).join('');
        const notes = [e.bingo && 'bingo +50', e.cred && `street cred +${e.cred}`].filter(Boolean).join(' · ');
        return `<li><div class="who">${who}</div><div class="total">${e.total}</div><div class="lw">${ws}${notes ? `<span class="note">${notes}</span>` : ''}</div></li>`;
      }
      if (e.type === 'end') return `<li><div class="who">Final count</div><div class="lw note">${esc(e.text)}</div></li>`;
      return `<li><div class="who">${who}</div><div class="lw note">${e.type === 'swap' ? `Swapped ${e.n} tile${e.n === 1 ? '' : 's'}` : 'Passed'}</div><div class="total">0</div></li>`;
    }).join('');
  }

  /* ---------- placing tiles ---------- */
  const rackTile = id => V.rack.find(t => t.id === id);
  const canPlace = () => V && !V.over && V.seat >= 0 && lexReady && !waiting && !swapMode;   // you may arrange tiles while waiting your turn

  function place(id, r, c, letter) {
    if (V.board[r][c] || pending.some(p => p.r === r && p.c === c)) return false;
    const t = rackTile(id); if (!t || pending.some(p => p.id === id)) return false;
    if (t.ch === '?' && !letter) { askBlank(ch => place(id, r, c, ch)); return true; }
    pending.push({ id, r, c, ch: t.ch === '?' ? letter : t.ch, blank: t.ch === '?' });
    selected = null; flashMsg = '';
    render();
    return true;
  }
  function askBlank(cb) {
    const ov = $('overlay');
    ov.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="blankTitle">
      <h2 id="blankTitle">Pick a letter</h2><p>Blank tiles can be any letter and score 0.</p>
      <div class="letters">${LETTERS.split('').map(l => `<button type="button" data-l="${l}">${l.toUpperCase()}</button>`).join('')}</div>
      <div class="row-end"><button class="btn" type="button" data-l="">Cancel</button></div></div>`;
    ov.hidden = false; ov.querySelector('[data-l="a"]').focus();
    ov.onclick = e => {
      const b = e.target.closest('[data-l]'); if (!b) return;
      ov.hidden = true; ov.onclick = null;
      if (b.dataset.l) cb(b.dataset.l); else render();
    };
  }

  boardEl.addEventListener('click', e => {
    const el = e.target.closest('.cell'); if (!el || !canPlace()) return;
    const r = +el.dataset.r, c = +el.dataset.c;
    const i = pending.findIndex(p => p.r === r && p.c === c);
    if (i >= 0) { pending.splice(i, 1); render(); return; }
    if (V.board[r][c]) return;
    if (selected) { place(selected, r, c); return; }
    if (cursor && cursor.r === r && cursor.c === c) cursor.down = !cursor.down;
    else cursor = { r, c, down: cursor ? cursor.down : false };
    render();
  });

  let drag = null;
  $('rack').addEventListener('pointerdown', e => {
    const el = e.target.closest('.rtile'); if (!el || !V) return;
    const id = +el.dataset.id;
    if (pending.some(p => p.id === id)) return;
    drag = { id, x: e.clientX, y: e.clientY, moved: false, el, ghost: null };
    try { el.setPointerCapture(e.pointerId); } catch (x) {}
  });
  $('rack').addEventListener('pointermove', e => {
    if (!drag || swapMode) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
      drag.moved = true;
      const t = rackTile(drag.id); if (!t) return;
      const g = document.createElement('div'); g.className = 'ghost rtile';
      g.innerHTML = `${t.ch === '?' ? '' : t.ch.toUpperCase()}<small>${t.ch === '?' ? 0 : VALUES[t.ch]}</small>`;
      document.body.appendChild(g); drag.ghost = g; drag.el.style.opacity = 0.3;
    }
    if (drag.ghost) { drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px'; }
  });
  const endDrag = e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.ghost) {
      d.ghost.remove(); d.el.style.opacity = '';
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const cell = target && target.closest('.cell');
      const rt = target && target.closest('.rtile');
      if (cell && canPlace()) place(d.id, +cell.dataset.r, +cell.dataset.c);
      else if (rt && +rt.dataset.id !== d.id) {   // drop on another tile to reorder
        const from = rackOrder.indexOf(d.id), to = rackOrder.indexOf(+rt.dataset.id);
        rackOrder.splice(from, 1); rackOrder.splice(to, 0, d.id); render();
      } else render();
      return;
    }
    if (e.type === 'pointercancel') return;
    if (swapMode) { swapSel.has(d.id) ? swapSel.delete(d.id) : swapSel.add(d.id); render(); return; }
    if (!canPlace()) return;
    selected = selected === d.id ? null : d.id;
    if (selected && cursor && !V.board[cursor.r][cursor.c]) { const { r, c } = cursor; if (place(selected, r, c)) advance(); return; }
    render();
  };
  $('rack').addEventListener('pointerup', endDrag);
  $('rack').addEventListener('pointercancel', endDrag);

  function advance() {
    if (!cursor) return;
    let { r, c } = cursor;
    do { cursor.down ? r++ : c++; } while (r < N && c < N && (V.board[r][c] || pending.some(p => p.r === r && p.c === c)));
    if (r < N && c < N) { cursor.r = r; cursor.c = c; } else cursor = null;
    render();
  }

  document.addEventListener('keydown', e => {
    if ($('game').hidden || !canPlace() || !$('overlay').hidden) return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'Enter' && pending.length) { e.preventDefault(); commitPlay(); return; }
    if (e.key === 'Escape') { cursor = null; selected = null; render(); return; }
    if (e.key === 'Backspace' && pending.length) {
      e.preventDefault();
      const p = pending.pop();
      if (cursor) { cursor.r = p.r; cursor.c = p.c; }
      render(); return;
    }
    if (cursor && /^[a-zA-Z]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const L = e.key.toLowerCase();
      const free = rackOrder.map(id => rackTile(id)).filter(t => t && !pending.some(p => p.id === t.id));
      const t = free.find(t => t.ch === L) || free.find(t => t.ch === '?');
      if (!t || V.board[cursor.r][cursor.c]) return;
      e.preventDefault();
      pending.push({ id: t.id, r: cursor.r, c: cursor.c, ch: L, blank: t.ch === '?' });
      advance();
    }
  });

  function commitPlay() {
    if (!myTurn() || !pending.length || waiting) return;
    const res = scoreMove(V.board, pending.map(p => ({ r: p.r, c: p.c, ch: p.ch, blank: p.blank })), lex);
    if (!res.valid) { renderPreview(); return; }
    cursor = null; selected = null;
    doAction({ type: 'play', tiles: pending.map(p => ({ id: p.id, r: p.r, c: p.c, ch: p.ch })) });
  }

  /* ---------- controls ---------- */
  $('btnShuffle').onclick = () => { for (let i = rackOrder.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rackOrder[i], rackOrder[j]] = [rackOrder[j], rackOrder[i]]; } render(); };
  $('btnRecall').onclick = () => { pending = []; render(); };
  let passTimer = null;
  $('btnPass').onclick = () => {
    if (!myTurn() || waiting) return;
    if (!passArmed) { passArmed = true; render(); clearTimeout(passTimer); passTimer = setTimeout(() => { passArmed = false; render(); }, 3000); return; }
    passArmed = false; pending = []; doAction({ type: 'pass' });
  };
  $('btnSwap').onclick = () => { swapMode = !swapMode; swapSel.clear(); pending = []; selected = null; cursor = null; render(); };
  $('preview').addEventListener('click', e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'play') commitPlay();
    if (a === 'doswap' && swapSel.size) doAction({ type: 'swap', ids: [...swapSel] });
    if (a === 'again' && mode === 'solo') { const cpu = S.players[1]; startSolo(cpu.level, S.slang); }
    if (a === 'rematch' && mode === 'host') hostRematch();
    if (a === 'lobby' && mode === 'host') hostBackToLobby();
    if (a === 'cpuseat' && mode === 'host' && S) {
      const p = S.players[S.turn];
      if (p.kind === 'human' && p.token !== myToken) { p.kind = 'cpu'; p.level = 'medium'; afterChange(); }
    }
  });

  $('checkForm').addEventListener('submit', e => {
    e.preventDefault();
    const w = $('checkInput').value.toLowerCase().replace(/[^a-z]/g, '');
    const v = $('verdict');
    if (!w) { v.textContent = ''; return; }
    if (!lexReady) { v.textContent = 'Still loading the word lists.'; return; }
    const W = w.toUpperCase();
    const slangOff = V && !V.slang ? ', but slang is off this game' : '';
    const show = () => {
      const prev = lex.slang; lex.slang = true; const k = lex.kind(w); lex.slang = prev;
      const n = liveDefs.get(w);
      if (k === 1) v.innerHTML = `<span class="yes">${W} is good.</span> It's in the dictionary. <a href="${lookup(w, 1)}" target="_blank" rel="noopener">Definition</a>`;
      else if (k === 2) v.innerHTML = `<span class="yes">${W} is good</span> as Urban Dictionary slang${n != null ? ` (${n} definition${n === 1 ? '' : 's'})` : ''}${slangOff}. <a href="${lookup(w, 2)}" target="_blank" rel="noopener">See it on UD</a>`;
      else if (n != null) v.innerHTML = `<span class="no">${W} doesn't count.</span> It's not in the dictionary, and Urban Dictionary has ${n} definition${n === 1 ? '' : 's'} (needs ${LIVE_MIN_DEFS}).`;
      else v.innerHTML = `<span class="no">${W} doesn't count.</span> It's not in the dictionary.`;
    };
    const prev = lex.slang; lex.slang = true; const known = lex.kind(w); lex.slang = prev;
    if (known || w.length < LIVE_MIN_LEN || UD_BLOCK.test(w) || lex.live.has(w)) return show();
    v.textContent = `Checking ${W} on Urban Dictionary…`;
    lookupUrban(w).then(show, () => { v.innerHTML = `<span class="no">Couldn't reach Urban Dictionary.</span> Try again in a moment.`; });
  });

  // read-only peek for debugging in the browser console: wordCypher.view
  window.wordCypher = { get view() { return V; }, get mode() { return mode; } };

  /* ---------- boot ---------- */
  const joinCode = new URLSearchParams(location.search).get('join');
  goHome('');
  // pick up where you left off if the page reloaded mid-session (phones do this when you switch apps)
  const RESUME_MS = 30 * 60 * 1000;
  const savedHost = store.get('wc.host'), savedGuest = store.get('wc.guest');
  if (!joinCode && typeof Peer !== 'undefined') {
    if (savedHost && savedHost.code && savedHost.at && Date.now() - savedHost.at < RESUME_MS && !(savedHost.S && savedHost.S.over)) hostResume(savedHost);
    else if (savedGuest && savedGuest.code && savedGuest.at && Date.now() - savedGuest.at < RESUME_MS) guestJoin(savedGuest.code, true);
  }
  if (joinCode) {
    $('codeInput').value = joinCode.toUpperCase().slice(0, 5);
    setStatus('homeStatus', 'You were invited to a room. Pick a name, then tap Join.');
    $('nameInput').focus();
  }
  if (typeof Peer === 'undefined') { $('btnHost').disabled = true; setStatus('homeStatus', "Online play couldn't load. You can still play the CPU.", true); }
})();
