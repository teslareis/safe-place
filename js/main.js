/** main.js: wires the lobby / hub UI to Network and GameHub. */
(function () {
  const $ = id => document.getElementById(id);
  const net = new Network();

  const statusEl = $('status');
  const setStatus = (text, cls) => {
    statusEl.textContent = text;
    statusEl.className = 'status status--' + cls;
  };
  const showScreen = name => {
    $('lobby').classList.toggle('hidden', name !== 'lobby');
    $('hub').classList.toggle('hidden', name !== 'hub');
  };

  GameHub.init(net, $('game-container'), $('game-menu'));

  // ---------- Voice chat: microphone ----------
  // The stream is handed to Network, which opens direct P2P media calls.
  // A denied/missing mic never breaks the game: players just don't transmit.
  const micBtn = $('btn-mic');
  let localStream = null;
  let inRoom = false;
  let micPending = false;
  let kickHandled = false;

  function renderMic(state) {
    const track = localStream && localStream.getAudioTracks()[0];
    state = state || (track ? (track.enabled ? 'on' : 'off') : 'off');
    micBtn.className = 'btn mic-btn mic-btn--' + state;
    micBtn.textContent = {
      on: 'Mic: On',
      off: 'Mic: Off',
      blocked: 'Mic: Off (blocked)',
      na: 'Mic: N/A',
    }[state];
    micBtn.title = state === 'blocked'
      ? 'Microphone access was denied. Click to try again.'
      : state === 'na'
        ? 'Microphone is not available in this browser/context.'
        : 'Mute / unmute your microphone';
  }

  async function initMic() {
    if (localStream || micPending) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return renderMic('na');
    micPending = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!inRoom) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      localStream = stream;
      localStream.getAudioTracks()[0].enabled = true;
      if (typeof net.setLocalStream === 'function') net.setLocalStream(localStream);
      renderMic();
    } catch (err) {
      console.warn('Microphone unavailable:', err.name || err);
      renderMic('blocked');
    } finally {
      micPending = false;
    }
  }

  function stopMic() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    if (typeof net.setLocalStream === 'function') net.setLocalStream(null);
    renderMic('off');
  }

  micBtn.onclick = () => {
    const track = localStream && localStream.getAudioTracks()[0];
    if (!track) return initMic();
    track.enabled = !track.enabled;
    renderMic();
  };

  function enterHub(code) {
    kickHandled = false;
    $('room-code').textContent = code;
    showScreen('hub');
    GameHub.enter();
    inRoom = true;
    renderMic('off');
    initMic();
    updatePlayerList(net.players || []);
  }

  // Host: room is live -> go straight to the hub and wait for players
  net.onEvent('ready', id => {
    setStatus('Hosting', 'on');
    enterHub(id);
  });

  // Client: host accepted us
  net.onEvent('joined', () => {
    setStatus('Connected ✔', 'on');
    enterHub(net.hostId);
  });

  net.onEvent('players', updatePlayerList);

  net.onEvent('closed', () => {
    if (!kickHandled) leaveRoom('The host closed the room.');
  });

  // ---------- Kick logic (Host -> Client) ----------
  function onKickedByHost() {
    if (kickHandled) return;
    kickHandled = true;
    window.alert('Oda sahibi tarafından odadan atıldınız. (Kicked by host)');
    leaveRoom('Oda sahibi tarafından odadan atıldınız.');
  }

  net.onEvent('kicked', onKickedByHost);
  net.on('sys', type => {
    if (type === 'kick') onKickedByHost();
  });

  function kickPlayer(peerId) {
    if (!net.isHost || !peerId || peerId === net.myId) return;

    // Send { type: 'kick' } on sys channel and also run network-level kick
    net.send('sys', 'kick', null, peerId);

    if (typeof net.kick === 'function') {
      net.kick(peerId);
      return;
    }

    // Fallback if an older network.js without net.kick() is loaded
    const conn = net.conns && net.conns.get(peerId);
    if (conn) {
      try { conn.send({ type: 'kick', channel: '_net' }); } catch (e) {}
      net.conns.delete(peerId);
    }
    const player = (net.players || []).find(p => p.id === peerId);
    net.players = (net.players || []).filter(p => p.id !== peerId);
    if (typeof net._dropVoice === 'function') net._dropVoice(peerId);
    if (typeof net._broadcastRoster === 'function') net._broadcastRoster();
    if (typeof net._emit === 'function') {
      net._emit('players', net.players);
      if (player) net._emit('peerleave', player);
    }
    if (conn) {
      setTimeout(() => { try { conn.close(); } catch (e) {} }, 100);
    }
  }

  /** Disconnect from the PeerJS session and return to the Create/Join screen. */
  function leaveRoom(msg) {
    resetLobby(msg);
  }

  net.onEvent('error', err => {
    const msgs = {
      'peer-unavailable': 'Room not found. Check the code.',
      'room-full': 'That room is full.',
    };
    resetLobby(msgs[err.type] || 'Connection error: ' + (err.type || err.message));
  });

  function updatePlayerList(list) {
    const players = Array.isArray(list) ? list : [];
    $('player-count').textContent = players.length;
    $('side-count').textContent = players.length;

    const ul = $('player-list');
    ul.innerHTML = '';

    const isLocalHost = Boolean(net.isHost || (net.myId && net.hostId && net.myId === net.hostId));

    players.forEach(p => {
      const peerId = p && typeof p === 'object' ? p.id : String(p);
      const playerName = p && typeof p === 'object' ? (p.name || p.id) : String(p);
      const isPlayerHost = Boolean(
        (p && typeof p === 'object' && p.isHost) ||
        (net.hostId && peerId === net.hostId) ||
        (isLocalHost && peerId === net.myId)
      );

      const li = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = 'dot';

      const name = document.createElement('span');
      name.textContent = playerName + (peerId === net.myId ? ' (you)' : '');

      li.append(dot, name);

      if (isPlayerHost) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '👑 host';
        li.append(tag);
      }

      // Only the Host sees the Kick button, and never next to the Host's own name
      if (isLocalHost && !isPlayerHost && peerId !== net.myId) {
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'kick-btn';
        kickBtn.textContent = '❌ (Kick)';
        kickBtn.title = 'Kick ' + playerName;
        kickBtn.style.cssText = 'margin-left:auto;cursor:pointer;background:transparent;color:#ff5c5c;border:1px solid #ff5c5c66;border-radius:6px;padding:2px 8px;font-size:.75rem;font-weight:600;';
        kickBtn.addEventListener('click', e => {
          e.stopPropagation();
          kickPlayer(peerId);
        });
        li.appendChild(kickBtn);
      }

      ul.appendChild(li);
    });
  }

  function resetLobby(msg) {
    GameHub.stop();
    inRoom = false;
    stopMic();
    net.leave();
    showScreen('lobby');
    setStatus('Not connected', 'off');
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
    $('lobby-msg').textContent = msg || '';
    $('player-list').innerHTML = '';
    $('player-count').textContent = '0';
    $('side-count').textContent = '0';
    $('game-container').innerHTML = '';
  }

  $('btn-create').onclick = () => {
    $('lobby-msg').textContent = '';
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    setStatus('Creating room…', 'wait');
    net.host($('name-input').value.trim() || 'Host');
  };

  $('btn-join').onclick = () => {
    const id = $('join-input').value.trim();
    if (!id) {
      $('lobby-msg').textContent = 'Enter a room code first.';
      return;
    }
    $('lobby-msg').textContent = '';
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    setStatus('Connecting…', 'wait');
    net.join(id, $('name-input').value.trim() || 'Player');
  };

  $('btn-copy').onclick = () => {
    navigator.clipboard.writeText($('room-code').textContent);
    $('btn-copy').textContent = 'Copied!';
    setTimeout(() => ($('btn-copy').textContent = 'Copy'), 1200);
  };

  $('btn-leave').onclick = () => leaveRoom('You left the room.');

  // In-game the sidebar is a slim bar; ☰ opens room code + players as a dropdown
  $('btn-side-toggle').onclick = () => $('sidebar').classList.toggle('open');
})();
