import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE, KOCH_ORDER, gaps, timeline, unitSeconds } from "../web/js/morse.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("Koch order covers every character exactly once", () => {
  assert.equal(new Set(KOCH_ORDER).size, KOCH_ORDER.length);
  assert.deepEqual([...KOCH_ORDER].sort(), Object.keys(CODE).sort());
});

test("PARIS is 50 units long including the trailing word gap", () => {
  const u = unitSeconds(20);
  const { duration } = timeline("PARIS", { wpm: 20 });
  close(duration + 7 * u, 50 * u);
});

test("standard gaps are 3 and 7 units", () => {
  const u = unitSeconds(20);
  const g = gaps(20);
  close(g.letter, 3 * u);
  close(g.word, 7 * u);
});

test("Farnsworth gaps hit the effective speed", () => {
  // One PARIS (with its word gap) must take 60/s seconds at effective speed s.
  const c = 20, s = 10;
  const { duration } = timeline("PARIS", { wpm: c, effectiveWpm: s });
  close(duration + gaps(c, s).word, 60 / s, 1e-6);
});

test("timeline places a letter gap between characters and a word gap between words", () => {
  const u = unitSeconds(20);
  const { tones } = timeline("E E", { wpm: 20 });
  close(tones[1].start - (tones[0].start + tones[0].duration), 7 * u);
  const two = timeline("EE", { wpm: 20 }).tones;
  close(two[1].start - (two[0].start + two[0].duration), 3 * u);
});
