const $ = (id) => document.getElementById(id);
const CIRCUMFERENCE = 2 * Math.PI * 52;
const DEFAULT_TARGET = 5;
const MIN_TARGET = 0.5;
const MAX_TARGET = 24;
const STEP = 0.5;
const HOUR = 3600 * 1000;

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
const fmtDur = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const fmtShort = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : fmtDur(ms);
};
const fmtHours = (h) => (Number.isInteger(h) ? `${h}h` : `${Math.floor(h)}h 30m`);
const send = (msg) => chrome.runtime.sendMessage(msg);

let state = null;

function renderSettings(target) {
  $("targetValue").textContent = fmtHours(target);
  $("dec").disabled = target <= MIN_TARGET;
  for (const btn of $("presets").children) btn.classList.toggle("on", +btn.dataset.hours === target);
  $("inc").disabled = target >= MAX_TARGET;
  const workDays = state?.workDays ?? [];
  for (const btn of $("days").children) {
    btn.classList.toggle("on", workDays.includes(+btn.dataset.day));
  }
  if (document.activeElement !== $("urlInput")) {
    const hostname = state?.origin ? new URL(state.origin).hostname : "";
    $("urlInput").value = hostname.replace(/\.darwinbox\.(in|com)$/i, "");
  }
}

function render() {
  const target = state?.targetHours ?? DEFAULT_TARGET;
  renderSettings(target);
  if (!state) return;

  const holiday = !!state.isHoliday;
  const hasData = !!state.clockIn && !holiday;
  const notSetUp = !state.origin && !holiday;
  const loggedOut = !!state.origin && state.loggedOut && !hasData && !holiday;
  const idle = !!state.origin && !state.loggedOut && !hasData && !holiday;

  const cls = document.body.classList;
  cls.toggle("has-data", hasData);
  cls.toggle("holiday", holiday);
  cls.toggle("idle", idle);

  $("openDb").hidden = !(notSetUp || loggedOut || idle);
  $("openDb").textContent = notSetUp ? "Set up" : "Open Darwinbox";

  if (!hasData) {
    cls.remove("done");
    $("progress").style.strokeDashoffset = CIRCUMFERENCE;
    $("elapsed").textContent = holiday ? "🌴" : idle ? "0h 00m" : "--";
    $("caption").textContent = holiday ? "Enjoy your day off" : `of ${fmtHours(target)}`;
    $("clockin").textContent = "—";
    $("timeLeft").textContent = holiday || notSetUp || loggedOut ? "—" : fmtHours(target);
    $("note").textContent = "";
    if (holiday) {
      $("pill").textContent = "Holiday";
      $("empty").textContent = "Not tracking today. Change work days in settings.";
    } else if (notSetUp) {
      $("pill").textContent = "Not set up";
      $("empty").textContent = "Add your Darwinbox URL in settings to start.";
    } else if (loggedOut) {
      $("pill").textContent = "Logged out";
      $("empty").textContent = "Can't reach Darwinbox. Log in to it in Chrome.";
    } else {
      $("pill").textContent = "Not clocked in";
    }
    return;
  }

  // Always count from clock-in to now, even if Darwinbox reports a clock-out,
  // so the ring shows how far along you are and when you can leave.
  const targetMs = target * HOUR;
  const now = Date.now();
  const elapsed = now - state.clockIn;
  const done = elapsed >= targetMs;

  cls.toggle("done", done);
  $("progress").style.strokeDashoffset = CIRCUMFERENCE * (1 - Math.min(1, elapsed / targetMs));
  $("elapsed").textContent = fmtDur(elapsed);
  $("clockin").textContent = fmtTime(state.clockIn);
  $("timeLeft").textContent = done ? "0h 00m" : fmtDur(targetMs - elapsed);

  $("pill").textContent = done ? "Target reached" : "Tracking";
  $("caption").textContent = done ? `+${fmtShort(elapsed - targetMs)} extra` : `of ${fmtHours(target)}`;

  $("note").textContent = state.clockOut ? `Darwinbox shows a clock-out at ${fmtTime(state.clockOut)}` : "";
}

async function update(msg) {
  state = await send(msg);
  render();
}

// --- Settings ---

function showSettings(show) {
  $("main").hidden = show;
  $("settings").hidden = !show;
  if (show) {
    $("urlStatus").textContent = "";
    if (!state?.origin) $("urlInput").focus();
  }
}

const setTarget = (delta) => {
  const hours = Math.min(MAX_TARGET, Math.max(MIN_TARGET, (state?.targetHours ?? DEFAULT_TARGET) + delta));
  update({ type: "setTarget", hours });
};

$("dec").addEventListener("click", () => setTarget(-STEP));
$("presets").addEventListener("click", (e) => {
  const hours = parseFloat(e.target.dataset?.hours);
  if (hours) update({ type: "setTarget", hours });
});
$("inc").addEventListener("click", () => setTarget(STEP));

$("days").addEventListener("click", (e) => {
  const day = e.target.dataset?.day;
  if (day === undefined) return;
  const days = new Set(state?.workDays ?? []);
  days.has(+day) ? days.delete(+day) : days.add(+day);
  update({ type: "setWorkDays", days: [...days] });
});

$("urlForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("urlStatus");
  const company = $("urlInput").value.trim();
  const res = await send({ type: "setOrigin", url: company ? `${company}.darwinbox.in` : "" });
  if (res?.error) {
    status.className = "url-status error";
    status.textContent = res.error;
    return;
  }
  state = res;
  $("urlInput").blur();
  status.className = "url-status ok";
  status.textContent = !state.origin
    ? "Removed."
    : state.loggedOut
      ? "Saved. Log in to Darwinbox in Chrome to start tracking."
      : "Saved and connected ✓";
  render();
});

$("openSettings").addEventListener("click", () => showSettings(true));
$("closeSettings").addEventListener("click", () => showSettings(false));

$("openDb").addEventListener("click", () => {
  if (!state?.origin) return showSettings(true);
  chrome.tabs.create({ url: state.origin + "/" });
  window.close();
});

update({ type: "getState" });
setInterval(render, 10 * 1000);
