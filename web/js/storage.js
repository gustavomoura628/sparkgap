// Practice data storage. Uses the local server (server.py) when it is
// running, so history lands in plain files on disk; otherwise falls back to
// the browser's localStorage, which also makes static hosting work.

const LS_ATTEMPTS = "sparkgap.attempts";
const LS_SETTINGS = "sparkgap.settings";
const LS_META = "sparkgap.meta";
const LS_BACKUP = "sparkgap.attempts.backup";
const LS_EVENTS = "sparkgap.events";
const LOCAL_EVENTS_MAX = 5000; // browser storage is small; keep the most recent events

const serverStore = {
  kind: "server",
  async loadAttempts() {
    const r = await fetch("api/attempts");
    if (!r.ok) throw new Error(`Loading attempts failed: HTTP ${r.status}`);
    return r.json();
  },
  async addAttempt(attempt) {
    const r = await fetch("api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt),
    });
    if (!r.ok) throw new Error(`Saving attempt failed: HTTP ${r.status}`);
  },
  async addEvent(event) {
    await fetch("api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  },
  /** Send an event while the page is closing, when a normal request may be cancelled. */
  addEventOnExit(event) {
    const blob = new Blob([JSON.stringify(event)], { type: "application/json" });
    if (!navigator.sendBeacon?.("api/events", blob)) this.addEvent(event).catch(() => {});
  },
  async loadEvents() {
    const r = await fetch("api/events");
    return r.ok ? r.json() : [];
  },
  async loadSettings() {
    const r = await fetch("api/settings");
    return r.ok ? r.json() : {};
  },
  async saveSettings(settings) {
    await fetch("api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  },
  async loadMeta() {
    const r = await fetch("api/meta");
    return r.ok ? r.json() : {};
  },
  async saveMeta(meta) {
    const r = await fetch("api/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta),
    });
    if (!r.ok) throw new Error(`Saving history version failed: HTTP ${r.status}`);
  },
  /** Replace the whole history after a format upgrade. The server backs up the old file first. */
  async replaceAttempts(attempts, { to }) {
    const r = await fetch("api/attempts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: to, attempts }),
    });
    if (!r.ok) throw new Error(`Upgrading history failed: HTTP ${r.status}`);
  },
};

/** Merge `patch` into the saved settings, so pages only overwrite the fields they change. */
async function updateSettings(patch) {
  const next = { ...(await this.loadSettings()), ...patch };
  await this.saveSettings(next);
  return next;
}
serverStore.updateSettings = updateSettings;

const readLS = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

const localStore = {
  kind: "browser",
  async loadAttempts() {
    return readLS(LS_ATTEMPTS, []);
  },
  async addAttempt(attempt) {
    const all = readLS(LS_ATTEMPTS, []);
    all.push(attempt);
    localStorage.setItem(LS_ATTEMPTS, JSON.stringify(all));
  },
  async addEvent(event) {
    const all = readLS(LS_EVENTS, []);
    all.push(event);
    localStorage.setItem(LS_EVENTS, JSON.stringify(all.slice(-LOCAL_EVENTS_MAX)));
  },
  addEventOnExit(event) {
    this.addEvent(event).catch(() => {});
  },
  async loadEvents() {
    return readLS(LS_EVENTS, []);
  },
  async loadSettings() {
    return readLS(LS_SETTINGS, {});
  },
  async saveSettings(settings) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  },
  async loadMeta() {
    return readLS(LS_META, {});
  },
  async saveMeta(meta) {
    localStorage.setItem(LS_META, JSON.stringify(meta));
  },
  updateSettings,
  async replaceAttempts(attempts, { from, to }) {
    // Keep the pre-upgrade history so an upgrade can be undone by hand.
    localStorage.setItem(LS_BACKUP, JSON.stringify({
      schemaVersion: from,
      savedAt: new Date().toISOString(),
      attempts: readLS(LS_ATTEMPTS, []),
    }));
    localStorage.setItem(LS_ATTEMPTS, JSON.stringify(attempts));
    localStorage.setItem(LS_META, JSON.stringify({ schemaVersion: to }));
  },
};

export async function openStore() {
  try {
    const r = await fetch("api/health", { cache: "no-store" });
    if (r.ok && (await r.json()).ok) return serverStore;
  } catch {
    /* no server: static hosting */
  }
  return localStore;
}
