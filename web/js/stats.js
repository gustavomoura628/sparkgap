// Lesson grouping and statistics. Pure functions over the attempt history.
//
// A lesson is a fixed number of answers (LESSON_SIZE). Each attempt carries:
//   lesson  lesson number (assigned by the app; derived here for older records)
//   durMs   active time credited to this answer (pauses excluded, idle capped)
//   charMs  how long the character took to play
// Older records without these fields get them derived from timestamps, so the
// whole history can be summarised the same way.

import { timeline } from "./morse.js";

export const LESSON_SIZE = 50;       // answers per lesson: about one minute at full speed
export const IDLE_CAP_MS = 20_000;   // most active time one answer can be credited with
export const NEW_SITTING_MS = 10 * 60_000; // a gap this long starts a new lesson
const FALLBACK_DUR_MS = 1500;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Duration of one character, in ms, at the given speed. */
export function charDurationMs(char, wpm) {
  return timeline(char, { wpm }).duration * 1000;
}

/**
 * Copy speed in words per minute: the rate at which characters could be
 * copied if each one took its playing time plus the reaction time
 * (5 characters per word).
 */
export function copyWpm(charMs, rtMs) {
  return 12_000 / (charMs + Math.max(0, rtMs));
}

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Return a copy of the history with lesson, durMs and charMs filled in.
 * Records that already carry them keep their values.
 */
export function normalize(attempts) {
  const out = [];
  let lesson = 0;
  let count = 0;
  let prevT = null;
  let started = false;

  for (const a of attempts) {
    const t = Date.parse(a.t);
    const gap = prevT == null || Number.isNaN(t) ? Infinity : t - prevT;
    prevT = Number.isNaN(t) ? prevT : t;

    let durMs = a.durMs;
    if (!Number.isFinite(durMs)) {
      durMs = gap > NEW_SITTING_MS ? FALLBACK_DUR_MS : Math.min(gap, IDLE_CAP_MS);
    }

    let id = a.lesson;
    if (!Number.isFinite(id)) {
      if (started && (count >= LESSON_SIZE || gap > NEW_SITTING_MS)) {
        lesson++;
        count = 0;
      }
      id = lesson;
    } else if (id !== lesson || !started) {
      count = 0;
      lesson = id;
    }
    started = true;
    count++;

    const charMs = Number.isFinite(a.charMs) ? a.charMs : charDurationMs(a.char, a.wpm || 20);
    out.push({ ...a, lesson: id, durMs, charMs });
  }
  return out;
}

/** Points earned by a lesson: harder sets and faster answers score more. */
export function lessonScore(items, accuracy) {
  let points = 0;
  for (const a of items) {
    if (!a.correct) continue;
    points += (a.level || 2) * (1000 / (Math.max(0, a.rtMs) + 500));
  }
  return Math.round(points * accuracy);
}

function summarizeChars(items) {
  const by = new Map();
  for (const a of items) {
    if (!by.has(a.char)) by.set(a.char, []);
    by.get(a.char).push(a);
  }
  const out = new Map();
  for (const [c, xs] of by) {
    const correct = xs.filter((a) => a.correct);
    out.set(c, {
      n: xs.length,
      correct: correct.length,
      medianRt: median(correct.map((a) => a.rtMs)),
    });
  }
  return out;
}

/** Summaries of every lesson, in order. `complete` lessons reached LESSON_SIZE answers. */
export function lessons(normalized) {
  const groups = new Map();
  for (const a of normalized) {
    if (!groups.has(a.lesson)) groups.set(a.lesson, []);
    groups.get(a.lesson).push(a);
  }
  const out = [];
  for (const [id, items] of [...groups].sort((a, b) => a[0] - b[0])) {
    const correct = items.filter((a) => a.correct);
    const rts = correct.map((a) => a.rtMs);
    const acc = correct.length / items.length;
    const activeMs = items.reduce((s, a) => s + a.durMs, 0);
    out.push({
      id,
      start: items[0].t,
      end: items[items.length - 1].t,
      chars: items.length,
      correct: correct.length,
      acc,
      medianRt: median(rts),
      meanRt: mean(rts),
      copyWpm: correct.length ? median(correct.map((a) => copyWpm(a.charMs, a.rtMs))) : null,
      level: Math.max(...items.map((a) => a.level || 2)),
      activeMs,
      score: lessonScore(items, acc),
      complete: items.length >= LESSON_SIZE,
      perChar: summarizeChars(items),
    });
  }
  return out;
}

/** Aggregate figures over a set of lessons (pass complete lessons only for fair tops). */
export function totals(lessonList, timeMs) {
  const withRt = lessonList.filter((l) => l.medianRt != null);
  const withCopy = lessonList.filter((l) => l.copyWpm != null);
  return {
    timeMs,
    lessons: lessonList.length,
    bestRt: withRt.length ? Math.min(...withRt.map((l) => l.medianRt)) : null,
    avgRt: mean(withRt.map((l) => l.medianRt)),
    topAcc: lessonList.length ? Math.max(...lessonList.map((l) => l.acc)) : null,
    avgAcc: mean(lessonList.map((l) => l.acc)),
    topCopy: withCopy.length ? Math.max(...withCopy.map((l) => l.copyWpm)) : null,
    avgCopy: mean(withCopy.map((l) => l.copyWpm)),
  };
}

/** Active practice time per local day, in ms. */
export function dailyActive(normalized) {
  const days = new Map();
  for (const a of normalized) {
    const k = dayKey(a.t);
    days.set(k, (days.get(k) || 0) + a.durMs);
  }
  return days;
}

/**
 * Longest run of consecutive complete lessons at or above each accuracy
 * threshold. Returns null for a threshold no lesson has reached.
 */
export function streaks(completeLessons, thresholds = [1, 0.97, 0.95]) {
  return thresholds.map((threshold) => {
    let best = null;
    let run = [];
    const close = () => {
      if (run.length && (!best || run.length > best.length)) best = run;
      run = [];
    };
    for (const l of completeLessons) {
      if (l.acc >= threshold) run.push(l);
      else close();
    }
    close();
    if (!best) return { threshold, lessons: 0 };
    const rts = best.filter((l) => l.medianRt != null).map((l) => l.medianRt);
    return {
      threshold,
      lessons: best.length,
      chars: best.reduce((s, l) => s + l.chars, 0),
      bestRt: rts.length ? Math.min(...rts) : null,
      avgRt: mean(rts),
      start: best[0].start,
    };
  });
}

/** Number of most recent consecutive complete lessons at or above the threshold. */
export function currentStreak(completeLessons, threshold = 0.95) {
  let n = 0;
  for (let i = completeLessons.length - 1; i >= 0 && completeLessons[i].acc >= threshold; i--) n++;
  return n;
}

/** One character's median reaction time in each complete lesson where it was answered correctly. */
export function charSeries(completeLessons, char) {
  const out = [];
  completeLessons.forEach((l, i) => {
    const c = l.perChar.get(char);
    if (c && c.medianRt != null) out.push({ x: i + 1, y: c.medianRt, n: c.n, correct: c.correct });
  });
  return out;
}

/** Hits, misses and reaction times per character over the whole history. */
export function charTotals(normalized) {
  const by = new Map();
  for (const a of normalized) {
    if (!by.has(a.char)) by.set(a.char, { hits: 0, misses: 0, rts: [] });
    const c = by.get(a.char);
    if (a.correct) {
      c.hits++;
      c.rts.push(a.rtMs);
    } else c.misses++;
  }
  for (const c of by.values()) {
    c.medianRt = median(c.rts);
    c.meanRt = mean(c.rts);
    c.missRatio = c.misses / (c.hits + c.misses);
    delete c.rts;
  }
  return by;
}

/** Counts of (played, typed) pairs for wrong answers. */
export function confusion(normalized) {
  const m = new Map();
  for (const a of normalized) {
    if (a.correct) continue;
    const k = `${a.char}\u0000${a.answer}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([k, n]) => {
    const [played, typed] = k.split("\u0000");
    return { played, typed, n };
  });
}

/** Least-squares line through {x, y} points. */
export function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

/**
 * Centred smoothing by local linear regression with a Gaussian kernel.
 * `smoothness` runs from 0 (raw values) to 1 (close to the straight-line fit).
 * Unlike a moving average it does not lag behind the data or drift toward
 * the first value. `xs` defaults to the value indices.
 */
export function smooth(values, smoothness, xs = values.map((_, i) => i)) {
  const s = clamp(smoothness, 0, 1);
  const n = values.length;
  if (s === 0 || n < 3) return [...values];
  const span = Math.max(...xs) - Math.min(...xs);
  if (!(span > 0)) return [...values];
  // Bandwidth grows geometrically from a fraction of the point spacing (raw)
  // to twice the full range (effectively a single straight line).
  const hMin = (0.25 * span) / (n - 1);
  const hMax = 2 * span;
  const h = hMin * (hMax / hMin) ** s;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return xs.map((x0) => {
    let sw = 0, sx = 0, sy = 0;
    const w = xs.map((x) => Math.exp(-0.5 * ((x - x0) / h) ** 2));
    for (let i = 0; i < n; i++) { sw += w[i]; sx += w[i] * xs[i]; sy += w[i] * values[i]; }
    const mx = sx / sw;
    const my = sy / sw;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += w[i] * (xs[i] - mx) ** 2;
      sxy += w[i] * (xs[i] - mx) * (values[i] - my);
    }
    const fit = sxx > 1e-9 * sw ? my + (sxy / sxx) * (x0 - mx) : my;
    return clamp(fit, lo, hi);
  });
}

/**
 * Compare answers given with and without a boolean flag (for example `music`).
 * Records without the flag are ignored. The differences are matched: they are
 * computed within each (level, character) pair that has at least `minEach`
 * answers on both sides, then averaged weighted by the smaller side, so a
 * different mix of characters or levels does not skew the result.
 * Differences are "flag on" minus "flag off".
 */
export function flagEffect(attempts, flag, minEach = 3) {
  const tagged = attempts.filter((a) => typeof a[flag] === "boolean");
  const summary = (xs) => {
    const correct = xs.filter((a) => a.correct);
    return {
      n: xs.length,
      acc: xs.length ? correct.length / xs.length : null,
      medianRt: median(correct.map((a) => a.rtMs)),
    };
  };
  const cells = new Map();
  for (const a of tagged) {
    const k = `${a.level}\u0000${a.char}`;
    if (!cells.has(k)) cells.set(k, { on: [], off: [] });
    cells.get(k)[a[flag] ? "on" : "off"].push(a);
  }
  let wAcc = 0, accDiff = 0, wRt = 0, rtDiff = 0;
  for (const { on, off } of cells.values()) {
    if (on.length < minEach || off.length < minEach) continue;
    const w = Math.min(on.length, off.length);
    const [sOn, sOff] = [summary(on), summary(off)];
    wAcc += w;
    accDiff += w * (sOn.acc - sOff.acc);
    if (sOn.medianRt != null && sOff.medianRt != null) {
      wRt += w;
      rtDiff += w * (sOn.medianRt - sOff.medianRt);
    }
  }
  return {
    on: summary(tagged.filter((a) => a[flag])),
    off: summary(tagged.filter((a) => !a[flag])),
    matched: wAcc,
    accDiff: wAcc ? accDiff / wAcc : null,
    rtDiff: wRt ? rtDiff / wRt : null,
  };
}
