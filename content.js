// Bridges page-hook.js (page context) and the background service worker.
// The background ignores messages unless this tab is the site set in settings.

function send(msg) {
  // After the extension is reloaded, scripts left in open tabs lose their
  // connection; chrome.runtime.id goes undefined and sendMessage throws.
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {}
}

send({ type: "connect" });

window.addEventListener("message", (e) => {
  if (e.source === window && e.data?.__loginTracker && typeof e.data.body === "string") {
    send({ type: "dayStatus", body: e.data.body, request: e.data.request });
  }
});
