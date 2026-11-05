/**
 * Tumble Match (Tumblestone Clone) — Production-Ready GitHub Pages Edition
 *
 * Key Engineering Features:
 *   1. Strict Lowercase Asset Paths (Linux / GitHub Pages Case-Sensitivity Safe):
 *      - Uses exclusively:
 *        - `assets/tesla-full.png`
 *        - `assets/tesla-avatar.png`
 *        - `assets/sinem-full.png`
 *        - `assets/sinem-avatar.png`
 *      - Zero uppercase characters, spaces, Turkish characters, or mixed extensions in file paths.
 *   2. Strict CSS & DOM Image Boundaries:
 *      - `.tm-player-avatar` and `.tm-character-sprite` / `.tm-shooter-img` enforce strict
 *        `max-width`, `max-height`, `width: 100%`, `height: 100%`, and `object-fit: contain`
 *        so images never overflow or overlap the viewport.
 *   3. Modal Character Selection Screen (`phase === 'select'`):
 *      - Hides the game boards completely until selection is done.
 *      - Players choose between 'tesla' and 'Sinem', dynamically assigning the chosen
 *        avatar and full sprite to each player's UI slot.
 *   4. Input Spam Filter:
 *      - Strict `activeProjectile !== null` lock per player blocks any new shot while a projectile is in flight.
 *   5. Strict Mathematical Puzzle Restores:
 *      - Mismatch errors revert the player's 5 columns strictly to `preTripletColumns`
 *        (the exact mathematical state of the 72-block matrix before that triplet began).
 *      - 'Yeniden Başlat (R)' restores strictly from `this.initialLayout`. Zero random block generation.
 *   6. Natural Physics Flight Speed (2200 PPS) + Match Point Slow-Motion:
 *      - Every shot computes `time = distance / velocity` using `PROJECTILE_VELOCITY_PPS = 2200`.
 *      - Overridden to `FINAL_SHOT_MS = 2000` (2.0s dramatic slow-motion) ONLY on Match Point
 *        (`isFinalShot`, when `b.remaining === 1`).
 */
const TumbleMatch = {
  id: 'tumblematch',
  name: 'Tumble Match',

  COLS: 5,
  ROWS: 14,
  TRIPLETS: 24,                  // 24 triplets = 72 blocks across 5 columns (14-15 rows deep)
  MAX_ROWS: 15,
  PROJECTILE_VELOCITY_PPS: 2200, // Natural physics velocity: 2200 pixels per second
  MIN_FLIGHT_MS: 45,             // Minimum visible pulse time for point-blank bottom row
  FINAL_SHOT_MS: 2000,           // 2.0s dramatic slow-motion for Match Point (last block left)

  // Strictly standardized lowercase relative paths for Linux / GitHub Pages deployment
  CHARACTERS: {
    tesla: {
      id: 'tesla',
      name: 'tesla',
      desc: 'Oyuncu 1 • Klasik Ceket & Gözlük',
      full: 'assets/tesla-full.png',
      avatar: 'assets/tesla-avatar.png',
    },
    sinem: {
      id: 'sinem',
      name: 'Sinem',
      desc: 'Oyuncu 2 • Asimetrik Bluz & Çanta',
      full: 'assets/sinem-full.png',
      avatar: 'assets/sinem-avatar.png',
    },
  },

  COLORS: [
    { id: 'ruby',    hex: '#ef4444', border: '#fca5a5', glow: 'rgba(239,68,68,0.65)',  sym: '◆' },
    { id: 'amber',   hex: '#f59e0b', border: '#fcd34d', glow: 'rgba(245,158,11,0.65)', sym: '▲' },
    { id: 'emerald', hex: '#10b981', border: '#6ee7b7', glow: 'rgba(16,185,129,0.65)', sym: '●' },
    { id: 'azure',   hex: '#3b82f6', border: '#93c5fd', glow: 'rgba(59,130,246,0.65)', sym: '■' },
    { id: 'violet',  hex: '#a855f7', border: '#d8b4fe', glow: 'rgba(168,85,247,0.65)', sym: '★' },
  ],

  start(ctx) {
    this.ctx = ctx;
    this.colorMap = Object.fromEntries(this.COLORS.map(c => [c.id, c]));
    this.initialLayout = null;             // Host's deep copy of the 72-block solvable puzzle
    this.activeProjectiles = [null, null]; // Client/Host active projectile DOM/timer per side
    this.shotTimers = [null, null];
    this.suspenseTimers = [];
    this.winSounded = false;

    this.state = this.fresh(true);
    this.build();
    this.bindInputs();

    ctx.onMessage((type, data, from) => {
      if (ctx.isHost) {
        switch (type) {
          case 'hello':    ctx.send('state', this.state, from); break;
          case 'pickchar': this.handlePickChar(from, data && data.charId); break;
          case 'ready':    this.handleReady(from); break;
          case 'reselect': this.resetAll(true); break;
          case 'aim':      this.handleAim(from, data && data.col); break;
          case 'shoot':    this.handleShoot(from, data); break;
          case 'restart':  this.handleRestart(from); break;
          case 'newgame':  this.resetAll(false); break;
        }
      } else {
        if (type === 'state') {
          this.state = data;
          this.render();
        } else if (type === 'event') {
          this.playClientEvent(data);
        }
      }
    });

    ctx.onPlayers(() => {
      if (!ctx.isHost) return this.render();
      const [a, b] = this.ids();
      if (a !== this.state.p1Id || b !== this.state.p2Id) this.resetAll(true);
      else this.render();
    });

    if (ctx.isHost) this.resetAll(true);
    else { ctx.send('hello', null, ctx.hostId); this.render(); }
  },

  destroy() {
    this.clearAllTimers();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this._onKey = null;
    this._onResize = null;
    document.querySelectorAll('.tm-flyer, .tm-projectile').forEach(el => el.remove());
  },

  clearAllTimers() {
    if (this.shotTimers) {
      this.shotTimers.forEach((t, i) => {
        if (t) clearTimeout(t);
        this.shotTimers[i] = null;
      });
    }
    if (this.activeProjectiles) {
      this.activeProjectiles.forEach((p, i) => {
        if (p && p.el) p.el.remove();
        this.activeProjectiles[i] = null;
      });
    }
    if (this.suspenseTimers) {
      this.suspenseTimers.forEach(t => clearTimeout(t));
      this.suspenseTimers = [];
    }
  },

  getCharMeta(charId) {
    return this.CHARACTERS[charId] || this.CHARACTERS.tesla;
  },

  // =====================================================================
  // HOST: Solvable 72-Block Matrix Generation & Strict State Management
  // =====================================================================
  ids() {
    const p = this.ctx.players;
    return [p[0] ? p[0].id : null, p[1] ? p[1].id : null];
  },

  deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  /**
   * Generates a 5-column, 72-block (24 triplets, 14-15 rows deep) puzzle guaranteed
   * to be 100% mathematically solvable from bottom to top.
   */
  generateSolvableColumns() {
    const cols = Array.from({ length: this.COLS }, () => []);
    let uid = 1;
    let lastColor = null;

    for (let t = 0; t < this.TRIPLETS; t++) {
      const pool = this.COLORS.filter(c => c.id !== lastColor);
      const useFiltered = Math.random() < 0.78 && pool.length > 0;
      const candidateList = useFiltered ? pool : this.COLORS;
      const chosenColor = candidateList[Math.floor(Math.random() * candidateList.length)];
      lastColor = chosenColor.id;

      for (let k = 0; k < 3; k++) {
        const avail = [];
        for (let c = 0; c < this.COLS; c++) {
          if (cols[c].length < this.MAX_ROWS) avail.push(c);
        }
        avail.sort((a, b) => cols[a].length - cols[b].length);
        const topChoices = avail.slice(0, Math.min(3, avail.length));
        const colIdx = topChoices[Math.floor(Math.random() * topChoices.length)];
        cols[colIdx].push({ id: 'b' + (uid++), color: chosenColor.id });
      }
    }
    return cols;
  },

  makeBoardState(columnsTemplate, charId = 'tesla', ready = false) {
    const cols = this.deepClone(columnsTemplate);
    const total = cols.reduce((s, c) => s + c.length, 0);
    return {
      columns: cols,
      // Strict mathematical snapshot before the current triplet started
      preTripletColumns: this.deepClone(cols),
      tray: [],                 // [{ id, color, sourceCol }]
      shooterCol: 2,            // 0..4 (starts centered)
      score: 0,
      remaining: total,
      total,
      activeProjectile: null,   // Non-null while a projectile is in flight (blocks spam!)
      matchPoint: false,        // True during slow-motion final shot
      resetToken: 1,
      charId: charId,
      ready: !!ready,
    };
  },

  fresh(openSelect = true) {
    const [p1Id, p2Id] = this.ctx ? this.ids() : [null, null];
    if (this.ctx && this.ctx.isHost) {
      this.initialLayout = this.generateSolvableColumns();
    }
    const base = this.initialLayout || Array.from({ length: this.COLS }, () => []);
    const prevChar0 = (this.state && this.state.boards && this.state.boards[0] && this.state.boards[0].charId) || 'tesla';
    const prevChar1 = (this.state && this.state.boards && this.state.boards[1] && this.state.boards[1].charId) || 'sinem';

    let nextPhase = 'waiting';
    if (p1Id && p2Id) {
      nextPhase = openSelect ? 'select' : 'play';
    }

    return {
      p1Id,
      p2Id,
      phase: nextPhase, // waiting | select | play | over
      winner: null,
      boards: [
        this.makeBoardState(base, prevChar0, !openSelect),
        this.makeBoardState(base, prevChar1, !openSelect),
      ],
    };
  },

  resetAll(openSelect = false) {
    this.clearAllTimers();
    this.winSounded = false;
    document.querySelectorAll('.tm-flyer, .tm-projectile').forEach(el => el.remove());
    this.state = this.fresh(openSelect);
    this.commit();
  },

  sideOf(playerId) {
    if (playerId === this.state.p1Id) return 0;
    if (playerId === this.state.p2Id) return 1;
    return -1;
  },

  commit() {
    this.ctx.send('state', this.state);
    this.render();
  },

  handlePickChar(from, charId) {
    const side = this.sideOf(from);
    if (side === -1 || this.state.phase !== 'select') return;
    if (!this.CHARACTERS[charId]) return;
    const b = this.state.boards[side];
    b.charId = charId;
    GameAudio.playFill(1);
    this.commit();
  },

  handleReady(from) {
    const side = this.sideOf(from);
    if (side === -1 || this.state.phase !== 'select') return;
    const b = this.state.boards[side];
    b.ready = !b.ready;

    if (this.state.boards[0].ready && this.state.boards[1].ready) {
      this.state.phase = 'play';
      const ev = { kind: 'gamestart', state: this.state };
      this.ctx.send('event', ev);
      this.playClientEvent(ev);
      return;
    }

    GameAudio.playReady();
    this.commit();
  },

  handleAim(from, col) {
    const side = this.sideOf(from);
    if (side === -1 || this.state.phase !== 'play') return;
    const b = this.state.boards[side];
    // Input spam filter: do not move aim while projectile is actively flying up the beam
    if (b.activeProjectile !== null) return;
    const c = Number(col);
    if (!Number.isInteger(c) || c < 0 || c >= this.COLS) return;
    if (b.shooterCol === c) return;
    b.shooterCol = c;
    this.commit();
  },

  /**
   * Restarts ONLY the requesting player's board back to the exact initial 72-block solvable matrix.
   */
  handleRestart(from) {
    const side = this.sideOf(from);
    if (side === -1 || this.state.phase !== 'play' || !this.initialLayout) return;

    if (this.shotTimers[side]) {
      clearTimeout(this.shotTimers[side]);
      this.shotTimers[side] = null;
    }
    if (this.activeProjectiles[side] && this.activeProjectiles[side].el) {
      this.activeProjectiles[side].el.remove();
    }
    this.activeProjectiles[side] = null;

    const prevCol = this.state.boards[side].shooterCol;
    const prevChar = this.state.boards[side].charId;
    const nextToken = (this.state.boards[side].resetToken || 1) + 1;
    this.state.boards[side] = this.makeBoardState(this.initialLayout, prevChar, true);
    this.state.boards[side].shooterCol = prevCol;
    this.state.boards[side].resetToken = nextToken;

    const ev = { kind: 'restart', side, state: this.state };
    this.ctx.send('event', ev);
    this.playClientEvent(ev);
  },

  /**
   * Phase 1 of Shooting:
   * - Enforces `b.activeProjectile !== null` spam filter.
   * - Calculates natural flight time from distance / 2200 PPS (or 2000ms on Match Point).
   */
  handleShoot(from, data) {
    const side = this.sideOf(from);
    if (side === -1 || this.state.phase !== 'play') return;
    const b = this.state.boards[side];

    // CRITICAL SPAM FILTER: Block any new shot if a projectile is already active
    if (b.activeProjectile !== null || this.shotTimers[side] !== null) return;

    const col = data && typeof data.col === 'number' ? data.col : b.shooterCol;
    if (Number.isInteger(col) && col >= 0 && col < this.COLS) {
      b.shooterCol = col;
    }
    const cIdx = b.shooterCol;
    const column = b.columns[cIdx];
    if (!column || column.length === 0) return;

    // If tray is empty, snapshot the exact mathematical column state before this triplet begins
    if (b.tray.length === 0) {
      b.preTripletColumns = this.deepClone(b.columns);
    }

    const targetedBlock = column[column.length - 1];

    // Check Match Point: is this the absolute last block remaining on the player's board?
    const isFinalShot = (b.remaining === 1);

    // Calculate natural physics travel time (time = distance / 2200 PPS)
    let travelMs;
    if (isFinalShot) {
      travelMs = this.FINAL_SHOT_MS;
    } else if (data && typeof data.distancePx === 'number' && data.distancePx > 0) {
      travelMs = Math.max(
        this.MIN_FLIGHT_MS,
        Math.round((data.distancePx / this.PROJECTILE_VELOCITY_PPS) * 1000)
      );
    } else {
      const estDistPx = Math.max(60, (this.MAX_ROWS - column.length + 1) * 28);
      travelMs = Math.max(
        this.MIN_FLIGHT_MS,
        Math.round((estDistPx / this.PROJECTILE_VELOCITY_PPS) * 1000)
      );
    }

    const tokenAtLaunch = b.resetToken;
    b.activeProjectile = {
      col: cIdx,
      color: targetedBlock.color,
      travelMs,
      isFinalShot,
      token: tokenAtLaunch,
    };
    b.matchPoint = isFinalShot;

    const launchEv = {
      kind: 'launch',
      side,
      col: cIdx,
      color: targetedBlock.color,
      isFinalShot,
      travelMs,
      state: this.state,
    };
    this.ctx.send('event', launchEv);
    this.playClientEvent(launchEv);

    // Schedule impact after projectile reaches the block
    this.shotTimers[side] = setTimeout(() => {
      this.shotTimers[side] = null;
      this.resolveShotImpact(from, side, cIdx, tokenAtLaunch);
    }, travelMs);
  },

  /**
   * Phase 2 of Shooting (Impact):
   * - Pops the targeted block only upon impact.
   * - If mismatched, strictly restores `b.columns` to `b.preTripletColumns` (the exact
   *   mathematical state before the error occurred — zero random/mutated blocks!).
   */
  resolveShotImpact(from, side, cIdx, tokenAtLaunch) {
    if (this.state.phase !== 'play') return;
    const b = this.state.boards[side];
    if (!b || b.resetToken !== tokenAtLaunch) return;

    b.activeProjectile = null;
    b.matchPoint = false;

    const column = b.columns[cIdx];
    if (!column || column.length === 0) {
      this.commit();
      return;
    }

    const shotBlock = column.pop();
    const trayColor = b.tray.length > 0 ? b.tray[0].color : null;
    const matches = !trayColor || trayColor === shotBlock.color;

    if (matches) {
      const slotIdx = b.tray.length;
      b.tray.push({ id: shotBlock.id, color: shotBlock.color, sourceCol: cIdx });
      b.remaining = b.columns.reduce((sum, colArr) => sum + colArr.length, 0);

      let cleared = false;
      if (b.tray.length === 3) {
        cleared = true;
        b.score += 3;
        b.tray = [];
        // Update mathematical pre-triplet snapshot now that this triplet is cleanly solved
        b.preTripletColumns = this.deepClone(b.columns);

        if (b.remaining === 0) {
          this.state.phase = 'over';
          this.state.winner = from;
        }
      }

      const ev = {
        kind: 'match',
        side,
        fromCol: cIdx,
        slotIdx,
        block: shotBlock,
        cleared,
        won: this.state.phase === 'over',
        state: this.state,
      };
      this.ctx.send('event', ev);
      this.playClientEvent(ev);
    } else {
      // STRICT MATHEMATICAL PUZZLE RESTORE ON ERROR:
      // Restore `b.columns` strictly from `b.preTripletColumns` so the 72-block puzzle is 100% preserved!
      const returned = [
        ...b.tray,
        { id: shotBlock.id, color: shotBlock.color, sourceCol: cIdx },
      ];
      b.tray = [];
      if (b.preTripletColumns) {
        b.columns = this.deepClone(b.preTripletColumns);
      } else {
        for (let i = returned.length - 1; i >= 0; i--) {
          const item = returned[i];
          b.columns[item.sourceCol].push({ id: item.id, color: item.color });
        }
      }
      b.remaining = b.columns.reduce((sum, colArr) => sum + colArr.length, 0);

      const ev = {
        kind: 'mismatch',
        side,
        fromCol: cIdx,
        block: shotBlock,
        returned,
        state: this.state,
      };
      this.ctx.send('event', ev);
      this.playClientEvent(ev);
    }
  },

  // =====================================================================
  // CLIENT: Character Selection, Bottom Moving Shooter & Physics Flight
  // =====================================================================
  nameOf(id, side) {
    const p = this.ctx.players.find(p => p.id === id);
    if (p && p.name && p.name !== 'Player') return p.name;
    return side === 0 ? 'tesla' : 'Sinem';
  },

  esc(t) {
    return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  mySide() {
    return this.sideOf(this.ctx.myId);
  },

  /**
   * Computes exact pixel distance from the bottom character shooter to the targeted lowest block
   * in `colIdx` so `time = distance / 2200 PPS` is physically accurate on screen.
   */
  measureShotDistancePx(side, colIdx) {
    const panel = this.panels && this.panels[side];
    if (!panel) return 220;
    const colEl = panel.cols[colIdx];
    const blocks = colEl ? colEl.querySelectorAll('.tm-block') : [];
    const targetEl = blocks.length ? blocks[blocks.length - 1] : colEl;
    if (!targetEl || !panel.shooter) return 220;

    const sRect = panel.shooter.getBoundingClientRect();
    const tRect = targetEl.getBoundingClientRect();
    const sx = sRect.left + sRect.width / 2;
    const sy = sRect.top;
    const tx = tRect.left + tRect.width / 2;
    const ty = tRect.bottom;
    return Math.max(30, Math.hypot(tx - sx, ty - sy));
  },

  playClientEvent(ev) {
    if (!ev) return;

    if (ev.kind === 'gamestart') {
      GameAudio.playReady();
      if (ev.state) {
        this.state = ev.state;
        this.render();
      }
      return;
    }

    const side = ev.side;
    const panel = this.panels && this.panels[side];

    // 1. PROJECTILE LAUNCH (Natural 2200 PPS flight or 2000ms Match Point slow-mo)
    if (panel && ev.kind === 'launch') {
      if (ev.state) {
        this.state = ev.state;
        this.render();
      }

      panel.shooter.classList.add('recoil');
      setTimeout(() => panel.shooter.classList.remove('recoil'), 110);

      const colEl = panel.cols[ev.col];
      const blocksInCol = colEl ? colEl.querySelectorAll('.tm-block') : [];
      const targetBlockEl = blocksInCol.length ? blocksInCol[blocksInCol.length - 1] : colEl;

      const shooterRect = panel.shooter.getBoundingClientRect();
      const targetRect = targetBlockEl ? targetBlockEl.getBoundingClientRect() : null;

      if (shooterRect.width > 0 && targetRect) {
        const localDistPx = Math.max(30, Math.hypot(
          (targetRect.left + targetRect.width / 2) - (shooterRect.left + shooterRect.width / 2),
          targetRect.bottom - shooterRect.top
        ));
        const visualMs = ev.isFinalShot
          ? this.FINAL_SHOT_MS
          : Math.min(ev.travelMs || 240, Math.max(this.MIN_FLIGHT_MS, Math.round((localDistPx / this.PROJECTILE_VELOCITY_PPS) * 1000)));

        this.spawnProjectile(
          side,
          ev.color,
          shooterRect,
          targetRect,
          visualMs,
          !!ev.isFinalShot
        );
      }

      if (ev.isFinalShot) {
        this.playSlowMoSuspenseAudio(ev.travelMs || this.FINAL_SHOT_MS);
      }
      return;
    }

    // 2. PROJECTILE IMPACT: MATCH OR MISMATCH
    if (panel && (ev.kind === 'match' || ev.kind === 'mismatch')) {
      if (this.activeProjectiles[side]) {
        if (this.activeProjectiles[side].el) this.activeProjectiles[side].el.remove();
        this.activeProjectiles[side] = null;
      }

      const colEl = panel.cols[ev.fromCol];
      const blocksInCol = colEl ? colEl.querySelectorAll('.tm-block') : [];
      const lowestEl = blocksInCol.length ? blocksInCol[blocksInCol.length - 1] : colEl;
      const startRect = lowestEl ? lowestEl.getBoundingClientRect() : null;
      const slotIdx = ev.kind === 'match' ? ev.slotIdx : Math.min(2, (ev.returned ? ev.returned.length - 1 : 0));
      const slotEl = panel.slots[slotIdx] || panel.slots[0];
      const endRect = slotEl ? slotEl.getBoundingClientRect() : null;

      if (startRect && endRect && ev.block) {
        this.spawnFlyer(side, ev.block.color, startRect, endRect, 145);
      }

      if (ev.kind === 'match') {
        if (ev.cleared) {
          GameAudio.playFill(3);
          panel.tray.classList.add('tm-tray--clear');
          setTimeout(() => panel.tray.classList.remove('tm-tray--clear'), 250);
        } else {
          GameAudio.playFill(1);
        }
      } else if (ev.kind === 'mismatch') {
        GameAudio.playError();
        panel.tray.classList.add('tm-tray--err');
        setTimeout(() => panel.tray.classList.remove('tm-tray--err'), 340);

        if (Array.isArray(ev.returned)) {
          ev.returned.forEach((item, idx) => {
            const sEl = panel.slots[Math.min(idx, 2)];
            const dColEl = panel.cols[item.sourceCol];
            if (sEl && dColEl) {
              const sRect = sEl.getBoundingClientRect();
              const cRect = dColEl.getBoundingClientRect();
              const targetRect = {
                left: cRect.left + 3,
                top: cRect.top + Math.min(cRect.height - 24, cRect.height * 0.65),
                width: cRect.width - 6,
                height: 20,
              };
              setTimeout(() => this.spawnFlyer(side, item.color, sRect, targetRect, 185), 65);
            }
          });
        }
      }
    } else if (panel && ev.kind === 'restart') {
      if (this.activeProjectiles[side] && this.activeProjectiles[side].el) {
        this.activeProjectiles[side].el.remove();
      }
      this.activeProjectiles[side] = null;
      document.querySelectorAll(`.tm-projectile[data-side="${side}"], .tm-flyer[data-side="${side}"]`).forEach(el => el.remove());
      GameAudio.playReady();
      panel.sec.classList.remove('tm-sec--reset');
      void panel.sec.offsetWidth;
      panel.sec.classList.add('tm-sec--reset');
      setTimeout(() => panel.sec.classList.remove('tm-sec--reset'), 360);
    }

    if (ev.state) {
      this.state = ev.state;
      this.render();
    }
  },

  /**
   * Spawns the upward-traveling energy projectile from the top of the character sprite
   * and tracks it in `this.activeProjectiles[side]` so input spam is blocked until impact.
   */
  spawnProjectile(side, colorId, shooterRect, targetRect, durationMs, isSlowMo) {
    if (this.activeProjectiles[side] && this.activeProjectiles[side].el) {
      this.activeProjectiles[side].el.remove();
    }

    const c = this.colorMap[colorId] || this.COLORS[0];
    const proj = document.createElement('div');
    proj.className = 'tm-projectile' + (isSlowMo ? ' tm-projectile--slowmo' : '');
    proj.dataset.side = String(side);
    proj.style.setProperty('--proj-color', c.hex);

    const startX = shooterRect.left + shooterRect.width / 2;
    const startY = shooterRect.top;
    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.bottom;

    proj.style.left = `${startX}px`;
    proj.style.top = `${startY}px`;
    proj.style.transitionDuration = `${durationMs}ms`;

    document.body.appendChild(proj);
    this.activeProjectiles[side] = { el: proj };

    void proj.offsetWidth;
    proj.style.left = `${endX}px`;
    proj.style.top = `${endY}px`;

    setTimeout(() => {
      proj.remove();
      if (this.activeProjectiles[side] && this.activeProjectiles[side].el === proj) {
        this.activeProjectiles[side] = null;
      }
    }, durationMs + 15);
  },

  playSlowMoSuspenseAudio(durationMs) {
    const steps = 8;
    const interval = Math.floor(durationMs / (steps + 1));
    for (let i = 1; i <= steps; i++) {
      const t = setTimeout(() => {
        if (this.state && this.state.phase === 'play') {
          GameAudio.playFill(i * 3);
        }
      }, i * interval);
      this.suspenseTimers.push(t);
    }
  },

  spawnFlyer(side, colorId, fromRect, toRect, durationMs) {
    const c = this.colorMap[colorId] || this.COLORS[0];
    const el = document.createElement('div');
    el.className = 'tm-flyer';
    el.dataset.side = String(side);
    el.style.background = c.hex;
    el.style.borderColor = '#fff';
    el.style.boxShadow = `0 0 16px ${c.glow}`;
    el.style.left = `${fromRect.left}px`;
    el.style.top = `${fromRect.top}px`;
    el.style.width = `${fromRect.width}px`;
    el.style.height = `${fromRect.height}px`;
    el.style.transitionDuration = `${durationMs}ms`;
    el.textContent = c.sym;
    document.body.appendChild(el);

    void el.offsetWidth;
    el.style.left = `${toRect.left}px`;
    el.style.top = `${toRect.top}px`;
    el.style.width = `${toRect.width}px`;
    el.style.height = `${toRect.height}px`;

    setTimeout(() => el.remove(), durationMs + 20);
  },

  build() {
    const defaultChars = ['tesla', 'sinem'];
    const charList = Object.values(this.CHARACTERS);

    this.ctx.container.innerHTML = `
      <div class="tm">
        <!-- Modal Character Selection Screen (Hides Game Boards Completely Until Done) -->
        <div class="tm-select-screen hidden">
          <div class="tm-sel-modal">
            <div class="tm-sel-header">
              <h2 class="tm-sel-title">⚡ KARAKTERİNİ SEÇ ⚡</h2>
              <p class="tm-sel-sub">Seçtiğin karakter kulenin altında hareket edecek ve bloklara ateş edecek!</p>
            </div>

            <div class="tm-sel-cards">
              ${charList.map(ch => `
                <div class="tm-char-card" data-char="${ch.id}">
                  <div class="tm-char-card-art">
                    <img
                      src="${ch.full}"
                      alt="${ch.name}"
                      style="width:100%;height:100%;max-width:130px;max-height:160px;object-fit:contain;"
                    />
                  </div>
                  <div class="tm-char-card-head">
                    <img
                      class="tm-char-card-avatar"
                      src="${ch.avatar}"
                      alt="${ch.name}"
                      style="width:28px;height:28px;max-width:28px;max-height:28px;border-radius:50%;object-fit:cover;"
                    />
                    <div class="tm-char-card-name">${ch.name}</div>
                  </div>
                  <div class="tm-char-card-desc">${ch.desc}</div>
                  <div class="tm-char-picks" data-picks-for="${ch.id}"></div>
                </div>
              `).join('')}
            </div>

            <div class="tm-sel-footer">
              <div class="tm-sel-status">
                <span class="tm-sel-p1-status">Oyuncu 1: Bekleniyor...</span>
                <span class="tm-sel-p2-status">Oyuncu 2: Bekleniyor...</span>
              </div>
              <button type="button" class="tm-btn-ready">HAZIRIM! / BAŞLA</button>
            </div>
          </div>
        </div>

        <!-- Split-Screen 5-Column Tall Narrow Towers (Hidden while Character Selection is open) -->
        <div class="tm-arena">
          ${[0, 1].map(side => {
            const defChar = this.getCharMeta(defaultChars[side]);
            return `
              <section class="tm-sec tm-sec--${side + 1}" data-side="${side}">
                <div class="tm-mp-banner">⚡ SON ATIŞ! / MATCH POINT! ⚡</div>

                <div class="tm-top">
                  <div class="tm-top-row1">
                    <div class="tm-identity">
                      <img
                        class="tm-player-avatar"
                        src="${defChar.avatar}"
                        alt="${defChar.name} avatar"
                        style="width:34px;height:34px;max-width:34px;max-height:34px;border-radius:50%;object-fit:cover;"
                      />
                      <div class="tm-id-text">
                        <div class="tm-pname"></div>
                        <div class="tm-wifi-badge">
                          <span class="tm-wifi-icon"></span>
                          <span class="tm-char-status-label">📶 Karakter Hazır • Oyuncu ${side + 1}</span>
                        </div>
                      </div>
                    </div>

                    <button type="button" class="tm-restart" data-side="${side}" title="Sadece kendi tahtanı başlangıç durumuna sıfırlar (R)">
                      ↻ Yeniden Başlat <kbd>R</kbd>
                    </button>
                  </div>

                  <div class="tm-top-row2">
                    <div class="tm-sub">Kalan: <b class="tm-rem">72</b> &nbsp;•&nbsp; Puan: <b class="tm-score">0</b></div>
                    <div class="tm-tray">
                      <div class="tm-slot" data-slot="0"></div>
                      <div class="tm-slot" data-slot="1"></div>
                      <div class="tm-slot" data-slot="2"></div>
                    </div>
                  </div>
                </div>

                <div class="tm-field">
                  <div class="tm-laser"></div>
                  ${Array.from({ length: this.COLS }, (_, c) => `<div class="tm-col" data-col="${c}"></div>`).join('')}
                </div>

                <!-- Bottom Track: Chosen Character Sprite Moves Across the 5 Columns & Fires Upward -->
                <div class="tm-track">
                  <div class="tm-shooter tm-character-sprite state-idle" style="--col: 3; width:100%; max-width:58px; height:64px; max-height:72px;" title="Ateş Et (Space / Tıkla)">
                    <img
                      class="tm-shooter-img"
                      src="${defChar.full}"
                      alt="${defChar.name}"
                      style="width:100%;height:100%;max-width:54px;max-height:68px;object-fit:contain;"
                    />
                  </div>
                </div>
              </section>
            `;
          }).join('')}
        </div>

        <div class="tm-hint">
          Hareket: <kbd>A</kbd>/<kbd>D</kbd> veya <kbd>←</kbd>/<kbd>→</kbd> &nbsp;|&nbsp;
          Ateş Et: <kbd>Space</kbd>, <kbd>↑</kbd> veya <kbd>Sütuna Tıkla</kbd> &nbsp;|&nbsp;
          Tahtanı Sıfırla (Yeniden Başlat): <kbd>R</kbd>
        </div>

        <div class="tm-overlay hidden">
          <div class="tm-modal">
            <div class="tm-mtitle"></div>
            <div class="tm-msub"></div>
            <div class="tm-modal-btns">
              <button type="button" class="btn btn--primary tm-again">Tekrar Oyna</button>
              <button type="button" class="btn tm-reselect">Karakter Değiştir</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const root = this.root = this.ctx.container.querySelector('.tm');
    this.arenaEl = root.querySelector('.tm-arena');
    this.hintEl = root.querySelector('.tm-hint');
    this.selectScreenEl = root.querySelector('.tm-select-screen');
    this.charCards = Array.from(root.querySelectorAll('.tm-char-card'));
    this.readyBtn = root.querySelector('.tm-btn-ready');
    this.p1StatusEl = root.querySelector('.tm-sel-p1-status');
    this.p2StatusEl = root.querySelector('.tm-sel-p2-status');

    this.overlayEl = root.querySelector('.tm-overlay');
    this.mTitleEl = root.querySelector('.tm-mtitle');
    this.mSubEl = root.querySelector('.tm-msub');
    this.againBtn = root.querySelector('.tm-again');
    this.reselectBtn = root.querySelector('.tm-reselect');

    this.panels = [0, 1].map(side => {
      const sec = root.querySelector(`.tm-sec[data-side="${side}"]`);
      const shooter = sec.querySelector('.tm-shooter');
      const shooterImg = sec.querySelector('.tm-shooter-img');
      const avatarImg = sec.querySelector('.tm-player-avatar');
      const charStatusLabel = sec.querySelector('.tm-char-status-label');

      return {
        sec,
        shooter,
        shooterImg,
        avatarImg,
        charStatusLabel,
        pname: sec.querySelector('.tm-pname'),
        rem: sec.querySelector('.tm-rem'),
        score: sec.querySelector('.tm-score'),
        restartBtn: sec.querySelector('.tm-restart'),
        tray: sec.querySelector('.tm-tray'),
        slots: Array.from(sec.querySelectorAll('.tm-slot')),
        field: sec.querySelector('.tm-field'),
        laser: sec.querySelector('.tm-laser'),
        cols: Array.from(sec.querySelectorAll('.tm-col')),
      };
    });
  },

  bindInputs() {
    const canFire = side => {
      if (side === -1 || this.state.phase !== 'play') return false;
      const b = this.state.boards[side];
      // Strict input spam filter: block if local or authoritative projectile is active
      return b && b.activeProjectile === null && this.activeProjectiles[side] === null;
    };

    const sendIntent = (type, data) => {
      if (this.ctx.isHost) {
        if (type === 'pickchar') this.handlePickChar(this.ctx.myId, data && data.charId);
        else if (type === 'ready') this.handleReady(this.ctx.myId);
        else if (type === 'reselect') this.resetAll(true);
        else if (type === 'aim') this.handleAim(this.ctx.myId, data && data.col);
        else if (type === 'shoot') this.handleShoot(this.ctx.myId, data);
        else if (type === 'restart') this.handleRestart(this.ctx.myId);
        else if (type === 'newgame') this.resetAll(false);
      } else {
        this.ctx.send(type, data, this.ctx.hostId);
      }
    };

    // Character Selection events
    this.charCards.forEach(card => {
      card.addEventListener('click', () => {
        if (this.state.phase !== 'select' || this.mySide() === -1) return;
        sendIntent('pickchar', { charId: card.dataset.char });
      });
    });

    this.readyBtn.addEventListener('click', () => {
      if (this.state.phase !== 'select' || this.mySide() === -1) return;
      sendIntent('ready');
    });

    this._onKey = e => {
      const mySide = this.mySide();
      if (mySide === -1 || this.state.phase !== 'play') return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        sendIntent('restart');
        return;
      }

      if (!canFire(mySide)) return;

      const b = this.state.boards[mySide];
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        const next = Math.max(0, b.shooterCol - 1);
        sendIntent('aim', { col: next });
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        const next = Math.min(this.COLS - 1, b.shooterCol + 1);
        sendIntent('aim', { col: next });
      } else if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        const distancePx = this.measureShotDistancePx(mySide, b.shooterCol);
        sendIntent('shoot', { col: b.shooterCol, distancePx });
      }
    };
    window.addEventListener('keydown', this._onKey);

    this.panels.forEach((p, side) => {
      p.restartBtn.addEventListener('click', e => {
        e.preventDefault();
        p.restartBtn.blur();
        if (this.mySide() !== side || this.state.phase !== 'play') return;
        sendIntent('restart');
      });

      p.cols.forEach((colEl, colIdx) => {
        colEl.addEventListener('pointerenter', () => {
          if (this.mySide() === side && canFire(side)) {
            sendIntent('aim', { col: colIdx });
          }
        });
        colEl.addEventListener('pointerdown', e => {
          e.preventDefault();
          if (this.mySide() !== side || !canFire(side)) return;
          const distancePx = this.measureShotDistancePx(side, colIdx);
          sendIntent('shoot', { col: colIdx, distancePx });
        });
      });

      p.shooter.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (this.mySide() !== side || !canFire(side)) return;
        const b = this.state.boards[side];
        const distancePx = this.measureShotDistancePx(side, b.shooterCol);
        sendIntent('shoot', { col: b.shooterCol, distancePx });
      });
    });

    this.againBtn.addEventListener('click', () => sendIntent('newgame'));
    this.reselectBtn.addEventListener('click', () => sendIntent('reselect'));

    this._onResize = () => {
      this.updateLaser(0);
      this.updateLaser(1);
    };
    window.addEventListener('resize', this._onResize);
  },

  render() {
    const s = this.state;
    const me = this.ctx.myId;
    const mySide = this.mySide();
    const ids = [s.p1Id, s.p2Id];
    const p1Name = s.p1Id ? this.nameOf(s.p1Id, 0) : 'Oyuncu 1';
    const p2Name = s.p2Id ? this.nameOf(s.p2Id, 1) : 'Oyuncu 2';

    if (s.phase === 'over' && !this.winSounded) {
      this.winSounded = true;
      GameAudio.playWin();
    } else if (s.phase !== 'over') {
      this.winSounded = false;
    }

    // 1. Character Selection Modal Visibility (Hides Game Boards Completely During Selection)
    const isSelectPhase = (s.phase === 'select');
    this.selectScreenEl.classList.toggle('hidden', !isSelectPhase);
    this.arenaEl.classList.toggle('hidden', isSelectPhase);
    this.hintEl.classList.toggle('hidden', isSelectPhase);

    if (isSelectPhase) {
      const b0 = s.boards[0];
      const b1 = s.boards[1];
      this.charCards.forEach(card => {
        const cid = card.dataset.char;
        card.classList.toggle('picked-p1', b0.charId === cid);
        card.classList.toggle('picked-p2', b1.charId === cid);
        const picksEl = card.querySelector('.tm-char-picks');
        let badges = '';
        if (b0.charId === cid) badges += `<span class="tm-pick-pill tm-pick-pill--p1">P1: ${this.esc(p1Name)}</span>`;
        if (b1.charId === cid) badges += `<span class="tm-pick-pill tm-pick-pill--p2">P2: ${this.esc(p2Name)}</span>`;
        picksEl.innerHTML = badges;
      });

      const c0 = this.getCharMeta(b0.charId);
      const c1 = this.getCharMeta(b1.charId);
      this.p1StatusEl.className = 'tm-sel-p1-status' + (b0.ready ? ' rdy' : '');
      this.p1StatusEl.textContent = `${p1Name} (${c0.name}): ${b0.ready ? '✓ HAZIR!' : 'Seçiyor…'}`;
      this.p2StatusEl.className = 'tm-sel-p2-status' + (b1.ready ? ' rdy' : '');
      this.p2StatusEl.textContent = `${p2Name} (${c1.name}): ${b1.ready ? '✓ HAZIR!' : 'Seçiyor…'}`;

      if (mySide !== -1) {
        const myReady = s.boards[mySide].ready;
        this.readyBtn.disabled = false;
        this.readyBtn.classList.toggle('is-ready', myReady);
        this.readyBtn.textContent = myReady ? '✓ HAZIRSIN (Rakip Bekleniyor…)' : '⚡ HAZIRIM! / BAŞLA';
      } else {
        this.readyBtn.disabled = true;
        this.readyBtn.textContent = 'Oyuncular Karakter Seçiyor…';
      }
    }

    const anyMatchPoint = s.phase === 'play' && (s.boards[0].matchPoint || s.boards[1].matchPoint);
    this.root.classList.toggle('tm--matchpoint', !!anyMatchPoint);

    // 2. Render both players' tall 5-column towers + chosen character shooter at the bottom
    [0, 1].forEach(side => {
      const p = this.panels[side];
      const pid = ids[side];
      const isMe = pid && pid === me;
      const b = s.boards[side];
      const charMeta = this.getCharMeta(b.charId);
      const isShooting = b.activeProjectile !== null || this.activeProjectiles[side] !== null;

      p.sec.classList.toggle('is-mine', !!isMe);
      p.sec.classList.toggle('tm-sec--matchpoint', !!(s.phase === 'play' && b.matchPoint));

      // Dynamically assign selected character's strictly lowercase avatar & full sprite paths
      if (p.avatarImg.dataset.charId !== charMeta.id) {
        p.avatarImg.dataset.charId = charMeta.id;
        p.avatarImg.src = charMeta.avatar;
      }
      if (p.shooterImg.dataset.charId !== charMeta.id) {
        p.shooterImg.dataset.charId = charMeta.id;
        p.shooterImg.src = charMeta.full;
      }
      p.charStatusLabel.textContent = `📶 ${charMeta.name} Hazır • Oyuncu ${side + 1}`;

      // Update bottom character shooter animation state (Idle / Shooting / Match Point)
      p.shooter.classList.toggle('state-idle', !isShooting && !b.matchPoint);
      p.shooter.classList.toggle('state-shooting', isShooting && !b.matchPoint);
      p.shooter.classList.toggle('state-matchpoint', !!b.matchPoint);
      p.shooter.classList.toggle('locked', isShooting);

      // Move the character shooter horizontally across the 5 columns!
      p.shooter.style.setProperty('--col', String(b.shooterCol + 1));

      const displayName = pid ? this.nameOf(pid, side) : charMeta.name;
      p.pname.innerHTML = `${this.esc(displayName)} <small style="opacity:.75">(${this.esc(charMeta.name)})</small> ${isMe ? '<span class="tm-you">SEN</span>' : ''}`;
      p.rem.textContent = String(b.remaining);
      p.score.textContent = String(b.score);
      p.restartBtn.disabled = !isMe || s.phase !== 'play';

      // Render 3-slot tray
      p.slots.forEach((slotEl, idx) => {
        const item = b.tray[idx];
        if (item) {
          const c = this.colorMap[item.color] || this.COLORS[0];
          slotEl.className = 'tm-slot filled';
          slotEl.style.background = c.hex;
          slotEl.style.borderColor = c.border;
          slotEl.style.boxShadow = `0 0 10px ${c.glow}`;
          slotEl.textContent = c.sym;
        } else {
          slotEl.className = 'tm-slot';
          slotEl.style.background = '';
          slotEl.style.borderColor = '';
          slotEl.style.boxShadow = '';
          slotEl.textContent = '';
        }
      });

      // Render 5 columns of blocks in the tall tower
      p.cols.forEach((colEl, cIdx) => {
        const blocks = b.columns[cIdx] || [];
        colEl.classList.toggle('aimed', cIdx === b.shooterCol);
        colEl.innerHTML = '';
        blocks.forEach((blk, rIdx) => {
          const c = this.colorMap[blk.color] || this.COLORS[0];
          const d = document.createElement('div');
          d.className = 'tm-block';
          if (cIdx === b.shooterCol && rIdx === blocks.length - 1) {
            d.classList.add('targeted');
          }
          d.style.background = c.hex;
          d.style.borderColor = c.border;
          d.style.setProperty('--glow', c.glow);
          d.textContent = c.sym;
          colEl.appendChild(d);
        });
      });
    });

    // Overlay for waiting / win
    if (s.phase === 'waiting') {
      this.overlayEl.classList.remove('hidden');
      this.mTitleEl.textContent = 'Oyuncu Bekleniyor…';
      this.mSubEl.textContent = 'İkinci oyuncu odaya katıldığında Karakter Seçimi ekranı açılacak.';
      this.againBtn.classList.add('hidden');
      this.reselectBtn.classList.add('hidden');
    } else if (s.phase === 'over') {
      this.overlayEl.classList.remove('hidden');
      const iWon = s.winner === me;
      const winSide = this.sideOf(s.winner);
      const winName = this.nameOf(s.winner, winSide);
      this.mTitleEl.textContent = iWon ? '🏆 KAZANDIN!' : `🏆 ${winName} KAZANDI!`;
      this.mSubEl.textContent = 'Son blok da vuruldu ve 72 blokluk kule tamamen temizlendi!';
      this.againBtn.classList.toggle('hidden', mySide === -1);
      this.reselectBtn.classList.toggle('hidden', mySide === -1);
    } else {
      this.overlayEl.classList.add('hidden');
    }

    if (!isSelectPhase) {
      requestAnimationFrame(() => {
        this.updateLaser(0);
        this.updateLaser(1);
      });
    }
  },

  /**
   * Positions the vertical targeting laser from the bottom character shooter up to the
   * lowest block in the currently aimed column.
   */
  updateLaser(side) {
    const p = this.panels && this.panels[side];
    const b = this.state && this.state.boards && this.state.boards[side];
    if (!p || !b) return;

    const fieldRect = p.field.getBoundingClientRect();
    const colEl = p.cols[b.shooterCol];
    if (!colEl || fieldRect.width === 0 || fieldRect.height === 0) return;

    const colRect = colEl.getBoundingClientRect();
    const centerX = (colRect.left - fieldRect.left) + colRect.width / 2;

    const blocks = colEl.querySelectorAll('.tm-block');
    const lowestEl = blocks.length > 0 ? blocks[blocks.length - 1] : null;
    let topPx = 4;

    if (lowestEl) {
      const bRect = lowestEl.getBoundingClientRect();
      topPx = Math.max(0, bRect.bottom - fieldRect.top);
      const colData = b.columns[b.shooterCol];
      const topBlk = colData && colData[colData.length - 1];
      const c = topBlk && this.colorMap[topBlk.color];
      if (c && !b.matchPoint) {
        p.laser.style.background = `linear-gradient(to top, ${c.hex}, ${c.border})`;
        p.laser.style.boxShadow = `0 0 12px ${c.glow}`;
      }
    } else {
      p.laser.style.background = 'linear-gradient(to top, #475569, transparent)';
      p.laser.style.boxShadow = 'none';
    }

    const heightPx = Math.max(0, fieldRect.height - topPx);
    p.laser.style.left = `${centerX}px`;
    p.laser.style.top = `${topPx}px`;
    p.laser.style.height = `${heightPx}px`;
  },
};

GameHub.register(TumbleMatch);
