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

// =====================================================================
// Idempotent Native Fullscreen Toggle Binder for Screen-Share & Video Feeds
// (Ensures Fullscreen buttons work whether initialized here or in main.js)
// =====================================================================
(function initSafePlaceFullscreen() {
  function bindFullscreenControls() {
    if (window.__safePlaceFullscreenInit) return;
    const screenContainer = document.getElementById('screen-share-container');
    const screenVideo = document.getElementById('screen-video');
    const screenFsBtn = document.getElementById('btn-screen-fullscreen');
    const screenFsOverlayBtn = document.getElementById('btn-screen-fs-overlay');
    const screenMinBtn = document.getElementById('btn-screen-min');
    const remoteVideoCard = document.getElementById('remote-video-card');
    const remoteVideo = document.getElementById('remote-video');
    const remoteFsBtn = document.getElementById('btn-remote-fullscreen');
    const localVideoCard = document.getElementById('local-video-card');
    const localVideo = document.getElementById('local-video');
    const localFsBtn = document.getElementById('btn-local-fullscreen');

    if (!screenContainer && !remoteVideoCard) return;
    window.__safePlaceFullscreenInit = true;

    const getFsEl = () =>
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null;

    const exitFs = () => {
      if (document.exitFullscreen) return document.exitFullscreen().catch(() => {});
      if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
      if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
      if (document.msExitFullscreen) return document.msExitFullscreen();
    };

    const reqFs = (targetEl, fallbackVideoEl) => {
      if (!targetEl) return;
      const fn =
        targetEl.requestFullscreen ||
        targetEl.webkitRequestFullscreen ||
        targetEl.mozRequestFullScreen ||
        targetEl.msRequestFullscreen;
      if (fn) {
        try {
          const p = fn.call(targetEl);
          if (p && typeof p.catch === 'function') {
            p.catch(() => {
              if (fallbackVideoEl && fallbackVideoEl !== targetEl) reqFs(fallbackVideoEl, null);
            });
          }
          return;
        } catch (e) {}
      }
      if (fallbackVideoEl && typeof fallbackVideoEl.webkitEnterFullscreen === 'function') {
        try { fallbackVideoEl.webkitEnterFullscreen(); } catch (e) {}
      }
    };

    const toggleFs = (containerEl, videoEl) => {
      if (!containerEl) return;
      containerEl.classList.remove('screen-share--minimized', 'video-dock--minimized');
      if (containerEl === screenContainer && screenMinBtn) screenMinBtn.textContent = '−';

      const fsEl = getFsEl();
      const isAlreadyFs = Boolean(
        (fsEl && (fsEl === containerEl || fsEl === videoEl || containerEl.contains(fsEl))) ||
        containerEl.classList.contains('is-fullscreen')
      );

      if (isAlreadyFs) {
        containerEl.classList.remove('is-fullscreen');
        if (fsEl) exitFs();
        syncUi();
      } else {
        if (screenContainer) screenContainer.classList.remove('is-fullscreen');
        if (remoteVideoCard) remoteVideoCard.classList.remove('is-fullscreen');
        if (localVideoCard) localVideoCard.classList.remove('is-fullscreen');
        containerEl.classList.add('is-fullscreen');
        syncUi();

        if (fsEl) {
          const p = exitFs();
          if (p && typeof p.then === 'function') p.then(() => reqFs(containerEl, videoEl));
          else reqFs(containerEl, videoEl);
        } else {
          reqFs(containerEl, videoEl);
        }
      }
    };

    const syncUi = () => {
      const fsEl = getFsEl();
      const videoDock = document.getElementById('video-dock');
      const isScreenFs = Boolean(
        (fsEl && screenContainer && (fsEl === screenContainer || screenContainer.contains(fsEl))) ||
        (screenContainer && screenContainer.classList.contains('is-fullscreen'))
      );
      const isRemoteFs = Boolean(
        (fsEl && remoteVideoCard && (fsEl === remoteVideoCard || remoteVideoCard.contains(fsEl))) ||
        (remoteVideoCard && remoteVideoCard.classList.contains('is-fullscreen'))
      );
      const isLocalFs = Boolean(
        (fsEl && localVideoCard && (fsEl === localVideoCard || localVideoCard.contains(fsEl))) ||
        (localVideoCard && localVideoCard.classList.contains('is-fullscreen'))
      );

      if (screenContainer) screenContainer.classList.toggle('is-fullscreen', isScreenFs);
      if (remoteVideoCard) remoteVideoCard.classList.toggle('is-fullscreen', isRemoteFs);
      if (localVideoCard) localVideoCard.classList.toggle('is-fullscreen', isLocalFs);
      if (videoDock) videoDock.classList.toggle('has-fullscreen-card', isRemoteFs || isLocalFs);

      if (screenFsBtn) screenFsBtn.textContent = isScreenFs ? '🗗 Çıkış / Exit' : '⛶ Tam Ekran / Fullscreen';
      if (screenFsOverlayBtn) screenFsOverlayBtn.textContent = isScreenFs ? '🗗 Tam Ekrandan Çık / Exit' : '⛶ Tam Ekran / Fullscreen';
      if (remoteFsBtn) remoteFsBtn.textContent = isRemoteFs ? '🗗 Çıkış / Exit' : '⛶ Tam Ekran';
      if (localFsBtn) localFsBtn.textContent = isLocalFs ? '🗗 Çıkış / Exit' : '⛶ Tam Ekran';
    };

    const onNativeFsChange = () => {
      if (!getFsEl()) {
        if (screenContainer) screenContainer.classList.remove('is-fullscreen');
        if (remoteVideoCard) remoteVideoCard.classList.remove('is-fullscreen');
        if (localVideoCard) localVideoCard.classList.remove('is-fullscreen');
      }
      syncUi();
    };

    document.addEventListener('fullscreenchange', onNativeFsChange);
    document.addEventListener('webkitfullscreenchange', onNativeFsChange);
    document.addEventListener('MSFullscreenChange', onNativeFsChange);
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (screenContainer) screenContainer.classList.remove('is-fullscreen');
        if (remoteVideoCard) remoteVideoCard.classList.remove('is-fullscreen');
        if (localVideoCard) localVideoCard.classList.remove('is-fullscreen');
        syncUi();
      }
    });

    if (screenFsBtn && screenContainer) {
      screenFsBtn.onclick = e => { e.stopPropagation(); toggleFs(screenContainer, screenVideo); };
    }
    if (screenFsOverlayBtn && screenContainer) {
      screenFsOverlayBtn.onclick = e => { e.stopPropagation(); toggleFs(screenContainer, screenVideo); };
    }
    if (screenVideo && screenContainer) {
      screenVideo.ondblclick = () => toggleFs(screenContainer, screenVideo);
    }
    if (remoteFsBtn && remoteVideoCard) {
      remoteFsBtn.onclick = e => { e.stopPropagation(); toggleFs(remoteVideoCard, remoteVideo); };
    }
    if (remoteVideo && remoteVideoCard) {
      remoteVideo.ondblclick = () => toggleFs(remoteVideoCard, remoteVideo);
    }
    if (localFsBtn && localVideoCard) {
      localFsBtn.onclick = e => { e.stopPropagation(); toggleFs(localVideoCard, localVideo); };
    }
    if (localVideo && localVideoCard) {
      localVideo.ondblclick = () => toggleFs(localVideoCard, localVideo);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindFullscreenControls);
  } else {
    bindFullscreenControls();
  }

  /* ==========================================================================
     Reverse Voice Challenge (4-Phase Synchronous WebRTC / PeerJS Audio Game)
     ========================================================================== */
  const ReverseVoice = {
    id: 'reversevoice',
    name: 'Reverse Voice',
    title: 'Reverse Voice',
    icon: '🎙️',

    ctx: null,
    root: null,
    state: null,

    audioCtx: null,
    activeSource: null,
    mediaRecorder: null,
    mediaStream: null,
    recordedChunks: [],
    recordStartTs: 0,
    recordTimer: null,
    localDraftDataUrl: null,
    localDraftDuration: 0,
    localImitationDataUrl: null,
    localImitationDuration: 0,
    localSubPhase: 0,
    isRecording: false,
    decodedCache: {},

    start(ctx) {
      this.ctx = ctx;
      this.decodedCache = {};
      this.localDraftDataUrl = null;
      this.localDraftDuration = 0;
      this.localImitationDataUrl = null;
      this.localImitationDuration = 0;
      this.localSubPhase = 0;
      this.isRecording = false;

      // Switch containers: display #reverse-voice-container as flex and hide #game-container
      const rvContainer = document.getElementById('reverse-voice-container');
      const stdContainer = ctx.container || document.getElementById('game-container');

      if (rvContainer) {
        if (stdContainer) stdContainer.style.display = 'none';
        rvContainer.classList.remove('hidden');
        rvContainer.style.display = 'flex';
        this.root = rvContainer;
      } else {
        this.root = stdContainer;
        if (this.root) this.root.style.display = 'flex';
        this._injectFallbackHtml();
      }

      this.state = this._freshState();
      this._bindDomEvents();
      this._renderPhase();

      // Request microphone stream once on tab open and keep it alive for the entire session
      this._ensureMicStream(true);

      ctx.onMessage((type, data, from) => {
        this._onNetMessage(type, data, from);
      });

      ctx.onPlayers(() => {
        this._ensurePlayerSlots();
        if (this.ctx && this.ctx.isHost) {
          this._broadcastState();
        } else {
          this._renderPhase();
        }
      });

      if (ctx.isHost) {
        this._broadcastState();
      } else {
        ctx.send('hello', null, ctx.hostId);
      }
    },

    destroy() {
      this._stopRecording(true);
      this._stopPlayback();
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        try { this.audioCtx.close(); } catch (e) {}
      }
      this.audioCtx = null;
      this.decodedCache = {};
      // NOTE: Do NOT call track.stop() on this.mediaStream / window.__rvPersistentMicStream
      // so microphone permission remains granted across rounds and tab switches!

      // Restore standard #game-container and hide #reverse-voice-container
      const rvContainer = document.getElementById('reverse-voice-container');
      const stdContainer = (this.ctx && this.ctx.container) || document.getElementById('game-container');
      if (rvContainer) {
        rvContainer.classList.add('hidden');
        rvContainer.style.display = 'none';
      }
      if (stdContainer) {
        stdContainer.style.display = '';
      }

      this.root = null;
      this.ctx = null;
    },

    _injectFallbackHtml() {
      if (!this.root) return;
      this.root.innerHTML = `
        <div class="rv">
          <div class="rv-header">
            <div>
              <h3 class="rv-title">🎙️ Reverse Voice Challenge</h3>
              <p class="rv-subtitle">Record a secret phrase, imitate your partner's reversed audio, and guess the double-reversed voice!</p>
            </div>
            <div id="rv-steps" class="rv-steps">
              <span class="rv-step is-active" data-step="1">1. Record</span>
              <span class="rv-step" data-step="2">2. Imitate</span>
              <span class="rv-step" data-step="3">3. Guess</span>
              <span class="rv-step" data-step="4">4. Reveal</span>
            </div>
          </div>
          <div id="rv-peer-status" class="rv-peer-status"></div>
          <div id="rv-phase-1" class="rv-card rv-phase-panel">
            <span class="rv-phase-badge">Phase 1 of 4 · Original Record</span>
            <h4 class="rv-phase-title">Record Your Secret Word or Short Phrase</h4>
            <p class="rv-phase-desc">Type your secret word and record a 1–5 second voice clip. Once both players finish, your recordings are swapped!</p>
            <div class="rv-input-row">
              <input id="rv-secret-word" type="text" class="rv-input" maxlength="50" placeholder="Enter secret word (e.g. 'Pineapple', 'I love you')..." autocomplete="off">
            </div>
            <div class="rv-controls">
              <button id="rv-btn-rec-p1" type="button" class="rv-btn rv-btn--record">🎙️ Start Recording</button>
              <button id="rv-btn-preview-p1" type="button" class="rv-btn rv-btn--play" disabled>▶ Play My Recording</button>
              <button id="rv-btn-send-p1" type="button" class="rv-btn rv-btn--send" disabled>🚀 Send Audio to Partner</button>
            </div>
            <div id="rv-status-p1" class="rv-status">Click "Start Recording" and speak clearly into your microphone.</div>
          </div>
          <div id="rv-phase-2" class="rv-card rv-phase-panel hidden">
            <span class="rv-phase-badge">Phase 2 of 4 · Imitate Reversed Audio</span>
            <h4 class="rv-phase-title">Listen to Partner's Reversed Audio &amp; Imitate It!</h4>
            <p class="rv-phase-desc">Listen closely to the alien-like reversed clip, then record your own vocal imitation of those sounds!</p>
            <div class="rv-controls">
              <button id="rv-btn-play-reversed-p2" type="button" class="rv-btn rv-btn--play">⏪ Play Partner's Reversed Audio</button>
            </div>
            <div class="rv-controls">
              <button id="rv-btn-rec-p2" type="button" class="rv-btn rv-btn--record">🎙️ Record My Imitation</button>
              <button id="rv-btn-preview-p2" type="button" class="rv-btn rv-btn--play" disabled>▶ Preview My Imitation</button>
              <button id="rv-btn-send-p2" type="button" class="rv-btn rv-btn--send" disabled>➡️ Continue to Guess (Phase 3)</button>
            </div>
            <div id="rv-status-p2" class="rv-status">Listen to the reversed audio first, then mimic the sounds!</div>
          </div>
          <div id="rv-phase-3" class="rv-card rv-phase-panel hidden">
            <span class="rv-phase-badge">Phase 3 of 4 · Guess Partner's Secret Word</span>
            <h4 class="rv-phase-title">Listen to Your Locally Reversed Imitation &amp; Guess!</h4>
            <p class="rv-phase-desc">We locally reversed your OWN vocal imitation using AudioContext! Listen and guess your partner's original word:</p>
            <div class="rv-controls">
              <button id="rv-btn-play-my-imit-rev-p3" type="button" class="rv-btn rv-btn--play">🔁 Play My Reversed Imitation</button>
              <button id="rv-btn-play-imit-rev-p3" type="button" class="rv-btn rv-btn--play">🎙️ Play My Raw Imitation</button>
            </div>
            <div class="rv-input-row">
              <input id="rv-guess-input" type="text" class="rv-input" maxlength="60" placeholder="Type your guess of partner's word..." autocomplete="off">
              <button id="rv-btn-send-p3" type="button" class="rv-btn rv-btn--send">✅ Submit Guess &amp; Reveal</button>
            </div>
            <div id="rv-status-p3" class="rv-status">Listen to your locally reversed imitation, then submit your guess!</div>
          </div>
          <div id="rv-phase-4" class="rv-card rv-phase-panel hidden">
            <span class="rv-phase-badge">Phase 4 of 4 · Grand Reveal</span>
            <h4 class="rv-phase-title">🎉 Original Words vs. Partner Guesses</h4>
            <p class="rv-phase-desc">Compare the original secret words with what each partner guessed and play back all 4 stages of audio!</p>
            <div id="rv-reveal-grid" class="rv-reveal-grid"></div>
            <div class="rv-controls" style="margin-top: 16px;">
              <button id="rv-btn-reveal-orig" type="button" class="rv-btn rv-btn--play">▶ 1. Original</button>
              <button id="rv-btn-reveal-rev" type="button" class="rv-btn rv-btn--play">⏪ 2. Reversed</button>
              <button id="rv-btn-reveal-raw-imit" type="button" class="rv-btn rv-btn--play">🎙️ 3. Imitation</button>
              <button id="rv-btn-reveal-imit" type="button" class="rv-btn rv-btn--play">🔁 4. Reversed Imitation</button>
            </div>
            <div class="rv-controls" style="margin-top: 18px;">
              <button id="rv-btn-new-round" type="button" class="rv-btn rv-btn--send">🔄 Start New Round</button>
            </div>
          </div>
        </div>
      `;
    },

    _getPlayersList() {
      const list = (this.ctx && (this.ctx.players || this.ctx.roster)) || [];
      return list.slice(0, 2);
    },

    _freshState() {
      const players = this._getPlayersList();
      const clips = {};
      players.forEach(p => {
        clips[p.id] = {
          name: p.name,
          word: '',
          originalB64: null,
          imitationB64: null,
          guess: '',
          p1Done: false,
          p2Done: false,
          p3Done: false
        };
      });
      return {
        phase: 1, // 1: Original Record, 2: Imitate (and local transition to 3: Guess), 4: Reveal
        round: 1,
        players: players.map(p => ({ id: p.id, name: p.name })),
        clips
      };
    },

    _ensurePlayerSlots() {
      if (!this.state || !this.ctx) return;
      const roster = this._getPlayersList();
      this.state.players = roster.map(p => ({ id: p.id, name: p.name }));
      roster.forEach(p => {
        if (!this.state.clips[p.id]) {
          this.state.clips[p.id] = {
            name: p.name,
            word: '',
            originalB64: null,
            imitationB64: null,
            guess: '',
            p1Done: false,
            p2Done: false,
            p3Done: false
          };
        } else {
          this.state.clips[p.id].name = p.name;
        }
      });
    },

    _getEffectiveUiPhase() {
      if (!this.state) return 1;
      if (this.state.phase === 1) return 1;
      if (this.state.phase === 4) return 4;
      // When network state is in the Imitate/Guess stage (phase 2 or 3),
      // each player advances locally from Phase 2 (Imitate) -> Phase 3 (Guess)
      // as soon as they lock in their own local imitation!
      const myClip = this.state.clips?.[this.ctx?.myId];
      if (this.localSubPhase === 3 || (myClip && (myClip.p2Done || myClip.p3Done)) || this.state.phase === 3) {
        return 3;
      }
      return 2;
    },

    _onNetMessage(type, data, fromId) {
      if (!this.ctx) return;

      if (type === 'state') {
        const prevPhase = this.state ? this.state.phase : 0;
        const prevRound = this.state ? this.state.round : 0;
        this.state = data;
        if (prevRound !== this.state.round) {
          this._stopRecording(true);
          this._stopPlayback();
          this.localDraftDataUrl = null;
          this.localDraftDuration = 0;
          this.localImitationDataUrl = null;
          this.localImitationDuration = 0;
          this.localSubPhase = 0;
          this.decodedCache = {};
          const wordInput = this.root?.querySelector('#rv-secret-word');
          const guessInput = this.root?.querySelector('#rv-guess-input');
          if (wordInput) wordInput.value = '';
          if (guessInput) guessInput.value = '';
        } else if (prevPhase !== this.state.phase && this.state.phase === 2 && prevPhase === 1) {
          this._stopRecording(true);
          this._stopPlayback();
          this.localDraftDataUrl = null;
          this.localDraftDuration = 0;
        }
        this._renderPhase();
        return;
      }

      if (!this.ctx.isHost) return;

      if (type === 'hello') {
        this._ensurePlayerSlots();
        this.ctx.send('state', this.state, fromId);
      } else if (type === 'submit_p1') {
        this._handleP1Submit((data && data.playerId) || fromId, data && data.word, data && data.audioB64);
      } else if (type === 'mark_p2_done') {
        this._handleP2Done((data && data.playerId) || fromId);
      } else if (type === 'submit_p3') {
        this._handleP3Submit(
          (data && data.playerId) || fromId,
          data && data.guess,
          data && data.imitationB64
        );
      } else if (type === 'new_round') {
        this._startNewRound();
      }
    },

    _broadcastState() {
      if (!this.ctx || !this.ctx.isHost) return;
      this._ensurePlayerSlots();
      this.ctx.send('state', this.state);
      this._renderPhase();
    },

    _handleP1Submit(playerId, word, audioB64) {
      this._ensurePlayerSlots();
      if (!this.state.clips[playerId] || !audioB64) return;
      this.state.clips[playerId].word = (word || '').trim();
      this.state.clips[playerId].originalB64 = audioB64;
      this.state.clips[playerId].p1Done = true;

      if (this._allPlayersDone('p1Done')) {
        this.state.phase = 2;
        this.localDraftDataUrl = null;
        this.localDraftDuration = 0;
      }
      this._broadcastState();
    },

    _handleP2Done(playerId) {
      this._ensurePlayerSlots();
      if (!this.state.clips[playerId]) return;
      // Only mark status as ready for Phase 3; imitation audio stays local until Phase 3 guess is submitted!
      this.state.clips[playerId].p2Done = true;
      if (this._allPlayersDone('p2Done') && this.state.phase < 3) {
        this.state.phase = 3;
      }
      this._broadcastState();
    },

    _handleP3Submit(playerId, guess, imitationB64) {
      this._ensurePlayerSlots();
      if (!this.state.clips[playerId]) return;
      this.state.clips[playerId].guess = (guess || '').trim() || '(No guess)';
      if (imitationB64) {
        this.state.clips[playerId].imitationB64 = imitationB64;
      }
      this.state.clips[playerId].p2Done = true;
      this.state.clips[playerId].p3Done = true;

      if (this._allPlayersDone('p3Done')) {
        this.state.phase = 4;
      }
      this._broadcastState();
    },

    _allPlayersDone(flag) {
      const ids = this.state.players.map(p => p.id);
      if (ids.length === 0) return false;
      return ids.every(id => this.state.clips[id] && this.state.clips[id][flag]);
    },

    _startNewRound() {
      const nextRound = (this.state?.round || 1) + 1;
      this.decodedCache = {};
      this.localDraftDataUrl = null;
      this.localDraftDuration = 0;
      this.localImitationDataUrl = null;
      this.localImitationDuration = 0;
      this.localSubPhase = 0;
      this.state = this._freshState();
      this.state.round = nextRound;
      const wordInput = this.root?.querySelector('#rv-secret-word');
      const guessInput = this.root?.querySelector('#rv-guess-input');
      if (wordInput) wordInput.value = '';
      if (guessInput) guessInput.value = '';
      if (this.ctx?.isHost) {
        this._broadcastState();
      }
    },

    _getPartnerId() {
      if (!this.state || !this.ctx) return null;
      const partner = this.state.players.find(p => p.id !== this.ctx.myId);
      return partner ? partner.id : this.ctx.myId;
    },

    /* ----------------------------------------------------------------------
       Web Audio API: Decode & Reverse AudioBuffer PCM Arrays
       ---------------------------------------------------------------------- */
    _getAudioContext() {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
      return this.audioCtx;
    },

    _dataUrlToArrayBuffer(dataUrl) {
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.buffer;
    },

    async _decodeDataUrl(cacheKey, dataUrl) {
      if (!dataUrl) throw new Error('No audio data available.');
      if (this.decodedCache[cacheKey]) {
        return this.decodedCache[cacheKey];
      }
      const actx = this._getAudioContext();
      const rawBuffer = this._dataUrlToArrayBuffer(dataUrl);
      const audioBuffer = await actx.decodeAudioData(rawBuffer.slice(0));
      this.decodedCache[cacheKey] = audioBuffer;
      return audioBuffer;
    },

    _reverseAudioBuffer(sourceBuffer) {
      const actx = this._getAudioContext();
      const numChannels = sourceBuffer.numberOfChannels;
      const length = sourceBuffer.length;
      const sampleRate = sourceBuffer.sampleRate;
      const reversedBuffer = actx.createBuffer(numChannels, length, sampleRate);

      for (let ch = 0; ch < numChannels; ch++) {
        const srcData = sourceBuffer.getChannelData(ch);
        const dstData = reversedBuffer.getChannelData(ch);
        for (let i = 0, j = length - 1; i < length; i++, j--) {
          dstData[i] = srcData[j];
        }
      }
      return reversedBuffer;
    },

    _stopPlayback() {
      if (this.activeSource) {
        try { this.activeSource.stop(); } catch (e) {}
        try { this.activeSource.disconnect(); } catch (e) {}
        this.activeSource = null;
      }
      if (this.root) {
        this.root.querySelectorAll('.rv-btn--playing').forEach(btn => {
          btn.classList.remove('rv-btn--playing');
        });
      }
    },

    async _playAudioDataUrl(cacheKey, dataUrl, shouldReverse, btnEl) {
      if (!dataUrl) {
        alert('No audio clip recorded yet for this stage.');
        return;
      }
      try {
        this._stopPlayback();
        const actx = this._getAudioContext();
        const decoded = await this._decodeDataUrl(cacheKey, dataUrl);
        const targetBuffer = shouldReverse
          ? this._reverseAudioBuffer(decoded)
          : decoded;

        const source = actx.createBufferSource();
        source.buffer = targetBuffer;
        source.connect(actx.destination);

        if (btnEl) btnEl.classList.add('rv-btn--playing');
        this.activeSource = source;
        source.onended = () => {
          if (this.activeSource === source) {
            this.activeSource = null;
          }
          if (btnEl) btnEl.classList.remove('rv-btn--playing');
        };
        source.start(0);
      } catch (err) {
        console.error('[ReverseVoice] Audio playback error:', err);
        alert('Could not play audio clip on this browser/device.');
      }
    },

    /* ----------------------------------------------------------------------
       Persistent Microphone Stream & MediaRecorder Helpers (Request ONCE)
       ---------------------------------------------------------------------- */
    _isStreamActive(stream) {
      if (!stream) return false;
      const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
      return tracks.length > 0 && tracks.some(t => t.readyState === 'live');
    },

    async _ensureMicStream(silent = false) {
      if (this._isStreamActive(this.mediaStream)) {
        return this.mediaStream;
      }
      if (this._isStreamActive(window.__rvPersistentMicStream)) {
        this.mediaStream = window.__rvPersistentMicStream;
        return this.mediaStream;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (!silent) alert('Audio recording is not supported on this browser/device.');
        return null;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        window.__rvPersistentMicStream = stream;
        this.mediaStream = stream;
        return stream;
      } catch (err) {
        if (!silent) {
          console.warn('[ReverseVoice] Microphone access failed:', err);
          alert('Microphone access was denied or unavailable. Please allow microphone permissions to play Reverse Voice.');
        }
        return null;
      }
    },

    async _startRecording(statusEl, recBtnEl) {
      if (this.isRecording) return;
      this._stopPlayback();

      if (typeof MediaRecorder === 'undefined') {
        alert('Audio recording is not supported on this browser/device.');
        return;
      }

      const stream = await this._ensureMicStream(false);
      if (!stream) return;

      try {
        this.recordedChunks = [];

        const mimeCandidates = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus'
        ];
        let options = {};
        if (typeof MediaRecorder.isTypeSupported === 'function') {
          for (const mime of mimeCandidates) {
            if (MediaRecorder.isTypeSupported(mime)) {
              options = { mimeType: mime };
              break;
            }
          }
        }

        const recorder = new MediaRecorder(stream, options);
        this.mediaRecorder = recorder;
        this.isRecording = true;
        this.recordStartTs = Date.now();

        recorder.ondataavailable = e => {
          if (e.data && e.data.size > 0) {
            this.recordedChunks.push(e.data);
          }
        };

        recorder.onstop = () => {
          const elapsed = Math.max(0.4, (Date.now() - this.recordStartTs) / 1000);
          this.localDraftDuration = Number(elapsed.toFixed(1));
          const mimeType = recorder.mimeType || 'audio/webm';
          const blob = new Blob(this.recordedChunks, { type: mimeType });
          // Keep this.mediaStream / window.__rvPersistentMicStream alive! Never call track.stop().
          this.isRecording = false;
          if (this.recordTimer) {
            clearInterval(this.recordTimer);
            this.recordTimer = null;
          }

          const reader = new FileReader();
          reader.onloadend = () => {
            this.localDraftDataUrl = reader.result;
            delete this.decodedCache['local_draft'];
            this._renderPhase();
          };
          reader.readAsDataURL(blob);
        };

        recorder.start();
        if (recBtnEl) {
          recBtnEl.classList.add('is-recording');
          recBtnEl.textContent = '⏹ Stop Recording';
        }
        if (statusEl) {
          statusEl.textContent = '🔴 Recording... (0.0s / max 6.0s)';
        }

        this.recordTimer = setInterval(() => {
          const sec = (Date.now() - this.recordStartTs) / 1000;
          if (statusEl) {
            statusEl.textContent = `🔴 Recording... (${sec.toFixed(1)}s / max 6.0s)`;
          }
          if (sec >= 6.0) {
            this._stopRecording(false);
          }
        }, 100);
      } catch (err) {
        console.warn('[ReverseVoice] MediaRecorder start failed:', err);
        this.isRecording = false;
        alert('Could not start audio recording on this device.');
      }
    },

    _stopRecording(discard = false) {
      if (this.recordTimer) {
        clearInterval(this.recordTimer);
        this.recordTimer = null;
      }
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        if (discard) {
          this.mediaRecorder.ondataavailable = null;
          this.mediaRecorder.onstop = null;
        }
        try { this.mediaRecorder.stop(); } catch (e) {}
      }
      this.mediaRecorder = null;
      this.isRecording = false;
      // Intentionally keep this.mediaStream tracks active so permission is never re-requested!
    },

    /* ----------------------------------------------------------------------
       DOM Event Bindings & Phase Synchronization UI
       ---------------------------------------------------------------------- */
    _bindDomEvents() {
      if (!this.root) return;

      // Phase 1 Controls
      const wordInput = this.root.querySelector('#rv-secret-word');
      const recBtnP1 = this.root.querySelector('#rv-btn-rec-p1');
      const previewBtnP1 = this.root.querySelector('#rv-btn-preview-p1');
      const sendBtnP1 = this.root.querySelector('#rv-btn-send-p1');
      const statusP1 = this.root.querySelector('#rv-status-p1');

      if (wordInput) {
        wordInput.oninput = () => {
          const myClip = this.state?.clips?.[this.ctx?.myId];
          if (myClip) myClip.word = wordInput.value;
        };
      }
      if (recBtnP1) {
        recBtnP1.onclick = () => {
          if (this.isRecording) this._stopRecording(false);
          else this._startRecording(statusP1, recBtnP1);
        };
      }
      if (previewBtnP1) {
        previewBtnP1.onclick = () => {
          this._playAudioDataUrl('local_draft', this.localDraftDataUrl, false, previewBtnP1);
        };
      }
      if (sendBtnP1) {
        sendBtnP1.onclick = () => {
          if (!this.localDraftDataUrl || !this.ctx) return;
          const wordVal = wordInput ? wordInput.value.trim() : '';
          const audioB64 = this.localDraftDataUrl;
          if (this.ctx.isHost) {
            this._handleP1Submit(this.ctx.myId, wordVal, audioB64);
          } else {
            const myClip = this.state.clips[this.ctx.myId];
            if (myClip) myClip.p1Done = true;
            this._renderPhase();
            this.ctx.send('submit_p1', {
              playerId: this.ctx.myId,
              word: wordVal,
              audioB64
            }, this.ctx.hostId);
          }
        };
      }

      // Phase 2 Controls (Imitate Partner's Reversed Audio -> Keep Local for Phase 3)
      const playRevBtnP2 = this.root.querySelector('#rv-btn-play-reversed-p2');
      const recBtnP2 = this.root.querySelector('#rv-btn-rec-p2');
      const previewBtnP2 = this.root.querySelector('#rv-btn-preview-p2');
      const sendBtnP2 = this.root.querySelector('#rv-btn-send-p2');
      const statusP2 = this.root.querySelector('#rv-status-p2');

      if (playRevBtnP2) {
        playRevBtnP2.onclick = () => {
          const partnerId = this._getPartnerId();
          const partnerClip = partnerId ? this.state?.clips?.[partnerId] : null;
          this._playAudioDataUrl(
            `orig_${partnerId}_r${this.state?.round || 1}`,
            partnerClip?.originalB64,
            true, // Reverse partner's original PCM arrays!
            playRevBtnP2
          );
        };
      }
      if (recBtnP2) {
        recBtnP2.onclick = () => {
          if (this.isRecording) this._stopRecording(false);
          else this._startRecording(statusP2, recBtnP2);
        };
      }
      if (previewBtnP2) {
        previewBtnP2.onclick = () => {
          this._playAudioDataUrl('local_draft', this.localDraftDataUrl, false, previewBtnP2);
        };
      }
      if (sendBtnP2) {
        sendBtnP2.onclick = () => {
          if (!this.localDraftDataUrl || !this.ctx) return;
          // Store imitation locally for Phase 3 (DO NOT send audio to partner yet!)
          this.localImitationDataUrl = this.localDraftDataUrl;
          this.localImitationDuration = this.localDraftDuration;
          this.localDraftDataUrl = null;
          this.localDraftDuration = 0;
          this.localSubPhase = 3;
          delete this.decodedCache['local_imitation'];

          if (this.ctx.isHost) {
            this._handleP2Done(this.ctx.myId);
          } else {
            const myClip = this.state.clips[this.ctx.myId];
            if (myClip) myClip.p2Done = true;
            this._renderPhase();
            this.ctx.send('mark_p2_done', { playerId: this.ctx.myId }, this.ctx.hostId);
          }
        };
      }

      // Phase 3 Controls (Locally Reverse OWN Imitation & Guess Partner's Original Word)
      const playMyImitRevBtnP3 = this.root.querySelector('#rv-btn-play-my-imit-rev-p3');
      const playRawImitBtnP3 = this.root.querySelector('#rv-btn-play-imit-rev-p3');
      const guessInput = this.root.querySelector('#rv-guess-input');
      const sendBtnP3 = this.root.querySelector('#rv-btn-send-p3');

      if (playMyImitRevBtnP3) {
        playMyImitRevBtnP3.onclick = () => {
          const myId = this.ctx?.myId;
          const myClip = myId ? this.state?.clips?.[myId] : null;
          const imitSrc = this.localImitationDataUrl || myClip?.imitationB64;
          this._playAudioDataUrl(
            'local_imitation',
            imitSrc,
            true, // Locally reverse OWN recorded imitation!
            playMyImitRevBtnP3
          );
        };
      }
      if (playRawImitBtnP3) {
        playRawImitBtnP3.onclick = () => {
          const myId = this.ctx?.myId;
          const myClip = myId ? this.state?.clips?.[myId] : null;
          const imitSrc = this.localImitationDataUrl || myClip?.imitationB64;
          this._playAudioDataUrl(
            'local_imitation',
            imitSrc,
            false, // Play own raw imitation unreversed
            playRawImitBtnP3
          );
        };
      }

      const submitGuess = () => {
        if (!this.ctx) return;
        const guessVal = guessInput ? guessInput.value.trim() : '';
        if (!guessVal) {
          alert('Please type a guess before submitting!');
          return;
        }
        const imitAudioB64 = this.localImitationDataUrl;
        if (this.ctx.isHost) {
          this._handleP3Submit(this.ctx.myId, guessVal, imitAudioB64);
        } else {
          const myClip = this.state.clips[this.ctx.myId];
          if (myClip) {
            myClip.guess = guessVal;
            if (imitAudioB64) myClip.imitationB64 = imitAudioB64;
            myClip.p3Done = true;
          }
          this._renderPhase();
          this.ctx.send('submit_p3', {
            playerId: this.ctx.myId,
            guess: guessVal,
            imitationB64: imitAudioB64
          }, this.ctx.hostId);
        }
      };

      if (sendBtnP3) sendBtnP3.onclick = submitGuess;
      if (guessInput) {
        guessInput.onkeydown = e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitGuess();
          }
        };
      }

      // Phase 4 Controls (Grand Reveal: Original, Reversed, Imitation, Reversed Imitation)
      const revOrigBtn = this.root.querySelector('#rv-btn-reveal-orig');
      const revRevBtn = this.root.querySelector('#rv-btn-reveal-rev');
      const revRawImitBtn = this.root.querySelector('#rv-btn-reveal-raw-imit');
      const revImitBtn = this.root.querySelector('#rv-btn-reveal-imit');
      const newRoundBtn = this.root.querySelector('#rv-btn-new-round');

      if (revOrigBtn) {
        revOrigBtn.onclick = () => {
          const partnerId = this._getPartnerId();
          const clip = partnerId ? this.state?.clips?.[partnerId] : null;
          this._playAudioDataUrl(`orig_${partnerId}_r${this.state?.round || 1}`, clip?.originalB64, false, revOrigBtn);
        };
      }
      if (revRevBtn) {
        revRevBtn.onclick = () => {
          const partnerId = this._getPartnerId();
          const clip = partnerId ? this.state?.clips?.[partnerId] : null;
          this._playAudioDataUrl(`orig_${partnerId}_r${this.state?.round || 1}`, clip?.originalB64, true, revRevBtn);
        };
      }
      if (revRawImitBtn) {
        revRawImitBtn.onclick = () => {
          const myId = this.ctx?.myId;
          const clip = myId ? this.state?.clips?.[myId] : null;
          this._playAudioDataUrl(`imit_${myId}_r${this.state?.round || 1}`, clip?.imitationB64 || this.localImitationDataUrl, false, revRawImitBtn);
        };
      }
      if (revImitBtn) {
        revImitBtn.onclick = () => {
          const myId = this.ctx?.myId;
          const clip = myId ? this.state?.clips?.[myId] : null;
          this._playAudioDataUrl(`imit_${myId}_r${this.state?.round || 1}`, clip?.imitationB64 || this.localImitationDataUrl, true, revImitBtn);
        };
      }
      if (newRoundBtn) {
        newRoundBtn.onclick = () => {
          if (!this.ctx) return;
          if (this.ctx.isHost) {
            this._startNewRound();
          } else {
            this.ctx.send('new_round', null, this.ctx.hostId);
          }
        };
      }
    },

    _renderPhase() {
      if (!this.root || !this.state || !this.ctx) return;
      this._ensurePlayerSlots();

      const uiPhase = this._getEffectiveUiPhase();

      // Update 4-step header pills
      const stepsEl = this.root.querySelector('#rv-steps');
      if (stepsEl) {
        const labels = [
          { num: 1, text: '1. Record' },
          { num: 2, text: '2. Imitate' },
          { num: 3, text: '3. Guess' },
          { num: 4, text: '4. Reveal' }
        ];
        stepsEl.innerHTML = labels.map(s => {
          let cls = 'rv-step';
          if (uiPhase === s.num) cls += ' is-active active';
          else if (uiPhase > s.num) cls += ' is-done done';
          return `<span class="${cls}">${s.text}</span>`;
        }).join('');
      }

      // Update Peer Synchronization Status Bar
      const peerBar = this.root.querySelector('#rv-peer-status');
      const doneKey = uiPhase === 1 ? 'p1Done' : uiPhase === 2 ? 'p2Done' : 'p3Done';
      if (peerBar) {
        peerBar.innerHTML = this.state.players.map(p => {
          const clip = this.state.clips[p.id];
          const isReady = uiPhase === 4 ? true : Boolean(clip && clip[doneKey]);
          const isMe = p.id === this.ctx.myId;
          let statusLabel = isReady ? 'Ready ✓' : 'Working...';
          if (uiPhase !== 1 && uiPhase !== 4 && clip) {
            if (clip.p3Done) statusLabel = 'Guessed ✓';
            else if (clip.p2Done) statusLabel = 'Guessing...';
            else statusLabel = 'Imitating...';
          }
          return `
            <span class="rv-peer-pill ${isReady ? 'is-ready ready' : ''}">
              <span class="rv-peer-dot"></span>
              ${this._esc(p.name)}${isMe ? ' (You)' : ''}: ${statusLabel}
            </span>
          `;
        }).join('');
      }

      // Show active phase panel and hide others
      const p1Panel = this.root.querySelector('#rv-phase-1');
      const p2Panel = this.root.querySelector('#rv-phase-2');
      const p3Panel = this.root.querySelector('#rv-phase-3');
      const p4Panel = this.root.querySelector('#rv-phase-4');

      [p1Panel, p2Panel, p3Panel, p4Panel].forEach((panel, idx) => {
        if (!panel) return;
        const isCurrent = (idx + 1) === uiPhase;
        panel.classList.toggle('hidden', !isCurrent);
      });

      const myId = this.ctx.myId;
      const myClip = this.state.clips[myId] || {};
      const hasDraft = Boolean(this.localDraftDataUrl);

      if (uiPhase === 1) {
        const recBtnP1 = this.root.querySelector('#rv-btn-rec-p1');
        const previewBtnP1 = this.root.querySelector('#rv-btn-preview-p1');
        const sendBtnP1 = this.root.querySelector('#rv-btn-send-p1');
        const statusP1 = this.root.querySelector('#rv-status-p1');

        if (recBtnP1 && !this.isRecording) {
          recBtnP1.classList.remove('is-recording');
          recBtnP1.disabled = Boolean(myClip.p1Done);
          recBtnP1.textContent = hasDraft ? '🎙️ Re-Record Audio' : '🎙️ Start Recording';
        }
        if (previewBtnP1) {
          previewBtnP1.disabled = !hasDraft;
          previewBtnP1.textContent = hasDraft ? `▶ Play My Recording (${this.localDraftDuration}s)` : '▶ Play My Recording';
        }
        if (sendBtnP1) {
          sendBtnP1.disabled = !hasDraft || Boolean(myClip.p1Done);
          sendBtnP1.textContent = myClip.p1Done ? '✅ Sent! Waiting for Partner...' : '🚀 Send Audio to Partner';
        }
        if (statusP1 && !this.isRecording) {
          if (myClip.p1Done) {
            statusP1.textContent = '🔒 Secret audio locked in! Waiting for your partner to finish Phase 1...';
          } else if (hasDraft) {
            statusP1.textContent = `✅ Recorded clip ready (${this.localDraftDuration}s). Click "Send Audio to Partner"!`;
          } else {
            statusP1.textContent = 'Click "Start Recording" and speak clearly into your microphone.';
          }
        }
      } else if (uiPhase === 2) {
        const recBtnP2 = this.root.querySelector('#rv-btn-rec-p2');
        const previewBtnP2 = this.root.querySelector('#rv-btn-preview-p2');
        const sendBtnP2 = this.root.querySelector('#rv-btn-send-p2');
        const statusP2 = this.root.querySelector('#rv-status-p2');

        if (recBtnP2 && !this.isRecording) {
          recBtnP2.classList.remove('is-recording');
          recBtnP2.disabled = false;
          recBtnP2.textContent = hasDraft ? '🎙️ Re-Record Imitation' : '🎙️ Record My Imitation';
        }
        if (previewBtnP2) {
          previewBtnP2.disabled = !hasDraft;
          previewBtnP2.textContent = hasDraft ? `▶ Preview My Imitation (${this.localDraftDuration}s)` : '▶ Preview My Imitation';
        }
        if (sendBtnP2) {
          sendBtnP2.disabled = !hasDraft;
          sendBtnP2.textContent = '➡️ Continue to Guess (Phase 3)';
        }
        if (statusP2 && !this.isRecording) {
          if (hasDraft) {
            statusP2.textContent = `✅ Imitation recorded (${this.localDraftDuration}s). Click "Continue to Guess (Phase 3)" to reverse your own imitation!`;
          } else {
            statusP2.textContent = 'Listen to the reversed audio first, then mimic the sounds!';
          }
        }
      } else if (uiPhase === 3) {
        const guessInput = this.root.querySelector('#rv-guess-input');
        const sendBtnP3 = this.root.querySelector('#rv-btn-send-p3');
        const statusP3 = this.root.querySelector('#rv-status-p3');

        if (guessInput) guessInput.disabled = Boolean(myClip.p3Done);
        if (sendBtnP3) {
          sendBtnP3.disabled = Boolean(myClip.p3Done);
          sendBtnP3.textContent = myClip.p3Done ? '✅ Guess Sent! Waiting for Partner...' : '✅ Submit Guess & Reveal';
        }
        if (statusP3) {
          statusP3.textContent = myClip.p3Done
            ? '🤔 Your guess and imitation were sent to your partner! Waiting for partner to finish...'
            : 'Listen to your locally reversed imitation, then type your guess of your partner\'s original word!';
        }
      } else if (uiPhase === 4) {
        const revealGrid = this.root.querySelector('#rv-reveal-grid');
        if (revealGrid) {
          const players = this.state.players;
          revealGrid.innerHTML = players.map(speaker => {
            const listener = players.find(p => p.id !== speaker.id) || speaker;
            const speakerClip = this.state.clips[speaker.id] || {};
            const listenerClip = this.state.clips[listener.id] || {};
            const originalWord = speakerClip.word ? speakerClip.word : '(Secret Audio Clip)';
            const listenerGuess = listenerClip.guess ? listenerClip.guess : '(No guess)';

            return `
              <div class="rv-reveal-card">
                <h5 class="rv-reveal-player">🎤 ${this._esc(speaker.name)}'s Secret Word Chain</h5>
                <div class="rv-reveal-pair">
                  <div class="rv-reveal-box">
                    <span class="rv-reveal-label">Original Word (${this._esc(speaker.name)})</span>
                    <div class="rv-reveal-word">${this._esc(originalWord)}</div>
                  </div>
                  <div class="rv-reveal-box">
                    <span class="rv-reveal-label">${this._esc(listener.name)}'s Guess (from own imitation)</span>
                    <div class="rv-reveal-word rv-reveal-word--guess">${this._esc(listenerGuess)}</div>
                  </div>
                </div>
                <div class="rv-playback-list">
                  <button type="button" class="rv-btn rv-btn--play" data-rv-play="orig" data-speaker="${speaker.id}">
                    ▶ 1. Original Audio (${this._esc(speaker.name)})
                  </button>
                  <button type="button" class="rv-btn rv-btn--play" data-rv-play="rev" data-speaker="${speaker.id}">
                    ⏪ 2. Reversed Audio (Alien Prompt)
                  </button>
                  <button type="button" class="rv-btn rv-btn--play" data-rv-play="imit_raw" data-listener="${listener.id}">
                    🎙️ 3. Imitation Audio (by ${this._esc(listener.name)})
                  </button>
                  <button type="button" class="rv-btn rv-btn--play" data-rv-play="imit_rev" data-listener="${listener.id}">
                    🔁 4. Reversed Imitation (What ${this._esc(listener.name)} Guessed From)
                  </button>
                </div>
              </div>
            `;
          }).join('');

          revealGrid.querySelectorAll('[data-rv-play]').forEach(btn => {
            btn.onclick = () => {
              const mode = btn.getAttribute('data-rv-play');
              if (mode === 'orig') {
                const spkId = btn.getAttribute('data-speaker');
                const clip = this.state.clips[spkId];
                this._playAudioDataUrl(`orig_${spkId}_r${this.state.round}`, clip?.originalB64, false, btn);
              } else if (mode === 'rev') {
                const spkId = btn.getAttribute('data-speaker');
                const clip = this.state.clips[spkId];
                this._playAudioDataUrl(`orig_${spkId}_r${this.state.round}`, clip?.originalB64, true, btn);
              } else if (mode === 'imit_raw') {
                const lstId = btn.getAttribute('data-listener');
                const clip = this.state.clips[lstId];
                this._playAudioDataUrl(`imit_${lstId}_r${this.state.round}`, clip?.imitationB64, false, btn);
              } else if (mode === 'imit_rev') {
                const lstId = btn.getAttribute('data-listener');
                const clip = this.state.clips[lstId];
                this._playAudioDataUrl(`imit_${lstId}_r${this.state.round}`, clip?.imitationB64, true, btn);
              }
            };
          });
        }
      }
    },

    _esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    },

    _escAttr(s) {
      return this._esc(s);
    }
  };

  GameHub.register(ReverseVoice);
})();
