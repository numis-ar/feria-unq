// UX Metrics collector — anonymous session-level telemetry.
// Include this script + ux-error-catalog.js in every HTML page.
(function () {
  "use strict";
  if (window.UXMetrics) return;

  const cfg = window.UX_METRICS_CONFIG || {};
  const endpoint = cfg.endpoint || "/ux-metrics";
  const flushIntervalMs = cfg.flushIntervalMs || 10000;
  const batchSize = cfg.batchSize || 50;
  const sampleRate = cfg.sampleRate || 1.0;
  const interactionThrottleMs = cfg.interactionThrottleMs || 500;

  const sessionId = (() => {
    const key = "ux-session-id";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id =
        Math.random().toString(36).slice(2) +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(key, id);
    }
    return id;
  })();

  let events = [];
  let requests = [];
  let loads = [];
  let flushTimer = null;
  let lastInteractionTs = 0;
  let wsErrorReported = false;

  function now() {
    return Date.now();
  }

  function enqueue(kind, payload) {
    if (Math.random() > sampleRate) return;
    const base = {
      ts: now(),
      session_id: sessionId,
    };
    const item = Object.assign(base, payload);
    if (kind === "event") events.push(item);
    else if (kind === "request") requests.push(item);
    else if (kind === "load") loads.push(item);

    const total = events.length + requests.length + loads.length;
    if (total >= batchSize) flush();
    else scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, flushIntervalMs);
  }

  function buildBody(arrays) {
    return JSON.stringify({
      session_id: sessionId,
      events: arrays.events,
      requests: arrays.requests,
      loads: arrays.loads,
    });
  }

  function flush(sync) {
    if (!events.length && !requests.length && !loads.length) return;
    const batch = { events, requests, loads };
    events = [];
    requests = [];
    loads = [];
    const body = buildBody(batch);

    if (sync && navigator.sendBeacon) {
      navigator.sendBeacon(
        endpoint,
        new Blob([body], { type: "application/json" })
      );
      return;
    }

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // Silent fail — we never want telemetry to break the app.
    });
  }

  // ---------------------------------------------------------------------------
  // Error capture
  // ---------------------------------------------------------------------------
  window.addEventListener(
    "error",
    (e) => {
      const target = e.target;
      let action = "js-runtime";
      let rootCode = "UNCAUGHT_EXCEPTION";
      let url = location.href;
      let message = e.message;
      let filename = e.filename;
      let lineno = e.lineno;
      let colno = e.colno;

      if (target && (target instanceof HTMLElement || target instanceof Element)) {
        action = "resource";
        rootCode = "LOAD_ERROR";
        url = target.src || target.href || location.href;
        message = "Resource failed to load: " + url;
        filename = url;
      }

      enqueue("event", {
        action,
        root_code: rootCode,
        url,
        payload: {
          message,
          filename,
          lineno,
          colno,
          stack: e.error && e.error.stack ? e.error.stack : null,
        },
      });

      if (action === "js-runtime" || action === "resource") {
        window.UXErrorCatalog && window.UXErrorCatalog.show(action, rootCode, message);
      }
    },
    true
  );

  window.addEventListener("unhandledrejection", (e) => {
    const reason =
      e.reason && e.reason.message ? e.reason.message : String(e.reason);
    enqueue("event", {
      action: "js-runtime",
      root_code: "UNHANDLED_REJECTION",
      url: location.href,
      payload: {
        reason,
        stack: e.reason && e.reason.stack ? e.reason.stack : null,
      },
    });
    window.UXErrorCatalog &&
      window.UXErrorCatalog.show("js-runtime", "UNHANDLED_REJECTION", reason);
  });

  // ---------------------------------------------------------------------------
  // Fetch interception (timing + HTTP errors + network errors)
  // ---------------------------------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function fetchInterceptor(...args) {
    const start = performance.now();
    let url = args[0];
    if (typeof url === "object" && url.url) url = url.url;
    url = String(url);
    let method = "GET";
    if (args[1] && args[1].method)
      method = String(args[1].method).toUpperCase();

    try {
      const res = await originalFetch.apply(this, args);
      const duration = Math.round(performance.now() - start);
      const status = res.status;
      const errorCode = status >= 400 ? `FETCH_${status}` : null;
      enqueue("request", {
        method,
        url,
        status,
        duration_ms: duration,
        error_code: errorCode,
        payload: { statusText: res.statusText },
      });

      if (status >= 500) {
        window.UXErrorCatalog &&
          window.UXErrorCatalog.show("network", `FETCH_${status}`, url);
      }
      return res;
    } catch (err) {
      const duration = Math.round(performance.now() - start);
      enqueue("request", {
        method,
        url,
        status: 0,
        duration_ms: duration,
        error_code: "FETCH_FAILED",
        payload: { message: err.message },
      });
      window.UXErrorCatalog &&
        window.UXErrorCatalog.show("network", "FETCH_FAILED", err.message);
      throw err;
    }
  };

  // ---------------------------------------------------------------------------
  // XMLHttpRequest interception
  // ---------------------------------------------------------------------------
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function XHRInterceptor() {
    const xhr = new OriginalXHR();
    const realOpen = xhr.open;
    const realSend = xhr.send;
    let method = "GET";
    let url = "";
    let start = 0;

    xhr.open = function open(m, u, ...rest) {
      method = String(m).toUpperCase();
      url = String(u);
      return realOpen.call(xhr, m, u, ...rest);
    };

    xhr.addEventListener("loadend", () => {
      const duration = Math.round(performance.now() - start);
      const status = xhr.status;
      const errorCode = status >= 400 ? `XHR_${status}` : null;
      enqueue("request", {
        method,
        url,
        status,
        duration_ms: duration,
        error_code: errorCode,
        payload: { statusText: xhr.statusText },
      });
    });

    xhr.send = function send(...sargs) {
      start = performance.now();
      return realSend.apply(xhr, sargs);
    };

    return xhr;
  };

  // ---------------------------------------------------------------------------
  // WebSocket interception
  // ---------------------------------------------------------------------------
  const OriginalWS = window.WebSocket;
  window.WebSocket = function WebSocketInterceptor(...args) {
    const ws = new OriginalWS(...args);
    const url = String(args[0]);
    const originalOnError = ws.onerror;
    const originalOnClose = ws.onclose;

    ws.onerror = function onError(e) {
      enqueue("event", {
        action: "network",
        root_code: "WS_ERROR",
        url,
        payload: {},
      });
      if (!wsErrorReported) {
        wsErrorReported = true;
        window.UXErrorCatalog &&
          window.UXErrorCatalog.show("network", "WS_ERROR");
      }
      if (originalOnError) originalOnError.call(this, e);
    };

    ws.onclose = function onClose(e) {
      if (!e.wasClean) {
        enqueue("event", {
          action: "network",
          root_code: "WS_CLOSE",
          url,
          payload: { code: e.code, reason: e.reason },
        });
        if (!wsErrorReported) {
          wsErrorReported = true;
          window.UXErrorCatalog &&
            window.UXErrorCatalog.show("network", "WS_CLOSE");
        }
      }
      if (originalOnClose) originalOnClose.call(this, e);
    };

    return ws;
  };

  // ---------------------------------------------------------------------------
  // Interaction tracking
  // ---------------------------------------------------------------------------
  document.addEventListener(
    "click",
    (e) => {
      const t = now();
      if (t - lastInteractionTs < interactionThrottleMs) return;
      lastInteractionTs = t;
      const el = e.target.closest(
        "[data-ux-action], button, a, input, select, textarea, [role='button']"
      );
      if (!el) return;
      const action =
        el.getAttribute("data-ux-action") ||
        el.id ||
        el.name ||
        el.textContent.trim().slice(0, 40) ||
        el.tagName.toLowerCase();
      enqueue("event", {
        action: "interaction",
        root_code: "click",
        url: location.href,
        payload: { tag: el.tagName, id: el.id, name: el.name, action },
      });
    },
    true
  );

  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target;
      const action =
        form.getAttribute("data-ux-action") ||
        form.id ||
        form.name ||
        "form-submit";
      enqueue("event", {
        action: "interaction",
        root_code: "submit",
        url: location.href,
        payload: { id: form.id, action: form.action, method: form.method },
      });
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Load timing
  // ---------------------------------------------------------------------------
  window.addEventListener("load", () => {
    setTimeout(() => {
      const nav = performance.getEntriesByType("navigation")[0] || {};
      const paints = performance.getEntriesByType("paint");
      const lcpEntries = performance.getEntriesByType(
        "largest-contentful-paint"
      );

      const fcpEntry = paints.find((p) => p.name === "first-contentful-paint");
      const lcpEntry = lcpEntries.length
        ? lcpEntries[lcpEntries.length - 1]
        : null;

      const timing = nav;
      const loadMs =
        timing.loadEventEnd != null && timing.startTime != null
          ? Math.round(timing.loadEventEnd - timing.startTime)
          : null;
      const ttfbMs =
        timing.responseStart != null && timing.startTime != null
          ? Math.round(timing.responseStart - timing.startTime)
          : null;

      enqueue("load", {
        url: location.href,
        load_ms: loadMs,
        ttfb_ms: ttfbMs,
        fcp_ms: fcpEntry ? Math.round(fcpEntry.startTime) : null,
        lcp_ms: lcpEntry ? Math.round(lcpEntry.startTime) : null,
        payload: {
          domComplete:
            timing.domComplete != null ? Math.round(timing.domComplete) : null,
          responseEnd:
            timing.responseEnd != null ? Math.round(timing.responseEnd) : null,
          fetchStart:
            timing.fetchStart != null ? Math.round(timing.fetchStart) : null,
        },
      });
    }, 0);
  });

  window.addEventListener("beforeunload", () => {
    flush(true);
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function showErrorToast(detail) {
    let container = document.getElementById("ux-error-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "ux-error-toast-container";
      container.setAttribute("role", "alert");
      container.setAttribute("aria-live", "assertive");
      container.style.cssText =
        "position:fixed;bottom:16px;left:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none;";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.style.cssText =
      "background:#fff;border-left:4px solid #dc5a1e;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:12px 16px;border-radius:4px;max-width:min(480px,calc(100vw - 32px));pointer-events:auto;font-family:system-ui,-apple-system,sans-serif;";

    const titleHtml = `<strong style="display:block;color:#b91c1c;font-size:14px;margin-bottom:4px;">${escapeHtml(
      detail.title
    )}</strong>`;
    const descHtml = `<span style="font-size:13px;color:#374151;">${escapeHtml(
      detail.description
    )}</span>`;
    const hintHtml = detail.actionHint
      ? `<span style="display:block;font-size:12px;color:#6b7280;margin-top:6px;">${escapeHtml(
          detail.actionHint
        )}</span>`
      : "";
    const extraHtml = detail.extraMessage
      ? `<span style="display:block;font-size:12px;color:#6b7280;margin-top:4px;">${escapeHtml(
          String(detail.extraMessage)
        )}</span>`
      : "";

    toast.innerHTML = titleHtml + descHtml + hintHtml + extraHtml;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s";
      setTimeout(() => toast.remove(), 300);
    }, 6000);
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.UXMetrics = {
    sessionId,
    trackEvent(action, rootCode, payload) {
      enqueue("event", {
        action,
        root_code: rootCode,
        url: location.href,
        payload,
      });
    },
    trackRequest(method, url, status, durationMs, errorCode, payload) {
      enqueue("request", {
        method,
        url,
        status,
        duration_ms: durationMs,
        error_code: errorCode,
        payload,
      });
    },
    trackLoad(loadMs, ttfbMs, fcpMs, lcpMs, payload) {
      enqueue("load", {
        url: location.href,
        load_ms: loadMs,
        ttfb_ms: ttfbMs,
        fcp_ms: fcpMs,
        lcp_ms: lcpMs,
        payload,
      });
    },
    flush,
    showErrorToast,
  };
})();
