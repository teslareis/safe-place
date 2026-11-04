/**
 * Tic-Tac-Toe for the star topology. Host owns the state.
 * X = first player in roster (host), O = second player. Everyone else spectates.
 * Messages: client->host: 'hello', 'move' {index}, 'reset'; host->all: 'state'
 */
const TicTacToe = {
  id: 'tictactoe',
  name: 'Tic-Tac-Toe',

  LINES: [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]],

  start(ctx) {
    this.ctx = ctx;
    this.fresh();
    this.oId = this.roleId(1);

    ctx.container.innerHTML = `
      <div class="ttt-info"></div>
      <div class="ttt-board"></div>
      <button class="btn">Restart</button>`;
    this.info = ctx.container.querySelector('.ttt-info');
    this.boardEl = ctx.container.querySelector('.ttt-board');
    ctx.container.querySelector('.btn').onclick = () => {
      if (ctx.isHost) this.reset(); else ctx.send('reset', null, ctx.hostId);
    };

    this.cells = [];
    for (let i = 0; i < 9; i++) {
      const c = document.createElement('button');
      c.className = 'ttt-cell';
      c.onclick = () => {
        if (ctx.isHost) this.applyMove(i, ctx.myId);
        else ctx.send('move', { index: i }, ctx.hostId);
      };
      this.boardEl.appendChild(c);
      this.cells.push(c);
    }

    ctx.onMessage((type, data, from) => {
      if (ctx.isHost) {
        if (type === 'hello') ctx.send('state', this.state, from);
        else if (type === 'move') this.applyMove(data.index, from);
        else if (type === 'reset') this.reset();
      } else if (type === 'state') {
        this.state = data;
        this.render();
      }
    });

    ctx.onPlayers(() => {
      if (!ctx.isHost) return this.render();
      const newO = this.roleId(1);
      if (newO !== this.oId) { this.oId = newO; this.reset(); } // opponent changed
      else this.render();
    });

    if (!ctx.isHost) ctx.send('hello', null, ctx.hostId);
    this.render();
  },

  fresh() { this.state = { board: Array(9).fill(null), turn: 'X', winner: null, winLine: [] }; },

  roleId(n) { const p = this.ctx.players[n]; return p ? p.id : null; },
  myRole(id = this.ctx.myId) {
    const p = this.ctx.players;
    if (p[0] && p[0].id === id) return 'X';
    if (p[1] && p[1].id === id) return 'O';
    return null;
  },

  // ---- host only ----
  reset() { this.fresh(); this.commit(); },

  applyMove(i, fromId) {
    const s = this.state;
    if (s.winner || s.board[i] || this.myRole(fromId) !== s.turn) return;
    s.board[i] = s.turn;
    for (const [a, b, c] of this.LINES) {
      if (s.board[a] && s.board[a] === s.board[b] && s.board[a] === s.board[c]) {
        s.winner = s.board[a];
        s.winLine = [a, b, c];
      }
    }
    if (!s.winner && s.board.every(Boolean)) s.winner = 'draw';
    else if (!s.winner) s.turn = s.turn === 'X' ? 'O' : 'X';
    this.commit();
  },

  commit() { this.ctx.send('state', this.state); this.render(); },

  // ---- everyone ----
  render() {
    const s = this.state, me = this.myRole();
    const ready = this.ctx.players.length >= 2;
    this.cells.forEach((c, i) => {
      c.textContent = s.board[i] || '';
      c.className = 'ttt-cell' + (s.board[i] ? ' ' + s.board[i] : '') + (s.winLine.includes(i) ? ' win' : '');
      c.disabled = !ready || !!s.board[i] || !!s.winner || s.turn !== me;
    });
    if (!ready) this.info.textContent = 'Waiting for a second player…';
    else if (s.winner === 'draw') this.info.textContent = "It's a draw! 🤝";
    else if (s.winner) this.info.textContent = !me ? `${s.winner} wins!` : s.winner === me ? 'You win! 🎉' : 'Your partner wins! 💖';
    else if (!me) this.info.textContent = `Spectating — ${s.turn}'s turn`;
    else this.info.textContent = (s.turn === me ? 'Your turn' : "Partner's turn") + ` (you are ${me})`;
  },

  destroy() {},
};

GameHub.register(TicTacToe);
