// Practice data storage. Uses the local server (server.py) when it is
// running, so history lands in plain files on disk; otherwise falls back to
// the browser's localStorage, which also makes static hosting work.

const LS_ATTEMPTS = "sparkgap.attempts";
const LS_SETTINGS = "sparkgap.settings";

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
};

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
  async loadSettings() {
    return readLS(LS_SETTINGS, {});
  },
  async saveSettings(settings) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
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
