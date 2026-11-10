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

test("version 2 stores lesson, durations and copy speed on every record", () => {
  const { attempts, version } = migrate(Array.from({ length: 50 }, (_, i) => v1(i)), 1);
  assert.equal(version, 2);
  for (const a of attempts) {
    for (const k of ["lesson", "durMs", "charMs", "copyWpm"]) assert.ok(Number.isFinite(a[k]), k);
  }
  assert.equal(attempts[0].charMs, 540);
});

test("version 2 keeps lesson boundaries identical to the derived ones", () => {
  const old = Array.from({ length: 120 }, (_, i) => v1(i));
  const migrated = migrate(old, 1).attempts;
  const before = lessons(normalize(old)).map((l) => [l.id, l.chars]);
  const after = lessons(normalize(migrated)).map((l) => [l.id, l.chars]);
  assert.deepEqual(after, before);
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
