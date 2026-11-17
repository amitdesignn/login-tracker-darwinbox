// Runs in the page's own JS context (world: MAIN) so it can see the
// attendance responses Darwinbox's app fetches, and forwards any that carry
// clock-in data to content.js — along with the request that produced them,
// so the background can replay it later without the page open.

(() => {
  const MARKER = /"clock_?in_time"/;
  const SKIP = /javascript|css|image|font|video|audio/i; // code files mention the field names too

  function forward(text, request) {
    if (text && text.length < 2e6 && MARKER.test(text)) {
      window.postMessage({ __loginTracker: true, body: text, request }, window.location.origin);
    }
  }

  // Only string-like bodies can be replayed; anything else is dropped.
  function describe(url, method, headers, body) {
    try {
      return {
        url: new URL(url, location.href).href,
        method: (method || "GET").toUpperCase(),
        headers,
        body: typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : null,
      };
    } catch {
      return null;
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    let request = null;
    try {
      const [input, init = {}] = args;
      const isReq = input instanceof Request;
      request = describe(
        isReq ? input.url : String(input),
        init.method || (isReq ? input.method : "GET"),
        Object.fromEntries(new Headers(init.headers || (isReq ? input.headers : undefined))),
        init.body
      );
    } catch {}
    const res = await origFetch.apply(this, args);
    try {
      if (!SKIP.test(res.headers.get("content-type") || "")) {
        res.clone().text().then((text) => forward(text, request), () => {});
      }
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    this.__lt = { method: args[0], url: args[1], headers: {}, body: null };
    this.addEventListener("load", () => {
      try {
        if (SKIP.test(this.getResponseHeader("content-type") || "")) return;
        const { method, url, headers, body } = this.__lt;
        const request = describe(url, method, headers, body);
        if (this.responseType === "" || this.responseType === "text") forward(this.responseText, request);
        else if (this.responseType === "json") forward(JSON.stringify(this.response), request);
      } catch {}
    });
    return origOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__lt) this.__lt.headers[name] = String(value);
    return origSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__lt) this.__lt.body = body ?? null;
    return origSend.call(this, body);
  };
})();
