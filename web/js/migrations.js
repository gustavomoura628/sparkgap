// Versioned upgrades for the practice history.
//
// History stores record the format version they were written with. On load,
// every migration newer than that version runs in order, and the upgraded
// history is saved back (the storage layer keeps a backup first). History
// written before versioning existed is version 1.
//
// To change the history format: append a migration with the next version
// number. Never edit a migration that has already shipped. Migrations must
// not depend on code that may change later (such as the lesson rules in
// stats.js): copy any logic they need into this file so that their result
// stays the same in every release.

import { charDurationMs, copyWpm } from "./stats.js";

const MINUTE = 60_000;

/** Version 2 lesson and duration derivation, frozen as it shipped. */
function deriveV2(attempts) {
  const out = [];
  let lesson = 0;
  let lessonMs = 0;
  let prevT = null;
  let started = false;
  for (const a of attempts) {
    const t = Date.parse(a.t);
    const gap = prevT == null || Number.isNaN(t) ? Infinity : t - prevT;
    prevT = Number.isNaN(t) ? prevT : t;
    let durMs = a.durMs;
    if (!Number.isFinite(durMs)) durMs = gap > 10 * MINUTE ? 1500 : Math.min(gap, 20_000);
    let id = a.lesson;
    if (!Number.isFinite(id)) {
      if (started && (lessonMs >= MINUTE || gap > 10 * MINUTE)) {
        lesson++;
        lessonMs = 0;
      }
      id = lesson;
    } else if (id !== lesson || !started) {
      lessonMs = 0;
      lesson = id;
    }
    started = true;
    lessonMs += durMs;
    const charMs = Number.isFinite(a.charMs) ? a.charMs : charDurationMs(a.char, a.wpm || 20);
    out.push({ ...a, lesson: id, durMs, charMs });
  }
  return out;
}

export const MIGRATIONS = Object.freeze([
  {
    version: 2,
    summary: "Store the lesson number, active time, character duration and copy speed on every answer.",
    up(attempts) {
      return deriveV2(attempts).map((a) => ({
        ...a,
        durMs: Math.round(a.durMs),
        charMs: Math.round(a.charMs),
        copyWpm: Number.isFinite(a.copyWpm)
          ? a.copyWpm
          : Math.round(copyWpm(a.charMs, a.rtMs) * 10) / 10,
      }));
    },
  },
  {
    version: 3,
    summary: "Regroup lessons into 50 answers each (they were one minute of active time).",
    up(attempts) {
      // A new lesson starts every 50 answers, or after a break of more than 10 minutes.
      let lesson = -1;
      let count = 0;
      let prevT = null;
      return attempts.map((a) => {
        const t = Date.parse(a.t);
        const gap = prevT == null || Number.isNaN(t) ? 0 : t - prevT;
        if (!Number.isNaN(t)) prevT = t;
        if (lesson < 0 || count >= 50 || gap > 10 * MINUTE) {
          lesson++;
          count = 0;
        }
        count++;
        return { ...a, lesson };
      });
    },
  },
  {
    version: 4,
    summary: "Time answers from the end of the first play, so a replay no longer restarts the clock.",
    up(attempts) {
      // Replayed answers take their time from the first play (rtFirstMs) and
      // keep the old value as rtLastMs. Replayed answers recorded before
      // rtFirstMs existed get no reaction time (null), since it cannot be
      // recovered. rtFirstMs is dropped: it is now the same as rtMs.
      return attempts.map((a) => {
        const { rtFirstMs, ...rest } = a;
        if (!(a.replays > 0)) return rest;
        const rtMs = Number.isFinite(rtFirstMs) ? rtFirstMs : null;
        const copy = rtMs != null && Number.isFinite(a.charMs)
          ? Math.round((12_000 / (a.charMs + Math.max(0, rtMs))) * 10) / 10
          : null;
        return { ...rest, rtMs, rtLastMs: a.rtMs, copyWpm: copy };
      });
    },
  },
]);

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Run every migration newer than `fromVersion`. Returns the upgraded history and what ran. */
export function migrate(attempts, fromVersion) {
  let out = attempts;
  let version = fromVersion;
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    out = m.up(out);
    version = m.version;
    applied.push(m);
  }
  return { attempts: out, version, applied };
}

/**
 * Load the history from a store and bring it up to the current format.
 * Returns { attempts, applied, newer } where `newer` means the history was
 * written by a newer version of the app and was left untouched.
 */
export async function loadHistory(store) {
  const [raw, meta] = await Promise.all([store.loadAttempts(), store.loadMeta()]);
  const attempts = Array.isArray(raw) ? raw : [];
  const stored = Number.isFinite(meta?.schemaVersion) ? meta.schemaVersion : null;
  // No version recorded: an empty store is new; anything else predates versioning.
  const from = stored ?? (attempts.length ? 1 : SCHEMA_VERSION);

  if (from > SCHEMA_VERSION) return { attempts, applied: [], newer: true };
  if (from === SCHEMA_VERSION) {
    if (stored == null) await store.saveMeta({ schemaVersion: SCHEMA_VERSION });
    return { attempts, applied: [], newer: false };
  }
  const result = migrate(attempts, from);
  await store.replaceAttempts(result.attempts, { from, to: result.version });
  return { attempts: result.attempts, applied: result.applied, newer: false };
}
