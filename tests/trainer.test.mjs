import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RULES, currentLevel, mastery, charStats, pickNext, pickNextWithProb, shouldUnlock, weights, speedFraction,
  slowBound, unlockProgress,
} from "../web/js/trainer.js";

const attempt = (char, correct, rtMs = 400, level = 2) => ({ char, answer: correct ? char : "?", correct, rtMs, level });

function solid(chars, n, level) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(attempt(chars[i % chars.length], true, 350, level));
  return out;
}

test("starts at the first lesson", () => {
  assert.equal(currentLevel([]), RULES.startLevel);
});

test("level comes from the highest level recorded", () => {
  assert.equal(currentLevel([attempt("K", true, 400, 2), attempt("U", true, 400, 3)]), 3);
});

test("unlocks after enough accurate attempts on every active character", () => {
  assert.equal(shouldUnlock(solid(["K", "M"], RULES.windowAll - 1, 2), 2), false);
  assert.equal(shouldUnlock(solid(["K", "M"], RULES.windowAll, 2), 2), true);
});

test("answers from earlier levels do not count toward the next unlock", () => {
  // A long clean history on K and M, then a few correct answers on the new U.
  const history = [...solid(["K", "M"], 60, 2), ...solid(["U", "U", "K", "U", "M", "U"], 8, 3)];
  assert.equal(shouldUnlock(history, 3), false);
});

test("the newest character needs its own minimum number of tries", () => {
  // Plenty of answers at the new level, but almost none on the newest character.
  const history = [...solid(["K", "M"], 60, 3), ...solid(["U"], RULES.minTriesNewest - 1, 3)];
  assert.equal(shouldUnlock(history, 3), false);
  history.push(attempt("U", true, 350, 3));
  assert.equal(shouldUnlock(history, 3), true);
});

test("does not unlock when one character is weak", () => {
  const history = solid(["K"], 40, 2);
  for (let i = 0; i < 8; i++) history.push(attempt("M", i % 2 === 0));
  assert.equal(shouldUnlock(history, 2), false);
});

test("weak characters get more weight", () => {
  const history = [...solid(["K"], 10, 2)];
  for (let i = 0; i < 10; i++) history.push(attempt("M", false));
  const w = Object.fromEntries(weights(history, 2).map((p) => [p.char, p.weight]));
  assert.ok(w.M > w.K);
});

test("never picks the same character three times in a row", () => {
  const history = [attempt("K", true), attempt("K", true)];
  for (let i = 0; i < 50; i++) assert.equal(pickNext(history, 2, () => i / 50), "M");
});

test("mastery rewards speed as well as accuracy", () => {
  const fast = charStats(solid(["K"], 10, 2), "K");
  const slow = charStats(Array.from({ length: 10 }, () => attempt("K", true, 1400)), "K");
  assert.ok(mastery(fast) > mastery(slow));
});

test("the pick reports its probability, and excluded characters are avoided", () => {
  const history = solid(["K", "M", "U"], 10, 3);
  const w = weights(history, 3);
  const total = w.reduce((s, p) => s + p.weight, 0);
  const { char, prob } = pickNextWithProb(history, 3, { rng: () => 0 });
  assert.equal(char, w[0].char);
  assert.ok(Math.abs(prob - w[0].weight / total) < 1e-12);
  for (let i = 0; i < 50; i++) {
    const p = pickNextWithProb(history, 3, { rng: () => i / 50, exclude: "K" });
    assert.notEqual(p.char, "K");
    const rest = w.filter((x) => x.char !== "K");
    const sum = rest.reduce((s, x) => s + x.weight, 0);
    assert.ok(Math.abs(p.prob - rest.find((x) => x.char === p.char).weight / sum) < 1e-12);
  }
});

test("speed fraction runs linearly from the slow bound to the target", () => {
  assert.equal(speedFraction(RULES.targetRtMs), 1);
  assert.equal(speedFraction(200), 1);
  assert.equal(speedFraction(RULES.slowMs), 0);
  assert.equal(speedFraction(5000), 0);
  assert.equal(speedFraction((RULES.slowMs + RULES.targetRtMs) / 2), 0.5);
  // A target near slowMs still leaves room for a scale.
  assert.equal(slowBound({ ...RULES, targetRtMs: 1400 }), 1900);
});

test("unlocking also needs every character at the target reaction time", () => {
  const slow = Array.from({ length: RULES.windowAll }, (_, i) => attempt(i % 2 ? "K" : "M", true, 800, 2));
  assert.equal(shouldUnlock(slow, 2), false);
  assert.equal(shouldUnlock(slow, 2, { ...RULES, targetRtMs: 900 }), true);
});

test("unlock progress agrees with the unlock check and stays in range", () => {
  const cases = [
    solid(["K", "M"], 10, 2),
    solid(["K", "M"], RULES.windowAll, 2),
    [...solid(["K", "M"], 60, 3), ...solid(["U"], 5, 3)],
    [...solid(["K"], 40, 2), ...Array.from({ length: 8 }, (_, i) => attempt("M", i % 2 === 0))],
  ];
  for (const h of cases) {
    const level = currentLevel(h);
    const p = unlockProgress(h, level);
    assert.equal(p.ready, shouldUnlock(h, level));
    assert.ok(p.progress >= 0 && p.progress <= 1);
    assert.equal(p.ready, p.progress === 1);
  }
  assert.equal(unlockProgress([], 2).char, "U");
});

test("unlock progress counts accuracy from the floor and takes each row's weakest part", () => {
  // M: 15 of 20 correct (75%), fast. Accuracy progress = (0.75 - 0.5) / (0.8 - 0.5).
  const history = [...solid(["K"], 40, 2)];
  for (let i = 0; i < 20; i++) history.push(attempt("M", i % 4 !== 0, 350));
  const m = unlockProgress(history, 2).rows.find((r) => r.kind === "char" && r.char === "M");
  assert.equal(m.ok, false);
  assert.ok(Math.abs(m.progress - (0.75 - 0.5) / (0.8 - 0.5)) < 1e-9);
  assert.deepEqual(m.parts.map((x) => x.ok), [true, false, true]);
});

test("unlock progress returns null when everything is unlocked", () => {
  assert.equal(unlockProgress([], 41), null);
});
