import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, currentLevel, mastery, charStats, pickNext, shouldUnlock, weights } from "../web/js/trainer.js";

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

test("unlocking also needs every character at the target reaction time", () => {
  const slow = Array.from({ length: RULES.windowAll }, (_, i) => attempt(i % 2 ? "K" : "M", true, 800, 2));
  assert.equal(shouldUnlock(slow, 2), false);
  assert.equal(shouldUnlock(slow, 2, { ...RULES, targetRtMs: 900 }), true);
});
