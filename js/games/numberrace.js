/**
 * Number Race (Sayı Yarışı) — 1v1, extra players spectate. Host owns all state.
 *
 * Roles: P1 = host (players[0], left, blue), P2 = first client (players[1], right, pink).
 *
 * Round flow
 *   'pick'      Filler picks a target (1-64) on an ordered 8x8 grid and presses HAZIRIM!.
 *               Seeker presses HAZIRIM!. Target stays secret until both are ready.
 *   'countdown' Full-screen "both ready" overlay for 2.5s.
 *   'race'      Filler marks ANY empty cell on their 10x10 sheet (free-form).
 *               Seeker hunts the target on a shuffled 8x8 (1-64) board; used numbers are crossed out.
 *               Correct click => roles swap, target is added to `used`, next round.
 *   'over'      First sheet to reach 100 wins.
 *
 * Messages
 *   client -> host : 'hello', 'lock' {n}, 'ready', 'fill' {i}, 'seek' {n}, 'reset'
 *   host   -> all  : 'state' (full), 'cell' {side, i} (one cell was filled)
 */
const NumberRace = {
  id: 'numberrace',
  name: 'Number Race',

  CELLS: 100,        // 10x10 sheet
  MAXNUM: 64,        // targets 1..64 (8x8)
  OVERLAY_MS: 2500,
  COMBO_WINDOW_MS: 1000,   // pause longer than this resets the fill combo

  start(ctx) {
    this.ctx = ctx;
    this.selected = null;     // picker's local (not yet locked) choice
    this.combo = 0;           // Filler's local fill streak (drives playFill pitch)
    this.lastFill = 0;
    this.winSounded = false;
    this.centerKey = null;
    this.timer = null;
    this.overlay = null;
    this.state = this.fresh();
    this.injectStyles();
    this.build();

    ctx.onMessage((type, data, from) => {
      if (ctx.isHost) {
        switch (type) {
          case 'hello': ctx.send('state', this.pub(), from); break;
          case 'lock':  this.lock(from, data && data.n); break;
          case 'ready': this.ready(from); break;
          case 'fill':  this.fill(from, data && data.i); break;
          case 'seek':  this.seek(from, data && data.n); break;
          case 'reset': this.reset(); break;
        }
      } else if (type === 'state') {
        if (data.round !== this.state.round || data.phase !== 'pick') this.selected = null;
        this.state = data;
        this.render();
      } else if (type === 'cell') {
        this.state[data.side === 1 ? 'c1' : 'c2'][data.i] = 1;
        this.paintCell(data.side, data.i);
        this.paintMeta();
        const mine = data.side === 1 ? this.state.p1Id : this.state.p2Id;
        if (mine === ctx.myId) this.comboHit();      // host confirmed MY fill
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

  destroy() {
    clearTimeout(this.timer);
    this.removeOverlay();
  },

  // ================= host-authoritative state =================
  ids() {
    const p = this.ctx.players;
    return [p[0] ? p[0].id : null, p[1] ? p[1].id : null];
  },

  fresh() {
    const [p1Id, p2Id] = this.ctx ? this.ids() : [null, null];
    return {
      p1Id, p2Id,
      c1: Array(this.CELLS).fill(0),     // exact cells filled by P1 / P2
      c2: Array(this.CELLS).fill(0),
      filler: p1Id,                      // host starts as Filler
      phase: p1Id && p2Id ? 'pick' : 'waiting',
      round: 1,
      target: null, board: null,
      used: [],                          // targets already found in earlier rounds
      fillerReady: false, seekerReady: false,
      roundFilled: 0, lastResult: null,  // lastResult: {target, filled}
      winner: null,
    };
  },

  /** What clients may see: the target/board stay hidden until the countdown. */
  pub() {
    const s = this.state, hide = s.phase === 'pick' || s.phase === 'waiting';
    return { ...s, target: hide ? null : s.target, board: hide ? null : s.board };
  },

  commit() { this.ctx.send('state', this.pub()); this.render(); },

  reset() {
    clearTimeout(this.timer);
    this.selected = null;
    this.state = this.fresh();
    this.commit();
  },

  seekerId() { const s = this.state; return s.filler === s.p1Id ? s.p2Id : s.p1Id; },

  lock(from, n) {
    const s = this.state;
    n = Number(n);
    if (s.phase !== 'pick' || from !== s.filler || s.fillerReady) return;
    if (!Number.isInteger(n) || n < 1 || n > this.MAXNUM || s.used.includes(n)) return;
    s.target = n;
    s.fillerReady = true;
    this.maybeStart();
    this.commit();
  },

  ready(from) {
    const s = this.state;
    if (s.phase !== 'pick' || from !== this.seekerId() || s.seekerReady) return;
    s.seekerReady = true;
    this.maybeStart();
    this.commit();
  },

  maybeStart() {
    const s = this.state;
    if (!(s.fillerReady && s.seekerReady)) return;
    s.phase = 'countdown';
    s.board = this.shuffled();
    clearTimeout(this.timer);
    const round = s.round;
    this.timer = setTimeout(() => {
      if (this.state.phase === 'countdown' && this.state.round === round) {
        this.state.phase = 'race';
        this.commit();
      }
    }, this.OVERLAY_MS);
  },

  // Filler marks one specific empty cell
  fill(from, i) {
    const s = this.state;
    if (s.phase !== 'race' || from !== s.filler) return;
    if (!Number.isInteger(i) || i < 0 || i >= this.CELLS) return;
    const side = from === s.p1Id ? 1 : 2;
    const arr = side === 1 ? s.c1 : s.c2;
    if (arr[i]) return;                       // only unfilled cells count
    arr[i] = 1;
    s.roundFilled++;
    if (arr.every(Boolean)) {
      s.phase = 'over';
      s.winner = from;
      this.commit();
    } else {
      this.ctx.send('cell', { side, i });
      this.paintCell(side, i);
      this.paintMeta();
      if (from === this.ctx.myId) this.comboHit();   // host is the Filler
    }
  },

  /** Local combo for the Filler: +1 per accepted fill, reset after >1s of inactivity. */
  comboHit() {
    const now = Date.now();
    if (now - this.lastFill > this.COMBO_WINDOW_MS) this.combo = 0;
    this.combo++;
    this.lastFill = now;
    GameAudio.playFill(this.combo);
  },

  // Seeker clicked a number: validate, then swap roles
  seek(from, n) {
    const s = this.state;
    n = Number(n);
    if (s.phase !== 'race' || from !== this.seekerId()) return;
    if (n !== s.target || s.used.includes(n)) return;
    s.used.push(n);
    s.lastResult = { target: n, filled: s.roundFilled };
    s.roundFilled = 0;
    s.round++;
    s.filler = from;                          // seeker becomes the new Filler
    s.phase = 'pick';
    s.target = null; s.board = null;
    s.fillerReady = false; s.seekerReady = false;
    this.selected = null;
    this.commit();
  },

  shuffled() {
    const a = Array.from({ length: this.MAXNUM }, (_, i) => i + 1);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // ================= UI =================
  nameOf(id) { const p = this.ctx.players.find(p => p.id === id); return p ? p.name : '—'; },
  esc(t) { return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  count(arr) { let n = 0; for (let i = 0; i < arr.length; i++) n += arr[i]; return n; },

  build() {
    this.ctx.container.innerHTML = `
      <div class="nr">
        ${[1, 2].map(side => `
          <section class="nr-col nr-col--${side}" data-side="${side}">
            <header><span class="nr-title"></span><span class="nr-badge"></span></header>
            <div class="nr-prog"><i></i></div>
            <div class="nr-grid"></div>
          </section>`).join('<div class="nr-center"></div>')}
      </div>`;
    // the join above puts the center between the columns
    const root = this.root = this.ctx.container.querySelector('.nr');
    this.center = root.querySelector('.nr-center');
    this.cols = [1, 2].map(side => {
      const col = root.querySelector(`.nr-col--${side}`);
      const grid = col.querySelector('.nr-grid');
      const cells = [];
      for (let i = 0; i < this.CELLS; i++) {
        const d = document.createElement('div');
        d.className = 'nr-cell';
        d.dataset.i = i;
        grid.appendChild(d);
        cells.push(d);
      }
      // free-form: click ANY empty cell of your own sheet
      grid.addEventListener('pointerdown', e => {
        const el = e.target;
        if (!el.classList.contains('nr-cell') || el.classList.contains('on')) return;
        if (!this.canFill(side)) return;
        const i = Number(el.dataset.i);
        if (this.ctx.isHost) this.fill(this.ctx.myId, i);
        else this.ctx.send('fill', { i }, this.ctx.hostId);
      });
      return {
        col, grid, cells,
        title: col.querySelector('.nr-title'),
        badge: col.querySelector('.nr-badge'),
        bar: col.querySelector('.nr-prog i'),
      };
    });
  },

  canFill(side) {
    const s = this.state, id = side === 1 ? s.p1Id : s.p2Id;
    return s.phase === 'race' && this.ctx.myId === id && s.filler === id;
  },

  paintCell(side, i) {
    const arr = side === 1 ? this.state.c1 : this.state.c2;
    this.cols[side - 1].cells[i].classList.toggle('on', !!arr[i]);
  },

  /** score badges, progress bars, "clickable" highlights (cheap; runs on every fill) */
  paintMeta() {
    const s = this.state, me = this.ctx.myId;
    const iPlay = me === s.p1Id || me === s.p2Id;
    [[1, s.p1Id, s.c1], [2, s.p2Id, s.c2]].forEach(([side, id, arr]) => {
      const c = this.cols[side - 1], n = this.count(arr);
      c.badge.innerHTML = `<b>${n}</b> /100`;
      c.bar.style.width = n + '%';
      const who = id ? this.nameOf(id) : 'Bekleniyor…';
      const label = !id ? 'OYUNCU ' + side
        : id === me ? 'SENİN 10x10 KAĞIDIN'
        : iPlay ? 'RAKİBİN 10x10 KARELİ KAĞIDI — CANLI' : `OYUNCU ${side} 10x10 KAĞIDI`;
      c.title.textContent = `${label} (${who})`;
      c.col.classList.toggle('filler', !!id && id === s.filler && (s.phase === 'pick' || s.phase === 'race'));
      c.col.classList.toggle('winner', !!s.winner && s.winner === id);
      c.grid.classList.toggle('clickable', this.canFill(side));
    });
  },

  /**
   * Layout modes (only during the race, for the two duelists):
   *   seek: [ shuffled board | opponent's live sheet ]  - own sheet hidden
   *   fill: [ own sheet (huge) | target reminder ]      - opponent's sheet hidden
   *   tri : [ P1 sheet | center | P2 sheet ]            - every other phase / spectators
   */
  applyLayout() {
    const s = this.state, me = this.ctx.myId;
    const iPlay = me === s.p1Id || me === s.p2Id;
    const mode = s.phase === 'race' && iPlay ? (me === s.filler ? 'fill' : 'seek') : 'tri';
    this.root.className = 'nr nr--' + mode;

    this.cols.forEach(c => { c.col.style.display = ''; c.col.style.order = ''; });
    this.center.style.order = '';
    const mine = this.cols[me === s.p1Id ? 0 : 1], opp = this.cols[me === s.p1Id ? 1 : 0];
    if (mode === 'seek') {
      mine.col.style.display = 'none';
      this.center.style.order = 1;
      opp.col.style.order = 2;
    } else if (mode === 'fill') {
      opp.col.style.display = 'none';
      mine.col.style.order = 1;
      this.center.style.order = 2;
    }
  },

  render() {
    const s = this.state;
    [[1, s.c1], [2, s.c2]].forEach(([side, arr]) => {
      const cells = this.cols[side - 1].cells;
      for (let i = 0; i < this.CELLS; i++) cells[i].classList.toggle('on', !!arr[i]);
    });
    this.paintMeta();
    this.applyLayout();

    // Celebratory arpeggio once per finished game (someone hit 100 squares)
    if (s.phase === 'over' && !this.winSounded) { this.winSounded = true; GameAudio.playWin(); }
    else if (s.phase !== 'over') this.winSounded = false;

    // Rebuild the center only when something relevant changed
    const key = [s.phase, s.filler, s.round, s.target, s.winner, s.fillerReady, s.seekerReady,
      s.used.length, this.ctx.myId, s.p1Id, s.p2Id].join('|');
    if (key !== this.centerKey) {
      this.centerKey = key;
      this.renderCenter();
    }
    if (s.phase === 'countdown') this.showOverlay(); else this.removeOverlay();
  },

  // ---------- center panel ----------
  renderCenter() {
    const s = this.state, me = this.ctx.myId, el = this.center, esc = t => this.esc(t);
    const iPlay = me === s.p1Id || me === s.p2Id;
    const isFiller = me === s.filler;
    const seeker = this.seekerId();
    const readyCount = (s.fillerReady ? 1 : 0) + (s.seekerReady ? 1 : 0);
    let html = '';

    if (s.phase === 'waiting') {
      html = `<div class="nr-card"><div class="nr-wait">Rakip bekleniyor…<small>Host, odaya katılan ilk oyuncuyla yarışır. Diğerleri izler.</small></div></div>`;
    } else if (s.phase === 'over') {
      html = `<div class="nr-card"><div class="nr-win">🏆<br>${s.winner === me ? 'KAZANDIN!' : esc(this.nameOf(s.winner)) + ' KAZANDI!'}</div>
        ${iPlay ? '<button class="nr-go" data-act="again">TEKRAR OYNA</button>' : ''}</div>`;
    } else {
      // header shared by pick/countdown/race
      const pill = s.lastResult && s.phase === 'pick'
        ? `<div class="nr-pill"><span>✔ Hedef (${s.lastResult.target}) Bulundu!</span><em>+${s.lastResult.filled} kutu dolduruldu</em></div>` : '';
      const role = !iPlay ? 'SEYİRCİ' : isFiller ? 'KUTULARI DOLDUR' : 'SAYIYI BUL';
      const dot = (id, ready) => `<span class="nr-who ${ready ? 'rdy' : ''}">${esc(this.nameOf(id))}${id === me ? ' (Sen)' : ''} <i>${ready ? '✔' : '○'}</i></span>`;
      const head = `${pill}
        <div class="nr-roundrow">
          <div><span class="nr-tag">TUR #${s.round} ${s.phase === 'pick' ? 'HAZIRLIĞI' : ''}</span>
            <div class="nr-role">Rolün: ${role}</div></div>
          <div class="nr-whos">${dot(s.filler, s.fillerReady)}${dot(seeker, s.seekerReady)}</div>
        </div>`;

      if (s.phase === 'pick') {
        if (iPlay && isFiller) html = head + this.pickerHTML();
        else if (iPlay) html = head + `<div class="nr-panel nr-panel--info"><div class="nr-ico">◎</div>
            <b>${esc(this.nameOf(s.filler))} senin bulman için bir hedef sayı seçiyor…</b>
            <small>Yan taraflardan senin ve rakibinin 10×10 kağıt durumunu inceleyebilirsin. İki taraf da Hazırım dediğinde tur başlar!</small></div>`;
        else html = head + `<div class="nr-panel nr-panel--info"><b>${esc(this.nameOf(s.filler))} hedef sayı seçiyor…</b><small>Oyuncular hazırlanıyor (${readyCount}/2)</small></div>`;

        // bottom button
        if (iPlay && isFiller) {
          const sel = this.selected;
          html += s.fillerReady
            ? `<button class="nr-go done" disabled>HAZIRSIN (${s.target}) — RAKİP BEKLENİYOR (${readyCount}/2)</button>`
            : `<button class="nr-go" data-act="lock" ${sel ? '' : 'disabled'}>HAZIRIM! ${sel ? `(${sel} SAYISINI SEÇ)` : '(SAYI SEÇ)'}</button>`;
        } else if (iPlay) {
          html += s.seekerReady
            ? `<button class="nr-go done" disabled>HAZIRSIN — RAKİP BEKLENİYOR (${readyCount}/2)</button>`
            : `<button class="nr-go" data-act="ready">HAZIRIM! (${readyCount}/2)</button>`;
        }
      } else if (s.phase === 'countdown') {
        html = head + `<div class="nr-panel nr-panel--info"><b>Tur başlıyor…</b></div>`;
      } else { // race
        if (iPlay && me === seeker) {
          html = head + `<div class="nr-panel">
            <div class="nr-phead"><span>◎ 1–64 KARIŞIK SAYI TABLOSU</span><span class="nr-chip">HEDEF: ${s.target}</span></div>
            <div class="nr-psub"><span>Hedef sayıyı bul ve üzerine tıkla</span><span>Üstü çizili sayılar önceki turlarda kullanıldı</span></div>
            <div class="nr-nums nr-nums--board">${s.board.map(n =>
              `<button class="nr-num ${s.used.includes(n) ? 'used' : ''}" data-n="${n}" ${s.used.includes(n) ? 'disabled' : ''}>${n}</button>`).join('')}</div></div>`;
        } else if (iPlay) {
          html = head + `<div class="nr-panel nr-panel--info">
            <div class="nr-targetlbl">HEDEF SAYI</div>
            <div class="nr-bigtarget">${s.target}</div>
            <b>KUTULARI DOLDUR!</b>
            <small>Rakibin ${s.target} sayısını bulana kadar kendi kağıdındaki boş kutulara tıkla.</small></div>`;
        } else {
          html = head + `<div class="nr-panel nr-panel--info"><b>${esc(this.nameOf(s.filler))} kutuları dolduruyor</b>
            <small>${esc(this.nameOf(seeker))}, ${s.target} sayısını arıyor…</small></div>`;
        }
      }
      html = `<div class="nr-card">${html}</div>`;
    }

    el.innerHTML = html.startsWith('<div class="nr-card"') ? html : `<div class="nr-card">${html}</div>`;
    this.bindCenter();
  },

  pickerHTML() {
    const s = this.state, sel = this.selected, locked = s.fillerReady;
    const left = this.MAXNUM - s.used.length;
    let nums = '';
    for (let n = 1; n <= this.MAXNUM; n++) {
      const used = s.used.includes(n);
      nums += `<button class="nr-num ${used ? 'used' : ''} ${n === (locked ? s.target : sel) ? 'sel' : ''}" data-n="${n}" ${used || locked ? 'disabled' : ''}>${n}</button>`;
    }
    return `<div class="nr-panel">
      <div class="nr-phead"><span>Hedef Sayı Seç: <b class="nr-chip nr-chip--y">${locked ? s.target : (sel || '–')}</b></span>
        <button class="nr-rnd" data-act="rnd" ${locked ? 'disabled' : ''}>🎲 Rastgele</button></div>
      <div class="nr-psub"><span>Önceki turlarda seçilen sayıların üstü çizilidir.</span><span class="nr-left">${left} sayı kaldı</span></div>
      <div class="nr-nums">${nums}</div></div>`;
  },

  bindCenter() {
    const s = this.state, me = this.ctx.myId, host = this.ctx.isHost;
    const send = (type, data) => host ? null : this.ctx.send(type, data, this.ctx.hostId);

    this.center.querySelectorAll('.nr-num').forEach(b => {
      b.onclick = () => {
        const n = Number(b.dataset.n);
        if (s.phase === 'pick') {                       // picker highlights a number
          if (s.used.includes(n)) return;
          this.selected = n;
          this.renderCenter();
        } else if (s.phase === 'race') {                // seeker clicks the board
          if (s.used.includes(n)) return;
          if (n !== s.target) {
            GameAudio.playError();
            b.classList.add('bad');
            setTimeout(() => b.classList.remove('bad'), 300);
          }
          if (host) this.seek(me, n); else send('seek', { n });
        }
      };
    });

    const act = name => this.center.querySelector(`[data-act="${name}"]`);
    if (act('rnd')) act('rnd').onclick = () => {
      const free = [];
      for (let n = 1; n <= this.MAXNUM; n++) if (!s.used.includes(n)) free.push(n);
      this.selected = free[Math.floor(Math.random() * free.length)];
      this.renderCenter();
    };
    if (act('lock')) act('lock').onclick = () => {
      if (!this.selected) return;
      GameAudio.playReady();
      if (host) this.lock(me, this.selected); else send('lock', { n: this.selected });
    };
    if (act('ready')) act('ready').onclick = () => { GameAudio.playReady(); if (host) this.ready(me); else send('ready'); };
    if (act('again')) act('again').onclick = () => { if (host) this.reset(); else send('reset'); };
  },

  // ---------- "both ready" overlay (2.5s) ----------
  showOverlay() {
    if (this.overlay) return;
    const s = this.state, me = this.ctx.myId;
    const msg = me === s.filler ? `Hazır ol! Rakibin ${s.target} sayısını ararken boş kutulara hızla tıkla!`
      : (me === this.seekerId() ? `Hazır ol! Tabloda ${s.target} sayısını hemen bul!`
        : `${this.esc(this.nameOf(s.filler))} kutuları doldururken ${this.esc(this.nameOf(this.seekerId()))} ${s.target} sayısını arayacak!`);
    const o = document.createElement('div');
    o.className = 'nr-overlay';
    o.innerHTML = `<div class="nr-modal">
      <div class="nr-mpill">İKİ OYUNCU DA HAZIR — TUR #${s.round} BAŞLIYOR!</div>
      <div class="nr-mnum">${s.target}</div>
      <div class="nr-mtitle">${s.target} SAYISI SEÇİLDİ!</div>
      <div class="nr-mtext">${msg}</div>
      <div class="nr-mbar"><i style="animation-duration:${this.OVERLAY_MS}ms"></i></div></div>`;
    document.body.appendChild(o);
    this.overlay = o;
  },

  removeOverlay() {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
  },

  // ---------- styles ----------
  injectStyles() {
    if (document.getElementById('nr-style')) return;
    const st = document.createElement('style');
    st.id = 'nr-style';
    st.textContent = `
      .nr { --nr-bg:#0b1020; --nr-card:#0f1629; --nr-line:#25304b; --nr-blue:#2f9bff; --nr-blue2:#1a67d8; --nr-pink:#ff3d7f; --nr-pink2:#d41f63; --nr-teal:#25d6c4; --nr-green:#2ee08a; --nr-yellow:#ffc928;
        width:100%; height:100%; max-height:100%; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.08fr) minmax(0,1fr); gap:12px; align-items:center; background:var(--nr-bg); padding:10px 12px; border-radius:14px; color:#e8ecf7; overflow:hidden; box-sizing:border-box; }
      @media (max-width: 980px) { .nr { grid-template-columns:1fr 1fr; grid-template-rows:minmax(0,1fr) minmax(0,1fr); } .nr-center { grid-column:1 / -1; order:-1; } }

      /* sheets */
      .nr-col { background:var(--nr-card); border:1px solid var(--nr-line); border-radius:12px; padding:8px 10px; display:flex; flex-direction:column; gap:5px; max-height:100%; min-height:0; overflow:hidden; }
      .nr-col--1 { border-color:#2aa7c988; box-shadow:0 0 14px #2f9bff22; }
      .nr-col--2 { border-color:#ff3d7f88; box-shadow:0 0 14px #ff3d7f22; }
      .nr-col.filler { box-shadow:0 0 18px #ffc92855; }
      .nr-col.winner { border-color:var(--nr-green); box-shadow:0 0 20px #2ee08a66; }
      .nr-col header { flex-shrink:0; display:flex; justify-content:space-between; align-items:center; gap:6px; font-size:.62rem; font-weight:800; letter-spacing:.04em; }
      .nr-col--1 .nr-title { color:#6fc3ff; } .nr-col--2 .nr-title { color:#ff7fa8; }
      .nr-title::before { content:'●'; margin-right:5px; }
      .nr-badge { background:#1b2542; border-radius:8px; padding:2px 7px; font-size:.68rem; color:#9aa6c6; white-space:nowrap; }
      .nr-badge b { color:#fff; }
      .nr-prog { flex-shrink:0; height:3px; background:#1b2542; border-radius:3px; overflow:hidden; }
      .nr-prog i { display:block; height:100%; width:0; transition:width .15s; }
      .nr-col--1 .nr-prog i { background:linear-gradient(90deg,var(--nr-blue),var(--nr-teal)); }
      .nr-col--2 .nr-prog i { background:linear-gradient(90deg,var(--nr-pink),#ff8a5c); }
      .nr-grid { width:min(100%, calc(100dvh - var(--header-height, 118px) - 96px)); margin:0 auto; aspect-ratio:1; display:grid; grid-template-columns:repeat(10,1fr); gap:2.5px; user-select:none; touch-action:manipulation; min-height:0; }
      .nr-cell { aspect-ratio:1; background:#0b1226; border:1px solid #1a2340; border-radius:4px; position:relative; transition:background .1s; min-width:0; min-height:0; }
      .nr-cell::after { content:''; position:absolute; inset:0; margin:auto; width:2px; height:2px; border-radius:50%; background:#1e2a4a; }
      .nr-col--1 .nr-cell.on { background:linear-gradient(145deg,#4db0ff,var(--nr-blue2)); border-color:#7cc4ff; box-shadow:0 0 6px #2f9bff66; }
      .nr-col--2 .nr-cell.on { background:linear-gradient(145deg,#ff6a9f,var(--nr-pink2)); border-color:#ff9bbd; box-shadow:0 0 6px #ff3d7f66; }
      .nr-cell.on::after { width:28%; height:28%; border-radius:2px; background:#fff; opacity:.9; }
      .nr-grid.clickable .nr-cell:not(.on) { cursor:pointer; border-color:#2c3b66; }
      .nr-col--1 .nr-grid.clickable .nr-cell:not(.on):hover { background:#2f9bff44; border-color:var(--nr-blue); }
      .nr-col--2 .nr-grid.clickable .nr-cell:not(.on):hover { background:#ff3d7f44; border-color:var(--nr-pink); }

      /* center */
      .nr-center { display:flex; justify-content:center; align-items:center; max-height:100%; min-height:0; overflow:hidden; }
      .nr-card { width:100%; max-height:100%; min-height:0; background:var(--nr-card); border:1px solid var(--nr-line); border-radius:14px; padding:10px; display:flex; flex-direction:column; gap:7px; box-shadow:0 8px 30px #0008; overflow:hidden; }
      .nr-pill { flex-shrink:0; display:flex; justify-content:space-between; align-items:center; gap:8px; background:#121b33; border:1px solid var(--nr-line); border-radius:8px; padding:4px 10px; font-size:.7rem; color:#ffd966; font-weight:700; }
      .nr-pill em { font-style:normal; color:var(--nr-green); }
      .nr-roundrow { flex-shrink:0; display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .nr-tag { display:inline-block; background:#13324a; color:var(--nr-teal); border:1px solid #1f5a73; border-radius:5px; padding:2px 7px; font-size:.58rem; font-weight:800; }
      .nr-role { font-weight:800; font-size:.88rem; margin-top:2px; }
      .nr-whos { display:flex; flex-direction:column; gap:2px; }
      .nr-who { background:#121b33; border:1px solid var(--nr-line); border-radius:6px; padding:2px 8px; font-size:.62rem; color:#aeb8d4; display:flex; justify-content:space-between; gap:10px; min-width:88px; }
      .nr-who.rdy { border-color:var(--nr-green); color:var(--nr-green); }
      .nr-who i { font-style:normal; }

      .nr-panel { flex:1 1 auto; min-height:0; background:#0b1226; border:1px solid var(--nr-line); border-radius:10px; padding:8px; display:flex; flex-direction:column; gap:5px; overflow:hidden; }
      .nr-panel--info { align-items:center; justify-content:center; text-align:center; padding:16px 12px; gap:8px; }
      .nr-panel--info small { color:#7d89ab; font-size:.68rem; line-height:1.4; }
      .nr-ico { font-size:1.6rem; color:var(--nr-teal); }
      .nr-bigtarget { font-size:2.6rem; font-weight:900; color:var(--nr-yellow); }
      .nr-phead { flex-shrink:0; display:flex; justify-content:space-between; align-items:center; font-size:.7rem; font-weight:800; color:#c9d3ee; }
      .nr-psub { flex-shrink:0; display:flex; justify-content:space-between; gap:6px; font-size:.56rem; color:#7d89ab; }
      .nr-left { color:#ff9b4a; font-weight:700; }
      .nr-chip { background:#13324a; color:var(--nr-yellow); border:1px solid #1f5a73; border-radius:6px; padding:2px 8px; font-weight:900; }
      .nr-chip--y { background:#3a2c08; border-color:#8a6a10; }
      .nr-rnd { cursor:pointer; background:#3a2c08; color:var(--nr-yellow); border:1px solid #8a6a10; border-radius:6px; padding:3px 9px; font-size:.66rem; font-weight:800; }
      .nr-rnd:disabled { opacity:.4; cursor:not-allowed; }

      .nr-nums { width:min(100%, calc(100dvh - var(--header-height, 118px) - 240px)); margin:0 auto; aspect-ratio:1; display:grid; grid-template-columns:repeat(8,1fr); gap:3.5px; min-height:0; }
      .nr-num { aspect-ratio:1; padding:0; font-size:clamp(.62rem,1.3vh,.8rem); font-weight:700; color:#dfe6fb; background:#141d36; border:1px solid #232f50; border-radius:6px; cursor:pointer; min-width:0; min-height:0; }
      .nr-nums--board .nr-num { font-size:clamp(.75rem,1.8vh,1.1rem); font-weight:800; border-radius:7px; }
      .nr-num:not(:disabled):hover { border-color:var(--nr-teal); background:#10343a; }
      .nr-num.sel { background:linear-gradient(145deg,#ffd84d,#f0a000); color:#2a1d00; border-color:#fff1a8; box-shadow:0 0 10px #ffc92888; }
      .nr-num.used { text-decoration:line-through; opacity:.3; cursor:not-allowed; }
      .nr-num.bad { background:#ff3d3d55; border-color:#ff5c5c; }
      .nr-num:disabled:not(.used):not(.sel) { cursor:default; }

      .nr-go { flex-shrink:0; cursor:pointer; border:none; border-radius:10px; padding:10px; font-size:.78rem; font-weight:900; letter-spacing:.03em; color:#06241e; background:linear-gradient(90deg,var(--nr-teal),var(--nr-green)); box-shadow:0 0 14px #25d6c455; }
      .nr-go:hover:not(:disabled) { filter:brightness(1.1); }
      .nr-go:disabled { cursor:not-allowed; opacity:.55; }
      .nr-go.done { background:#12382f; color:var(--nr-green); box-shadow:none; opacity:1; border:1px solid #1d6b52; }
      .nr-wait { text-align:center; padding:24px 10px; font-weight:800; display:flex; flex-direction:column; gap:8px; }
      .nr-wait small { color:#7d89ab; font-weight:500; }
      .nr-win { text-align:center; font-size:1.5rem; font-weight:900; color:var(--nr-yellow); padding:16px 0; }

      /* both-ready overlay */
      .nr-overlay { position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; background:#02050dcc; backdrop-filter:blur(3px); animation:nr-fade .2s ease-out; }
      .nr-modal { width:min(420px,90vw); background:#0d1426; border:2px solid #d9a92c; border-radius:18px; padding:26px 22px 22px; text-align:center; display:flex; flex-direction:column; align-items:center; gap:12px; box-shadow:0 0 40px #ffc92844, 0 20px 60px #000c; animation:nr-pop .35s cubic-bezier(.2,1.4,.4,1); }
      .nr-mpill { background:#2a2108; color:#f2c744; border:1px solid #8a6a10; border-radius:6px; padding:4px 12px; font-size:.62rem; font-weight:900; letter-spacing:.04em; }
      .nr-mnum { width:96px; height:96px; display:flex; align-items:center; justify-content:center; font-size:2.8rem; font-weight:900; color:#1c1400; background:linear-gradient(145deg,#ffe066,#f09a00); border:3px solid #fff3b0; border-radius:16px; box-shadow:0 0 28px #ffc928aa; }
      .nr-mtitle { font-size:1.6rem; font-weight:900; color:#fff; }
      .nr-mtext { color:var(--nr-green); font-size:.8rem; font-weight:700; line-height:1.4; }
      .nr-mbar { width:100%; height:6px; background:#1b2542; border-radius:4px; overflow:hidden; }
      .nr-mbar i { display:block; height:100%; width:0; background:linear-gradient(90deg,#ffd84d,var(--nr-teal)); animation:nr-bar linear forwards; }
      @keyframes nr-bar { to { width:100%; } }
      @keyframes nr-pop { from { transform:scale(.7); opacity:0; } to { transform:scale(1); opacity:1; } }
      @keyframes nr-fade { from { opacity:0; } to { opacity:1; } }

      /* ===== dynamic race layouts (set by applyLayout) ===== */
      /* Seeker: giant shuffled board (left) + opponent's live sheet (right); own sheet hidden */
      .nr--seek { grid-template-columns:minmax(0,1.1fr) minmax(0,1fr); gap:16px; }
      .nr--seek .nr-nums--board { width:min(100%, calc(100dvh - var(--header-height, 118px) - 150px)); margin:0 auto; gap:clamp(3px,.45vw,7px); }
      .nr--seek .nr-num { font-size:clamp(.85rem,2vh,1.7rem); }
      .nr--seek .nr-phead { font-size:clamp(.75rem,1.1vw,1rem); }
      .nr--seek .nr-psub { font-size:clamp(.58rem,.85vw,.75rem); }
      /* Filler: giant own sheet (left) + small target reminder (right); opponent hidden */
      .nr--fill { grid-template-columns:minmax(0,2fr) minmax(200px,1fr); gap:16px; }
      .nr--fill .nr-bigtarget { font-size:clamp(3rem,7vh,5.5rem); line-height:1; }
      .nr-targetlbl { font-size:.7rem; font-weight:800; letter-spacing:.08em; color:#9aa6c6; }
      /* big sheets */
      .nr--seek .nr-grid, .nr--fill .nr-grid { width:min(100%, calc(100dvh - var(--header-height, 118px) - 86px)); margin:0 auto; gap:clamp(2.5px,.4vw,6px); }
      .nr--seek .nr-col, .nr--fill .nr-col { padding:10px 12px; gap:6px; }
      .nr--seek .nr-col header, .nr--fill .nr-col header { font-size:clamp(.62rem,.95vw,.85rem); }
      .nr--seek .nr-cell, .nr--fill .nr-cell { border-radius:clamp(3px,.5vw,8px); }
      @media (max-width: 980px) { .nr--seek, .nr--fill { grid-template-columns:1fr; } }

    `;
    document.head.appendChild(st);
  },
};

GameHub.register(NumberRace);
