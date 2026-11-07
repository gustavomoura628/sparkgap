// Morse code table, Koch lesson order, and PARIS-standard timing.

export const CODE = Object.freeze({
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.",
  H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.",
  O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-",
  V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-",
  5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-.", "=": "-...-",
});

// Lesson order used by LCWO and most Koch trainers. Early characters are
// chosen to sound distinct from each other.
export const KOCH_ORDER = Object.freeze([
  "K", "M", "U", "R", "E", "S", "N", "A", "P", "T",
  "L", "W", "I", ".", "J", "Z", "=", "F", "O", "Y",
  ",", "V", "G", "5", "/", "Q", "9", "2", "H", "3",
  "8", "B", "?", "4", "7", "C", "1", "D", "6", "0",
  "X",
]);

/** Duration of one dit, in seconds, at the given words-per-minute. */
export function unitSeconds(wpm) {
  return 1.2 / wpm;
}

/**
 * Letter and word gaps, in seconds, for Farnsworth timing.
 *
 * Characters are sent at `charWpm`; the gaps are stretched so that the
 * overall rate is `effectiveWpm`. Formula from Jon Bloom, "A Standard for
 * Morse Timing Using the Farnsworth Technique" (ARRL): the standard word
 * PARIS has 19 units of letter/word spacing, which together take
 * ta = (60c - 37.2s) / (s*c) seconds.
 */
export function gaps(charWpm, effectiveWpm = charWpm) {
  const u = unitSeconds(charWpm);
  if (effectiveWpm >= charWpm) return { letter: 3 * u, word: 7 * u };
  const ta = (60 * charWpm - 37.2 * effectiveWpm) / (charWpm * effectiveWpm);
  return { letter: (3 * ta) / 19, word: (7 * ta) / 19 };
}

/**
 * Convert text to a list of key-down intervals.
 * Returns { tones: [{ start, duration }], duration } with times in seconds.
 * Unknown characters are skipped.
 */
export function timeline(text, { wpm, effectiveWpm = wpm }) {
  const u = unitSeconds(wpm);
  const { letter, word } = gaps(wpm, effectiveWpm);
  const tones = [];
  let t = 0;
  let pending = 0; // gap owed before the next tone

  for (const w of String(text).toUpperCase().split(/\s+/).filter(Boolean)) {
    if (tones.length) pending = word;
    for (const ch of w) {
      const code = CODE[ch];
      if (!code) continue;
      if (tones.length && pending === 0) pending = letter;
      for (let i = 0; i < code.length; i++) {
        t += pending;
        const duration = code[i] === "." ? u : 3 * u;
        tones.push({ start: t, duration });
        t += duration;
        pending = u;
      }
      pending = 0;
    }
  }
  return { tones, duration: t };
}
