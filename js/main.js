/** main.js: wires the lobby / hub UI to Network and GameHub. */
(function () {
  const $ = id => document.getElementById(id);
  const net = new Network();

  const statusEl = $('status');
  const setStatus = (text, cls) => { statusEl.textContent = text; statusEl.className = 'status status--' + cls; };
  const showScreen = name => {
    $('lobby').classList.toggle('hidden', name !== 'lobby');
    $('hub').classList.toggle('hidden', name !== 'hub');
  };

  GameHub.init(net, $('game-container'), $('game-menu'));

  function enterHub(code) {
    $('room-code').textContent = code;
    showScreen('hub');
    GameHub.enter();
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

  net.onEvent('players', renderPlayers);

  net.onEvent('closed', () => resetLobby('The host closed the room.'));

  net.onEvent('error', err => {
    const msgs = {
      'peer-unavailable': 'Room not found. Check the code.',
      'room-full': 'That room is full.',
    };
    resetLobby(msgs[err.type] || 'Connection error: ' + (err.type || err.message));
  });

  function renderPlayers(list) {
    $('player-count').textContent = list.length;
    $('side-count').textContent = list.length;
    const ul = $('player-list');
    ul.innerHTML = '';
    list.forEach(p => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === net.myId ? ' (you)' : '');
      li.append(dot, name);
      if (p.isHost) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '👑 host';
        li.append(tag);
      }
      ul.appendChild(li);
    });
  }

  function resetLobby(msg) {
    GameHub.stop();
    net.leave();
    showScreen('lobby');
    setStatus('Not connected', 'off');
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
    $('lobby-msg').textContent = msg || '';
    $('player-list').innerHTML = '';
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
    if (!id) { $('lobby-msg').textContent = 'Enter a room code first.'; return; }
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

  $('btn-leave').onclick = () => resetLobby('You left the room.');

  // In-game the sidebar is a slim bar; ☰ opens room code + players as a dropdown
  $('btn-side-toggle').onclick = () => $('sidebar').classList.toggle('open');
})();
