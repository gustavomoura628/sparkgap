// Profile page: statistics over the whole practice history.

import { CODE, KOCH_ORDER } from "./morse.js";
import { openStore } from "./storage.js";
import * as S from "./stats.js";
import * as T from "./trainer.js";
import * as C from "./charts.js";
import { loadHistory } from "./migrations.js";

const $ = (id) => document.getElementById(id);
const DEFAULTS = { targetRtMs: T.RULES.targetRtMs, dailyGoalMin: 15 };

let settings;
let rules;
let colors;

// Formatting -----------------------------------------------------------------

const ms = (v) => (v == null ? "–" : `${Math.round(Math.max(0, v))} ms`);
const pct = (v) => (v == null ? "–" : `${Math.round(v * 1000) / 10}%`);
const wpm = (v) => (v == null ? "–" : `${v.toFixed(1)} wpm`);

function hms(totalMs) {
  const s = Math.floor(totalMs / 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

const when = (t) => new Date(t).toLocaleString(undefined, {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

function el(tag, attrs = {}, text = null) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function emptyNote(container, text) {
  container.replaceChildren(el("p", { class: "empty" }, text));
}

const NEED_LESSON = `Finish a ${S.LESSON_SIZE}-answer lesson to fill this chart.`;

// Tiles ----------------------------------------------------------------------

function tiles(container, t) {
  const items = [
    ["Time practised", hms(t.timeMs)],
    ["Lessons", t.lessons.toLocaleString()],
    ["Best reaction", ms(t.bestRt), t.topCopy != null ? `top copy speed ${wpm(t.topCopy)}` : null],
    ["Average reaction", ms(t.avgRt), t.avgCopy != null ? `average copy speed ${wpm(t.avgCopy)}` : null],
    ["Top accuracy", pct(t.topAcc)],
    ["Average accuracy", pct(t.avgAcc)],
  ];
  container.replaceChildren(...items.map(([label, value, note]) => {
    const div = el("div", { class: "tile" });
    div.append(el("dt", {}, label), el("dd", {}, value));
    if (note) div.append(el("dd", { class: "note" }, note));
    return div;
  }));
}

// Music ----------------------------------------------------------------------

const MIN_MATCHED = 30; // matched answers needed before showing a difference

function musicEffect(container, normalized) {
  const e = S.flagEffect(normalized, "music");
  if (!e.on.n || !e.off.n) {
    return emptyNote(container, e.on.n + e.off.n
      ? `So far every recorded answer was ${e.on.n ? "with" : "without"} music. Practise both ways to compare.`
      : "Turn on the Music switch on the practice page while listening to music. Answers record it from then on.");
  }
  const signed = (v, unit, digits = 0) =>
    `${v > 0 ? "+" : v < 0 ? "\u2212" : "\u00b1"}${Math.abs(v).toFixed(digits)}${unit}`;
  const side = (label, s) => [label, ms(s.medianRt), `${pct(s.acc)} accuracy, ${s.n.toLocaleString()} answers`];
  const enough = e.matched >= MIN_MATCHED;
  const items = [
    side("Without music", e.off),
    side("With music", e.on),
    ["Reaction with music", enough && e.rtDiff != null ? signed(e.rtDiff, " ms") : "\u2013",
      !enough ? `needs ${MIN_MATCHED} matched answers, ${e.matched} so far`
        : e.rtDiff == null ? null : e.rtDiff > 0 ? "slower" : e.rtDiff < 0 ? "faster" : "no difference"],
    ["Accuracy with music", enough ? signed(e.accDiff * 100, " pts", 1) : "\u2013",
      enough ? `over ${e.matched} matched answers` : null],
  ];
  container.replaceChildren(...items.map(([label, value, note]) => {
    const div = el("div", { class: "tile" });
    div.append(el("dt", {}, label), el("dd", {}, value));
    if (note) div.append(el("dd", { class: "note" }, note));
    return div;
  }));
}

// Streaks --------------------------------------------------------------------

function streakList(container, complete) {
  const list = el("dl", { class: "streak-list" });
  for (const s of S.streaks(complete)) {
    list.append(el("dt", {}, `${Math.round(s.threshold * 100)}% accuracy`));
    list.append(el("dd", {}, s.lessons
      ? `${s.lessons} ${s.lessons === 1 ? "lesson" : "lessons"}, ${s.chars.toLocaleString()} characters, ` +
        `best reaction ${ms(s.bestRt)}, average ${ms(s.avgRt)}, starting ${when(s.start)}`
      : "No lesson at this accuracy yet."));
  }
  container.replaceChildren(list);
}

// Learning progress overview --------------------------------------------------

function overview(container, complete) {
  if (!complete.length) return emptyNote(container, NEED_LESSON);
  const maxLevel = Math.max(...complete.map((l) => l.level));
  const chars = KOCH_ORDER.slice(0, maxLevel);
  const amber = C.ramp(colors.lampOff, colors.amber);
  const grid = C.heatGrid({
    rows: chars,
    cols: complete.length,
    label: "Learning progress: speed of each character in each lesson",
    cell: (r, c) => {
      const v = complete[c].perChar.get(chars[r]);
      if (!v) return null;
      const title = `${chars[r]}, lesson ${c + 1}`;
      const rows = [
        { value: `${v.correct} of ${v.n}`, label: "correct" },
        { value: ms(v.medianRt), label: "median reaction" },
      ];
      if (v.medianRt == null) return { color: colors.miss, title, rows };
      return { color: amber(0.15 + 0.85 * T.speedScore(v.medianRt, rules)), title, rows };
    },
  });
  const table = C.tableView(
    ["Character", "First lesson", "Lessons practised", "Latest median reaction"],
    chars.map((ch) => {
      const seen = complete.map((l, i) => [i, l.perChar.get(ch)]).filter(([, v]) => v);
      const last = [...seen].reverse().find(([, v]) => v.medianRt != null);
      return [ch, seen.length ? seen[0][0] + 1 : "", seen.length, last ? ms(last[1].medianRt) : ""];
    }),
  );
  container.replaceChildren(grid, scaleLegend(amber), table);
}

function scaleLegend(rampFn) {
  const wrap = el("div", { class: "scale-legend" });
  const bar = el("span", { class: "scale-bar" });
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `${rampFn(0.15 + 0.85 * t)} ${t * 100}%`);
  bar.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  wrap.append(el("span", {}, "Slow"), bar, el("span", {}, `At target (${settings.targetRtMs} ms)`));
  const miss = el("span", { class: "swatch" });
  miss.style.background = colors.miss;
  wrap.append(miss, el("span", {}, "All wrong"));
  return wrap;
}

// Trends ----------------------------------------------------------------------

function slider(onInput, initial = 0.35) {
  const wrap = el("label", { class: "controls" });
  const input = el("input", { type: "range", min: "0", max: "1", step: "0.05" });
  input.value = initial;
  input.addEventListener("input", () => onInput(Number(input.value)));
  wrap.append(el("span", {}, "Smoothness"), input);
  return wrap;
}

function trends(container, complete) {
  if (!complete.length) return emptyNote(container, NEED_LESSON);
  const charts = el("div", { class: "multiples" });
  const draw = (smoothness) => {
    const rt = complete.map((l, i) => ({ x: i + 1, y: l.medianRt })).filter((p) => p.y != null);
    const acc = complete.map((l, i) => ({ x: i + 1, y: l.acc * 100 }));
    const lvl = complete.map((l, i) => ({ x: i + 1, y: l.level }));
    const panel = (title, chart) => {
      const f = el("figure", { class: "multiple" });
      f.append(el("figcaption", {}, title), chart);
      return f;
    };
    charts.replaceChildren(
      panel("Median reaction time (ms)", C.lineChart({
        points: rt, smoothness, color: colors.amber, trend: true, yName: "median reaction",
        yFormat: (v) => `${Math.round(v)}`, label: "Median reaction time per lesson",
        reference: { value: settings.targetRtMs, label: "target" },
      })),
      panel("Accuracy (%)", C.lineChart({
        points: acc, smoothness, color: colors.hit, yName: "accuracy", height: 140,
        yFormat: (v) => `${Math.round(v * 10) / 10}`, yDomain: [null, 100], label: "Accuracy per lesson",
      })),
      panel("Characters unlocked", C.lineChart({
        points: lvl, smoothness: 0, color: colors.bone, yName: "characters", height: 120,
        yFormat: (v) => `${Math.round(v)}`, label: "Characters unlocked per lesson",
      })),
    );
  };
  draw(0.35);
  const table = C.tableView(
    ["Lesson", "Date", "Median reaction", "Accuracy", "Copy speed", "Characters", "Score"],
    complete.map((l, i) => [i + 1, when(l.end), ms(l.medianRt), pct(l.acc), wpm(l.copyWpm), l.level, l.score]),
  );
  container.replaceChildren(slider(draw), charts, table);
}

// Per character ---------------------------------------------------------------

function perChar(container, complete, normalized) {
  if (!complete.length) return emptyNote(container, NEED_LESSON);
  const maxLevel = Math.max(...complete.map((l) => l.level));
  const chars = KOCH_ORDER.slice(0, maxLevel);
  let selected = chars[0];
  let smoothness = 0.35;

  const picker = el("div", { class: "char-picker", role: "group", "aria-label": "Character" });
  const summary = el("p", { class: "char-summary" });
  const chartBox = el("div");
  const tableBox = el("div");

  const buttons = chars.map((ch) => {
    const b = el("button", { type: "button", class: "lamp small", "aria-pressed": "false" }, ch);
    const m = T.mastery(T.charStats(normalized, ch), rules);
    b.dataset.state = "active";
    b.style.setProperty("--m", m.toFixed(3));
    b.addEventListener("click", () => {
      selected = ch;
      draw();
    });
    return b;
  });
  picker.append(...buttons);

  const draw = () => {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === selected)));
    const series = S.charSeries(complete, selected);
    const fit = S.linearFit(series);
    const best = series.length ? Math.min(...series.map((p) => p.y)) : null;
    const last = series.length ? series[series.length - 1].y : null;
    summary.replaceChildren(
      el("span", {}, `Last ${ms(last)}`),
      el("span", {}, `Best ${ms(best)}`),
      el("span", {}, fit
        ? `Learning rate ${fit.slope <= 0 ? "−" : "+"}${Math.abs(fit.slope).toFixed(1)} ms per lesson` +
          (fit.slope < 0 ? " (getting faster)" : fit.slope > 0 ? " (getting slower)" : "")
        : "Learning rate needs two lessons"),
    );
    if (!series.length) {
      chartBox.replaceChildren(el("p", { class: "empty" }, `No correct answers for ${selected} in a complete lesson yet.`));
      tableBox.replaceChildren();
      return;
    }
    chartBox.replaceChildren(C.lineChart({
      points: series, smoothness, color: colors.amber, trend: true, yName: "median reaction",
      yFormat: (v) => `${Math.round(v)} ms`, label: `Reaction time for ${selected} per lesson`,
      reference: { value: settings.targetRtMs, label: "target" },
    }));
    tableBox.replaceChildren(C.tableView(
      ["Lesson", "Median reaction", "Correct"],
      series.map((p) => [p.x, ms(p.y), `${p.correct} of ${p.n}`]),
    ));
  };
  draw();
  container.replaceChildren(picker, summary, slider((v) => { smoothness = v; draw(); }), chartBox, tableBox);
}

// Per-character bars ----------------------------------------------------------

function charsWithData(totals) {
  return KOCH_ORDER.filter((c) => totals.has(c));
}

function charAverages(container, totals) {
  const chars = charsWithData(totals).filter((c) => totals.get(c).medianRt != null);
  if (!chars.length) return emptyNote(container, "No correct answers yet.");
  const values = chars.map((c) => Math.max(0, totals.get(c).medianRt));
  container.replaceChildren(
    C.barChart({
      cats: chars, values, color: colors.amber, yFormat: (v) => `${Math.round(v)}`,
      label: "Median reaction time per character",
      tipTitle: (i) => chars[i],
      tipRows: (i) => [{ value: ms(values[i]), label: "median reaction" }],
    }),
    C.tableView(["Character", "Median reaction"], chars.map((c, i) => [c, ms(values[i])])),
  );
}

function hitsAndMisses(container, totals) {
  const chars = charsWithData(totals);
  if (!chars.length) return emptyNote(container, "No answers yet.");
  const get = (k) => chars.map((c) => totals.get(c)[k]);
  const hits = get("hits");
  const misses = get("misses");
  const ratio = get("missRatio").map((v) => v * 100);
  const rowsFor = (i) => [
    { value: hits[i].toLocaleString(), label: "hits" },
    { value: misses[i].toLocaleString(), label: "misses" },
    { value: `${ratio[i].toFixed(1)}%`, label: "miss rate" },
  ];
  const panel = (title, values, color, fmt) => {
    const f = el("figure", { class: "multiple" });
    f.append(el("figcaption", {}, title), C.barChart({
      cats: chars, values, color, height: 130, yFormat: fmt, label: title,
      tipTitle: (i) => chars[i], tipRows: rowsFor,
    }));
    return f;
  };
  container.replaceChildren(
    panel("Hits", hits, colors.hit, (v) => `${Math.round(v)}`),
    panel("Misses", misses, colors.miss, (v) => `${Math.round(v)}`),
    panel("Miss rate (%)", ratio, colors.miss, (v) => `${Math.round(v)}`),
    C.tableView(["Character", "Hits", "Misses", "Miss rate"],
      chars.map((c, i) => [c, hits[i], misses[i], `${ratio[i].toFixed(1)}%`])),
  );
}

// Morse tree ------------------------------------------------------------------

function buildTree() {
  // Nodes are code prefixes; a node is a character if its code is in the table.
  const byCode = new Map(Object.entries(CODE).map(([ch, code]) => [code, ch]));
  const codes = new Set([""]);
  for (const code of byCode.keys()) for (let i = 1; i <= code.length; i++) codes.add(code.slice(0, i));
  const node = (code) => ({
    code,
    char: byCode.get(code) || null,
    kids: [".", "-"].map((e) => code + e).filter((c) => codes.has(c)).map(node),
  });
  return node("");
}

function morseTree(container, normalized, totals) {
  const root = buildTree();
  const W = C.WIDTH;
  const levelH = 64;
  const H = 30 + 6 * levelH + 20;
  let mode = "speed";

  // Leaves spread evenly; parents sit above the middle of their children.
  const leaves = [];
  const collect = (n, depth) => {
    n.depth = depth;
    if (!n.kids.length) leaves.push(n);
    n.kids.forEach((k) => collect(k, depth + 1));
  };
  collect(root, 0);
  const step = (W - 40) / Math.max(leaves.length - 1, 1);
  leaves.forEach((n, i) => { n.x = 20 + i * step; });
  const place = (n) => {
    if (n.kids.length) {
      n.kids.forEach(place);
      n.x = (n.kids[0].x + n.kids[n.kids.length - 1].x) / 2;
    }
    n.y = 24 + n.depth * levelH;
  };
  place(root);

  const amber = C.ramp(colors.lampOff, colors.amber);
  const red = C.ramp(colors.lampOff, colors.miss);
  const box = el("div");

  const draw = () => {
    const svgRoot = C.svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart tree", role: "img",
      "aria-label": "Morse tree shaded by " + (mode === "speed" ? "reaction time" : "miss rate") });
    const edges = C.svg("g", { class: "tree-edges" }, svgRoot);
    const nodes = C.svg("g", {}, svgRoot);
    const visit = (n) => {
      for (const k of n.kids) {
        C.svg("line", { x1: n.x, y1: n.y, x2: k.x, y2: k.y }, edges);
        visit(k);
      }
      if (!n.char) {
        C.svg("circle", { cx: n.x, cy: n.y, r: n.code === "" ? 5 : 3, class: "tree-stub" }, nodes);
        return;
      }
      const t = totals.get(n.char);
      const recent = T.charStats(normalized, n.char);
      let fill = null;
      if (t && mode === "speed" && recent.medianRt != null) fill = amber(0.15 + 0.85 * T.speedScore(recent.medianRt, rules));
      if (t && mode === "miss") fill = red(0.1 + 0.9 * t.missRatio);
      const g = C.svg("g", { class: "tree-node" }, nodes);
      C.svg("circle", { cx: n.x, cy: n.y, r: 11, fill: fill || "none", class: fill ? "" : "tree-empty" }, g);
      const text = C.svg("text", { x: n.x, y: n.y, "text-anchor": "middle", "dominant-baseline": "central",
        class: "tree-label" }, g);
      text.textContent = n.char;
      if (fill && (mode === "speed" ? T.speedScore(recent.medianRt, rules) > 0.6 : false)) text.classList.add("on-light");
      C.svg("circle", { cx: n.x, cy: n.y, r: 16, fill: "transparent" }, g);
      const rows = t
        ? [
          { value: ms(recent.medianRt), label: "recent median reaction" },
          { value: `${(t.missRatio * 100).toFixed(1)}%`, label: "miss rate" },
          { value: (t.hits + t.misses).toLocaleString(), label: "answers" },
        ]
        : [{ value: "No answers yet", label: "" }];
      const title = `${n.char}  ${n.code.replace(/\./g, "·").replace(/-/g, "–")}`;
      g.addEventListener("pointermove", (ev) => C.showTip(ev.clientX, ev.clientY, title, rows));
      g.addEventListener("pointerleave", C.hideTip);
    };
    visit(root);
    box.replaceChildren(svgRoot);
  };

  const toggle = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Shade by" });
  for (const [value, text] of [["speed", "Reaction time"], ["miss", "Miss rate"]]) {
    const b = el("button", { type: "button", role: "radio", "aria-checked": String(value === mode) }, text);
    b.addEventListener("click", () => {
      mode = value;
      toggle.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      draw();
    });
    toggle.append(b);
  }
  draw();
  const chars = KOCH_ORDER.filter((c) => totals.has(c));
  container.replaceChildren(toggle, box, C.tableView(
    ["Character", "Code", "Recent median reaction", "Miss rate"],
    chars.map((c) => [c, CODE[c], ms(T.charStats(normalized, c).medianRt), `${(totals.get(c).missRatio * 100).toFixed(1)}%`]),
  ));
}

// Confusion matrix --------------------------------------------------------------

function confusionMatrix(container, normalized) {
  const pairs = S.confusion(normalized);
  if (!pairs.length) return emptyNote(container, "No wrong answers yet.");
  const involved = new Set(pairs.flatMap((p) => [p.played, p.typed]));
  const chars = KOCH_ORDER.filter((c) => involved.has(c));
  const count = new Map(pairs.map((p) => [`${p.played}>${p.typed}`, p.n]));
  const max = Math.max(...pairs.map((p) => p.n));
  const red = C.ramp(colors.lampOff, colors.miss);
  const grid = C.heatGrid({
    rows: chars, cols: chars.length, square: true, rowHeight: 28, background: colors.lampOff,
    colLabel: (c) => chars[c], label: "Confusion matrix of wrong answers",
    cell: (r, c) => {
      const n = count.get(`${chars[r]}>${chars[c]}`);
      if (!n) return null;
      return {
        color: red(0.25 + 0.75 * (n / max)),
        title: `Played ${chars[r]}, typed ${chars[c]}`,
        rows: [{ value: `${n}`, label: n === 1 ? "time" : "times" }],
      };
    },
  });
  const sorted = [...pairs].sort((a, b) => b.n - a.n);
  container.replaceChildren(grid, C.tableView(["Played", "Typed", "Times"], sorted.map((p) => [p.played, p.typed, p.n])));
}

// Calendar ----------------------------------------------------------------------

function calendar(container, normalized) {
  $("calendar-sub").textContent =
    `Days with practice, shaded by how much of the ${settings.dailyGoalMin}-minute daily goal was met.`;
  const days = S.dailyActive(normalized);
  const goal = settings.dailyGoalMin * 60_000;
  const months = new Set([...days.keys()].map((k) => k.slice(0, 7)));
  months.add(S.dayKey(Date.now()).slice(0, 7));
  const amber = C.ramp(colors.lampOff, colors.amber);
  const step = (f) => (f >= 1 ? 4 : f >= 0.75 ? 3 : f >= 0.5 ? 2 : f >= 0.25 ? 1 : f > 0 ? 0.4 : 0);
  const fillFor = (s) => (s === 0 ? null : amber(s / 4));

  const wrap = el("div", { class: "calendar" });
  for (const key of [...months].sort()) {
    const [y, m] = key.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const daysIn = new Date(y, m, 0).getDate();
    const offset = (first.getDay() + 6) % 7; // Monday first
    const table = el("table", { class: "month" });
    table.createCaption().textContent = first.toLocaleString(undefined, { month: "long", year: "numeric" });
    const head = table.createTHead().insertRow();
    for (const d of ["M", "T", "W", "T", "F", "S", "S"]) head.append(el("th", { scope: "col" }, d));
    const body = table.createTBody();
    let row = body.insertRow();
    for (let i = 0; i < offset; i++) row.insertCell();
    for (let d = 1; d <= daysIn; d++) {
      if (row.cells.length === 7) row = body.insertRow();
      const k = `${key}-${String(d).padStart(2, "0")}`;
      const active = days.get(k) || 0;
      const cell = row.insertCell();
      cell.textContent = d;
      const fill = fillFor(step(active / goal));
      if (fill) {
        cell.style.background = fill;
        cell.classList.add(active >= goal * 0.75 ? "on-light" : "on-dark");
      }
      if (k === S.dayKey(Date.now())) cell.classList.add("today");
      cell.title = `${Math.round(active / 60_000)} of ${settings.dailyGoalMin} min`;
    }
    wrap.append(table);
  }
  const legend = el("div", { class: "scale-legend" });
  legend.append(el("span", {}, "Daily goal"));
  for (const [s, label] of [[4, "100%"], [3, "75%"], [2, "50%"], [1, "25%"], [0, "0%"]]) {
    const sw = el("span", { class: "swatch" });
    sw.style.background = fillFor(s) || colors.lampOff;
    legend.append(sw, el("span", {}, label));
  }
  container.replaceChildren(wrap, legend);
}

// Boot ------------------------------------------------------------------------

async function boot() {
  colors = {
    amber: C.cssVar("--amber"),
    hit: C.cssVar("--hit"),
    miss: C.cssVar("--miss"),
    bone: C.cssVar("--bone-dim"),
    lampOff: C.cssVar("--lamp-off"),
  };
  const store = await openStore();
  const [history, saved] = await Promise.all([loadHistory(store), store.loadSettings()]);
  settings = { ...DEFAULTS, ...saved };
  rules = { ...T.RULES, targetRtMs: settings.targetRtMs };

  const normalized = S.normalize(history.attempts);
  if (!normalized.length) {
    $("empty").hidden = false;
    for (const s of document.querySelectorAll(".card")) s.hidden = true;
    return;
  }
  const all = S.lessons(normalized);
  const complete = all.filter((l) => l.complete);
  const days = S.dailyActive(normalized);
  const totalMs = [...days.values()].reduce((a, b) => a + b, 0);
  const today = S.dayKey(Date.now());
  const completeToday = complete.filter((l) => S.dayKey(l.end) === today);
  const totals = S.charTotals(normalized);

  tiles($("tiles-all"), S.totals(complete, totalMs));
  tiles($("tiles-today"), S.totals(completeToday, days.get(today) || 0));
  musicEffect($("music"), normalized);
  streakList($("streaks"), complete);
  overview($("overview"), complete);
  trends($("trends"), complete);
  perChar($("per-char"), complete, normalized);
  charAverages($("char-avg"), totals);
  hitsAndMisses($("hits"), totals);
  morseTree($("tree"), normalized, totals);
  confusionMatrix($("confusion"), normalized);
  calendar($("calendar"), normalized);
}

boot();
