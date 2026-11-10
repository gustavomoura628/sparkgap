// Versioned upgrades for the practice history.
//
// History stores record the format version they were written with. On load,
// every migration newer than that version runs in order, and the upgraded
// history is saved back (the storage layer keeps a backup first). History
// written before versioning existed is version 1.
//
// To change the history format: append a migration with the next version
// number. Never edit a migration that has already shipped.

import { copyWpm, normalize } from "./stats.js";

export const MIGRATIONS = Object.freeze([
  {
    version: 2,
    summary: "Store the lesson number, active time, character duration and copy speed on every answer.",
    up(attempts) {
      return normalize(attempts).map((a) => ({
        ...a,
        durMs: Math.round(a.durMs),
        charMs: Math.round(a.charMs),
        copyWpm: Number.isFinite(a.copyWpm)
          ? a.copyWpm
          : Math.round(copyWpm(a.charMs, a.rtMs) * 10) / 10,
      }));
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
