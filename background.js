// Service worker: keeps today's clock-in/out from Darwinbox, updates the
// badge, and notifies once the target duration is reached.

const DEFAULT_TARGET_HOURS = 5;
const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5]; // Date#getDay(): 0 = Sun … 6 = Sat
const TICK_ALARM = "tick";
const POLL_ALARM = "poll";
const DAY_STATUS_PATH = "/attendance/attendanceAPI/getDayStatus";
const HOUR = 3600 * 1000;

const todayKey = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

// Accepts "acme.darwinbox.in", "https://acme.darwinbox.in/ms/db/…", etc.
// Limited to the Darwinbox domains the manifest grants access to.
function normalizeOrigin(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  const raw = input.trim();
  try {
    const { hostname } = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    return /^[a-z0-9-]+\.darwinbox\.(in|com)$/i.test(hostname) ? "https://" + hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function getState() {
  const s = await chrome.storage.local.get([
    "date",
    "clockIn",
    "clockOut",
    "notified",
    "origin",
    "loggedOut",
    "targetHours",
    "workDays",
  ]);
  const patch = {};
  if (s.origin && normalizeOrigin(s.origin) !== s.origin) {
    patch.origin = null; // not a valid Darwinbox site (e.g. saved by an older version)
  }
  if (s.date !== todayKey()) {
    // New day: drop yesterday's session but keep the site and settings.
    Object.assign(patch, { date: todayKey(), clockIn: null, clockOut: null, notified: false });
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);

  const workDays = s.workDays ?? DEFAULT_WORK_DAYS;
  return {
    ...s,
    ...patch,
    targetHours: s.targetHours ?? DEFAULT_TARGET_HOURS,
    workDays,
    isHoliday: !workDays.includes(new Date().getDay()),
  };
}

// --- Parsing Darwinbox's day status ---

const IN_KEYS = ["clockin_time", "clock_in_time"];
const OUT_KEYS = ["clockout_time", "clock_out_time"];

// Finds the first object carrying a clock-in field, e.g.
// {"clockin_time":"09:44:58","clockout_time":null,"shift_date":"2026-10-27"}
function findDayStatus(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  const inKey = IN_KEYS.find((k) => k in obj);
  if (inKey) {
    const outKey = OUT_KEYS.find((k) => k in obj);
    return { in: obj[inKey], out: outKey ? obj[outKey] : null, date: obj.shift_date };
  }
  for (const v of Object.values(obj)) {
    const found = findDayStatus(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function toTimestamp(time, date) {
  const m = typeof time === "string" && time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(y, mo - 1, d, +m[1], +m[2], +(m[3] || 0)).getTime();
}

async function applyDayStatus(json) {
  const status = findDayStatus(json);
  if (!status) return false;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(status.date) ? status.date : todayKey();
  if (date !== todayKey()) return true; // a different shift day; nothing to track

  const clockIn = toTimestamp(status.in, date);
  let clockOut = toTimestamp(status.out, date);
  if (clockIn && clockOut && clockOut < clockIn) clockOut += 24 * HOUR; // past midnight

  const s = await getState();
  if (s.clockIn !== clockIn || s.clockOut !== clockOut) {
    await chrome.storage.local.set({
      clockIn,
      clockOut,
      notified: s.clockIn === clockIn ? s.notified : false,
    });
  }
  await refresh();
  return true;
}

// --- Background fetch (uses the browser's existing Darwinbox login) ---

let inFlight = null;

// Popup opens, page loads and alarms can all ask at once; share one request.
function poll() {
  inFlight ??= doPoll().finally(() => (inFlight = null));
  return inFlight;
}

async function doPoll() {
  const { origin, isHoliday } = await getState();
  if (!origin || isHoliday) return;
  const ok = await fetchDayStatus(origin);
  await chrome.storage.local.set({ loggedOut: !ok });
  if (!ok) await autoOpen(origin);
}

// Tries the request Darwinbox's own page last used (exact URL, method,
// headers and body), then the known endpoint.
async function fetchDayStatus(origin) {
  const { dayStatusRequest: saved } = await chrome.storage.local.get("dayStatusRequest");
  const attempts = [];
  if (saved && new URL(saved.url).origin === origin) attempts.push(saved);
  attempts.push({ url: origin + DAY_STATUS_PATH, method: "GET", headers: {}, body: null });

  for (const r of attempts) {
    try {
      const res = await fetch(r.url, {
        method: r.method,
        body: r.method === "GET" || r.method === "HEAD" ? undefined : r.body ?? undefined,
        credentials: "include",
        // Darwinbox's app sends these; some endpoints redirect to login without them.
        headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json", ...r.headers },
      });
      if (res.ok && (await applyDayStatus(await res.json()))) return true;
    } catch {
      // Not JSON (usually the login page) or a network error.
    }
  }
  return false;
}

// Keeps only a replayable same-origin request from the page hook.
function sanitizeRequest(req, origin) {
  if (!req || typeof req.url !== "string") return null;
  try {
    if (new URL(req.url).origin !== origin) return null;
  } catch {
    return null;
  }
  const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
  if (method !== "GET" && method !== "POST") return null;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (typeof k === "string" && typeof v === "string") headers[k] = v;
  }
  const body = typeof req.body === "string" && req.body.length < 1e5 ? req.body : null;
  return { url: req.url, method, headers, body };
}

// --- Auto-open: when the session has lapsed (e.g. overnight), loading
// Darwinbox in a background tab lets SSO sign back in and the page hook
// report the day status. The tab closes itself once that arrives. ---

const AUTO_CLOSE_ALARM = "closeAutoTab";
const AUTO_OPEN_GAP = HOUR; // between attempts
const AUTO_OPEN_TIMEOUT = 1.5; // minutes before giving up on a tab

async function autoOpen(origin) {
  const { autoOpen: a } = await chrome.storage.local.get("autoOpen");
  const today = todayKey();
  if (a?.date === today) {
    if (a.failed) return; // needs a real login; don't keep opening tabs today
    if (Date.now() - a.at < AUTO_OPEN_GAP) return;
  }
  // An open Darwinbox tab already reports through its page hook.
  if ((await chrome.tabs.query({ url: origin + "/*" })).length) return;

  const tab = await chrome.tabs.create({ url: origin + "/", active: false });
  await chrome.storage.local.set({ autoOpen: { date: today, at: Date.now(), tabId: tab.id, failed: false } });
  chrome.alarms.create(AUTO_CLOSE_ALARM, { delayInMinutes: AUTO_OPEN_TIMEOUT });
}

async function finishAutoOpen(succeeded) {
  const { autoOpen: a } = await chrome.storage.local.get("autoOpen");
  if (!a?.tabId) return;
  chrome.alarms.clear(AUTO_CLOSE_ALARM);
  await chrome.storage.local.set({ autoOpen: { ...a, tabId: null, failed: !succeeded } });
  try {
    // Leave it alone if the user has switched to it.
    if (!(await chrome.tabs.get(a.tabId)).active) await chrome.tabs.remove(a.tabId);
  } catch {
    // Already closed.
  }
}

// --- Badge and notification (checked every minute) ---

async function refresh() {
  const s = await getState();
  const tracking = s.clockIn && !s.isHoliday;
  const elapsed = tracking ? Date.now() - s.clockIn : 0; // from clock-in to now, ignoring any clock-out
  const targetMs = s.targetHours * HOUR;
  const done = elapsed >= targetMs;

  if (tracking && done && !s.notified) await notifyDone(s);

  const mins = Math.floor(Math.max(0, targetMs - elapsed) / 60000);
  chrome.action.setBadgeText({
    text: tracking ? (done ? "0:00" : `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`) : "",
  });
  chrome.action.setBadgeBackgroundColor({ color: done ? "#79a87d" : "#6f9c8e" });
}

async function notifyDone(s) {
  await chrome.storage.local.set({ notified: true });
  const clockInStr = new Date(s.clockIn).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  chrome.notifications.create("done-" + Date.now(), {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `🎉 ${s.targetHours} hours completed!`,
    message: `You clocked in at ${clockInStr} and have completed ${s.targetHours} hours. You can clock out and head home.`,
  });
}

// --- Messages ---

const isValidTarget = (h) => typeof h === "number" && h >= 0.5 && h <= 24;
const isValidDays = (d) => Array.isArray(d) && d.every((x) => Number.isInteger(x) && x >= 0 && x <= 6);

// From the popup: read state and change settings.
async function handleExtensionMessage(msg) {
  switch (msg.type) {
    case "getState":
      await poll();
      return getState();

    case "setOrigin": {
      const origin = normalizeOrigin(msg.url);
      if (msg.url && !origin) return { error: "Enter a Darwinbox address like yourcompany.darwinbox.in" };
      // Switching sites invalidates today's data from the old one.
      await chrome.storage.local.set({ origin, clockIn: null, clockOut: null, notified: false, loggedOut: false });
      await poll();
      await refresh();
      return getState();
    }

    case "setTarget": {
      if (!isValidTarget(msg.hours)) return getState();
      const s = await getState();
      const elapsed = s.clockIn ? Date.now() - s.clockIn : 0;
      // Notify for the new target only if it's still ahead; don't fire for one already passed.
      await chrome.storage.local.set({ targetHours: msg.hours, notified: elapsed >= msg.hours * HOUR });
      await refresh();
      return getState();
    }

    case "setWorkDays":
      if (!isValidDays(msg.days)) return getState();
      await chrome.storage.local.set({ workDays: msg.days });
      await poll();
      await refresh();
      return getState();
  }
}

// From content.js: only trusted when the tab is the site set in settings.
async function handleTabMessage(msg, tab) {
  const { origin, autoOpen: a } = await chrome.storage.local.get(["origin", "autoOpen"]);
  if (!origin || new URL(tab.url).origin !== origin) return;
  if (msg.type === "connect") await poll();
  if (msg.type === "dayStatus" && typeof msg.body === "string") {
    let ok = false;
    try {
      ok = await applyDayStatus(JSON.parse(msg.body));
    } catch {}
    if (!ok) return;
    const request = sanitizeRequest(msg.request, origin);
    await chrome.storage.local.set({ loggedOut: false, ...(request && { dayStatusRequest: request }) });
    if (a?.tabId === tab.id) await finishAutoOpen(true);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromExtension = sender.url?.startsWith(chrome.runtime.getURL(""));
  const task = fromExtension
    ? handleExtensionMessage(msg)
    : sender.tab?.url
      ? handleTabMessage(msg, sender.tab)
      : Promise.resolve();
  task.then((res) => sendResponse(res ?? { ok: true }), () => sendResponse({ ok: false }));
  return true; // keep the channel open for the async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll();
  else if (alarm.name === AUTO_CLOSE_ALARM) finishAutoOpen(false);
  else refresh();
});

function init() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 5 });
  poll().then(refresh);
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
