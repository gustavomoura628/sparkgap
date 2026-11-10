// Adaptive Koch drill logic. Pure functions over the attempt history, so the
// same history always produces the same lesson state.
//
// An attempt looks like:
//   { char: "K", answer: "K", correct: true, rtMs: 412, level: 2, ... }
// where rtMs is measured from the end of the last tone to the key press
// (negative if the answer came before the character finished).

import { KOCH_ORDER } from "./morse.js";

export const RULES = Object.freeze({
  startLevel: 2,      // characters in the first lesson
  windowAll: 50,      // answers since the last unlock needed before the next one
  minAccAll: 0.9,     // accuracy over those answers needed to unlock the next character
  windowChar: 10,     // recent attempts per character considered
  minTriesChar: 6,    // each active character needs this many recent tries...
  minAccChar: 0.8,    // ...at this accuracy before unlocking
  minTriesNewest: 15, // the newest character needs this many tries since it was added...
  minAccNewest: 0.9,  // ...and this accuracy over its last windowChar tries
  targetRtMs: 500,    // every active character's median reaction time must reach this
  fastMs: 300,        // reaction times at or below this count as instant
  slowMs: 1500,       // reaction times at or above this count as slow
  newCharBoost: 25,   // the newest character is favoured for its first N tries
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Recent performance on one character. */
export function charStats(attempts, char, window = RULES.windowChar) {
  const all = attempts.filter((a) => a.char === char);
  const recent = all.slice(-window);
  const correct = recent.filter((a) => a.correct).length;
  const rts = recent.filter((a) => a.correct && Number.isFinite(a.rtMs)).map((a) => a.rtMs);
  return {
    total: all.length,
    tries: recent.length,
    correct,
    acc: recent.length ? correct / recent.length : null,
    medianRt: median(rts),
  };
}

/** Lesson level (number of active Koch characters) implied by the history. */
export function currentLevel(attempts, rules = RULES) {
  let level = rules.startLevel;
  for (const a of attempts) if (Number.isFinite(a.level)) level = Math.max(level, a.level);
  return clamp(level, rules.startLevel, KOCH_ORDER.length);
}

export function activeChars(level) {
  return KOCH_ORDER.slice(0, level);
}

/**
 * True when the history shows the current set is solid enough to add a character.
 * Only answers given at the current level count toward the overall window, so a
 * new character cannot unlock the next one on the strength of older history.
 */
export function shouldUnlock(attempts, level, rules = RULES) {
  if (level >= KOCH_ORDER.length) return false;
  const active = activeChars(level);
  const inSet = attempts.filter((a) => active.includes(a.char));
  const atLevel = inSet.filter((a) => a.level === level);
  const recent = atLevel.slice(-rules.windowAll);
  if (recent.length < rules.windowAll) return false;
  const acc = recent.filter((a) => a.correct).length / recent.length;
  if (acc < rules.minAccAll) return false;

  const newest = charStats(atLevel, active[active.length - 1], rules.windowChar);
  if (newest.total < rules.minTriesNewest || newest.acc < rules.minAccNewest) return false;

  return active.every((c) => {
    const s = charStats(inSet, c, rules.windowChar);
    return s.tries >= rules.minTriesChar && s.acc >= rules.minAccChar &&
      s.medianRt != null && s.medianRt <= rules.targetRtMs;
  });
}

/** How close a reaction time is to the target: 1 at or below target, falling off above it. */
export function speedScore(rtMs, rules = RULES) {
  if (rtMs == null) return 0;
  return clamp(rules.targetRtMs / Math.max(rtMs, 1), 0, 1);
}

/** 0..1 score combining recent accuracy and reaction speed relative to the target. */
export function mastery(stats, rules = RULES) {
  if (!stats.tries) return 0;
  const confidence = Math.min(1, stats.tries / rules.windowChar);
  const speed = stats.medianRt == null ? 0.2 : Math.max(0.2, speedScore(stats.medianRt, rules));
  return stats.acc * speed * confidence;
}

/** Sampling weight per active character: weak and slow characters come up more often. */
export function weights(attempts, level, rules = RULES) {
  const active = activeChars(level);
  const newest = active[active.length - 1];
  return active.map((c) => {
    const s = charStats(attempts, c, rules.windowChar);
    const acc = (s.correct + 1) / (s.tries + 2); // Laplace prior: unknown = 50%
    const slow = s.medianRt == null
      ? 0.5
      : clamp((s.medianRt - rules.fastMs) / (rules.slowMs - rules.fastMs), 0, 1);
    let w = 1 + 4 * (1 - acc) + 1.5 * slow;
    if (c === newest && s.total < rules.newCharBoost && level > rules.startLevel) w += 2;
    return { char: c, weight: w };
  });
}

/**
 * Pick the next character. Avoids the same character three times in a row.
 * `rng` returns a float in [0, 1).
 */
export function pickNext(attempts, level, rng = Math.random, rules = RULES) {
  let pool = weights(attempts, level, rules);
  const last2 = attempts.slice(-2).map((a) => a.char);
  if (last2.length === 2 && last2[0] === last2[1] && pool.length > 1) {
    pool = pool.filter((p) => p.char !== last2[0]);
  }
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = rng() * total;
  for (const p of pool) {
    r -= p.weight;
    if (r < 0) return p.char;
  }
  return pool[pool.length - 1].char;
}
