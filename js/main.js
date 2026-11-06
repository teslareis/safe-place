/** main.js: wires the lobby / hub UI, voice chat, live camera sharing, and screen sharing to Network and GameHub. */
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

  // ---------- Media Elements & State ----------
  const micBtn = $('btn-mic');
  const camBtn = $('btn-cam');
  const screenBtn = $('btn-screen');

  const videoDock = $('video-dock');
  const dockMinBtn = $('btn-dock-min');
  const dockPosBtn = $('btn-dock-pos');
  const localVideoCard = $('local-video-card');
  const remoteVideoCard = $('remote-video-card');
  const localVideo = $('local-video');
  const remoteVideo = $('remote-video');
  const localVideoLabel = $('local-video-label');
  const remoteVideoLabel = $('remote-video-label');
  const localFsBtn = $('btn-local-fullscreen');
  const remoteFsBtn = $('btn-remote-fullscreen');

  const screenContainer = $('screen-share-container');
  const screenVideo = $('screen-video');
  const screenLabel = $('screen-share-label');
  const screenFsBtn = $('btn-screen-fullscreen');
  const screenFsOverlayBtn = $('btn-screen-fs-overlay');
  const screenSizeBtn = $('btn-screen-size');
  const screenMinBtn = $('btn-screen-min');
  const screenStopBtn = $('btn-screen-stop');

  let localStream = null;        // Voice microphone stream
  let cameraStream = null;       // Local camera stream (getUserMedia({ video: true, audio: true }))
  let screenStream = null;       // Local screen share stream (getDisplayMedia({ video: true }))
  let remoteCameraMap = new Map(); // peerId -> MediaStream
  let remoteScreenMap = new Map(); // peerId -> MediaStream

  let inRoom = false;
  let micPending = false;
  let camPending = false;
  let screenPending = false;
  let kickHandled = false;
  let dockPositions = ['pos-br', 'pos-bl', 'pos-tr'];
  let dockPosIdx = 0;

  // Helper to resolve a peer's display name from the roster
  function peerName(peerId) {
    if (!peerId) return 'Partner';
    if (peerId === net.myId) return ($('name-input').value.trim() || 'You');
    const found = (net.players || []).find(p => p && p.id === peerId);
    return (found && found.name) ? found.name : 'Partner';
  }

  function isMicEnabled() {
    const audioTrack = localStream && localStream.getAudioTracks()[0];
    if (audioTrack) return Boolean(audioTrack.enabled);
    const camAudio = cameraStream && cameraStream.getAudioTracks()[0];
    if (camAudio) return Boolean(camAudio.enabled);
    return false;
  }

  function syncAllAudioTracks(enabled) {
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = Boolean(enabled); });
    }
    if (cameraStream) {
      cameraStream.getAudioTracks().forEach(t => { t.enabled = Boolean(enabled); });
    }
  }

  // ---------- 1. Voice chat: microphone ----------
  function renderMic(state) {
    const track = (localStream && localStream.getAudioTracks()[0]) ||
                  (cameraStream && cameraStream.getAudioTracks()[0]);
    state = state || (track ? (track.enabled ? 'on' : 'off') : 'off');
    micBtn.className = 'btn mic-btn mic-btn--' + state;
    micBtn.textContent = {
      on: 'Mic: On',
      off: 'Mic: Off',
      blocked: 'Mic: Off (blocked)',
      na: 'Mic: N/A',
    }[state] || 'Mic: Off';
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
      localStream.getAudioTracks().forEach(t => { t.enabled = true; });
      if (cameraStream) {
        cameraStream.getAudioTracks().forEach(t => { t.enabled = true; });
      }
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
    const track = (localStream && localStream.getAudioTracks()[0]) ||
                  (cameraStream && cameraStream.getAudioTracks()[0]);
    if (!track) return initMic();
    const nextEnabled = !track.enabled;
    syncAllAudioTracks(nextEnabled);
    renderMic();
  };

  // ---------- 2. Live Camera Sharing (getUserMedia + PeerJS call) ----------
  function renderCam(state) {
    if (!camBtn) return;
    const videoTrack = cameraStream && cameraStream.getVideoTracks()[0];
    state = state || (videoTrack && videoTrack.readyState === 'live' && videoTrack.enabled ? 'on' : 'off');
    camBtn.className = 'btn cam-btn cam-btn--' + state;
    camBtn.textContent = {
      on: 'Cam: On',
      off: 'Cam: Off',
      blocked: 'Cam: Blocked',
      na: 'Cam: N/A',
    }[state] || 'Cam: Off';
    camBtn.title = state === 'blocked'
      ? 'Camera access was denied. Click to retry.'
      : state === 'na'
        ? 'Camera is not available in this browser.'
        : 'Turn your camera on or off';
  }

  function updateVideoDockVisibility() {
    if (!videoDock) return;
    const hasLocalCam = Boolean(cameraStream && cameraStream.getVideoTracks().length > 0);
    const hasRemoteCam = remoteCameraMap.size > 0;

    if (localVideoCard) localVideoCard.classList.toggle('hidden', !hasLocalCam);
    if (remoteVideoCard) remoteVideoCard.classList.toggle('hidden', !hasRemoteCam);
    videoDock.classList.toggle('hidden', !hasLocalCam && !hasRemoteCam);

    if (localVideoLabel) {
      localVideoLabel.textContent = ($('name-input').value.trim() || 'You') + ' (You)';
    }
  }

  async function startCamera() {
    if (cameraStream || camPending || !inRoom) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      renderCam('na');
      return;
    }
    camPending = true;
    try {
      let stream = null;
      try {
        // Request both video and audio as required by specification
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: true,
        });
      } catch (avErr) {
        // Fallback to video-only if audio device is busy or unavailable
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: false,
        });
      }

      if (!inRoom) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      cameraStream = stream;

      // Sync camera stream audio track mute state with current Mic state
      const micCurrentlyOn = localStream
        ? Boolean(localStream.getAudioTracks()[0] && localStream.getAudioTracks()[0].enabled)
        : true;
      cameraStream.getAudioTracks().forEach(t => { t.enabled = micCurrentlyOn; });
      if (!localStream && cameraStream.getAudioTracks().length > 0) {
        renderMic(micCurrentlyOn ? 'on' : 'off');
      }

      // Handle hardware disconnect / track end
      const videoTrack = cameraStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => stopCamera();
      }

      // Attach local camera stream to #local-video
      if (localVideo) {
        localVideo.srcObject = cameraStream;
        localVideo.muted = true;
        const p = localVideo.play();
        if (p && p.catch) p.catch(() => {});
      }

      // Transmit camera stream to peers via PeerJS call
      if (typeof net.setCameraStream === 'function') {
        net.setCameraStream(cameraStream);
      }

      renderCam('on');
      updateVideoDockVisibility();
    } catch (err) {
      console.warn('Camera unavailable:', err.name || err);
      renderCam('blocked');
    } finally {
      camPending = false;
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    if (localVideo) {
      localVideo.pause();
      localVideo.srcObject = null;
    }
    if (typeof net.setCameraStream === 'function') {
      net.setCameraStream(null);
    }
    renderCam('off');
    renderMic();
    updateVideoDockVisibility();
  }

  if (camBtn) {
    camBtn.onclick = () => {
      if (cameraStream) stopCamera();
      else startCamera();
    };
  }

  // ---------- 3. Screen Sharing (getDisplayMedia + track.onended + Mobile Guard) ----------
  function renderScreenBtn(state) {
    if (!screenBtn) return;
    const active = Boolean(screenStream && screenStream.getVideoTracks().length > 0);
    // Never leave button stuck in 'na' or 'blocked' state — always revert cleanly to 'off'
    const normalized = (state === 'on' || (active && !state)) ? 'on' : 'off';
    screenBtn.disabled = false;
    screenBtn.className = 'btn screen-btn screen-btn--' + normalized;
    screenBtn.textContent = normalized === 'on' ? 'Screen: On' : 'Share Screen';
  }

  function updateScreenShareView() {
    if (!screenContainer || !screenVideo) return;

    // Prioritize showing a remote peer's shared screen; otherwise show local shared screen preview
    const remoteEntries = Array.from(remoteScreenMap.entries());
    if (remoteEntries.length > 0) {
      const [remotePeerId, remoteStream] = remoteEntries[remoteEntries.length - 1];
      if (screenVideo.srcObject !== remoteStream) {
        screenVideo.srcObject = remoteStream;
        screenVideo.muted = false;
        const p = screenVideo.play();
        if (p && p.catch) p.catch(() => {});
      }
      if (screenLabel) {
        screenLabel.textContent = `${peerName(remotePeerId)}'s Screen — Live`;
      }
      if (screenStopBtn) {
        screenStopBtn.classList.toggle('hidden', !screenStream);
      }
      screenContainer.classList.remove('hidden');
      return;
    }

    if (screenStream && screenStream.getVideoTracks().length > 0) {
      if (screenVideo.srcObject !== screenStream) {
        screenVideo.srcObject = screenStream;
        screenVideo.muted = true;
        const p = screenVideo.play();
        if (p && p.catch) p.catch(() => {});
      }
      if (screenLabel) {
        screenLabel.textContent = 'Your Screen — Sharing Live';
      }
      if (screenStopBtn) {
        screenStopBtn.classList.remove('hidden');
      }
      screenContainer.classList.remove('hidden');
      return;
    }

    // Neither local nor remote screen share is active
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
    if (fsEl && (fsEl === screenContainer || fsEl === screenVideo)) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    screenVideo.pause();
    screenVideo.srcObject = null;
    if (screenStopBtn) screenStopBtn.classList.add('hidden');
    screenContainer.classList.add('hidden');
    screenContainer.classList.remove('screen-share--expanded', 'screen-share--minimized', 'is-fullscreen');
    if (screenSizeBtn) screenSizeBtn.textContent = '⛶ Expand';
    if (screenMinBtn) screenMinBtn.textContent = '−';
  }

  async function startScreenShare() {
    if (screenStream || screenPending || !inRoom) return;

    // Robust feature detection for mobile/tablet browsers where getDisplayMedia is restricted
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      window.alert('Screen sharing is not supported on this device.');
      renderScreenBtn('off');
      updateScreenShareView();
      return;
    }

    screenPending = true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      if (!inRoom) {
        stream.getTracks().forEach(t => t.stop());
        renderScreenBtn('off');
        return;
      }

      screenStream = stream;
      const screenTrack = screenStream.getVideoTracks()[0];
      if (screenTrack) {
        // Gracefully handle browser's built-in "Stop sharing" button
        screenTrack.onended = () => {
          stopScreenShare();
        };
      }

      if (typeof net.setScreenStream === 'function') {
        net.setScreenStream(screenStream);
      }

      renderScreenBtn('on');
      updateScreenShareView();
    } catch (err) {
      console.warn('Screen share error:', err && (err.name || err.message || err));
      const errName = (err && err.name) || '';
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');
      if (isMobile || errName === 'NotFoundError' || errName === 'NotSupportedError' || errName === 'InvalidAccessError' || errName === 'TypeError') {
        window.alert('Screen sharing is not supported on this device.');
      } else if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError' || errName === 'AbortError') {
        window.alert('Screen sharing was cancelled or is not supported on this device.');
      } else {
        window.alert('Screen sharing is not supported on this device.');
      }
      renderScreenBtn('off');
      updateScreenShareView();
    } finally {
      screenPending = false;
    }
  }

  function stopScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach(t => {
        t.onended = null;
        t.stop();
      });
      screenStream = null;
    }
    if (typeof net.setScreenStream === 'function') {
      net.setScreenStream(null);
    }
    renderScreenBtn('off');
    updateScreenShareView();
  }

  if (screenBtn) {
    screenBtn.onclick = () => {
      if (screenStream) stopScreenShare();
      else startScreenShare();
    };
  }
  if (screenStopBtn) {
    screenStopBtn.onclick = () => stopScreenShare();
  }

  // ---------- 4. Interactive Video, Screen Dock & Native Fullscreen Controls ----------
  function getActiveFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  function exitNativeFullscreen() {
    if (document.exitFullscreen) return document.exitFullscreen().catch(() => {});
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
    if (document.msExitFullscreen) return document.msExitFullscreen();
  }

  function requestNativeFullscreen(targetEl, fallbackVideoEl) {
    if (!targetEl) return;
    const req =
      targetEl.requestFullscreen ||
      targetEl.webkitRequestFullscreen ||
      targetEl.mozRequestFullScreen ||
      targetEl.msRequestFullscreen;

    if (req) {
      try {
        const res = req.call(targetEl);
        if (res && typeof res.catch === 'function') {
          res.catch(() => {
            if (fallbackVideoEl && fallbackVideoEl !== targetEl) {
              requestNativeFullscreen(fallbackVideoEl, null);
            }
          });
        }
        return;
      } catch (e) {}
    }
    if (fallbackVideoEl && typeof fallbackVideoEl.webkitEnterFullscreen === 'function') {
      try { fallbackVideoEl.webkitEnterFullscreen(); } catch (e) {}
    }
  }

  function toggleElementFullscreen(containerEl, videoEl) {
    if (!containerEl) return;
    // Restore if minimized before entering fullscreen
    containerEl.classList.remove('screen-share--minimized', 'video-dock--minimized');
    if (containerEl === screenContainer && screenMinBtn) screenMinBtn.textContent = '−';

    const fsEl = getActiveFullscreenElement();
    const isAlreadyFs = Boolean(
      (fsEl && (fsEl === containerEl || fsEl === videoEl || containerEl.contains(fsEl))) ||
      containerEl.classList.contains('is-fullscreen')
    );

    if (isAlreadyFs) {
      containerEl.classList.remove('is-fullscreen');
      if (fsEl) exitNativeFullscreen();
      syncFullscreenState();
    } else {
      if (screenContainer) screenContainer.classList.remove('is-fullscreen');
      if (remoteVideoCard) remoteVideoCard.classList.remove('is-fullscreen');
      if (localVideoCard) localVideoCard.classList.remove('is-fullscreen');
      containerEl.classList.add('is-fullscreen');
      syncFullscreenState();

      if (fsEl) {
        const p = exitNativeFullscreen();
        if (p && typeof p.then === 'function') {
          p.then(() => requestNativeFullscreen(containerEl, videoEl));
        } else {
          requestNativeFullscreen(containerEl, videoEl);
        }
      } else {
        requestNativeFullscreen(containerEl, videoEl);
      }
    }
  }

  function syncFullscreenState() {
    const fsEl = getActiveFullscreenElement();
    const isScreenFs = Boolean(
      (fsEl && (fsEl === screenContainer || fsEl === screenVideo || (screenContainer && screenContainer.contains(fsEl)))) ||
      (screenContainer && screenContainer.classList.contains('is-fullscreen'))
    );
    const isRemoteFs = Boolean(
      (fsEl && (fsEl === remoteVideoCard || fsEl === remoteVideo || (remoteVideoCard && remoteVideoCard.contains(fsEl)))) ||
      (remoteVideoCard && remoteVideoCard.classList.contains('is-fullscreen'))
    );
    const isLocalFs = Boolean(
      (fsEl && (fsEl === localVideoCard || fsEl === localVideo || (localVideoCard && localVideoCard.contains(fsEl)))) ||
      (localVideoCard && localVideoCard.classList.contains('is-fullscreen'))
    );

    if (screenContainer) screenContainer.classList.toggle('is-fullscreen', isScreenFs);
    if (remoteVideoCard) remoteVideoCard.classList.toggle('is-fullscreen', isRemoteFs);
    if (localVideoCard) localVideoCard.classList.toggle('is-fullscreen', isLocalFs);
    if (videoDock) videoDock.classList.toggle('has-fullscreen-card', isRemoteFs || isLocalFs);

    if (screenFsBtn) {
      screenFsBtn.textContent = isScreenFs ? '🗗 Çıkış / Exit' : '⛶ Tam Ekran / Fullscreen';
      screenFsBtn.title = isScreenFs ? 'Tam Ekrandan Çık / Exit Fullscreen (Esc)' : 'Tam Ekran / Fullscreen';
    }
    if (screenFsOverlayBtn) {
      screenFsOverlayBtn.textContent = isScreenFs ? '🗗 Tam Ekrandan Çık / Exit' : '⛶ Tam Ekran / Fullscreen';
      screenFsOverlayBtn.title = isScreenFs ? 'Tam Ekrandan Çık / Exit Fullscreen (Esc)' : 'Tam Ekran / Fullscreen';
    }
    if (remoteFsBtn) {
      remoteFsBtn.textContent = isRemoteFs ? '🗗 Çıkış / Exit' : '⛶ Tam Ekran';
      remoteFsBtn.title = isRemoteFs ? 'Tam Ekrandan Çık / Exit Fullscreen (Esc)' : 'Tam Ekran / Fullscreen';
    }
    if (localFsBtn) {
      localFsBtn.textContent = isLocalFs ? '🗗 Çıkış / Exit' : '⛶ Tam Ekran';
      localFsBtn.title = isLocalFs ? 'Tam Ekrandan Çık / Exit Fullscreen (Esc)' : 'Tam Ekran / Fullscreen';
    }
  }

  function onNativeFullscreenChange() {
    const fsEl = getActiveFullscreenElement();
    if (!fsEl) {
      if (screenContainer) screenContainer.classList.remove('is-fullscreen');
      if (remoteVideoCard) remoteVideoCard.classList.remove('is-fullscreen');
      if (localVideoCard) localVideoCard.classList.remove('is-fullscreen');
    }
    syncFullscreenState();
  }

  window.__safePlaceFullscreenInit = true;
  document.addEventListener('fullscreenchange', onNativeFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onNativeFullscreenChange);
  document.addEventListener('MSFullscreenChange', onNativeFullscreenChange);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (screenContainer) screenContainer.classList.remove('is-fullscreen');
      if (remoteVideoCard) remoteVideoCard.classList.remove('is-fullscreen');
      if (localVideoCard) localVideoCard.classList.remove('is-fullscreen');
      syncFullscreenState();
    }
  });

  if (screenFsBtn && screenContainer) {
    screenFsBtn.onclick = e => {
      e.stopPropagation();
      toggleElementFullscreen(screenContainer, screenVideo);
    };
  }
  if (screenFsOverlayBtn && screenContainer) {
    screenFsOverlayBtn.onclick = e => {
      e.stopPropagation();
      toggleElementFullscreen(screenContainer, screenVideo);
    };
  }
  if (screenVideo && screenContainer) {
    screenVideo.ondblclick = () => toggleElementFullscreen(screenContainer, screenVideo);
  }

  if (remoteFsBtn && remoteVideoCard) {
    remoteFsBtn.onclick = e => {
      e.stopPropagation();
      toggleElementFullscreen(remoteVideoCard, remoteVideo);
    };
  }
  if (remoteVideo && remoteVideoCard) {
    remoteVideo.ondblclick = () => toggleElementFullscreen(remoteVideoCard, remoteVideo);
  }

  if (localFsBtn && localVideoCard) {
    localFsBtn.onclick = e => {
      e.stopPropagation();
      toggleElementFullscreen(localVideoCard, localVideo);
    };
  }
  if (localVideo && localVideoCard) {
    localVideo.ondblclick = () => toggleElementFullscreen(localVideoCard, localVideo);
  }

  if (dockMinBtn && videoDock) {
    dockMinBtn.onclick = () => {
      const minimized = videoDock.classList.toggle('video-dock--minimized');
      dockMinBtn.textContent = minimized ? '+' : '−';
      dockMinBtn.title = minimized ? 'Expand cameras' : 'Minimize cameras';
    };
  }

  if (dockPosBtn && videoDock) {
    dockPosBtn.onclick = () => {
      videoDock.classList.remove(...dockPositions);
      dockPosIdx = (dockPosIdx + 1) % dockPositions.length;
      videoDock.classList.add(dockPositions[dockPosIdx]);
    };
  }

  if (screenSizeBtn && screenContainer) {
    screenSizeBtn.onclick = () => {
      screenContainer.classList.remove('screen-share--minimized');
      if (screenMinBtn) screenMinBtn.textContent = '−';
      const expanded = screenContainer.classList.toggle('screen-share--expanded');
      screenSizeBtn.textContent = expanded ? '🗗 Compact' : '⛶ Expand';
    };
  }

  if (screenMinBtn && screenContainer) {
    screenMinBtn.onclick = () => {
      const minimized = screenContainer.classList.toggle('screen-share--minimized');
      screenMinBtn.textContent = minimized ? '+' : '−';
    };
  }

  // ---------- 5. Network Media Event Listeners ----------
  net.onEvent('remote-camera', ({ peerId, stream }) => {
    if (!peerId || peerId === net.myId) return;

    if (stream && stream.getVideoTracks().length > 0) {
      remoteCameraMap.set(peerId, stream);
      if (remoteVideo) {
        remoteVideo.srcObject = stream;
        // Prevent duplicate audio echo if voice chat <audio> is already active for this peer
        const hasDedicatedVoiceAudio = Boolean(net.audios && net.audios.has(peerId));
        remoteVideo.muted = hasDedicatedVoiceAudio;
        const p = remoteVideo.play();
        if (p && p.catch) p.catch(() => {});
      }
      if (remoteVideoLabel) {
        remoteVideoLabel.textContent = peerName(peerId);
      }
    } else {
      remoteCameraMap.delete(peerId);
      const remaining = Array.from(remoteCameraMap.entries());
      if (remaining.length > 0) {
        const [nextPeerId, nextStream] = remaining[remaining.length - 1];
        if (remoteVideo) {
          remoteVideo.srcObject = nextStream;
          const p = remoteVideo.play();
          if (p && p.catch) p.catch(() => {});
        }
        if (remoteVideoLabel) remoteVideoLabel.textContent = peerName(nextPeerId);
      } else if (remoteVideo) {
        remoteVideo.pause();
        remoteVideo.srcObject = null;
      }
    }
    updateVideoDockVisibility();
  });

  net.onEvent('remote-screen', ({ peerId, stream }) => {
    if (!peerId || peerId === net.myId) return;
    if (stream && stream.getVideoTracks().length > 0) {
      remoteScreenMap.set(peerId, stream);
    } else {
      remoteScreenMap.delete(peerId);
    }
    updateScreenShareView();
  });

  // ---------- 6. Hub & Lobby Lifecycle ----------
  function enterHub(code) {
    kickHandled = false;
    $('room-code').textContent = code;
    showScreen('hub');
    GameHub.enter();
    inRoom = true;
    renderMic('off');
    renderCam('off');
    renderScreenBtn('off');
    initMic();
    updatePlayerList(net.players || []);
    updateVideoDockVisibility();
    updateScreenShareView();
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

  net.onEvent('players', list => {
    updatePlayerList(list);
    // Keep remote video/screen labels up to date with player names
    const camEntries = Array.from(remoteCameraMap.keys());
    if (camEntries.length > 0 && remoteVideoLabel) {
      remoteVideoLabel.textContent = peerName(camEntries[camEntries.length - 1]);
    }
    updateScreenShareView();
  });

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

    net.send('sys', 'kick', null, peerId);

    if (typeof net.kick === 'function') {
      net.kick(peerId);
      return;
    }

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
    stopScreenShare();
    stopCamera();
    stopMic();
    remoteCameraMap.clear();
    remoteScreenMap.clear();
    if (remoteVideo) {
      remoteVideo.pause();
      remoteVideo.srcObject = null;
    }
    updateVideoDockVisibility();
    updateScreenShareView();
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

  function joinRoomByCode(roomCode) {
    const id = String(roomCode || '').trim();
    if (!id) {
      $('lobby-msg').textContent = 'Enter a room code first.';
      return;
    }
    if ($('join-input')) $('join-input').value = id;
    $('lobby-msg').textContent = '';
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    setStatus('Connecting…', 'wait');
    net.join(id, $('name-input').value.trim() || 'Player');
  }

  $('btn-create').onclick = () => {
    $('lobby-msg').textContent = '';
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    setStatus('Creating room…', 'wait');
    net.host($('name-input').value.trim() || 'Host');
  };

  $('btn-join').onclick = () => {
    joinRoomByCode($('join-input').value);
  };

  function copyTextToClipboard(text, onDone) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onDone).catch(() => fallbackCopy(text, onDone));
    } else {
      fallbackCopy(text, onDone);
    }
  }

  function fallbackCopy(text, onDone) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
    if (onDone) onDone();
  }

  function buildInviteLink() {
    const roomCode = ($('room-code') && $('room-code').textContent.trim()) || '';
    return window.location.origin + window.location.pathname + '?room=' + roomCode;
  }

  $('btn-copy').onclick = () => {
    const code = $('room-code').textContent.trim();
    copyTextToClipboard(code, () => {
      $('btn-copy').textContent = 'Copied!';
      setTimeout(() => ($('btn-copy').textContent = 'Copy'), 1200);
    });
  };

  if ($('btn-copy-link')) {
    $('btn-copy-link').onclick = () => {
      const link = buildInviteLink();
      copyTextToClipboard(link, () => {
        $('btn-copy-link').textContent = '✔ Invite Link Copied!';
        setTimeout(() => ($('btn-copy-link').textContent = '🔗 Copy Invite Link'), 1500);
      });
    };
  }

  if ($('btn-invite-top')) {
    $('btn-invite-top').onclick = () => {
      const link = buildInviteLink();
      copyTextToClipboard(link, () => {
        $('btn-invite-top').textContent = '✔ Copied!';
        setTimeout(() => ($('btn-invite-top').textContent = '🔗 Invite Link'), 1500);
      });
    };
  }

  $('btn-leave').onclick = () => {
    if (window.location.search.includes('room=')) {
      try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
    }
    leaveRoom('You left the room.');
  };

  // In-game the sidebar is a slim bar; ☰ opens room code + players as a dropdown
  $('btn-side-toggle').onclick = () => $('sidebar').classList.toggle('open');

  // ---------- 7. Auto-Join via Direct Invite Link (?room=...) ----------
  function checkAutoJoinFromUrl() {
    if (window.__safePlaceAutoJoinChecked) return;
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && roomParam.trim()) {
      window.__safePlaceAutoJoinChecked = true;
      joinRoomByCode(roomParam.trim());
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAutoJoinFromUrl);
  } else {
    checkAutoJoinFromUrl();
  }
})();
