/**
 * Network: the ONLY file that knows about PeerJS. Star topology for data,
 * direct P2P MediaConnections for voice, camera, and screen sharing.
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
 *        'ready'(roomId)                   host: room code is available
 *        'joined'()                        client: connected & accepted by host
 *        'players'(list)                   roster changed: [{id, name, isHost}]
 *        'peerjoin'(player) / 'peerleave'(player)   host only
 *        'remote-camera'({peerId, stream}) remote peer camera stream started/stopped
 *        'remote-screen'({peerId, stream}) remote peer screen stream started/stopped
 *        'closed'()                        client: lost the host
 *        'error'(err)
 * Wire format: { channel, type, payload, from?, to? }. Internal channel: '_net'.
 */
class Network {
  static MAX_PLAYERS = 8;

  constructor() {
    this.handlers = {};
    this.events = {};
    // Media streams (survive _reset so streams can be set before/after joining)
    this.localStream = null;        // microphone audio stream
    this.cameraStream = null;       // webcam video (+audio) stream
    this.screenStream = null;       // display media screen-share stream

    this.calls = new Map();         // remote peerId -> voice MediaConnection
    this.cameraCalls = new Map();   // remote peerId -> outgoing/incoming camera MediaConnection
    this.screenCalls = new Map();   // remote peerId -> outgoing/incoming screen MediaConnection
    this.audios = new Map();        // remote peerId -> hidden <audio> element
    this._knownIds = new Set();     // roster ids seen last time (to detect who left)
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
      } else if (msg.type === 'media-state' && this.conns.has(from)) {
        const stateMsg = { channel: '_net', type: 'media-state', payload: { ...(msg.payload || {}), peerId: from } };
        this._handleMediaState(stateMsg.payload);
        this.conns.forEach((c, id) => { if (id !== from && c.open) c.send(stateMsg); });
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
    this._syncCalls();                      // destroys that player's calls + <audio>/<video>
    if (player) this._emit('peerleave', player);
  }

  /**
   * Host only: remove a player from the room.
   * Tells them ({ channel:'_net', type:'kick' }), removes them from the roster and
   * voice/video immediately, then force-closes their data connection.
   */
  kick(peerId) {
    if (!this.isHost || peerId === this.myId) return;       // never the host itself
    const conn = this.conns.get(peerId);
    if (!conn) return;

    try { conn.send({ channel: '_net', type: 'kick' }); } catch (e) {}

    this.conns.delete(peerId);
    const player = this.players.find(p => p.id === peerId);
    this.players = this.players.filter(p => p.id !== peerId);
    this._dropPeerMedia(peerId);
    this._broadcastRoster();
    this._emit('players', this.players);
    this._syncCalls();
    if (player) this._emit('peerleave', player);

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
    if (!msg) return;
    if (msg.type === 'kick') {
      this._left = true;
      this._emit('kicked');
      return;
    }
    if (!msg.channel) return;
    if (msg.channel === '_net') {
      if (msg.type === 'roster') {
        this.players = msg.payload;
        if (!this._joined) { this._joined = true; this._emit('joined'); }
        this._emit('players', this.players);
        this._syncCalls();
      } else if (msg.type === 'media-state') {
        this._handleMediaState(msg.payload);
      } else if (msg.type === 'full') {
        this._left = true;
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

  // ================= Voice, Camera & Screen Media Streaming =================

  /** Give Network the microphone stream (or null to stop transmitting). */
  setLocalStream(stream) {
    this.localStream = stream || null;
    const track = this.localStream && this.localStream.getAudioTracks()[0];
    this.calls.forEach(call => this._swapOutgoingTrack(call, track || this._silentTrack(), 'audio'));
    this._syncCalls();
  }

  /**
   * Give Network the local camera stream (from getUserMedia({ video: true, audio: true }))
   * or null when turning the camera off.
   * Uses PeerJS `peer.call(remotePeerId, localStream)` to transmit to all peers.
   */
  setCameraStream(stream) {
    this.cameraStream = stream || null;
    if (!this.cameraStream) {
      this.cameraCalls.forEach(call => { try { call.close(); } catch (e) {} });
      this.cameraCalls.clear();
      this._broadcastMediaState({ cam: false });
      return;
    }

    // If a local audio track exists in cameraStream, also keep voice calls synced
    const audioTrack = this.cameraStream.getAudioTracks()[0];
    if (audioTrack && !this.localStream) {
      this.calls.forEach(call => this._swapOutgoingTrack(call, audioTrack, 'audio'));
    }

    // Transmit camera stream to all peers in the room via peer.call(remotePeerId, stream)
    const videoTrack = this.cameraStream.getVideoTracks()[0];
    this._remotePeerIds().forEach(peerId => {
      const existing = this.cameraCalls.get(peerId);
      if (existing && existing.peerConnection && videoTrack) {
        this._swapOutgoingTrack(existing, videoTrack, 'video');
      } else {
        this._callPeerCamera(peerId);
      }
    });
    this._broadcastMediaState({ cam: true });
  }

  /**
   * Give Network the local screen-share stream (from getDisplayMedia({ video: true }))
   * or null when screen sharing ends.
   * Transmits via PeerJS `peer.call(remotePeerId, screenStream)` and supports track replacement.
   */
  setScreenStream(stream) {
    this.screenStream = stream || null;
    if (!this.screenStream) {
      this.screenCalls.forEach(call => { try { call.close(); } catch (e) {} });
      this.screenCalls.clear();
      // If camera is still active, ensure camera video track is restored on any shared connection
      const camVideoTrack = this.cameraStream && this.cameraStream.getVideoTracks()[0];
      if (camVideoTrack) {
        this.cameraCalls.forEach(call => this._swapOutgoingTrack(call, camVideoTrack, 'video'));
      }
      this._broadcastMediaState({ screen: false });
      return;
    }

    const screenTrack = this.screenStream.getVideoTracks()[0];
    this._remotePeerIds().forEach(peerId => {
      const existing = this.screenCalls.get(peerId);
      if (existing && existing.peerConnection && screenTrack) {
        this._swapOutgoingTrack(existing, screenTrack, 'video');
      } else {
        this._callPeerScreen(peerId);
      }
    });
    this._broadcastMediaState({ screen: true });
  }

  /** Replace the outgoing video track across active video calls (camera <-> screen). */
  replaceVideoTrack(videoTrack) {
    if (!videoTrack) return;
    this.cameraCalls.forEach(call => this._swapOutgoingTrack(call, videoTrack, 'video'));
    this.screenCalls.forEach(call => this._swapOutgoingTrack(call, videoTrack, 'video'));
  }

  _remotePeerIds() {
    if (!this.myId) return [];
    return this.players.map(p => p.id).filter(id => id && id !== this.myId);
  }

  _broadcastMediaState(state) {
    if (!this.myId) return;
    const payload = { ...state, peerId: this.myId };
    if (this.isHost) {
      const msg = { channel: '_net', type: 'media-state', payload };
      this.conns.forEach(c => c.open && c.send(msg));
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ channel: '_net', type: 'media-state', payload });
    }
  }

  _handleMediaState(payload) {
    if (!payload || !payload.peerId || payload.peerId === this.myId) return;
    const peerId = payload.peerId;
    if (payload.cam === false) {
      const call = this.cameraCalls.get(peerId);
      if (call) {
        this.cameraCalls.delete(peerId);
        try { call.close(); } catch (e) {}
      }
      this.setPeerAudioMuted(peerId, false);
      this._emit('remote-camera', { peerId, stream: null });
    }
    if (payload.screen === false) {
      const call = this.screenCalls.get(peerId);
      if (call) {
        this.screenCalls.delete(peerId);
        try { call.close(); } catch (e) {}
      }
      this._emit('remote-screen', { peerId, stream: null });
    }
  }

  /** Stream to hand to voice peer.call()/answer(): the mic, or silence (so we can still HEAR others). */
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

  _swapOutgoingTrack(call, track, kind = 'audio') {
    const pc = call && call.peerConnection;
    if (!pc || !track) return;
    const senders = typeof pc.getSenders === 'function' ? pc.getSenders() : [];
    const sender = senders.find(s => s && s.track && s.track.kind === kind);
    if (sender) {
      sender.replaceTrack(track).catch(() => {});
      return;
    }
    const transceivers = typeof pc.getTransceivers === 'function' ? pc.getTransceivers() : [];
    const t = transceivers.find(tr => tr.receiver && tr.receiver.track && tr.receiver.track.kind === kind);
    if (t && t.sender) t.sender.replaceTrack(track).catch(() => {});
  }

  /** Start missing calls, and tear down voice/video for players that left the roster. */
  _syncCalls() {
    if (!this.peer || !this.myId) return;
    const now = new Set(this._remotePeerIds());

    // Players who were in the roster before and are gone now -> destroy their media calls
    this._knownIds.forEach(id => { if (!now.has(id)) this._dropPeerMedia(id); });
    this._knownIds = now;

    now.forEach(id => {
      // 1. Voice mesh call (smaller peer ID initiates)
      if (!this.calls.has(id) && this.myId < id) {
        try {
          const call = this.peer.call(id, this._currentStream(), { metadata: { kind: 'voice', from: this.myId } });
          if (call) this._wireVoiceCall(call);
        } catch (e) { console.warn('Voice call failed:', e); }
      }
      // 2. If our camera is currently active, transmit it to newly joined peer
      if (this.cameraStream && !this.cameraCalls.has(id)) {
        this._callPeerCamera(id);
      }
      // 3. If our screen share is currently active, transmit it to newly joined peer
      if (this.screenStream && !this.screenCalls.has(id)) {
        this._callPeerScreen(id);
      }
    });
  }

  _callPeerCamera(peerId) {
    if (!this.peer || !this.cameraStream || !peerId || peerId === this.myId) return;
    try {
      const call = this.peer.call(peerId, this.cameraStream, {
        metadata: { kind: 'camera', from: this.myId },
      });
      if (call) this._wireCameraCall(call);
    } catch (e) {
      console.warn('Camera call failed:', e);
    }
  }

  _callPeerScreen(peerId) {
    if (!this.peer || !this.screenStream || !peerId || peerId === this.myId) return;
    try {
      const call = this.peer.call(peerId, this.screenStream, {
        metadata: { kind: 'screen', from: this.myId },
      });
      if (call) this._wireScreenCall(call);
    } catch (e) {
      console.warn('Screen share call failed:', e);
    }
  }

  _onIncomingCall(call) {
    const kind = (call && call.metadata && call.metadata.kind) || 'voice';

    if (kind === 'screen') {
      try { call.answer(); } catch (e) { call.answer(this._silentStream()); }
      this._wireScreenCall(call);
      return;
    }

    if (kind === 'camera') {
      // Answer with our own camera stream if active, or silent audio stream so two-way negotiation succeeds
      call.answer(this.cameraStream || this._currentStream());
      this._wireCameraCall(call);
      return;
    }

    // Default / voice call (also supports generic peer.call(remotePeerId, localStream) with video+audio)
    call.answer(this.cameraStream || this._currentStream());
    this._wireVoiceCall(call);
  }

  _wireVoiceCall(call) {
    const id = call.peer;
    if (this.calls.has(id) && this.calls.get(id) !== call) this._dropVoice(id);
    this.calls.set(id, call);
    call.on('stream', remote => {
      if (remote.getAudioTracks().length > 0) this._attachAudio(id, remote);
      if (remote.getVideoTracks().length > 0) {
        this._emit('remote-camera', { peerId: id, stream: remote });
      }
    });
    call.on('close', () => { if (this.calls.get(id) === call) this._dropVoice(id); });
    call.on('error', () => { if (this.calls.get(id) === call) this._dropVoice(id); });
  }

  _wireCameraCall(call) {
    const id = call.peer;
    const prev = this.cameraCalls.get(id);
    if (prev && prev !== call) {
      try { prev.close(); } catch (e) {}
    }
    this.cameraCalls.set(id, call);

    call.on('stream', remote => {
      if (remote && remote.getVideoTracks().length > 0) {
        // If remote camera stream also carries audio and we don't have a voice <audio>, attach audio
        if (remote.getAudioTracks().length > 0 && !this.audios.has(id)) {
          this._attachAudio(id, remote);
        }
        this._emit('remote-camera', { peerId: id, stream: remote });
      }
    });
    const cleanup = () => {
      if (this.cameraCalls.get(id) === call) {
        this.cameraCalls.delete(id);
        this.setPeerAudioMuted(id, false);
        this._emit('remote-camera', { peerId: id, stream: null });
      }
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
  }

  _wireScreenCall(call) {
    const id = call.peer;
    const prev = this.screenCalls.get(id);
    if (prev && prev !== call) {
      try { prev.close(); } catch (e) {}
    }
    this.screenCalls.set(id, call);

    call.on('stream', remote => {
      if (remote && remote.getVideoTracks().length > 0) {
        const vt = remote.getVideoTracks()[0];
        if (vt) {
          vt.addEventListener('ended', () => {
            this._emit('remote-screen', { peerId: id, stream: null });
          });
        }
        this._emit('remote-screen', { peerId: id, stream: remote });
      }
    });
    const cleanup = () => {
      if (this.screenCalls.get(id) === call) {
        this.screenCalls.delete(id);
        this._emit('remote-screen', { peerId: id, stream: null });
      }
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
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
    if (p && p.catch) p.catch(() => {});
  }

  /** Mute/unmute the hidden <audio> for a peer (used to prevent duplicate audio when <video> plays audio). */
  setPeerAudioMuted(id, muted) {
    const el = this.audios.get(id);
    if (el) el.muted = Boolean(muted);
  }

  /** Close the voice call and remove that player's <audio> element (no ghost elements). */
  _dropVoice(id) {
    const call = this.calls.get(id);
    this.calls.delete(id);
    if (call) { try { call.close(); } catch (e) {} }
    const el = this.audios.get(id);
    if (el) { el.pause(); el.srcObject = null; el.remove(); }
    this.audios.delete(id);
  }

  /** Close voice, camera, and screen calls for a specific peer. */
  _dropPeerMedia(id) {
    this._dropVoice(id);
    const camCall = this.cameraCalls.get(id);
    if (camCall) {
      this.cameraCalls.delete(id);
      try { camCall.close(); } catch (e) {}
    }
    this._emit('remote-camera', { peerId: id, stream: null });

    const scrCall = this.screenCalls.get(id);
    if (scrCall) {
      this.screenCalls.delete(id);
      try { scrCall.close(); } catch (e) {}
    }
    this._emit('remote-screen', { peerId: id, stream: null });
  }

  _dropAllVoice() {
    const allIds = new Set([
      ...this.calls.keys(),
      ...this.cameraCalls.keys(),
      ...this.screenCalls.keys(),
      ...this.audios.keys(),
    ]);
    allIds.forEach(id => this._dropPeerMedia(id));
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
