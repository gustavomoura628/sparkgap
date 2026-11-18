// Adaptive Koch drill logic. Pure functions over the attempt history, so the
// same history always produces the same lesson state.
//
// An attempt looks like:
//   { char: "K", answer: "K", correct: true, rtMs: 412, level: 2, ... }
// where rtMs is measured from the end of the first play to the key press
// (negative if the answer came before the character finished).

import { KOCH_ORDER } from "./morse.js";

export const RULES = Object.freeze({
  startLevel: 2,      // characters in the first lesson
  windowAll: 50,      // answers since the last unlock needed before the next one
  minAccAll: 0.9,     // accuracy over those answers needed to unlock the next character
  windowChar: 20,     // recent attempts per character considered
  minTriesChar: 10,   // each active character needs this many recent tries...
  minAccChar: 0.8,    // ...at this accuracy before unlocking
  minTriesNewest: 25, // the newest character needs this many tries since it was added...
  minAccNewest: 0.9,  // ...and this accuracy over its last windowChar tries
  targetRtMs: 500,    // every active character's median reaction time must reach this
  slowMs: 1500,       // reaction times at or above this count as slow
  newCharBoost: 25,   // the newest character is favoured for its first N tries
  focusBoost: 1,      // extra weight for the focus character, in average weights
  focusStickiness: 0.1, // the focus moves only when another character is this much further behind
  confusionWindow: 300, // recent answers used to find what the focus is confused with
  maxShare: 2.5,      // no character is picked more than this times an even share
  accFloor: 0.5,      // unlock progress counts accuracy from here (at or below = no progress)
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
 * Every check that gates the next character, with how far along each one is.
 *
 * Rows: the overall window (answers at the current level), the newest
 * character (tries since it was added), and one row per active character
 * (its last windowChar tries). Each row is made of parts (count, accuracy,
 * speed) with a 0..1 progress; a row's progress is its weakest part, and the
 * overall progress is the mean of the rows. `ready` is true only when every
 * part passes. Only answers given at the current level count toward the
 * overall window and the newest character, so a new character cannot unlock
 * the next one on the strength of older history.
 *
 * Returns null when every character is already unlocked.
 */
export function unlockProgress(attempts, level, rules = RULES) {
  if (level >= KOCH_ORDER.length) return null;
  const active = activeChars(level);
  const newest = active[active.length - 1];
  const inSet = attempts.filter((a) => active.includes(a.char));
  const atLevel = inSet.filter((a) => a.level === level);

  const count = (have, need) => ({
    kind: "count", have, need, ok: have >= need, progress: Math.min(1, have / need),
  });
  const accuracy = (correct, tries, need) => {
    const acc = tries ? correct / tries : null;
    return {
      kind: "accuracy", correct, tries, have: acc, need,
      ok: acc != null && acc >= need,
      progress: acc == null ? 0 : clamp((acc - rules.accFloor) / (need - rules.accFloor), 0, 1),
    };
  };
  const speed = (rt) => ({
    kind: "speed", have: rt, need: rules.targetRtMs,
    ok: rt != null && rt <= rules.targetRtMs, progress: speedFraction(rt, rules),
  });
  const row = (kind, char, parts) => {
    const ok = parts.every((p) => p.ok);
    return { kind, char, parts, ok, progress: ok ? 1 : Math.min(...parts.map((p) => p.progress)) };
  };

  const recent = atLevel.slice(-rules.windowAll);
  const n = charStats(atLevel, newest, rules.windowChar);
  const rows = [
    row("overall", null, [
      count(recent.length, rules.windowAll),
      accuracy(recent.filter((a) => a.correct).length, recent.length, rules.minAccAll),
    ]),
    row("newest", newest, [count(n.total, rules.minTriesNewest), accuracy(n.correct, n.tries, rules.minAccNewest)]),
    ...active.map((c) => {
      const s = charStats(inSet, c, rules.windowChar);
      return row("char", c, [
        count(s.tries, rules.minTriesChar), accuracy(s.correct, s.tries, rules.minAccChar), speed(s.medianRt),
      ]);
    }),
  ];
  return {
    char: KOCH_ORDER[level],
    rows,
    ready: rows.every((r) => r.ok),
    progress: rows.reduce((sum, r) => sum + r.progress, 0) / rows.length,
  };
}

/** True when the history shows the current set is solid enough to add a character. */
export function shouldUnlock(attempts, level, rules = RULES) {
  return unlockProgress(attempts, level, rules)?.ready ?? false;
}

/** Reaction time at or above which the speed fraction is 0. */
export const slowBound = (rules = RULES) => Math.max(rules.slowMs, rules.targetRtMs + 500);

/** Reaction speed from 0 (at slowBound or slower) to 1 (at the target or faster), linear in between. */
export function speedFraction(rtMs, rules = RULES) {
  if (rtMs == null) return 0;
  const slow = slowBound(rules);
  return clamp((slow - rtMs) / (slow - rules.targetRtMs), 0, 1);
}

/** 0..1 score combining recent accuracy and reaction speed relative to the target. */
export function mastery(stats, rules = RULES) {
  if (!stats.tries) return 0;
  const confidence = Math.min(1, stats.tries / rules.windowChar);
  return stats.acc * speedFraction(stats.medianRt, rules) * confidence;
}

/**
 * The focus: the active character furthest from passing its unlock check
 * (keeping the previous focus on near ties), and the characters it is confused
 * with over the last `confusionWindow` answers. Each partner has `count` (mix-ups
 * in either direction), `answers` (answers where either character was sent) and
 * `rate` (count / answers). Returns null when there is nothing to focus on
 * (every character passes, or every character is unlocked).
 */
export function focusOf(attempts, level, rules = RULES) {
  const gate = unlockProgress(attempts, level, rules);
  if (!gate) return null;
  const rows = gate.rows.filter((r) => r.kind === "char" && !r.ok);
  if (!rows.length) return null;
  // Lowest progress first; ties go to the lower accuracy, then to the Koch order.
  const acc = (r) => r.parts.find((p) => p.kind === "accuracy").have ?? 0;
  const weakest = rows.reduce((a, b) =>
    b.progress < a.progress - 1e-9 || (Math.abs(b.progress - a.progress) <= 1e-9 && acc(b) < acc(a)) ? b : a);
  // Keep the previous focus (stored on the last answer) unless another character
  // is clearly further behind, so the focus does not flip back and forth on near ties.
  const prev = rows.find((r) => r.char === attempts[attempts.length - 1]?.focus);
  const focus = prev && prev.progress <= weakest.progress + rules.focusStickiness ? prev.char : weakest.char;

  const active = new Set(activeChars(level));
  const recent = attempts.slice(-rules.confusionWindow);
  const sent = new Map();
  const counts = new Map();
  for (const a of recent) {
    sent.set(a.char, (sent.get(a.char) ?? 0) + 1);
    if (a.correct || !active.has(a.char) || !active.has(a.answer)) continue;
    const other = a.char === focus ? a.answer : a.answer === focus ? a.char : null;
    if (other && other !== focus) counts.set(other, (counts.get(other) ?? 0) + 1);
  }
  const partners = [...counts]
    .map(([char, count]) => {
      const answers = (sent.get(focus) ?? 0) + (sent.get(char) ?? 0);
      return { char, count, answers, rate: count / answers };
    })
    .sort((a, b) => b.count - a.count || activeChars(level).indexOf(a.char) - activeChars(level).indexOf(b.char));
  return { char: focus, partners };
}

/** Limit every weight to `maxShare` times an even share of the total. */
function capWeights(list, maxShare) {
  const out = list.map((p) => ({ ...p }));
  if (out.length < 2) return out;
  for (let i = 0; i < 10; i++) {
    const total = out.reduce((s, p) => s + p.weight, 0);
    const limit = (maxShare / out.length) * total;
    const over = out.filter((p) => p.weight > limit + 1e-9);
    if (!over.length) break;
    // Solve for the limit after capping: capped weights equal L = share * (rest + k*L).
    const rest = out.filter((p) => p.weight <= limit + 1e-9).reduce((s, p) => s + p.weight, 0);
    const share = maxShare / out.length;
    const L = (share * rest) / (1 - share * over.length);
    if (!(L > 0)) break;
    for (const p of over) p.weight = L;
  }
  return out;
}

/**
 * Sampling weight per active character.
 *
 * Each character starts from its recent accuracy and its speed against the
 * target. The focus character (see focusOf) then gets one average weight
 * extra, and each character it is confused with is raised towards the focus
 * weight by the share of their answers that are ambiguous between the two.
 *
 * Why: an answer is either clear or ambiguous (the listener cannot tell the
 * pair apart and effectively picks one). Ambiguous answers come out wrong about
 * half the time whatever the picking habit, so the ambiguous share is about
 * twice the pair's mix-up rate. Unequal frequencies only reward a picking habit
 * on ambiguous answers, so the gap is closed in that proportion: fully only at a
 * 50% mix-up rate (pure guessing), barely for a pair that is rarely confused.
 * No character may exceed `maxShare`
 * times an even share.
 */
export function weights(attempts, level, rules = RULES) {
  return selection(attempts, level, rules).weights;
}

/** The sampling weights together with the focus they were built around. */
export function selection(attempts, level, rules = RULES) {
  const active = activeChars(level);
  const newest = active[active.length - 1];
  const base = active.map((c) => {
    const s = charStats(attempts, c, rules.windowChar);
    const acc = (s.correct + 1) / (s.tries + 2); // Laplace prior: unknown = 50%
    const slow = s.medianRt == null ? 0.5 : 1 - speedFraction(s.medianRt, rules);
    let w = 1 + 6 * (1 - acc) + 2 * slow;
    if (c === newest && s.total < rules.newCharBoost && level > rules.startLevel) w += 2;
    return { char: c, weight: w };
  });

  const focus = focusOf(attempts, level, rules);
  if (focus) {
    const mean = base.reduce((s, p) => s + p.weight, 0) / base.length;
    const f = base.find((p) => p.char === focus.char);
    f.weight += rules.focusBoost * mean;
    for (const { char, rate } of focus.partners) {
      const p = base.find((x) => x.char === char);
      const ambiguous = Math.min(1, 2 * rate);
      if (p.weight < f.weight) p.weight += (f.weight - p.weight) * ambiguous;
    }
  }
  return { weights: capWeights(base, rules.maxShare), focus };
}

/**
 * Pick the next character and report the probability it had of being picked.
 * Avoids the same character three times in a row, and `exclude` (for example
 * a character just skipped) when another one is available.
 * `rng` returns a float in [0, 1).
 */
export function pickNextWithProb(attempts, level, { rng = Math.random, rules = RULES, exclude = null } = {}) {
  const sel = selection(attempts, level, rules);
  let pool = sel.weights;
  const last2 = attempts.slice(-2).map((a) => a.char);
  const drop = (ch) => {
    if (ch != null && pool.length > 1 && pool.some((p) => p.char === ch)) pool = pool.filter((p) => p.char !== ch);
  };
  if (last2.length === 2 && last2[0] === last2[1]) drop(last2[0]);
  drop(exclude);
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = rng() * total;
  let pick = pool[pool.length - 1];
  for (const p of pool) {
    r -= p.weight;
    if (r < 0) {
      pick = p;
      break;
    }
  }
  return { char: pick.char, prob: pick.weight / total, focus: sel.focus?.char ?? null };
}

/** Pick the next character (see pickNextWithProb). */
export function pickNext(attempts, level, rng = Math.random, rules = RULES) {
  return pickNextWithProb(attempts, level, { rng, rules }).char;
}
