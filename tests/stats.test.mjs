import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LESSON_SIZE, NEW_SITTING_MS, normalize, lessons, streaks, currentStreak, copyWpm,
  linearFit, smooth, confusion, charTotals, dailyActive, flagEffect,
} from "../web/js/stats.js";

const T0 = Date.parse("2026-01-05T10:00:00Z");
const rec = (i, extra = {}) => ({
  t: new Date(T0 + i * 1500).toISOString(), char: "K", answer: "K", correct: true,
  rtMs: 300, level: 2, wpm: 20, ...extra,
});

test("records without a lesson number are grouped into lessons of LESSON_SIZE answers", () => {
  assert.equal(LESSON_SIZE, 50);
  const n = normalize(Array.from({ length: 120 }, (_, i) => rec(i)));
  assert.equal(n[49].lesson, 0);
  assert.equal(n[50].lesson, 1);
  assert.equal(n[100].lesson, 2);
  assert.deepEqual(lessons(n).map((l) => l.complete), [true, true, false]);
});

test("a long break starts a new lesson", () => {
  const history = [rec(0), rec(1), { ...rec(2), t: new Date(T0 + NEW_SITTING_MS + 60_000).toISOString() }];
  const n = normalize(history);
  assert.deepEqual(n.map((a) => a.lesson), [0, 0, 1]);
});

test("explicit lesson numbers and durations are kept", () => {
  const history = [rec(0, { lesson: 7, durMs: 900, charMs: 540 })];
  const [a] = normalize(history);
  assert.equal(a.lesson, 7);
  assert.equal(a.durMs, 900);
  assert.equal(a.charMs, 540);
});

test("derived character duration matches PARIS timing", () => {
  const [a] = normalize([rec(0)]);
  // K = dah dit dah: 3+1+1+1+3 = 9 units of 60 ms at 20 wpm
  assert.ok(Math.abs(a.charMs - 540) < 1e-6);
});

test("copy speed counts playing time plus reaction time", () => {
  assert.equal(copyWpm(600, 400), 12);
  assert.equal(copyWpm(600, -200), 20); // early answers do not add speed
});

test("lesson summary", () => {
  const items = [
    rec(0, { lesson: 0, durMs: 1000 }),
    rec(1, { lesson: 0, durMs: 1000, correct: false, answer: "M", rtMs: 900 }),
  ];
  const [l] = lessons(normalize(items));
  assert.equal(l.chars, 2);
  assert.equal(l.acc, 0.5);
  assert.equal(l.medianRt, 300);
  assert.equal(l.activeMs, 2000);
  assert.equal(l.complete, false);
  const full = Array.from({ length: LESSON_SIZE }, (_, i) => rec(i, { lesson: 0, durMs: 1000 }));
  assert.equal(lessons(normalize(full))[0].complete, true);
});

test("streaks find the longest run above each threshold", () => {
  const ls = [1, 0.96, 1, 1, 0.9, 0.98, 0.97, 0.99, 1].map((acc, i) => ({
    acc, chars: 40, medianRt: 300, start: `d${i}`,
  }));
  const [s100, s97, s95] = streaks(ls);
  assert.equal(s100.lessons, 2);
  assert.equal(s100.start, "d2");
  assert.equal(s97.lessons, 4);
  assert.equal(s95.lessons, 4);
  assert.equal(currentStreak(ls, 0.95), 4);
});

test("linear fit and smoothing", () => {
  const fit = linearFit([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 1);
  assert.deepEqual(smooth([1, 2, 3], 0), [1, 2, 3]);
  const s = smooth([0, 10, 10, 10], 0.5);
  assert.ok(s[1] > 0 && s[1] < 10);
  // A straight line stays straight at any smoothness (no lag, no flattening).
  const line = [100, 90, 80, 70, 60, 50];
  for (const k of [0.3, 0.7, 1]) {
    smooth(line, k).forEach((v, i) => assert.ok(Math.abs(v - line[i]) < 1e-6));
  }
  // Maximum smoothness approaches the least-squares line, not a flat one.
  const noisy = [100, 70, 95, 60, 75, 40, 55, 30];
  const fitN = linearFit(noisy.map((y, x) => ({ x, y })));
  smooth(noisy, 1).forEach((v, i) => assert.ok(Math.abs(v - (fitN.intercept + fitN.slope * i)) < 2));
  // Smoothing never leaves the range of the data.
  smooth([0, 1, 1, 1], 0.6).forEach((v) => assert.ok(v >= 0 && v <= 1));
});

test("confusion and per-character totals", () => {
  const n = normalize([
    rec(0), rec(1, { correct: false, answer: "Y" }), rec(2, { correct: false, answer: "Y" }),
  ]);
  assert.deepEqual(confusion(n), [{ played: "K", typed: "Y", n: 2 }]);
  const k = charTotals(n).get("K");
  assert.equal(k.hits, 1);
  assert.equal(k.misses, 2);
});

test("daily active time sums durations per local day", () => {
  const n = normalize([rec(0, { durMs: 1000 }), rec(1, { durMs: 2000 })]);
  assert.equal([...dailyActive(n).values()][0], 3000);
});

test("flag effect compares matched character and level pairs", () => {
  const a = (char, level, music, rtMs, correct = true) =>
    ({ t: "2026-01-05T10:00:00Z", char, answer: correct ? char : "X", correct, rtMs, level, music });
  const xs = [
    // K: music adds 100 ms
    ...Array.from({ length: 4 }, () => a("K", 2, false, 400)),
    ...Array.from({ length: 4 }, () => a("K", 2, true, 500)),
    // M: practised mostly with music and slower overall; no gap within M
    ...Array.from({ length: 3 }, () => a("M", 2, false, 900)),
    ...Array.from({ length: 10 }, () => a("M", 2, true, 900)),
    // Untagged history is ignored.
    a("K", 2, undefined, 5000),
  ];
  const e = flagEffect(xs, "music");
  assert.equal(e.on.n, 14);
  assert.equal(e.off.n, 7);
  assert.equal(e.matched, 7);
  // Weighted by the smaller side: (4 x 100 + 3 x 0) / 7
  assert.ok(Math.abs(e.rtDiff - 400 / 7) < 1e-9);
  assert.equal(e.accDiff, 0);
  // The raw medians differ much more, because of the character mix.
  assert.equal(e.on.medianRt - e.off.medianRt, 500);
});
