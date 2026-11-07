// Drill UI: plays a character, waits for the answer, records the attempt.

import { CODE, KOCH_ORDER } from "./morse.js";
import { Keyer } from "./audio.js";
import { openStore } from "./storage.js";
import * as T from "./trainer.js";

const DEFAULTS = Object.freeze({ wpm: 20, frequency: 600, volume: 0.5 });
const LIMITS = { wpm: [5, 50], frequency: [300, 1200], volume: [0.05, 1] };
const HIT_PAUSE_MS = 450;

const $ = (id) => document.getElementById(id);
const ui = {
  readout: $("readout"),
  stage: $("stage"),
  status: $("status"),
  glyph: $("glyph"),
  detail: $("detail"),
  lamps: $("lamps"),
  lesson: $("lesson"),
  session: $("session"),
  storage: $("storage"),
  dialog: $("settings"),
  form: $("settings-form"),
};

const keyer = new Keyer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let store;
let attempts = [];
let settings = { ...DEFAULTS };
let level = T.RULES.startLevel;
let introQueue = [];
let sessionAttempts = [];

// state: idle | intro | listening | feedback | correcting | paused
let state = "idle";
let resumeTo = "idle";
let current = null; // { char, endsAt, replays, answered }
let generation = 0; // bumped to cancel an in-flight sequence (e.g. on pause)

// Rendering ---------------------------------------------------------------

function setStage(status, glyph = "", glyphClass = "", detail = "") {
  ui.status.textContent = status;
  ui.status.className = `status ${glyphClass}`.trim();
  ui.glyph.textContent = glyph;
  ui.glyph.className = `glyph ${glyphClass}`.trim();
  if (typeof detail === "string") ui.detail.textContent = detail;
  else ui.detail.replaceChildren(...detail);
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

function buildLamps() {
  ui.lamps.replaceChildren(
    ...KOCH_ORDER.map((ch) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lamp";
      b.textContent = ch;
      b.dataset.char = ch;
      b.addEventListener("click", () => previewChar(ch));
      return b;
    }),
  );
}

function renderLamps() {
  const active = new Set(T.activeChars(level));
  const newest = KOCH_ORDER[level - 1];
  for (const b of ui.lamps.children) {
    const ch = b.dataset.char;
    if (!active.has(ch)) {
      b.dataset.state = "locked";
      b.style.setProperty("--m", 0);
      b.removeAttribute("data-newest");
      b.title = `${ch}: not unlocked yet`;
      b.setAttribute("aria-label", `${ch}, locked`);
      continue;
    }
    const s = T.charStats(attempts, ch);
    const m = T.mastery(s);
    b.dataset.state = "active";
    b.style.setProperty("--m", m.toFixed(3));
    b.toggleAttribute("data-newest", ch === newest);
    const desc = s.tries
      ? `${Math.round(s.acc * 100)}% of the last ${s.tries}` +
        (s.medianRt != null ? `, median ${seconds(Math.max(0, s.medianRt))}` : "")
      : "no attempts yet";
    b.title = `${ch}: ${desc}`;
    b.setAttribute("aria-label", `${ch}, ${desc}`);
  }
  ui.lesson.textContent = `${level} of ${KOCH_ORDER.length} unlocked`;
}

function renderSession() {
  const n = sessionAttempts.length;
  if (!n) {
    ui.session.textContent = `${attempts.length} answers recorded so far.`;
    return;
  }
  const acc = sessionAttempts.filter((a) => a.correct).length / n;
  const rt = T.median(sessionAttempts.filter((a) => a.correct).map((a) => a.rtMs));
  ui.session.textContent =
    `This session: ${n} ${n === 1 ? "answer" : "answers"}, ${Math.round(acc * 100)}% correct` +
    (rt != null ? `, median reaction ${seconds(Math.max(0, rt))}.` : ".");
}

function renderReadout() {
  ui.readout.textContent = `${settings.wpm} wpm, ${settings.frequency} Hz`;
}

// Drill flow --------------------------------------------------------------

function play(ch) {
  return keyer.play(ch, settings);
}

async function start() {
  await keyer.ensure();
  introQueue = T.activeChars(level).filter((c) => T.charStats(attempts, c).total === 0);
  next();
}

function next() {
  if (introQueue.length) intro(introQueue[0]);
  else prompt();
}

async function intro(ch) {
  const gen = ++generation;
  state = "intro";
  current = null;
  renderLamps();
  setStage("New character", ch, "intro", "Listen to it a few times. Space plays it again; any other key continues.");
  for (let i = 0; i < 3; i++) {
    await play(ch).done;
    if (gen !== generation) return;
    await sleep(500);
    if (gen !== generation) return;
  }
}

function prompt() {
  generation++;
  const ch = T.pickNext(attempts, level);
  current = { char: ch, endsAt: 0, replays: 0, answered: false };
  setStage("Type what you hear");
  current.endsAt = play(ch).endsAt;
  state = "listening";
}

function replay() {
  keyer.stop();
  current.replays++;
  current.endsAt = play(current.char).endsAt;
}

async function answer(ch) {
  const gen = generation;
  state = "feedback";
  current.answered = true;
  const rtMs = Math.round(performance.now() - current.endsAt);
  const correct = ch === current.char;
  keyer.stop();

  const attempt = {
    t: new Date().toISOString(),
    mode: "letters",
    char: current.char,
    answer: ch,
    correct,
    rtMs,
    replays: current.replays,
    level,
    wpm: settings.wpm,
    frequency: settings.frequency,
  };
  attempts.push(attempt);
  sessionAttempts.push(attempt);
  store.addAttempt(attempt).catch((err) => {
    ui.storage.textContent = `${err.message}. This answer was not saved.`;
  });
  renderLamps();
  renderSession();

  if (correct) {
    setStage("Correct", current.char, "hit", rtMs < 0 ? "Before it finished" : seconds(rtMs));
    await sleep(HIT_PAUSE_MS);
  } else {
    const you = document.createElement("span");
    you.className = "miss";
    you.textContent = `you typed ${ch}`;
    setStage("Missed", current.char, "miss",
      [`It was ${current.char}, `, you, `. Type ${current.char} to continue.`]);
    // Wait for the correct key before moving on; only the first answer is recorded.
    state = "correcting";
    await sleep(150);
    if (gen !== generation || state !== "correcting") return;
    play(current.char);
    return;
  }
  if (gen !== generation) return;
  advance();
}

/** Unlock the next character if earned, then continue the drill. */
function advance() {
  if (T.shouldUnlock(attempts, level)) {
    level++;
    introQueue.push(KOCH_ORDER[level - 1]);
  }
  next();
}

async function previewChar(ch) {
  if (state === "listening" || state === "feedback" || state === "correcting") return;
  await keyer.ensure();
  keyer.stop();
  play(ch);
}

// Pause and settings --------------------------------------------------------

function pause() {
  if (state === "paused") return;
  resumeTo = state === "feedback" ? "listening" : state;
  generation++;
  keyer.stop();
  state = "paused";
  for (const [k, v] of Object.entries(settings)) ui.form.elements[k].value = v;
  ui.dialog.showModal();
}

function readSettings() {
  const next = { ...settings };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Number(ui.form.elements[k].value);
    if (Number.isFinite(v)) next[k] = Math.min(hi, Math.max(lo, v));
  }
  return next;
}

async function resume() {
  settings = readSettings();
  renderReadout();
  store.saveSettings(settings).catch(() => {});
  const to = resumeTo;
  if (to === "idle") {
    state = "idle";
    return;
  }
  await keyer.ensure();
  if (to === "intro" && introQueue.length) return intro(introQueue[0]);
  if (to === "correcting") {
    state = "correcting";
    play(current.char);
    return;
  }
  if (current && !current.answered) {
    state = "listening";
    setStage("Type what you hear");
    current.endsAt = play(current.char).endsAt;
    return;
  }
  next();
}

function exportHistory() {
  const blob = new Blob([JSON.stringify(attempts, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sparkgap-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Keyboard ------------------------------------------------------------------

function normalizeKey(e) {
  if (e.key.length !== 1) return null;
  const k = e.key.toUpperCase();
  return CODE[k] ? k : null;
}

function onKeyDown(e) {
  if (ui.dialog.open || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;

  if (e.key === "Escape") {
    // Without preventDefault, this same key press would close the dialog it opens.
    e.preventDefault();
    if (state !== "idle") pause();
    return;
  }
  const isSpace = e.key === " ";
  if (isSpace) e.preventDefault(); // keep Space from clicking a focused lamp

  switch (state) {
    case "idle":
      start();
      break;
    case "intro":
      keyer.stop();
      if (isSpace) {
        generation++;
        play(introQueue[0]);
      } else {
        introQueue.shift();
        next();
      }
      break;
    case "correcting": {
      if (isSpace) {
        keyer.stop();
        play(current.char);
        return;
      }
      if (normalizeKey(e) === current.char) {
        e.preventDefault();
        keyer.stop();
        generation++;
        advance();
      }
      break;
    }
    case "listening": {
      if (isSpace) return replay();
      const ch = normalizeKey(e);
      if (ch) {
        e.preventDefault();
        answer(ch);
      }
      break;
    }
  }
}

// Boot ----------------------------------------------------------------------

async function boot() {
  buildLamps();
  store = await openStore();
  const [history, saved] = await Promise.all([store.loadAttempts(), store.loadSettings()]);
  attempts = Array.isArray(history) ? history : [];
  settings = { ...DEFAULTS, ...saved };
  level = T.currentLevel(attempts);

  renderReadout();
  renderLamps();
  renderSession();
  ui.storage.textContent = store.kind === "server"
    ? "History is saved by the local server."
    : "History is saved in this browser.";

  document.addEventListener("keydown", onKeyDown);
  $("open-settings").addEventListener("click", () => {
    if (state === "idle") {
      resumeTo = "idle";
      for (const [k, v] of Object.entries(settings)) ui.form.elements[k].value = v;
      state = "paused";
      ui.dialog.showModal();
    } else pause();
  });
  $("export").addEventListener("click", exportHistory);
  ui.stage.addEventListener("click", () => {
    if (state === "idle") start();
  });
  ui.dialog.addEventListener("close", resume);
}

boot();
