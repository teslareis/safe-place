/**
 * Scramble Board — 15x15 tile-placement word game (Turkish tile set), 2 players + spectators.
 * The HOST is authoritative: it owns the bag, both hands, validation, scoring and vetoes.
 *
 * There is NO dictionary. Instead, after a move the opponent may press "Veto Last Move"
 * (only on their own turn, only against the move right before it). A veto fully reverts that move.
 *
 * Messages
 *   client -> host : 'hello', 'submit' {placements:[{i,id,l}]}, 'pass', 'veto', 'reset'
 *   host   -> all  : 'state'  (public: board, scores, turn, counts, last move, event)
 *   host   -> one  : 'hand' {tiles} (secret rack, only to its owner), 'reject' {msg}
 *
 * Rules implemented
 *   - Tiles of one move must lie in one row/column with no gaps, and touch existing tiles
 *     (first move: cover the centre star, >= 2 tiles).
 *   - Score = sum of letter points of every newly formed word (main word + cross words);
 *     letters already on the board count again, jokers count 0. No premium squares.
 *   - Refill to 7 from the bag, turn passes. Veto: points removed, placed tiles return to the
 *     owner's rack, the tiles they drew go back to the bag, the vetoer keeps the turn.
 *   - Game ends when the bag is empty and a player has gone out (after the opponent had the
 *     chance to veto), or after 4 consecutive passes. Leftover tiles are subtracted.
 */
const ScrambleBoard = {
  id: 'scrambleboard',
  name: 'Scramble Board',

  SIZE: 15,
  CENTER: 112,       // (7,7)
  HAND: 7,

  // Standard Turkish distribution: [letter, count, points]  (100 tiles incl. 2 jokers)
  TILES: [
    ['A', 12, 1], ['B', 2, 3], ['C', 2, 4], ['Ç', 2, 4], ['D', 2, 3], ['E', 8, 1], ['F', 1, 7],
    ['G', 1, 5], ['Ğ', 1, 8], ['H', 1, 5], ['I', 4, 2], ['İ', 7, 1], ['J', 1, 10], ['K', 7, 1],
    ['L', 7, 1], ['M', 4, 2], ['N', 5, 1], ['O', 3, 2], ['Ö', 1, 7], ['P', 1, 5], ['R', 6, 1],
    ['S', 3, 2], ['Ş', 2, 4], ['T', 5, 1], ['U', 3, 2], ['Ü', 2, 3], ['V', 1, 7], ['Y', 2, 3],
    ['Z', 2, 4], ['*', 2, 0],
  ],

  start(ctx) {
    this.ctx = ctx;
    this.ALPHABET = this.TILES.filter(t => t[0] !== '*').map(t => t[0]);
    this.hand = [];               // my secret rack (from host)
    this.pending = new Map();     // cell index -> { tile, l }  (not yet submitted)
    this.selected = null;         // selected hand tile id
    this.jokerPick = null;        // { i, tile } waiting for a letter choice
    this.notice = '';
    this.synced = false;          // true after the first state (so late joiners don't hear old events)
    this.wasOver = false;
    this.injectStyles();

    ctx.container.innerHTML = '<div id="scramble-board" class="sb"></div>';
    this.root = ctx.container.firstChild;
    this.root.addEventListener('click', e => this.onClick(e));

    this.state = this.fresh();

    ctx.onMessage((type, data, from) => {
      if (ctx.isHost) {
        switch (type) {
          case 'hello':
            ctx.send('state', this.state, from);
            if (this.hands[from]) ctx.send('hand', { tiles: this.hands[from] }, from);
            break;
          case 'submit': this.submit(from, data && data.placements); break;
          case 'pass':   this.pass(from); break;
          case 'veto':   this.veto(from); break;
          case 'reset':  this.reset(); break;
        }
      } else if (type === 'state') {
        const prevNo = this.state.moveNo;
        this.state = data;
        if (data.moveNo !== prevNo) { this.pending.clear(); this.selected = null; this.jokerPick = null; }
        this.notice = '';
        if (this.synced) this.playEvent();
        else { this.wasOver = data.phase === 'over'; this._lastEventNo = data.event ? data.event.no : undefined; }
        this.synced = true;
        this.render();
      } else if (type === 'hand') {
        this.hand = data.tiles;
        this.prunePending();
        this.render();
      } else if (type === 'reject') {
        this.notice = data.msg;
        this.render();
      }
    });

    ctx.onPlayers(() => {
      if (!ctx.isHost) return this.render();
      const [a, b] = this.ids();
      if (a !== this.state.p1Id || b !== this.state.p2Id) this.reset(); // a duelist joined/left
      else this.render();
    });

    if (ctx.isHost) this.reset();
    else { ctx.send('hello', null, ctx.hostId); this.render(); }
  },

  destroy() {},

  // =====================================================================
  // HOST: authoritative state
  // =====================================================================
  ids() {
    const p = this.ctx.players;
    return [p[0] ? p[0].id : null, p[1] ? p[1].id : null];
  },

  fresh() {
    const [p1Id, p2Id] = this.ctx ? this.ids() : [null, null];
    this.bag = [];
    this.hands = {};
    this.lastPriv = null;           // host-only: data needed to revert the last move
    if (this.ctx && this.ctx.isHost && p1Id && p2Id) {
      let n = 0;
      this.TILES.forEach(([l, count, p]) => {
        for (let k = 0; k < count; k++) this.bag.push({ id: 't' + (n++), l: l === '*' ? '' : l, p, j: l === '*' });
      });
      this.shuffle(this.bag);
      this.hands[p1Id] = this.bag.splice(0, this.HAND);
      this.hands[p2Id] = this.bag.splice(0, this.HAND);
    }
    return {
      p1Id, p2Id,
      board: Array(this.SIZE * this.SIZE).fill(null),
      scores: [0, 0],
      turn: p1Id,                                   // host starts
      phase: p1Id && p2Id ? 'play' : 'waiting',     // waiting | play | over
      bagCount: this.bag.length,
      handCounts: [this.hands[p1Id] ? this.HAND : 0, this.hands[p2Id] ? this.HAND : 0],
      last: null,                                   // public view of the vetoable move {by, score, cells, words}
      moveNo: 0,
      event: null,                                  // {no, type:'move'|'veto'|'pass', ...} for log + sounds
      passes: 0,
      winner: null,                                 // player id | 'draw'
    };
  },

  reset() {
    this.state = this.fresh();
    this.pending.clear(); this.selected = null; this.jokerPick = null; this.notice = '';
    this.wasOver = false;
    this.commit();
  },

  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  other(id) { return id === this.state.p1Id ? this.state.p2Id : this.state.p1Id; },
  sideOf(id) { return id === this.state.p1Id ? 0 : 1; },

  /** Broadcast: private racks first, then public state. */
  commit() {
    const s = this.state, ctx = this.ctx;
    s.bagCount = this.bag.length;
    s.handCounts = [
      (this.hands[s.p1Id] || []).length,
      (this.hands[s.p2Id] || []).length,
    ];
    [s.p1Id, s.p2Id].forEach(id => {
      if (id && id !== ctx.myId) ctx.send('hand', { tiles: this.hands[id] || [] }, id);
    });
    ctx.send('state', s);
    this.hand = this.hands[ctx.myId] || [];
    this.prunePending();
    if (s.moveNo !== this._lastRenderedNo) { this.pending.clear(); this.selected = null; this.jokerPick = null; }
    this._lastRenderedNo = s.moveNo;
    this.playEvent();
    this.render();
  },

  reject(to, msg) {
    if (to === this.ctx.myId) { this.notice = msg; this.render(); }
    else this.ctx.send('reject', { msg }, to);
  },

  // ---- geometry helpers ----
  neighbors(i) {
    const n = this.SIZE, r = Math.floor(i / n), c = i % n, out = [];
    if (r > 0) out.push(i - n);
    if (r < n - 1) out.push(i + n);
    if (c > 0) out.push(i - 1);
    if (c < n - 1) out.push(i + 1);
    return out;
  },

  /** Cells of the run through `i` on axis 'h'/'v' (null if shorter than 2). */
  wordAt(b, i, axis) {
    const n = this.SIZE;
    let r = Math.floor(i / n), c = i % n;
    const dr = axis === 'v' ? 1 : 0, dc = axis === 'h' ? 1 : 0;
    while (r - dr >= 0 && c - dc >= 0 && b[(r - dr) * n + (c - dc)]) { r -= dr; c -= dc; }
    const cells = [];
    while (r < n && c < n && b[r * n + c]) { cells.push(r * n + c); r += dr; c += dc; }
    return cells.length > 1 ? cells : null;
  },

  // ---- Submit Move ----
  submit(from, placements) {
    const s = this.state, n = this.SIZE;
    const fail = msg => this.reject(from, msg);
    if (s.phase !== 'play' || from !== s.turn) return fail('It is not your turn.');
    if (!Array.isArray(placements) || !placements.length || placements.length > this.HAND) return fail('Place at least one tile.');

    const hand = this.hands[from] || [];
    const used = new Set(), cells = new Set(), placed = [];
    for (const p of placements) {
      const i = p && p.i;
      if (!Number.isInteger(i) || i < 0 || i >= n * n || s.board[i] || cells.has(i)) return fail('Invalid square.');
      const t = hand.find(t => t.id === p.id);
      if (!t || used.has(t.id)) return fail('Invalid tile.');
      let letter = t.l;
      if (t.j) {
        if (!this.ALPHABET.includes(p.l)) return fail('Choose a letter for the joker.');
        letter = p.l;
      }
      cells.add(i); used.add(t.id);
      placed.push({ i, orig: t, tile: { id: t.id, l: letter, p: t.p, j: t.j } });
    }

    // 1) one straight line, no gaps
    const rows = new Set(placed.map(x => Math.floor(x.i / n)));
    const cols = new Set(placed.map(x => x.i % n));
    if (rows.size > 1 && cols.size > 1) return fail('Tiles must be in a single row or column.');
    const b = s.board.slice();
    placed.forEach(x => { b[x.i] = x.tile; });
    if (placed.length > 1) {
      if (rows.size === 1) {
        const r = [...rows][0], cs = [...cols];
        for (let c = Math.min(...cs); c <= Math.max(...cs); c++) if (!b[r * n + c]) return fail('There must be no gaps between your tiles.');
      } else {
        const c = [...cols][0], rs = [...rows];
        for (let r = Math.min(...rs); r <= Math.max(...rs); r++) if (!b[r * n + c]) return fail('There must be no gaps between your tiles.');
      }
    }

    // 2) first move on the star / later moves must connect
    const boardEmpty = s.board.every(c => !c);
    if (boardEmpty) {
      if (!cells.has(this.CENTER)) return fail('The first word must cover the centre star.');
      if (placed.length < 2) return fail('The first word needs at least 2 tiles.');
    } else if (!placed.some(x => this.neighbors(x.i).some(k => s.board[k]))) {
      return fail('Your tiles must connect to the tiles on the board.');
    }

    // 3) every newly formed word (main + cross words)
    const words = new Map();
    placed.forEach(x => ['h', 'v'].forEach(axis => {
      const w = this.wordAt(b, x.i, axis);
      if (w) words.set(axis + w[0], w);
    }));
    if (!words.size) return fail('Your tiles must form a word of at least 2 letters.');

    let score = 0;
    const wordStrs = [];
    words.forEach(w => {
      wordStrs.push(w.map(k => b[k].l).join(''));
      w.forEach(k => { score += b[k].p; });
    });

    // ---- apply ----
    placed.forEach(x => { s.board[x.i] = x.tile; });
    const rack = hand.filter(t => !used.has(t.id));
    const drawn = this.bag.splice(0, Math.min(this.HAND - rack.length, this.bag.length));
    this.hands[from] = rack.concat(drawn);
    s.scores[this.sideOf(from)] += score;
    s.last = { by: from, score, cells: placed.map(x => x.i), words: wordStrs };
    this.lastPriv = { by: from, placed: placed.map(x => ({ i: x.i, orig: x.orig })), drawn, score };
    s.passes = 0;
    s.moveNo++;
    s.event = { no: s.moveNo, type: 'move', by: from, score, words: wordStrs };
    s.turn = this.other(from);
    this.checkEnd(from);
    this.commit();
  },

  // ---- Veto Last Move ----
  veto(from) {
    const s = this.state, lp = this.lastPriv;
    if (s.phase !== 'play' || from !== s.turn) return this.reject(from, 'You can only veto on your own turn.');
    if (!lp || lp.by === from) return this.reject(from, 'There is no opponent move to veto.');

    lp.placed.forEach(x => { s.board[x.i] = null; });              // tiles leave the board
    s.scores[this.sideOf(lp.by)] -= lp.score;                      // points subtracted
    const drawnIds = new Set(lp.drawn.map(t => t.id));
    const rack = (this.hands[lp.by] || []).filter(t => !drawnIds.has(t.id));
    this.hands[lp.by] = rack.concat(lp.placed.map(x => x.orig));   // tiles return to their owner
    this.bag.push(...lp.drawn);                                    // replacement tiles go back to the bag
    this.shuffle(this.bag);

    s.last = null; this.lastPriv = null;
    s.passes = 0;
    s.moveNo++;
    s.event = { no: s.moveNo, type: 'veto', by: from, against: lp.by, score: lp.score };
    // the vetoed player lost their turn: it stays with the vetoer
    this.commit();
  },

  pass(from) {
    const s = this.state;
    if (s.phase !== 'play' || from !== s.turn) return this.reject(from, 'It is not your turn.');
    s.passes++;
    s.last = null; this.lastPriv = null;                           // passing forfeits the right to veto
    s.moveNo++;
    s.event = { no: s.moveNo, type: 'pass', by: from };
    s.turn = this.other(from);
    this.checkEnd(from);
    this.commit();
  },

  /** After `actor` finished a move/pass: has the game ended? */
  checkEnd(actor) {
    const s = this.state, opp = this.other(actor);
    const oppEmpty = (this.hands[opp] || []).length === 0;
    if (s.passes >= 4 || (this.bag.length === 0 && oppEmpty)) this.finish();
  },

  finish() {
    const s = this.state;
    const left = [s.p1Id, s.p2Id].map(id => (this.hands[id] || []).reduce((a, t) => a + t.p, 0));
    const empty = [s.p1Id, s.p2Id].map(id => (this.hands[id] || []).length === 0);
    s.scores[0] -= left[0];
    s.scores[1] -= left[1];
    if (empty[0]) s.scores[0] += left[1];
    if (empty[1]) s.scores[1] += left[0];
    s.phase = 'over';
    s.winner = s.scores[0] === s.scores[1] ? 'draw' : (s.scores[0] > s.scores[1] ? s.p1Id : s.p2Id);
    s.last = null; this.lastPriv = null;
  },

  // =====================================================================
  // CLIENT / UI
  // =====================================================================
  nameOf(id) { const p = this.ctx.players.find(p => p.id === id); return p ? p.name : 'Player'; },
  esc(t) { return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

  prunePending() {
    const ids = new Set(this.hand.map(t => t.id));
    this.pending.forEach((v, i) => { if (!ids.has(v.tile.id)) this.pending.delete(i); });
    if (this.selected && !ids.has(this.selected)) this.selected = null;
  },

  playEvent() {
    const e = this.state.event;
    if (e && e.no !== this._lastEventNo) {
      this._lastEventNo = e.no;
      if (e.type === 'move') GameAudio.playFill(1);       // submit
      else if (e.type === 'veto') GameAudio.playError();  // veto
    }
    const over = this.state.phase === 'over';
    if (over && !this.wasOver) GameAudio.playWin();
    this.wasOver = over;
  },

  isMyTurn() {
    const s = this.state;
    return s.phase === 'play' && s.turn === this.ctx.myId;
  },

  // ---- input (delegated) ----
  onClick(e) {
    const el = e.target.closest('[data-cell],[data-tile],[data-act],[data-letter]');
    if (!el) return;
    const s = this.state, me = this.ctx.myId, host = this.ctx.isHost;
    const send = (type, data) => this.ctx.send(type, data, this.ctx.hostId);

    if (el.dataset.letter !== undefined) {                 // joker letter chosen
      const jp = this.jokerPick;
      if (!jp) return;
      this.pending.set(jp.i, { tile: jp.tile, l: el.dataset.letter });
      this.jokerPick = null; this.selected = null;
      GameAudio.playReady();                               // tile drop
      return this.render();
    }

    if (el.dataset.tile) {                                 // pick a tile from the rack
      if (!this.isMyTurn()) return;
      this.selected = this.selected === el.dataset.tile ? null : el.dataset.tile;
      return this.render();
    }

    if (el.dataset.cell !== undefined) {                   // board square
      if (!this.isMyTurn()) return;
      const i = Number(el.dataset.cell);
      if (s.board[i]) return;
      if (this.pending.has(i)) { this.pending.delete(i); return this.render(); } // pick it back up
      if (!this.selected) return;
      const tile = this.hand.find(t => t.id === this.selected);
      if (!tile) return;
      if (tile.j) { this.jokerPick = { i, tile }; return this.render(); }         // ask which letter
      this.pending.set(i, { tile, l: tile.l });
      this.selected = null;
      GameAudio.playReady();                               // tile drop
      return this.render();
    }

    switch (el.dataset.act) {
      case 'recall':
        this.pending.clear(); this.selected = null; this.jokerPick = null;
        return this.render();
      case 'shuffle':
        this.shuffle(this.hand);
        if (window.GameAudio) GameAudio.playReady();
        return this.render();
      case 'cancel-joker':
        this.jokerPick = null; return this.render();
      case 'submit': {
        if (!this.isMyTurn() || !this.pending.size) return;
        const placements = [...this.pending].map(([i, v]) => ({ i, id: v.tile.id, l: v.l }));
        this.notice = '';
        if (host) this.submit(me, placements); else send('submit', { placements });
        return;
      }
      case 'pass': if (host) this.pass(me); else send('pass'); return;
      case 'veto': if (host) this.veto(me); else send('veto'); return;
      case 'again': if (host) this.reset(); else send('reset'); return;
    }
  },

  // ---- rendering ----
  render() {
    const s = this.state, me = this.ctx.myId, esc = t => this.esc(t);
    const iPlay = me === s.p1Id || me === s.p2Id;
    const myTurn = this.isMyTurn();
    const pendIds = new Set([...this.pending.values()].map(v => v.tile.id));
    const rack = this.hand.filter(t => !pendIds.has(t.id));
    const lastCells = new Set(s.last ? s.last.cells : []);

    // ----- board -----
    let boardHtml = '';
    for (let i = 0; i < s.board.length; i++) {
      const t = s.board[i], pend = this.pending.get(i);
      let inner = '', cls = 'sb-cell';
      if (t) {
        inner = `<div class="sb-tile${t.j ? ' joker' : ''}${lastCells.has(i) ? ' last' : ''}">${esc(t.l)}<sub>${t.p || ''}</sub></div>`;
      } else if (pend) {
        inner = `<div class="sb-tile pending${pend.tile.j ? ' joker' : ''}">${esc(pend.l)}<sub>${pend.tile.p || ''}</sub></div>`;
      } else {
        if (i === this.CENTER) { cls += ' star'; inner = '★'; }
        if (myTurn && this.selected) cls += ' drop';
      }
      boardHtml += `<div class="${cls}" data-cell="${i}">${inner}</div>`;
    }

    // ----- player columns -----
    const col = side => {
      const id = side === 0 ? s.p1Id : s.p2Id;
      const isTurn = s.phase === 'play' && id && s.turn === id;
      const canVeto = s.phase === 'play' && s.last && s.last.by === id && me !== id && iPlay && s.turn === me;
      return `<div class="sb-col sb-col--${side + 1}${isTurn ? ' turn' : ''}${s.winner === id ? ' winner' : ''}">
        <div class="sb-pname">${id ? esc(this.nameOf(id)) + (id === me ? ' (you)' : '') : 'Waiting…'}</div>
        <div class="sb-pscore">${s.scores[side]}</div>
        <div class="sb-pmeta">${isTurn ? '▶ playing' : '&nbsp;'}</div>
        <div class="sb-stat"><span>Bag</span><b>${s.bagCount}</b></div>
        <div class="sb-stat"><span>Tiles in rack</span><b>${s.handCounts[side]}</b></div>
        ${canVeto ? `<div class="sb-lastinfo">${esc(s.last.words.join(', '))} (+${s.last.score})</div>
          <button class="sb-btn sb-btn--veto" data-act="veto">Veto Last Move</button>` : ''}
      </div>`;
    };

    // ----- status line -----
    let status;
    if (s.phase === 'waiting') status = 'Waiting for a second player…';
    else if (s.phase === 'over') {
      status = s.winner === 'draw' ? "It's a draw! 🤝"
        : `🏆 ${s.winner === me ? 'You win!' : esc(this.nameOf(s.winner)) + ' wins!'}`;
    } else if (myTurn) status = 'Your turn — pick a tile, then a square.';
    else status = iPlay ? `${esc(this.nameOf(s.turn))} is thinking…` : `${esc(this.nameOf(s.turn))} is playing`;

    let log = '';
    const ev = s.event;
    if (ev) {
      if (ev.type === 'move') log = `${esc(this.nameOf(ev.by))} played <b>${esc(ev.words.join(', '))}</b> (+${ev.score})`;
      else if (ev.type === 'veto') log = `⚠️ ${esc(this.nameOf(ev.by))} vetoed ${esc(this.nameOf(ev.against))}'s move (−${ev.score})`;
      else if (ev.type === 'pass') log = `${esc(this.nameOf(ev.by))} passed`;
    }

    // ----- rack + controls (bottom center of board container) -----
    let rackHtml = '';
    if (iPlay && s.phase !== 'waiting') {
      rackHtml = `
        <div class="sb-dock">
          <div class="sb-rack${myTurn ? '' : ' idle'}">` +
            rack.map(t => `<button class="sb-tile hand${t.j ? ' joker' : ''}${this.selected === t.id ? ' sel' : ''}" data-tile="${t.id}" ${myTurn ? '' : 'disabled'}>${t.j ? '★' : esc(t.l)}<sub>${t.p || ''}</sub></button>`).join('') +
          `</div>
          <div class="sb-controls">
            <button class="sb-btn" data-act="recall" ${myTurn && this.pending.size ? '' : 'disabled'}>Recall</button>
            <button class="sb-btn" data-act="shuffle" ${rack.length > 1 ? '' : 'disabled'}>Shuffle</button>
            <button class="sb-btn sb-btn--go" data-act="submit" ${myTurn && this.pending.size ? '' : 'disabled'}>Submit Move</button>
            <button class="sb-btn sb-btn--ghost" data-act="pass" ${myTurn ? '' : 'disabled'}>Pass</button>
          </div>
        </div>`;
    }
    if (s.phase === 'over' && iPlay) {
      rackHtml = `<div class="sb-dock"><div class="sb-controls"><button class="sb-btn sb-btn--go" data-act="again">Play again</button></div></div>`;
    }

    // ----- joker letter picker -----
    const picker = this.jokerPick ? `<div class="sb-picker"><div>Joker — choose a letter:</div>
      <div class="sb-letters">${this.ALPHABET.map(l => `<button class="sb-letter" data-letter="${l}">${l}</button>`).join('')}</div>
      <button class="sb-btn sb-btn--ghost" data-act="cancel-joker">Cancel</button></div>` : '';

    this.root.innerHTML = `
      ${col(0)}
      <div class="sb-center">
        <div class="sb-info">
          <div class="sb-status">${status}</div>
          <div class="sb-log">${log || '&nbsp;'}</div>
          ${this.notice ? `<div class="sb-notice">${esc(this.notice)}</div>` : ''}
        </div>
        <div class="sb-board-wrap">
          <div class="sb-board">${boardHtml}</div>
          ${picker}
        </div>
        ${rackHtml}
      </div>
      ${col(1)}`;
  },

  // ---- styles ----
  injectStyles() {
    let st = document.getElementById('sb-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'sb-style';
      document.head.appendChild(st);
    }
    st.textContent = `
      .sb {
        width: 100%;
        height: 100%;
        max-height: 100%;
        min-height: 0;
        padding: 4px 10px 6px;
        box-sizing: border-box;
        display: grid;
        grid-template-columns: minmax(150px, 210px) minmax(0, 1fr) minmax(150px, 210px);
        gap: clamp(10px, 1.6vw, 18px);
        align-items: start;
        color: #e8ecf7;
        overflow: hidden;
      }
      @media (max-width: 900px) {
        .sb { grid-template-columns: 1fr 1fr; overflow-y: auto; }
        .sb-center { grid-column: 1 / -1; order: -1; }
      }

      .sb-col {
        background: #0f1629;
        border: 1px solid #25304b;
        border-radius: 12px;
        padding: clamp(10px, 1.4vh, 14px);
        margin-top: 2px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        box-sizing: border-box;
        max-width: 100%;
      }
      .sb-col--1 { border-color: #2aa7c988; }
      .sb-col--2 { border-color: #ff3d7f88; }
      .sb-col.turn { box-shadow: 0 0 16px #ffc92844; }
      .sb-col.winner { border-color: #2ee08a; box-shadow: 0 0 20px #2ee08a66; }
      .sb-pname { font-weight: 800; font-size: clamp(.82rem, 1.4vh, .95rem); overflow-wrap: anywhere; }
      .sb-pscore { font-size: clamp(1.6rem, 3.2vh, 2.5rem); font-weight: 900; line-height: 1; }
      .sb-col--1 .sb-pscore { color: #6fc3ff; }
      .sb-col--2 .sb-pscore { color: #ff7fa8; }
      .sb-pmeta { font-size: .72rem; color: #ffd966; min-height: 1em; }
      .sb-stat { display: flex; justify-content: space-between; background: #141d36; border-radius: 8px; padding: 5px 10px; font-size: .78rem; color: #9aa6c6; }
      .sb-stat b { color: #fff; }
      .sb-lastinfo { font-size: .74rem; color: #ffd966; overflow-wrap: anywhere; }

      .sb-center {
        height: 100%;
        max-height: 100%;
        min-height: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: space-between;
        gap: clamp(4px, 0.7vh, 8px);
        min-width: 0;
        box-sizing: border-box;
        overflow: hidden;
      }

      .sb-info {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        width: 100%;
      }
      .sb-status { font-weight: 800; font-size: clamp(.82rem, 1.5vh, 1rem); text-align: center; line-height: 1.2; }
      .sb-log { font-size: clamp(.7rem, 1.2vh, .8rem); color: #9aa6c6; text-align: center; min-height: 1.1em; line-height: 1.2; }
      .sb-notice { font-size: .76rem; color: #ff7b7b; font-weight: 700; text-align: center; }

      .sb-board-wrap {
        position: relative;
        flex: 1 1 0;
        min-height: 0;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }

      .sb-board {
        display: grid;
        grid-template-columns: repeat(15, 1fr);
        grid-template-rows: repeat(15, 1fr);
        gap: 2px;
        padding: 5px;
        background: #0b1020;
        border: 1px solid #25304b;
        border-radius: 10px;
        aspect-ratio: 1 / 1;
        height: 100%;
        max-height: min(100%, calc(100dvh - var(--header-height, 118px) - 168px));
        width: auto;
        max-width: 100%;
        box-sizing: border-box;
        user-select: none;
      }

      .sb-cell {
        aspect-ratio: 1;
        background: #141a2e;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: clamp(.48rem, 1.05vh, .9rem);
        color: #ff5c8a66;
        position: relative;
        min-width: 0;
        min-height: 0;
      }
      .sb-cell.star { background: #241a2e; }
      .sb-cell.drop { cursor: pointer; outline: 1px dashed #6c8cff55; }
      .sb-cell.drop:hover { background: #6c8cff33; }

      .sb-tile {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        padding: 0;
        font-weight: 800;
        font-size: clamp(.6rem, 1.45vh, 1.15rem);
        color: #2b1c00;
        background: linear-gradient(145deg, #f6dfae, #d6a84f);
        border: 1px solid #fff0c4;
        border-radius: 4px;
        box-sizing: border-box;
      }
      .sb-tile sub { position: absolute; right: 2px; bottom: 0; font-size: .5em; font-weight: 700; line-height: 1; }
      .sb-tile.last { box-shadow: 0 0 0 2px #ffc928, 0 0 8px #ffc928aa; }
      .sb-tile.pending { background: linear-gradient(145deg, #bcd2ff, #6c8cff); border-color: #e6efff; color: #0a1a44; cursor: pointer; }
      .sb-tile.joker { color: #a3125a; }

      .sb-dock {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: clamp(5px, 0.8vh, 8px);
        width: 100%;
        padding-bottom: 2px;
        box-sizing: border-box;
        z-index: 5;
      }

      .sb-rack {
        display: flex;
        gap: 6px;
        justify-content: center;
        align-items: center;
        padding: clamp(5px, 0.8vh, 8px) 10px;
        background: #0f1629;
        border: 1px solid #25304b;
        border-radius: 12px;
        min-height: clamp(46px, 6.8vh, 58px);
        max-width: 100%;
        box-sizing: border-box;
      }
      .sb-rack.idle { opacity: .65; }
      .sb-tile.hand {
        width: clamp(34px, 5.2vh, 48px);
        height: clamp(34px, 5.2vh, 48px);
        font-size: clamp(.95rem, 2vh, 1.35rem);
        border-radius: 6px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .sb-tile.hand:disabled { cursor: default; }
      .sb-tile.hand.sel { transform: translateY(-5px); box-shadow: 0 0 0 2px #6c8cff, 0 6px 12px #0008; }

      .sb-controls {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        width: 100%;
      }
      .sb-btn {
        cursor: pointer;
        border: 1px solid #2d3243;
        border-radius: 9px;
        padding: clamp(6px, 1vh, 9px) clamp(12px, 1.6vw, 18px);
        font-size: clamp(.78rem, 1.35vh, .88rem);
        font-weight: 700;
        color: #e8eaf0;
        background: #222633;
        line-height: 1.1;
      }
      .sb-btn:hover:not(:disabled) { filter: brightness(1.2); }
      .sb-btn:disabled { opacity: .4; cursor: not-allowed; }
      .sb-btn--go { background: linear-gradient(90deg, #25d6c4, #2ee08a); color: #06241e; border: none; }
      .sb-btn--ghost { background: transparent; }
      .sb-btn--veto { background: #3a1218; color: #ff7b7b; border-color: #ff5c5c88; width: 100%; margin-top: 2px; }

      .sb-picker {
        position: absolute;
        inset: auto 12px 12px 12px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 12px;
        background: #0f1629ee;
        backdrop-filter: blur(4px);
        border: 2px solid #d9a92c;
        border-radius: 12px;
        z-index: 10;
        box-shadow: 0 12px 32px #000c;
      }
      .sb-letters { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; max-width: 420px; }
      .sb-letter { width: 32px; height: 32px; cursor: pointer; font-weight: 800; color: #2b1c00; background: linear-gradient(145deg, #f6dfae, #d6a84f); border: 1px solid #fff0c4; border-radius: 6px; }
    `;
  },
};

GameHub.register(ScrambleBoard);
