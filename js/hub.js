/**
 * GameHub: registry + lifecycle for games. Only the HOST can pick games.
 *
 * A game is an object:
 *   { id, name, start(ctx), destroy() (optional) }
 * ctx = {
 *   container,              // DOM element to render into
 *   isHost, myId, hostId,   // identity
 *   players,                // live roster [{id, name, isHost}] (host first)
 *   send(type, data, to?)   // to omitted = everyone else; to = playerId = one player
 *   onMessage(fn)           // fn(type, data, fromId)
 *   onPlayers(fn)           // fn(players) whenever someone joins/leaves
 * }
 * Convention: the host owns the game state; clients send intents to ctx.hostId
 * and render the 'state' the host broadcasts. Late joiners send 'hello' to
 * the host to receive the current state.
 *
 * While a game is running, <body> gets the class "in-game" (CSS collapses the
 * sidebar into a slim top bar). It is removed when no game is running.
 * Register with: GameHub.register(myGame)
 */
const GameHub = {
  games: {},
  network: null,
  container: null,
  menu: null,
  current: null,
  _unsub: null,
  _msgHandlers: new Set(),
  _playerHandlers: new Set(),
  IDLE_HTML: '<p class="muted center">Waiting for a game to start…</p>',

  register(game) { this.games[game.id] = game; },

  init(network, container, menu) {
    this.network = network;
    this.container = container;
    this.menu = menu;

    // Hub-level channel: only the host may switch games (id === null -> back to hub).
    network.on('hub', (type, payload, from) => {
      if (type !== 'select' || from !== network.hostId) return;
      if (payload.id) this._launch(payload.id); else this._idle();
    });
    network.onEvent('players', list => this._playerHandlers.forEach(fn => fn(list)));
    // Bring late joiners onto the current game.
    network.onEvent('peerjoin', p => {
      if (this.current) network.send('hub', 'select', { id: this.current.id }, p.id);
    });
  },

  /** Call when entering the hub screen (after becoming host or joining). */
  enter() { this._idle(); },

  _idle() {
    this.stop();
    this.container.innerHTML = this.IDLE_HTML;
    this._renderMenu();
  },

  _renderMenu() {
    this.menu.innerHTML = '';
    if (!this.network.isHost) {
      this.menu.innerHTML = '<span class="muted">Only the host can choose the game.</span>';
      return;
    }
    Object.values(this.games).forEach(g => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = g.name;
      b.dataset.id = g.id;
      b.onclick = () => this.select(g.id);
      this.menu.appendChild(b);
    });
    const home = document.createElement('button');
    home.className = 'btn btn--ghost hub-home';
    home.textContent = '🏠 Hub';
    home.title = 'Back to the hub (shows the sidebar again)';
    home.onclick = () => this.exitGame();
    this.menu.appendChild(home);
  },

  /** Host picks a game: start locally and broadcast to everyone. */
  select(id) {
    if (!this.network.isHost) return;
    this._launch(id);
    this.network.send('hub', 'select', { id });
  },

  /** Host leaves the current game for everybody. */
  exitGame() {
    if (!this.network.isHost) return;
    this._idle();
    this.network.send('hub', 'select', { id: null });
  },

  _launch(id) {
    const game = this.games[id];
    if (!game) return;
    this.stop();
    this.current = game;
    document.body.classList.add('in-game');
    this.container.innerHTML = '';
    this.menu.querySelectorAll('.btn').forEach(b => b.classList.toggle('active', b.dataset.id === id));

    const net = this.network;
    this._unsub = net.on(id, (type, data, from) => this._msgHandlers.forEach(fn => fn(type, data, from)));

    game.start({
      container: this.container,
      isHost: net.isHost,
      myId: net.myId,
      hostId: net.hostId,
      get players() { return net.players; },
      send: (type, data, to) => net.send(id, type, data, to),
      onMessage: fn => this._msgHandlers.add(fn),
      onPlayers: fn => this._playerHandlers.add(fn),
    });
  },

  stop() {
    if (this.current && this.current.destroy) this.current.destroy();
    if (this._unsub) this._unsub();
    this._msgHandlers.clear();
    this._playerHandlers.clear();
    this.current = null;
    this._unsub = null;
    document.body.classList.remove('in-game');
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.remove('open');
  },
};
