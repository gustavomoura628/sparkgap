// Sidetone playback with the Web Audio API. Tones are scheduled on the audio
// clock, so timing does not depend on the main thread.

import { timeline } from "./morse.js";

const RAMP = 0.005; // 5 ms rise/fall avoids key clicks

export class Keyer {
  constructor() {
    this.ctx = null;
    this.voices = new Set();
  }

  /** Must be called from a user gesture the first time (browser autoplay rules). */
  async ensure() {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /**
   * Play text as Morse. Resolves when the last tone ends.
   * The returned object's `endsAt` is a performance.now() timestamp for the
   * end of the last tone as heard, used for reaction-time measurement.
   */
  play(text, { wpm, effectiveWpm = wpm, frequency = 600, volume = 0.5 }) {
    const ctx = this.ctx;
    const { tones, duration } = timeline(text, { wpm, effectiveWpm });
    const t0 = ctx.currentTime + 0.03;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, t0);
    for (const { start, duration: d } of tones) {
      const a = t0 + start;
      gain.gain.setValueAtTime(0, a);
      gain.gain.linearRampToValueAtTime(volume, a + RAMP);
      gain.gain.setValueAtTime(volume, a + d - RAMP);
      gain.gain.linearRampToValueAtTime(0, a + d);
    }
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);

    const latency = (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
    const endsAt = performance.now() + (t0 + duration - ctx.currentTime) * 1000 + latency;

    const voice = { osc, gain };
    this.voices.add(voice);
    const done = new Promise((resolve) => {
      osc.onended = () => {
        this.voices.delete(voice);
        gain.disconnect();
        resolve();
      };
    });
    return { endsAt, done, latencyMs: latency };
  }

  /** Silence everything that is playing or scheduled. */
  stop() {
    for (const { osc, gain } of this.voices) {
      gain.gain.cancelScheduledValues(0);
      gain.gain.value = 0;
      try { osc.stop(); } catch { /* already stopped */ }
    }
  }
}
