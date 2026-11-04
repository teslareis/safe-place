/**
 * Rock-Paper-Scissors for any number of players (2+). Host owns the state.
 * Rule: if exactly two different choices appear, the beating one wins;
 * if all three (or only one) appear, it's a draw.
 * Messages: client->host: 'hello', 'pick' {choice}, 'reset'; host->all: 'state'
 */
const RPS = {
  id: 'rps',
  name: 'Rock-Paper-Scissors',

  EMOJI: { rock: '🪨', paper: '📄', scissors: '✂️' },
  BEATS: { rock: 'scissors', paper: 'rock', scissors: 'paper' },

  start(ctx) {
    this.ctx = ctx;
    this.picks = {};                         // host only: id -> choice
    this.myChoice = null;
    this.state = { picked: [], reveal: null };

    ctx.container.innerHTML = '<div class="rps"></div>';
    this.root = ctx.container.firstChild;

    ctx.onMessage((type, data, from) => {
      if (ctx.isHost) {
        if (type === 'hello') ctx.send('state', this.state, from);
        else if (type === 'pick') this.pick(from, data.choice);
        else if (type === 'reset') this.reset();
      } else if (type === 'state') {
        if (!data.reveal && !data.picked.includes(ctx.myId)) this.myChoice = null;
        this.state = data;
        this.render();
      }
    });

    ctx.onPlayers(() => {
      if (!ctx.isHost) return this.render();
      const ids = ctx.players.map(p => p.id);
      if (!this.state.reveal) {
        Object.keys(this.picks).forEach(id => { if (!ids.includes(id)) delete this.picks[id]; });
        this.check();
      }
      this.commit();
    });

    if (!ctx.isHost) ctx.send('hello', null, ctx.hostId);
    this.render();
  },

  nameOf(id) { const p = this.ctx.players.find(p => p.id === id); return p ? p.name : 'Player'; },

  onPick(choice) {
    if (this.myChoice || this.state.reveal || !this.BEATS[choice]) return;
    this.myChoice = choice;
    if (this.ctx.isHost) this.pick(this.ctx.myId, choice);
    else { this.ctx.send('pick', { choice }, this.ctx.hostId); this.render(); }
  },

  // ---- host only ----
  pick(id, choice) {
    if (this.state.reveal || !this.BEATS[choice] || this.picks[id]) return;
    if (!this.ctx.players.some(p => p.id === id)) return;
    this.picks[id] = choice;
    this.check();
    this.commit();
  },

  check() {
    const ids = this.ctx.players.map(p => p.id);
    if (ids.length < 2 || !ids.every(id => this.picks[id])) return;
    const kinds = [...new Set(ids.map(id => this.picks[id]))];
    let winners = [];
    if (kinds.length === 2) {
      const [a, b] = kinds;
      const winKind = this.BEATS[a] === b ? a : b;
      winners = ids.filter(id => this.picks[id] === winKind);
    }
    this.state.reveal = {
      picks: ids.map(id => ({ id, name: this.nameOf(id), choice: this.picks[id] })),
      winners,
    };
  },

  reset() { this.picks = {}; this.myChoice = null; this.state = { picked: [], reveal: null }; this.commit(); },

  commit() {
    if (!this.state.reveal) this.state.picked = Object.keys(this.picks);
    this.ctx.send('state', this.state);
    this.render();
  },

  // ---- everyone ----
  render() {
    const { ctx, state } = this;
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const enough = ctx.players.length >= 2;
    const locked = !!state.reveal || !!this.myChoice || !enough;

    let html = '<h3>Rock · Paper · Scissors</h3>';
    html += enough ? '' : '<p class="muted">Waiting for at least 2 players…</p>';
    html += '<div class="rps-choices">' + Object.keys(this.EMOJI).map(k =>
      `<button class="rps-btn${this.myChoice === k ? ' picked' : ''}" data-c="${k}" ${locked ? 'disabled' : ''}>
         <span>${this.EMOJI[k]}</span>${k}</button>`).join('') + '</div>';

    if (state.reveal) {
      const w = state.reveal.winners;
      html += '<ul class="rps-results">' + state.reveal.picks.map(r =>
        `<li class="${w.includes(r.id) ? 'winner' : ''}">${esc(r.name)}: ${this.EMOJI[r.choice]} ${r.choice}${w.includes(r.id) ? ' 🏆' : ''}</li>`).join('') + '</ul>';
      html += `<p class="rps-outcome">${w.length === 0 ? "It's a draw! 🤝" : w.includes(ctx.myId) ? 'You win! 🎉' : 'Winner: ' + esc(w.map(id => this.nameOf(id) ).join(', '))}</p>`;
      html += '<button class="btn btn--primary" data-next>Next round</button>';
    } else {
      html += '<ul class="rps-results">' + ctx.players.map(p =>
        `<li>${esc(p.name)}: ${state.picked.includes(p.id) || (p.id === ctx.myId && this.myChoice) ? '✅ ready' : '⏳ thinking…'}</li>`).join('') + '</ul>';
    }

    this.root.innerHTML = html;
    this.root.querySelectorAll('.rps-btn').forEach(b => b.onclick = () => this.onPick(b.dataset.c));
    const next = this.root.querySelector('[data-next]');
    if (next) next.onclick = () => (ctx.isHost ? this.reset() : ctx.send('reset', null, ctx.hostId));
  },

  destroy() {},
};

GameHub.register(RPS);
