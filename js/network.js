/**
 * Network: the ONLY file that knows about PeerJS. Star topology.
 *
 *   Host  <--->  Client A
 *     ^--------> Client B   (clients only ever talk to the host; the host relays)
 *
 * Public API
 *   net.host(name) / net.join(hostId, name) / net.leave()
 *   net.send(channel, type, payload, to?)
 *        to omitted  -> everyone else in the room
 *        to = peerId -> just that player (host relays if sender is a client)
 *   net.on(channel, fn)   fn(type, payload, fromId); returns unsubscribe fn
 *   net.onEvent(name, fn) lifecycle events:
 *        'ready'(roomId)   host: room code is available
 *        'joined'()        client: connected & accepted by host
 *        'players'(list)   roster changed: [{id, name, isHost}] (host is always first)
 *        'peerjoin'(player) / 'peerleave'(player)   host only
 *        'closed'()        client: lost the host
 *        'error'(err)
 * Wire format: { channel, type, payload, from?, to? }. Internal channel: '_net'.
 */
class Network {
  static MAX_PLAYERS = 8;

  constructor() {
    this.handlers = {};
    this.events = {};
    this._reset();
  }

  _reset() {
    this.peer = null;
    this.hostConn = null;       // client -> host connection
    this.conns = new Map();     // host: peerId -> DataConnection
    this.players = [];
    this.myId = null;
    this.hostId = null;
    this.isHost = false;
    this._left = false;
    this._joined = false;
  }

  // ---- lifecycle events ----
  onEvent(name, fn) { (this.events[name] ||= new Set()).add(fn); }
  _emit(name, arg) { (this.events[name] || []).forEach(fn => fn(arg)); }

  // ---- Host (room creator) ----
  host(name) {
    this.leave();
    this.isHost = true;
    this.peer = new Peer(this._randomId());
    this.peer.on('open', id => {
      this.myId = this.hostId = id;
      this.players = [{ id, name: name || 'Host', isHost: true }];
      this._emit('ready', id);
      this._emit('players', this.players);
    });
    this.peer.on('connection', conn => this._hostAccept(conn));
    this.peer.on('error', err => this._emit('error', err));
  }

  _hostAccept(conn) {
    conn.on('data', msg => this._hostOnData(conn, msg));
    conn.on('close', () => this._hostDrop(conn));
    conn.on('error', () => this._hostDrop(conn));
  }

  _hostOnData(conn, msg) {
    if (!msg || !msg.channel) return;
    const from = conn.peer;

    if (msg.channel === '_net') {
      if (msg.type === 'hello' && !this.conns.has(from)) {
        if (this.players.length >= Network.MAX_PLAYERS) {
          conn.send({ channel: '_net', type: 'full' });
          setTimeout(() => conn.close(), 200);
          return;
        }
        const player = { id: from, name: this._uniqueName(msg.payload && msg.payload.name), isHost: false };
        this.conns.set(from, conn);
        this.players.push(player);
        this._broadcastRoster();
        this._emit('players', this.players);
        this._emit('peerjoin', player);
      }
      return;
    }
    if (!this.conns.has(from)) return; // ignore strangers

    const out = { channel: msg.channel, type: msg.type, payload: msg.payload, from };
    if (msg.to && msg.to !== this.hostId) {
      // direct message to another client: relay only
      const target = this.conns.get(msg.to);
      if (target && target.open) target.send({ ...out, to: msg.to });
    } else {
      this._deliver(out);
      if (!msg.to) { // broadcast: relay to everyone except the sender
        this.conns.forEach((c, id) => { if (id !== from && c.open) c.send(out); });
      }
    }
  }

  _hostDrop(conn) {
    const id = conn.peer;
    if (!this.conns.has(id)) return;
    this.conns.delete(id);
    const player = this.players.find(p => p.id === id);
    this.players = this.players.filter(p => p.id !== id);
    this._broadcastRoster();
    this._emit('players', this.players);
    if (player) this._emit('peerleave', player);
  }

  _broadcastRoster() {
    const msg = { channel: '_net', type: 'roster', payload: this.players };
    this.conns.forEach(c => c.open && c.send(msg));
  }

  _uniqueName(raw) {
    const base = (String(raw || '').trim().slice(0, 16)) || 'Player';
    let name = base, n = 2;
    while (this.players.some(p => p.name === name)) name = `${base} ${n++}`;
    return name;
  }

  // ---- Client ----
  join(hostId, name) {
    this.leave();
    this.isHost = false;
    this.peer = new Peer();
    this.peer.on('open', id => {
      this.myId = id;
      this.hostId = hostId.trim();
      const conn = this.peer.connect(this.hostId, { reliable: true });
      this.hostConn = conn;
      conn.on('open', () => conn.send({ channel: '_net', type: 'hello', payload: { name } }));
      conn.on('data', msg => this._clientOnData(msg));
      conn.on('close', () => this._clientLost());
      conn.on('error', () => this._clientLost());
    });
    this.peer.on('error', err => this._emit('error', err));
  }

  _clientOnData(msg) {
    if (!msg || !msg.channel) return;
    if (msg.channel === '_net') {
      if (msg.type === 'roster') {
        this.players = msg.payload;
        if (!this._joined) { this._joined = true; this._emit('joined'); }
        this._emit('players', this.players);
      } else if (msg.type === 'full') {
        this._left = true; // suppress 'closed'
        this._emit('error', { type: 'room-full' });
      }
      return;
    }
    this._deliver(msg);
  }

  _clientLost() {
    if (this._left) return;
    this._left = true;
    this._emit('closed');
  }

  // ---- messaging ----
  send(channel, type, payload, to) {
    if (this.isHost) {
      const msg = { channel, type, payload, from: this.myId, to };
      if (to) {
        const c = this.conns.get(to);
        if (c && c.open) c.send(msg);
      } else {
        this.conns.forEach(c => c.open && c.send(msg));
      }
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ channel, type, payload, to });
    }
  }

  on(channel, fn) {
    (this.handlers[channel] ||= new Set()).add(fn);
    return () => this.handlers[channel].delete(fn);
  }

  _deliver(msg) {
    (this.handlers[msg.channel] || []).forEach(fn => fn(msg.type, msg.payload, msg.from));
  }

  // ---- teardown ----
  leave() {
    this._left = true;
    this.conns.forEach(c => { try { c.close(); } catch (e) {} });
    if (this.hostConn) { try { this.hostConn.close(); } catch (e) {} }
    if (this.peer) { try { this.peer.destroy(); } catch (e) {} }
    this._reset();
  }

  // Short, friendly room code instead of a long UUID
  _randomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return 'safe-' + s;
  }
}
