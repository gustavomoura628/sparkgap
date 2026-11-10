import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS, SCHEMA_VERSION, migrate, loadHistory } from "../web/js/migrations.js";
import { lessons, normalize } from "../web/js/stats.js";

const T0 = Date.parse("2026-01-05T10:00:00Z");
const v1 = (i) => ({
  t: new Date(T0 + i * 1500).toISOString(), char: "K", answer: "K", correct: true,
  rtMs: 300, level: 2, wpm: 20,
});

function memoryStore(attempts, meta) {
  return {
    attempts, meta, replaced: null,
    async loadAttempts() { return this.attempts; },
    async loadMeta() { return this.meta; },
    async saveMeta(m) { this.meta = m; },
    async replaceAttempts(a, { from, to }) { this.replaced = { from, to }; this.attempts = a; this.meta = { schemaVersion: to }; },
  };
}

test("migrations are numbered in order and the last one is the current version", () => {
  MIGRATIONS.forEach((m, i) => assert.equal(m.version, i + 2));
  assert.equal(SCHEMA_VERSION, MIGRATIONS[MIGRATIONS.length - 1].version);
});

const v2 = MIGRATIONS.find((m) => m.version === 2);
const v3 = MIGRATIONS.find((m) => m.version === 3);
const v4 = MIGRATIONS.find((m) => m.version === 4);
const sizes = (attempts) => lessons(normalize(attempts)).map((l) => l.chars);

test("version 2 stores lesson, durations and copy speed on every record", () => {
  const attempts = v2.up(Array.from({ length: 50 }, (_, i) => v1(i)));
  for (const a of attempts) {
    for (const k of ["lesson", "durMs", "charMs", "copyWpm"]) assert.ok(Number.isFinite(a[k]), k);
  }
  assert.equal(attempts[0].charMs, 540);
});

test("version 2 groups lessons by one minute of active time, as it shipped", () => {
  // Answers 1.5 s apart: 40 per minute.
  assert.deepEqual(sizes(v2.up(Array.from({ length: 120 }, (_, i) => v1(i)))), [40, 40, 40]);
});

test("version 3 regroups lessons into 50 answers", () => {
  const migrated = migrate(Array.from({ length: 120 }, (_, i) => v1(i)), 1);
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.deepEqual(sizes(migrated.attempts), [50, 50, 20]);
});

test("version 3 starts a new lesson after a break", () => {
  const late = (i) => ({ ...v1(i), t: new Date(T0 + 11 * 60_000 + i * 1500).toISOString() });
  const history = [...Array.from({ length: 10 }, (_, i) => v1(i)), ...Array.from({ length: 5 }, (_, i) => late(i))];
  assert.deepEqual(sizes(v3.up(v2.up(history))), [10, 5]);
});

test("version 3 matches the lessons derived for unlabelled history", () => {
  const late = (i) => ({ ...v1(i), t: new Date(T0 + 3_600_000 + i * 1500).toISOString() });
  const old = [...Array.from({ length: 73 }, (_, i) => v1(i)), ...Array.from({ length: 64 }, (_, i) => late(i))];
  assert.deepEqual(sizes(migrate(old, 1).attempts), sizes(old));
});

test("migrating twice changes nothing", () => {
  const once = migrate([v1(0), v1(1)], 1).attempts;
  assert.deepEqual(migrate(once, 1).attempts, once);
});

test("an empty store starts at the current version without a rewrite", async () => {
  const store = memoryStore([], {});
  const r = await loadHistory(store);
  assert.equal(r.applied.length, 0);
  assert.equal(store.replaced, null);
  assert.equal(store.meta.schemaVersion, SCHEMA_VERSION);
});

test("an unversioned history is treated as version 1 and upgraded", async () => {
  const store = memoryStore([v1(0), v1(1)], {});
  const r = await loadHistory(store);
  assert.deepEqual(store.replaced, { from: 1, to: SCHEMA_VERSION });
  assert.equal(r.applied.length, SCHEMA_VERSION - 1);
  assert.ok(Number.isFinite(r.attempts[0].lesson));
});

test("a current history is left alone", async () => {
  const store = memoryStore([v1(0)], { schemaVersion: SCHEMA_VERSION });
  await loadHistory(store);
  assert.equal(store.replaced, null);
});

test("a history from a newer app version is not touched", async () => {
  const store = memoryStore([v1(0)], { schemaVersion: SCHEMA_VERSION + 1 });
  const r = await loadHistory(store);
  assert.equal(r.newer, true);
  assert.equal(store.replaced, null);
});

test("version 4 times replayed answers from the first play", () => {
  const base = { char: "K", correct: true, charMs: 540, copyWpm: 20 };
  const [plain, replayed, old] = v4.up([
    { ...base, rtMs: 400, replays: 0, rtFirstMs: 400 },
    { ...base, rtMs: -120, replays: 1, rtFirstMs: 2900 },
    { ...base, rtMs: -80, replays: 2 },
  ]);
  assert.deepEqual(plain, { ...base, rtMs: 400, replays: 0 });
  assert.equal(replayed.rtMs, 2900);
  assert.equal(replayed.rtLastMs, -120);
  assert.equal(replayed.copyWpm, Math.round((12_000 / (540 + 2900)) * 10) / 10);
  assert.ok(!("rtFirstMs" in replayed));
  // Recorded before rtFirstMs existed: the time cannot be recovered.
  assert.equal(old.rtMs, null);
  assert.equal(old.rtLastMs, -80);
  assert.equal(old.copyWpm, null);
});
