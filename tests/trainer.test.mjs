import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RULES, currentLevel, mastery, charStats, pickNext, pickNextWithProb, shouldUnlock, weights, speedFraction,
  slowBound, unlockProgress, focusOf,
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

// Six characters with 20 tries each; `misses` maps a sent character to the keys typed instead.
function level6(misses = {}) {
  const out = [];
  for (const c of ["K", "M", "U", "R", "E", "S"]) {
    const wrong = misses[c] ?? [];
    for (let i = 0; i < 20; i++) {
      const typed = wrong[i];
      out.push({ ...attempt(c, !typed, 450, 6), answer: typed ?? c });
    }
  }
  return out;
}

test("the focus is the character furthest from passing, with its confusions in both directions", () => {
  const h = level6({ R: ["K", "K", "K", "K", "K", "U", "U"], K: ["R", "R"], S: ["U"] });
  const f = focusOf(h, 6);
  assert.equal(f.char, "R");
  // Every character was sent 20 times, so each pair has 40 answers.
  assert.deepEqual(f.partners, [
    { char: "K", count: 7, answers: 40, rate: 7 / 40 },
    { char: "U", count: 2, answers: 40, rate: 2 / 40 },
  ]);
});

test("a confuser closes the gap to the focus by twice the pair's mix-up rate", () => {
  // K and M have identical records, so any difference between them comes from the pairing.
  for (const n of [5, 8]) { // R fails its accuracy check, so it is the focus
    const h = level6({ R: Array(n).fill("K") });
    const w = Object.fromEntries(weights(h, 6).map((p) => [p.char, p.weight]));
    const closed = (w.K - w.M) / (w.R - w.M);
    assert.ok(Math.abs(closed - 2 * (n / 40)) < 1e-9, `${n}: ${closed}`);
  }
});

test("a pair mixed up half the time is fully matched", () => {
  const h = level6({ R: Array(10).fill("K"), K: Array(10).fill("R") }); // 20 of 40
  const w = Object.fromEntries(weights(h, 6).map((p) => [p.char, p.weight]));
  assert.ok(Math.abs(w.R - w.K) < 1e-9);
});

test("confusions with characters that are not unlocked are ignored", () => {
  const h = level6({ R: ["D", "D", "D", "D", "D", "D", "K"] });
  assert.deepEqual(focusOf(h, 6).partners.map((p) => [p.char, p.count]), [["K", 1]]);
});

test("no character goes over the share cap", () => {
  const h = level6({ R: Array(20).fill("K"), K: Array(20).fill("R") });
  const w = weights(h, 6);
  const total = w.reduce((s, p) => s + p.weight, 0);
  for (const p of w) assert.ok(p.weight / total <= RULES.maxShare / 6 + 1e-9, `${p.char} ${p.weight / total}`);
});

test("the focus stays put on a near tie", () => {
  // R and S are equally far behind; S was the focus on the last answer.
  const h = level6({ R: ["K", "K", "K", "K", "K"], S: ["U", "U", "U", "U", "U"] });
  assert.equal(focusOf(h, 6).char, "R");
  h[h.length - 1] = { ...h[h.length - 1], focus: "S" };
  assert.equal(focusOf(h, 6).char, "S");
});

test("the pick reports the focus it was made with", () => {
  const h = level6({ R: ["K", "K", "K", "K", "K"] });
  assert.equal(pickNextWithProb(h, 6, { rng: () => 0.5 }).focus, "R");
});

test("there is no focus when every character passes", () => {
  const h = level6().map((a) => ({ ...a, rtMs: 300 }));
  assert.equal(focusOf(h, 6), null);
});
