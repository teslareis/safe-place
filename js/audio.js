/**
 * GameAudio: procedural sound effects via the Web Audio API (no audio files).
 * Plain script -> exposes the global `GameAudio`.
 *
 *   GameAudio.playReady()       pleasant two-note chime
 *   GameAudio.playError()       short low buzz
 *   GameAudio.playWin()         celebratory arpeggio
 *   GameAudio.playFill(combo)   snappy pop; pitch rises with the combo integer
 *   GameAudio.setVolume(0..1) / GameAudio.setMuted(bool)
 *
 * Browsers only allow audio after a user gesture, so the context is created
 * lazily and resumed on the first click/key/touch.
 */
const GameAudio = (function () {
  let ctx = null, master = null, volume = 0.6, muted = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Unlock audio on the first user gesture
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, () => ensure(), { once: true, passive: true }));

  /**
   * One enveloped tone.
   * opts: { type, freq, freqEnd, start (s offset), dur, peak, attack, filter }
   */
  function tone(o) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (o.start || 0);
    const dur = o.dur || 0.2, attack = o.attack || 0.005, peak = o.peak || 0.3;

    const osc = c.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + dur);

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let node = osc;
    if (o.filter) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.filter;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Soft bell: fundamental + a quieter octave partial. */
  function bell(freq, start, dur, peak) {
    tone({ type: 'sine', freq, start, dur, peak });
    tone({ type: 'sine', freq: freq * 2, start, dur: dur * 0.6, peak: peak * 0.3 });
  }

  return {
    playReady() {
      bell(784, 0, 0.35, 0.22);      // G5
      bell(1175, 0.09, 0.5, 0.22);   // D6
    },

    playError() {
      tone({ type: 'sawtooth', freq: 130, freqEnd: 80, dur: 0.22, peak: 0.28, filter: 700 });
      tone({ type: 'square', freq: 65, freqEnd: 55, dur: 0.22, peak: 0.12, filter: 400 });
    },

    playWin() {
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568]; // C5 E5 G5 C6 E6 G6
      notes.forEach((f, i) => {
        tone({ type: 'triangle', freq: f, start: i * 0.09, dur: 0.35, peak: 0.25 });
        tone({ type: 'sine', freq: f * 2, start: i * 0.09, dur: 0.2, peak: 0.06 });
      });
      const end = notes.length * 0.09;       // final shimmering chord
      [1046.5, 1318.5, 1568].forEach(f =>
        tone({ type: 'triangle', freq: f, start: end, dur: 0.9, peak: 0.16 }));
    },

    /** combo: integer >= 1. Each step is a quarter-tone up (capped at ~1.5 octaves). */
    playFill(combo) {
      const n = Math.max(0, Math.min(Math.floor(combo) || 0, 36));
      const f = 300 * Math.pow(2, n / 24);
      tone({ type: 'triangle', freq: f * 1.6, freqEnd: f, dur: 0.09, attack: 0.002, peak: 0.28 });
      tone({ type: 'sine', freq: f * 2, dur: 0.04, attack: 0.001, peak: 0.08 });
    },

    setVolume(v) { volume = Math.max(0, Math.min(1, v)); if (master) master.gain.value = muted ? 0 : volume; },
    setMuted(m) { muted = !!m; if (master) master.gain.value = muted ? 0 : volume; },
  };
})();
