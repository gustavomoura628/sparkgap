// Drill UI: plays a character, waits for the answer, records the attempt.

import { CODE, KOCH_ORDER } from "./morse.js";
import { Keyer } from "./audio.js";
import { openStore } from "./storage.js";
import * as T from "./trainer.js";
import * as S from "./stats.js";
import { loadHistory, SCHEMA_VERSION } from "./migrations.js";

const DEFAULTS = Object.freeze({ wpm: 20, frequency: 600, volume: 0.5, targetRtMs: 500, dailyGoalMin: 15 });
const LIMITS = {
  wpm: [5, 50], frequency: [300, 1200], volume: [0.05, 1], targetRtMs: [150, 2000], dailyGoalMin: [1, 240],
};
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
  metric: { rt: $("m-rt"), acc: $("m-acc"), score: $("m-score"), copy: $("m-copy") },
  delta: { rt: $("d-rt"), acc: $("d-acc"), score: $("d-score"), copy: $("d-copy") },
  goalText: $("goal-text"),
  goalFill: $("goal-fill"),
  currentChar: $("current-char"),
  streak: $("streak"),
  lessonLabel: $("lesson-label"),
  lessonFill: $("lesson-fill"),
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

// Active practice time: counted from the start of the drill, paused with the drill.
let activeSince = null; // performance.now() when counting resumed; null while stopped
let bankedMs = 0;       // time counted before a pause
let lessonId = 0;
let lessonMs = 0;

const rules = () => ({ ...T.RULES, targetRtMs: settings.targetRtMs });

/** Active time since the previous answer, capped so walking away does not count. */
function takeActiveMs() {
  const now = performance.now();
  const d = activeSince == null ? 0 : Math.min(now - activeSince, S.IDLE_CAP_MS);
  activeSince = now;
  return Math.round(d);
}

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
    const m = T.mastery(s, rules());
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

const ms = (v) => `${Math.round(Math.max(0, v))} ms`;
const pct = (v) => `${Math.round(v * 1000) / 10}%`;

function setDelta(el, diff, { lowerIsBetter = false, format }) {
  if (diff == null || Math.abs(diff) < 1e-9) {
    el.textContent = "";
    el.className = "delta";
    return;
  }
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  el.textContent = `${diff > 0 ? "\u25B2" : "\u25BC"} ${format(Math.abs(diff))}`;
  el.className = `delta ${good ? "good" : "bad"}`;
  el.setAttribute("aria-label", `${good ? "better" : "worse"} by ${format(Math.abs(diff))} than the lesson before`);
}

/** Metrics from the last complete lesson, daily goal, streak and lesson progress. */
function renderProgress() {
  const normalized = S.normalize(attempts);
  const complete = S.lessons(normalized).filter((l) => l.complete);
  const last = complete[complete.length - 1];
  const prev = complete[complete.length - 2];

  if (last) {
    ui.metric.rt.textContent = last.medianRt != null ? ms(last.medianRt) : "\u2013";
    ui.metric.acc.textContent = pct(last.acc);
    ui.metric.score.textContent = last.score.toLocaleString();
    ui.metric.copy.textContent = last.copyWpm != null ? `${last.copyWpm.toFixed(1)} wpm` : "\u2013";
    const d = (k) => (prev && last[k] != null && prev[k] != null ? last[k] - prev[k] : null);
    setDelta(ui.delta.rt, d("medianRt"), { lowerIsBetter: true, format: (v) => `${Math.round(v)} ms` });
    setDelta(ui.delta.acc, d("acc"), { format: (v) => `${(v * 100).toFixed(1)} pts` });
    setDelta(ui.delta.score, d("score"), { format: (v) => Math.round(v).toLocaleString() });
    setDelta(ui.delta.copy, d("copyWpm"), { format: (v) => `${v.toFixed(1)} wpm` });
  }

  const todayMs = S.dailyActive(normalized).get(S.dayKey(Date.now())) || 0;
  const goalMs = settings.dailyGoalMin * 60_000;
  ui.goalText.textContent = `${Math.floor(todayMs / 60_000)} of ${settings.dailyGoalMin} min`;
  ui.goalFill.style.width = `${Math.min(100, (todayMs / goalMs) * 100)}%`;

  const streak = S.currentStreak(complete, 0.95);
  ui.streak.textContent = `${streak} ${streak === 1 ? "lesson" : "lessons"} in a row at 95% or better`;

  if (level >= KOCH_ORDER.length) {
    ui.currentChar.textContent = "All characters are unlocked.";
  } else {
    const ch = KOCH_ORDER[level - 1];
    const s = T.charStats(attempts, ch);
    ui.currentChar.textContent = s.tries
      ? `Newest: ${ch}, ${s.correct} of the last ${s.tries} correct, ` +
        (s.medianRt != null ? `${ms(s.medianRt)} median` : "no correct answers yet") +
        ` (target ${settings.targetRtMs} ms)`
      : `Newest: ${ch}, not practised yet (target ${settings.targetRtMs} ms)`;
  }

  ui.lessonLabel.textContent = `Lesson ${complete.length + 1}`;
  ui.lessonFill.style.width = `${Math.min(100, (lessonMs / S.LESSON_MS) * 100)}%`;
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
  activeSince = performance.now();
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
  const durMs = takeActiveMs();
  const charMs = Math.round(S.charDurationMs(current.char, settings.wpm));
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
    lesson: lessonId,
    durMs,
    charMs,
    copyWpm: Math.round(S.copyWpm(charMs, rtMs) * 10) / 10,
  };
  attempts.push(attempt);
  sessionAttempts.push(attempt);
  store.addAttempt(attempt).catch((err) => {
    ui.storage.textContent = `${err.message}. This answer was not saved.`;
  });
  lessonMs += durMs;
  if (lessonMs >= S.LESSON_MS) {
    lessonId++;
    lessonMs = 0;
  }
  renderLamps();
  renderSession();
  renderProgress();

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
  if (T.shouldUnlock(attempts, level, rules())) {
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
  if (activeSince != null) bankedMs = performance.now() - activeSince;
  activeSince = null;
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
  renderLamps();
  renderProgress();
  store.saveSettings(settings).catch(() => {});
  const to = resumeTo;
  if (to === "idle") {
    state = "idle";
    return;
  }
  activeSince = performance.now() - bankedMs;
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
  const data = { schemaVersion: SCHEMA_VERSION, attempts };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
  const [history, saved] = await Promise.all([loadHistory(store), store.loadSettings()]);
  attempts = history.attempts;
  settings = { ...DEFAULTS, ...saved };
  level = T.currentLevel(attempts);

  // Continue an unfinished lesson from a recent sitting; otherwise start a new one.
  const past = S.lessons(S.normalize(attempts));
  const lastLesson = past[past.length - 1];
  if (lastLesson) {
    const recent = Date.now() - Date.parse(lastLesson.end) < S.NEW_SITTING_MS;
    if (!lastLesson.complete && recent) {
      lessonId = lastLesson.id;
      lessonMs = lastLesson.activeMs;
    } else lessonId = lastLesson.id + 1;
  }

  renderReadout();
  renderLamps();
  renderSession();
  renderProgress();
  ui.storage.textContent = store.kind === "server"
    ? "History is saved by the local server."
    : "History is saved in this browser.";
  if (history.applied.length) {
    ui.storage.textContent += ` It was upgraded to format ${SCHEMA_VERSION}; a backup of the previous version was kept.`;
  }
  if (history.newer) {
    ui.storage.textContent = "This history was saved by a newer version of sparkgap. Update this copy before practising.";
  }

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
