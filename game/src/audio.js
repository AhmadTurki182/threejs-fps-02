// audio.js — every sound in IRONLINE is synthesized with WebAudio:
// no audio files, no network, nothing to download. A shared noise
// buffer feeds the gunshots and the explosion; short oscillators make
// the beeps, ticks and stings. Everything is guarded: in a headless
// browser the context may stay suspended, and the game must never
// crash for want of a speaker.

export class SoundBank {
  constructor() {
    this.ctx = null;
    this.noiseBuf = null;
    this.master = null;
    this.enabled = true;
  }

  /** Create the context on the first user gesture (Play click). */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** A burst of filtered noise. */
  noise(dur, freq, gain, when = 0) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 0.8;
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(amp).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** A short tone with a pitch slide. */
  tone(freq, dur, gain, slideTo = null, type = 'sine', when = 0) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(amp).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  shot(weapon, distant = false) {
    const loud = distant ? 0.1 : 0.32;
    if (weapon === 'sniper') {
      this.noise(0.28, 900, loud + 0.1);
      this.tone(160, 0.16, 0.2, 50, 'sawtooth');
    } else if (weapon === 'smg') {
      this.noise(0.09, 2400, loud);
    } else if (weapon === 'rifle') {
      this.noise(0.14, 1600, loud);
    } else {
      this.noise(0.11, 1900, loud * 0.9);
    }
  }

  dryFire() {
    this.tone(1400, 0.03, 0.08, null, 'square');
  }

  hit(headshot) {
    this.tone(headshot ? 2100 : 1500, 0.06, 0.16, null, 'square');
    if (headshot) this.tone(2600, 0.08, 0.12, null, 'square', 0.05);
  }

  kill() {
    this.tone(880, 0.1, 0.16, 1320, 'triangle');
  }

  reload() {
    this.tone(700, 0.05, 0.1, null, 'square');
    this.tone(500, 0.05, 0.1, null, 'square', 0.18);
  }

  plantBeep() {
    this.tone(1050, 0.09, 0.14, null, 'sine');
  }

  defuseBeep() {
    this.tone(760, 0.09, 0.14, null, 'sine');
  }

  planted() {
    this.tone(520, 0.16, 0.18, 780, 'sawtooth');
    this.tone(780, 0.2, 0.14, 1040, 'sawtooth', 0.14);
  }

  explode() {
    this.noise(1.1, 160, 0.6);
    this.tone(90, 0.9, 0.5, 30, 'sine');
  }

  buy() {
    this.tone(980, 0.07, 0.14, null, 'triangle');
    this.tone(1320, 0.09, 0.14, null, 'triangle', 0.06);
  }

  denied() {
    this.tone(220, 0.12, 0.14, 180, 'square');
  }

  roundWin() {
    this.tone(523, 0.14, 0.16, null, 'triangle');
    this.tone(659, 0.14, 0.16, null, 'triangle', 0.12);
    this.tone(784, 0.22, 0.18, null, 'triangle', 0.24);
  }

  roundLose() {
    this.tone(392, 0.16, 0.15, null, 'triangle');
    this.tone(311, 0.2, 0.15, null, 'triangle', 0.14);
    this.tone(233, 0.3, 0.15, null, 'triangle', 0.28);
  }

  step() {
    this.noise(0.05, 500, 0.045);
  }

  click() {
    this.tone(1200, 0.04, 0.1, null, 'square');
  }
}
