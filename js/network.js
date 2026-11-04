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
    // voice chat state (survives _reset so a mic stream can be set before/after joining)
    this.localStream = null;
    this.calls = new Map();     // remote peerId -> MediaConnection
    this.audios = new Map();    // remote peerId -> hidden <audio> element
    this._knownIds = new Set(); // roster ids seen last time (to detect who left)
    this._silent = null;
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
    this.peer.on('call', call => this._onIncomingCall(call));
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
        this._syncCalls();
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
    this._syncCalls();                      // destroys that player's call + <audio>
    if (player) this._emit('peerleave', player);
  }

  /**
   * Host only: remove a player from the room.
   * Tells them ({ channel:'_net', type:'kick' }), removes them from the roster and
   * voice immediately, then force-closes their data connection.
   */
  kick(peerId) {
    if (!this.isHost || peerId === this.myId) return;       // never the host itself
    const conn = this.conns.get(peerId);
    if (!conn) return;

    try { conn.send({ channel: '_net', type: 'kick' }); } catch (e) {}

    // Remove from the active list first, so the later 'close' event is ignored by _hostDrop
    // and anything they still send is dropped as coming from a stranger.
    this.conns.delete(peerId);
    const player = this.players.find(p => p.id === peerId);
    this.players = this.players.filter(p => p.id !== peerId);
    this._dropVoice(peerId);                                // media call + <audio> element
    this._broadcastRoster();                                // everyone else sees the new list
    this._emit('players', this.players);
    this._syncCalls();
    if (player) this._emit('peerleave', player);

    // Force-close the data connection. Tiny delay so the 'kick' message is flushed
    // before the channel goes down (the client also closes itself when it receives it).
    setTimeout(() => { try { conn.close(); } catch (e) {} }, 150);
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
    this.peer.on('call', call => this._onIncomingCall(call));
    this.peer.on('error', err => this._emit('error', err));
  }

  _clientOnData(msg) {
    if (!msg || !msg.channel) return;
    if (msg.channel === '_net') {
      if (msg.type === 'roster') {
        this.players = msg.payload;
        if (!this._joined) { this._joined = true; this._emit('joined'); }
        this._emit('players', this.players);
        this._syncCalls();
      } else if (msg.type === 'full') {
        this._left = true; // suppress 'closed'
        this._emit('error', { type: 'room-full' });
      } else if (msg.type === 'kick') {
        this._left = true; // we are being removed: suppress the generic 'closed' event
        this._emit('kicked');
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

  // ================= Voice chat (direct P2P media calls) =================
  // Data uses the star topology, but voice is a full mesh: every pair of players
  // gets ONE direct MediaConnection. To avoid both sides calling each other at
  // the same time, only the player with the smaller peer id initiates the call;
  // the other side answers (peer.on('call')).

  /** Give Network the microphone stream (or null to stop transmitting). */
  setLocalStream(stream) {
    this.localStream = stream || null;
    // Calls that already exist (opened before the mic was ready) get the real track swapped in
    const track = this.localStream && this.localStream.getAudioTracks()[0];
    this.calls.forEach(call => this._swapOutgoingTrack(call, track || this._silentTrack()));
    this._syncCalls();
  }

  /** Stream to hand to peer.call()/answer(): the mic, or silence (so we can still HEAR others). */
  _currentStream() { return this.localStream || this._silentStream(); }

  _silentStream() {
    if (!this._silent) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._silentCtx = new AC();
      this._silent = this._silentCtx.createMediaStreamDestination().stream; // silent audio track
    }
    return this._silent;
  }

  _silentTrack() { return this._silentStream().getAudioTracks()[0]; }

  _swapOutgoingTrack(call, track) {
    const pc = call.peerConnection;
    if (!pc || !track) return;
    const t = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
    if (t && t.sender) t.sender.replaceTrack(track).catch(() => {});
  }

  /** Start missing calls, and tear down voice for players that left the roster. */
  _syncCalls() {
    if (!this.peer || !this.myId) return;
    const now = new Set(this.players.map(p => p.id).filter(id => id !== this.myId));

    // Players who were in the roster before and are gone now -> destroy their call + <audio>
    this._knownIds.forEach(id => { if (!now.has(id)) this._dropVoice(id); });
    this._knownIds = now;

    now.forEach(id => {
      if (this.calls.has(id) || !(this.myId < id)) return;   // exists, or the other side initiates
      try {
        const call = this.peer.call(id, this._currentStream());
        if (call) this._wireCall(call);
      } catch (e) { console.warn('Voice call failed:', e); }
    });
  }

  _onIncomingCall(call) {
    call.answer(this._currentStream());      // answers even without a mic (receive-only)
    this._wireCall(call);
  }

  _wireCall(call) {
    const id = call.peer;
    if (this.calls.has(id) && this.calls.get(id) !== call) this._dropVoice(id); // replace stale call
    this.calls.set(id, call);
    call.on('stream', remote => this._attachAudio(id, remote));
    call.on('close', () => { if (this.calls.get(id) === call) this._dropVoice(id); });
    call.on('error', () => { if (this.calls.get(id) === call) this._dropVoice(id); });
  }

  /** One hidden <audio autoplay> per remote player, keyed by their peer id. */
  _attachAudio(id, stream) {
    let el = this.audios.get(id);
    if (el && el.srcObject === stream) return;
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      el.hidden = true;
      el.dataset.peer = id;
      document.body.appendChild(el);
      this.audios.set(id, el);
    }
    el.srcObject = stream;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});     // autoplay may need a user gesture; the next click resumes it
  }

  /** Close the call and remove that player's <audio> element (no ghost elements). */
  _dropVoice(id) {
    const call = this.calls.get(id);
    this.calls.delete(id);
    if (call) { try { call.close(); } catch (e) {} }
    const el = this.audios.get(id);
    if (el) { el.pause(); el.srcObject = null; el.remove(); }
    this.audios.delete(id);
  }

  _dropAllVoice() {
    [...new Set([...this.calls.keys(), ...this.audios.keys()])].forEach(id => this._dropVoice(id));
    this._knownIds = new Set();
  }

  // ---- teardown ----
  leave() {
    this._left = true;
    this._dropAllVoice();
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
