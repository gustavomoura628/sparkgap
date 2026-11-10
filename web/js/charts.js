// Small SVG chart toolkit: line, bar and heat-grid charts with a shared
// tooltip, keyboard access (focus a chart, then use the arrow keys), and a
// table view for every chart.

import { linearFit, smooth } from "./stats.js";

const NS = "http://www.w3.org/2000/svg";
export const WIDTH = 880;

export function svg(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Colour ramps, interpolated in OKLab so steps look even ------------------------

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklab(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return "#" + rgb
    .map((c) => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255).toString(16).padStart(2, "0"))
    .join("");
}

/** Returns t (0..1) -> hex, interpolating between two colours. */
export function ramp(from, to) {
  const a = hexToOklab(from);
  const b = hexToOklab(to);
  return (t) => {
    const u = Math.min(1, Math.max(0, t));
    return oklabToHex(a.map((v, i) => v + (b[i] - v) * u));
  };
}

// Tooltip ---------------------------------------------------------------------

let tipEl = null;

/**
 * Show the shared tooltip. `title` is a string; `rows` are { value, label, key }
 * where key is an optional colour for a short line key.
 */
export function showTip(x, y, title, rows = []) {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.setAttribute("role", "status");
    document.body.appendChild(tipEl);
  }
  const head = document.createElement("p");
  head.className = "tip-title";
  head.textContent = title;
  const lines = rows.map((r) => {
    const row = document.createElement("p");
    if (r.key) {
      const k = document.createElement("span");
      k.className = "tip-key";
      k.style.background = r.key;
      row.appendChild(k);
    }
    const v = document.createElement("strong");
    v.textContent = r.value;
    row.appendChild(v);
    if (r.label) row.appendChild(document.createTextNode(` ${r.label}`));
    return row;
  });
  tipEl.replaceChildren(head, ...lines);
  tipEl.hidden = false;
  const pad = 14;
  const { width, height } = tipEl.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + width > window.innerWidth - 8) left = x - width - pad;
  if (top + height > window.innerHeight - 8) top = y - height - pad;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

// Scales and ticks ------------------------------------------------------------

export const scale = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

export function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function integerTicks(min, max, count = 6) {
  if (max <= min) return [min];
  const step = Math.max(1, Math.ceil((max - min) / count));
  const ticks = [];
  for (let v = min; v <= max; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

/** Keyboard cursor: arrow keys move an index, and the caller shows it. */
function keyboardCursor(el, count, onMove, onLeave) {
  let i = -1;
  el.setAttribute("tabindex", "0");
  el.addEventListener("keydown", (e) => {
    if (!count) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      i = i < 0 ? 0 : Math.min(count - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)));
      onMove(i, true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      i = e.key === "Home" ? 0 : count - 1;
      onMove(i, true);
    }
  });
  el.addEventListener("blur", () => {
    i = -1;
    onLeave();
  });
}

function screenPoint(svgEl, x, y) {
  const r = svgEl.getBoundingClientRect();
  const vb = svgEl.viewBox.baseVal;
  return [r.left + (x / vb.width) * r.width, r.top + (y / vb.height) * r.height];
}

// Line chart ------------------------------------------------------------------

/**
 * points: [{ x, y }] raw values. Draws faint raw dots, a smoothed line, an
 * optional trend line and an optional reference line (e.g. a target).
 */
export function lineChart({
  points, smoothness = 0.35, color, height = 180, yFormat = String, xName = "Lesson",
  yName, trend = false, reference = null, yDomain = null, label,
}) {
  const H = height;
  const m = { l: 56, r: 64, t: 12, b: 28 };
  const root = svg("svg", { viewBox: `0 0 ${WIDTH} ${H}`, class: "chart", role: "img", "aria-label": label });
  if (!points.length) return root;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const sm = smooth(ys, smoothness, xs);
  const fit = trend ? linearFit(points) : null;

  let lo = Math.min(...ys, ...(reference ? [reference.value] : []));
  let hi = Math.max(...ys, ...(reference ? [reference.value] : []));
  if (yDomain) [lo, hi] = [yDomain[0] ?? lo, yDomain[1] ?? hi];
  const ticks = niceTicks(lo, hi, 4);
  const y = scale(ticks[0], ticks[ticks.length - 1], H - m.b, m.t);
  const x = scale(Math.min(...xs), Math.max(...xs), m.l, WIDTH - m.r);

  const grid = svg("g", { class: "grid" }, root);
  for (const t of ticks) {
    svg("line", { x1: m.l, x2: WIDTH - m.r, y1: y(t), y2: y(t) }, grid);
    svg("text", { x: m.l - 8, y: y(t), class: "tick", "text-anchor": "end", "dominant-baseline": "middle" }, grid)
      .textContent = yFormat(t);
  }
  for (const t of integerTicks(Math.min(...xs), Math.max(...xs))) {
    svg("text", { x: x(t), y: H - 8, class: "tick", "text-anchor": "middle" }, grid).textContent = t;
  }

  if (reference) {
    svg("line", { x1: m.l, x2: WIDTH - m.r, y1: y(reference.value), y2: y(reference.value), class: "reference" }, root);
    svg("text", { x: WIDTH - m.r + 6, y: y(reference.value), class: "tick", "dominant-baseline": "middle" }, root)
      .textContent = reference.label;
  }

  const dots = svg("g", { fill: color, opacity: smoothness > 0 ? 0.3 : 0.9 }, root);
  points.forEach((p) => svg("circle", { cx: x(p.x), cy: y(p.y), r: smoothness > 0 ? 2.5 : 3.5 }, dots));

  if (smoothness > 0 && points.length > 1) {
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(sm[i]).toFixed(1)}`).join("");
    svg("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, root);
  }

  if (fit) {
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    svg("line", {
      x1: x(x0), x2: x(x1), y1: y(fit.intercept + fit.slope * x0), y2: y(fit.intercept + fit.slope * x1),
      class: "trend",
    }, root);
  }

  // Hover layer: a crosshair that snaps to the nearest lesson.
  const cross = svg("line", { y1: m.t, y2: H - m.b, class: "crosshair", visibility: "hidden" }, root);
  const marker = svg("circle", { r: 4.5, fill: color, class: "marker", visibility: "hidden" }, root);
  const show = (i, fromKeyboard, ev) => {
    const px = x(points[i].x);
    const py = y(smoothness > 0 ? sm[i] : ys[i]);
    cross.setAttribute("x1", px);
    cross.setAttribute("x2", px);
    marker.setAttribute("cx", px);
    marker.setAttribute("cy", py);
    cross.setAttribute("visibility", "visible");
    marker.setAttribute("visibility", "visible");
    const rows = [{ value: yFormat(ys[i]), label: yName, key: color }];
    if (smoothness > 0) rows.push({ value: yFormat(sm[i]), label: "smoothed" });
    const [sx, sy] = fromKeyboard ? screenPoint(root, px, py) : [ev.clientX, ev.clientY];
    showTip(sx, sy, `${xName} ${points[i].x}`, rows);
  };
  const hide = () => {
    cross.setAttribute("visibility", "hidden");
    marker.setAttribute("visibility", "hidden");
    hideTip();
  };
  const hit = svg("rect", { x: m.l, y: m.t, width: WIDTH - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, root);
  hit.addEventListener("pointermove", (ev) => {
    const r = root.getBoundingClientRect();
    const vx = ((ev.clientX - r.left) / r.width) * WIDTH;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(x(points[i].x) - vx) < Math.abs(x(points[best].x) - vx)) best = i;
    }
    show(best, false, ev);
  });
  hit.addEventListener("pointerleave", hide);
  keyboardCursor(root, points.length, (i) => show(i, true), hide);
  return root;
}

// Bar chart -------------------------------------------------------------------

/** One bar per category, grown from a zero baseline. */
export function barChart({ cats, values, color, height = 170, yFormat = String, label, tipTitle, tipRows }) {
  const H = height;
  const m = { l: 56, r: 16, t: 12, b: 28 };
  const root = svg("svg", { viewBox: `0 0 ${WIDTH} ${H}`, class: "chart", role: "img", "aria-label": label });
  if (!cats.length) return root;

  const max = Math.max(...values.filter(Number.isFinite), 0);
  const ticks = niceTicks(0, max || 1, 3);
  const y = scale(0, ticks[ticks.length - 1], H - m.b, m.t);
  const band = (WIDTH - m.l - m.r) / cats.length;
  const bw = Math.min(24, band * 0.62);

  const grid = svg("g", { class: "grid" }, root);
  for (const t of ticks) {
    svg("line", { x1: m.l, x2: WIDTH - m.r, y1: y(t), y2: y(t) }, grid);
    svg("text", { x: m.l - 8, y: y(t), class: "tick", "text-anchor": "end", "dominant-baseline": "middle" }, grid)
      .textContent = yFormat(t);
  }

  const bars = [];
  cats.forEach((c, i) => {
    const cx = m.l + band * (i + 0.5);
    svg("text", { x: cx, y: H - 8, class: "tick cat", "text-anchor": "middle" }, root).textContent = c;
    const v = values[i];
    if (Number.isFinite(v) && v > 0) {
      const top = y(v);
      const base = y(0);
      const r = Math.min(4, (base - top) / 2, bw / 2);
      const x0 = cx - bw / 2;
      const d = `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z`;
      bars[i] = svg("path", { d, fill: color, class: "bar" }, root);
    }
  });

  const show = (i, fromKeyboard, ev) => {
    bars.forEach((b, j) => b && b.classList.toggle("active", j === i));
    const cx = m.l + band * (i + 0.5);
    const [sx, sy] = fromKeyboard ? screenPoint(root, cx, y(values[i] || 0)) : [ev.clientX, ev.clientY];
    showTip(sx, sy, tipTitle(i), tipRows(i));
  };
  const hide = () => {
    bars.forEach((b) => b && b.classList.remove("active"));
    hideTip();
  };
  cats.forEach((c, i) => {
    const hit = svg("rect", { x: m.l + band * i, y: m.t, width: band, height: H - m.t - m.b, fill: "transparent" }, root);
    hit.addEventListener("pointermove", (ev) => show(i, false, ev));
    hit.addEventListener("pointerleave", hide);
  });
  keyboardCursor(root, cats.length, (i) => show(i, true), hide);
  return root;
}

// Heat grid -------------------------------------------------------------------

/**
 * rows: labels; cols: number of columns; cell(r, c) -> { color, title, rows } or null.
 * One pointer listener resolves the hovered cell, so large grids stay cheap.
 */
export function heatGrid({
  rows, cols, cell, rowHeight = 16, label, colLabel = (c) => c + 1, square = false, background = null,
}) {
  const m = { l: 40, r: 16, t: 8, b: 26 };
  const cw = square ? rowHeight : (WIDTH - m.l - m.r) / Math.max(cols, 1);
  const W = square ? m.l + cw * cols + m.r : WIDTH;
  const H = m.t + rows.length * rowHeight + m.b;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": label });
  if (square) root.style.maxWidth = `${W}px`;

  const gap = cw > 4 ? 1 : 0;
  const cells = [];
  rows.forEach((name, r) => {
    svg("text", { x: m.l - 8, y: m.t + r * rowHeight + rowHeight / 2, class: "tick cat", "text-anchor": "end", "dominant-baseline": "middle" }, root)
      .textContent = name;
    for (let c = 0; c < cols; c++) {
      const v = cell(r, c);
      if (!v) {
        if (background) {
          svg("rect", {
            x: m.l + c * cw + 1, y: m.t + r * rowHeight + 1, width: cw - 2, height: rowHeight - 2,
            fill: background, rx: 2,
          }, root);
        }
        continue;
      }
      svg("rect", {
        x: m.l + c * cw + gap / 2, y: m.t + r * rowHeight + 1,
        width: Math.max(cw - gap, 0.6), height: rowHeight - 2, fill: v.color, rx: square ? 2 : 0,
      }, root);
      cells.push({ r, c, v });
    }
  });
  const ticks = square ? [...Array(cols).keys()] : integerTicks(0, cols - 1, 6);
  for (const c of ticks) {
    svg("text", { x: m.l + c * cw + cw / 2, y: H - 8, class: "tick cat", "text-anchor": "middle" }, root).textContent = colLabel(c);
  }

  const outline = svg("rect", { class: "cell-outline", visibility: "hidden", fill: "none" }, root);
  const showCell = (r, c, sx, sy) => {
    const v = cell(r, c);
    if (!v) return hide();
    outline.setAttribute("x", m.l + c * cw);
    outline.setAttribute("y", m.t + r * rowHeight);
    outline.setAttribute("width", Math.max(cw, 2));
    outline.setAttribute("height", rowHeight);
    outline.setAttribute("visibility", "visible");
    showTip(sx, sy, v.title, v.rows);
  };
  const hide = () => {
    outline.setAttribute("visibility", "hidden");
    hideTip();
  };
  root.addEventListener("pointermove", (ev) => {
    const b = root.getBoundingClientRect();
    const vx = ((ev.clientX - b.left) / b.width) * W;
    const vy = ((ev.clientY - b.top) / b.height) * H;
    const c = Math.floor((vx - m.l) / cw);
    const r = Math.floor((vy - m.t) / rowHeight);
    if (r < 0 || r >= rows.length || c < 0 || c >= cols) return hide();
    showCell(r, c, ev.clientX, ev.clientY);
  });
  root.addEventListener("pointerleave", hide);
  keyboardCursor(root, cells.length, (i) => {
    const { r, c } = cells[i];
    const [sx, sy] = screenPoint(root, m.l + c * cw + cw / 2, m.t + r * rowHeight + rowHeight / 2);
    showCell(r, c, sx, sy);
  }, hide);
  return root;
}

// Table view ------------------------------------------------------------------

/** A collapsed data table: the accessible, tooltip-free view of a chart. */
export function tableView(columns, rows, summary = "Show as table") {
  const details = document.createElement("details");
  details.className = "table-view";
  const s = document.createElement("summary");
  s.textContent = summary;
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const c of columns) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const v of r) tr.insertCell().textContent = v ?? "";
  }
  details.append(s, table);
  return details;
}
