// UX Metrics collector — anonymous session-level telemetry.
// Include this script + ux-error-catalog.js in every HTML page.
(function () {
  "use strict";
  if (window.UXMetrics) return;

  const cfg = window.UX_METRICS_CONFIG || {};
  const endpoint = cfg.endpoint || "/ux-metrics";
  const flushIntervalMs = Math.max(15000, cfg.flushIntervalMs || 15000);
  const sampleRate = cfg.sampleRate || 1.0;
  const interactionThrottleMs = cfg.interactionThrottleMs || 500;

  function isMetricsUrl(url) {
    try {
      return new URL(url, location.href).pathname === endpoint;
    } catch {
      return false;
    }
  }

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
  let lastPostAt = now();
  let pendingPost = null;
  let pendingErrorFlush = false;
  let lastInteractionTs = 0;
  let wsErrorReported = false;

  function now() {
    return Date.now();
  }

  function isErrorItem(kind, item) {
    if (kind === "load") return false;
    return item.affects_experience === true;
  }

  function omitEmpty(obj) {
    const out = {};
    for (const key in obj) {
      const val = obj[key];
      if (val == null) continue;
      if (typeof val === "string" && val === "") continue;
      if (typeof val === "object" && !Array.isArray(val)) {
        const cleaned = omitEmpty(val);
        if (Object.keys(cleaned).length === 0) continue;
        out[key] = cleaned;
        continue;
      }
      out[key] = val;
    }
    return out;
  }

  function enqueue(kind, payload) {
    if (Math.random() > sampleRate) return;
    const item = omitEmpty(payload);
    if (kind === "event") events.push(item);
    else if (kind === "request") requests.push(item);
    else if (kind === "load") loads.push(item);

    flushSoon(isErrorItem(kind, item));
  }

  function flushSoon(force) {
    if (!events.length && !requests.length && !loads.length) return;
    if (pendingPost) {
      if (force) pendingErrorFlush = true;
      return;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const elapsed = now() - lastPostAt;
    if (force || elapsed >= flushIntervalMs) {
      flush();
    } else {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, flushIntervalMs - elapsed);
    }
  }

  function buildBody(arrays) {
    const body = { session_id: sessionId };
    if (arrays.events.length) body.events = arrays.events;
    if (arrays.requests.length) body.requests = arrays.requests;
    if (arrays.loads.length) body.loads = arrays.loads;
    return JSON.stringify(body);
  }

  function flush(sync) {
    if (!events.length && !requests.length && !loads.length) return;
    const batch = { events, requests, loads };
    events = [];
    requests = [];
    loads = [];
    const body = buildBody(batch);

    if (sync) {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          endpoint,
          new Blob([body], { type: "application/json" })
        );
      } else {
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {
          // Silent fail — we never want telemetry to break the app.
        });
      }
      return;
    }

    lastPostAt = now();
    pendingErrorFlush = false;
    pendingPost = fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    })
      .catch(() => {
        // Silent fail — we never want telemetry to break the app.
      })
      .finally(() => {
        pendingPost = null;
        if (pendingErrorFlush) {
          pendingErrorFlush = false;
          flushSoon(true);
        } else if (events.length || requests.length || loads.length) {
          flushSoon(false);
        }
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
      let affectsExperience = true;

      if (target && (target instanceof HTMLElement || target instanceof Element)) {
        action = "resource";
        rootCode = "LOAD_ERROR";
        url = target.src || target.href || location.href;
        message = "Resource failed to load: " + url;
        filename = url;
        affectsExperience = false;
      }

      enqueue("event", {
        action,
        root_code: rootCode,
        url,
        affects_experience: affectsExperience,
        payload: {
          message,
          filename,
          lineno,
          colno,
          stack: e.error && e.error.stack ? e.error.stack : null,
        },
      });

      if (window.UXErrorCatalog) {
        window.UXErrorCatalog.show(action, rootCode, message);
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
      affects_experience: true,
      payload: {
        reason,
        stack: e.reason && e.reason.stack ? e.reason.stack : null,
      },
    });
    if (window.UXErrorCatalog) {
      window.UXErrorCatalog.show("js-runtime", "UNHANDLED_REJECTION", reason);
    }
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

    // Propagate the anonymous session id to the backend so it can correlate
    // backend-side activity with the same UX session.
    if (!isMetricsUrl(url)) {
      const options = args[1] || {};
      const headers = options.headers ? { ...options.headers } : {};
      headers["X-Session-Id"] = sessionId;
      args[1] = { ...options, headers };
    }

    try {
      if (isMetricsUrl(url)) return await originalFetch.apply(this, args);

      const res = await originalFetch.apply(this, args);
      const duration = Math.round(performance.now() - start);
      const status = res.status;
      const errorCode = status >= 400 ? `FETCH_${status}` : null;
      const affectsExperience = status >= 500;
      enqueue("request", {
        method,
        url,
        status,
        duration_ms: duration,
        error_code: errorCode,
        affects_experience: affectsExperience,
        payload: { statusText: res.statusText },
      });

      if (status >= 500) {
        window.UXErrorCatalog &&
          window.UXErrorCatalog.show("network", `FETCH_${status}`, url);
      }
      return res;
    } catch (err) {
      if (isMetricsUrl(url)) throw err;
      const isAbort =
        err.name === "AbortError" ||
        /abort/i.test(err.message || "");
      if (isAbort) {
        // Intentional aborts (e.g. long-polling cancelled when WebSocket takes
        // over) are part of the normal flow and should not be reported.
        throw err;
      }
      const duration = Math.round(performance.now() - start);
      enqueue("request", {
        method,
        url,
        status: 0,
        duration_ms: duration,
        error_code: "FETCH_FAILED",
        affects_experience: true,
        payload: { message: err.message },
      });
      if (window.UXErrorCatalog) {
        window.UXErrorCatalog.show("network", "FETCH_FAILED", err.message);
      }
      throw err;
    }
  };

  // ---------------------------------------------------------------------------
  // JSON decode errors
  // ---------------------------------------------------------------------------
  const originalResponseJson = Response.prototype.json;
  Response.prototype.json = async function jsonInterceptor() {
    try {
      return await originalResponseJson.call(this);
    } catch (err) {
      const url = this.url || location.href;
      if (isMetricsUrl(url)) throw err;
      enqueue("event", {
        action: "json-decode",
        root_code: "PARSE_ERROR",
        url,
        affects_experience: true,
        payload: {
          message: err.message,
          status: this.status,
          statusText: this.statusText,
        },
      });
      if (window.UXErrorCatalog) {
        window.UXErrorCatalog.show("json-decode", "PARSE_ERROR", err.message);
      }
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
      if (isMetricsUrl(url)) return;
      const duration = Math.round(performance.now() - start);
      const status = xhr.status;
      const errorCode = status >= 400 ? `XHR_${status}` : null;
      enqueue("request", {
        method,
        url,
        status,
        duration_ms: duration,
        error_code: errorCode,
        affects_experience: status >= 500,
        payload: { statusText: xhr.statusText },
      });
    });

    xhr.send = function send(...sargs) {
      start = performance.now();
      try {
        xhr.setRequestHeader("X-Session-Id", sessionId);
      } catch {
        // Some requests may already be in a state that disallows headers.
      }
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
        affects_experience: false,
        payload: {},
      });
      if (window.UXErrorCatalog) {
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
          affects_experience: false,
          payload: { code: e.code, reason: e.reason },
        });
        if (window.UXErrorCatalog) {
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
      try {
        const nav = performance.getEntriesByType("navigation")[0];
        if (!nav) return;
        const paints = performance.getEntriesByType("paint");
        const lcpEntries = performance.getEntriesByType(
          "largest-contentful-paint"
        );

        const fcpEntry = paints.find(
          (p) => p.name === "first-contentful-paint"
        );
        const lcpEntry = lcpEntries.length
          ? lcpEntries[lcpEntries.length - 1]
          : null;

        const loadMs =
          nav.loadEventEnd != null ? Math.round(nav.loadEventEnd - nav.startTime) : null;
        const ttfbMs =
          nav.responseStart != null ? Math.round(nav.responseStart - nav.startTime) : null;

        enqueue("load", {
          url: location.href,
          load_ms: loadMs,
          ttfb_ms: ttfbMs,
          fcp_ms: fcpEntry ? Math.round(fcpEntry.startTime) : null,
          lcp_ms: lcpEntry ? Math.round(lcpEntry.startTime) : null,
          payload: {
            domComplete:
              nav.domComplete != null ? Math.round(nav.domComplete) : null,
            responseEnd:
              nav.responseEnd != null ? Math.round(nav.responseEnd) : null,
            fetchStart:
              nav.fetchStart != null ? Math.round(nav.fetchStart) : null,
          },
        });
      } catch {
        // Ignore timing errors — never break the app for telemetry.
      }
    }, 0);
  });

  window.addEventListener("beforeunload", () => {
    flush(true);
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function showErrorToast(detail) {
    let container = document.getElementById("toast-container");
    const useExistingContainer = !!container;
    if (!container) {
      container = document.getElementById("ux-error-toast-container");
    }
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
    if (useExistingContainer) {
      toast.className =
        container.children.length % 2 === 0 ? "toast-info" : "toast-error";
      toast.style.cssText =
        "background:#fff;border-left:4px solid #dc5a1e;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:12px 16px;border-radius:4px;pointer-events:auto;font-family:system-ui,-apple-system,sans-serif;";
    } else {
      toast.style.cssText =
        "background:#fff;border-left:4px solid #dc5a1e;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:12px 16px;border-radius:4px;max-width:min(480px,calc(100vw - 32px));pointer-events:auto;font-family:system-ui,-apple-system,sans-serif;";
    }

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
    trackEvent(action, rootCode, payload, affectsExperience) {
      enqueue("event", {
        action,
        root_code: rootCode,
        url: location.href,
        affects_experience: affectsExperience,
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
        affects_experience: status >= 500,
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
