/* QA Test Case Recorder — page probe (MAIN world, all frames).
 * v0.9.0: console/network/page-error reporting (as before),
 * plus: HTTP method on network issues + long-task (blocked UI) warnings.
 *
 * Reports via window.postMessage to the isolated-world recorder, which
 * forwards them to the background as issues:
 *   { source:"qa-plugin-probe", kind, severity, message, detail, stack, method }
 */
(function () {
  "use strict";

  var WINDOW_MS = 5000;
  var MAX_PER_WINDOW = 40;
  var LONGTASK_MS = 200;

  var windowStart = Date.now();
  var sentInWindow = 0;
  var sending = false;

  function clip(s, n) {
    s = s == null ? "" : String(s);
    return s.length > n ? s.slice(0, n) : s;
  }

  function report(kind, severity, message, detail, stack, method) {
    if (sending) return;
    var now = Date.now();
    if (now - windowStart > WINDOW_MS) {
      windowStart = now;
      sentInWindow = 0;
    }
    if (sentInWindow >= MAX_PER_WINDOW) return;
    sentInWindow += 1;
    sending = true;
    try {
      window.postMessage(
        {
          source: "qa-plugin-probe",
          kind: kind,
          severity: severity,
          message: clip(message, 500),
          detail: detail == null ? undefined : clip(detail, 1000),
          stack: stack == null ? undefined : clip(stack, 2000),
          method: method == null ? undefined : clip(method, 16),
        },
        location.origin === "null" ? "*" : location.origin
      );
    } finally {
      sending = false;
    }
  }

  function describe(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message;
    try {
      return JSON.stringify(v) != null ? JSON.stringify(v) : String(v);
    } catch (e) {
      return String(v);
    }
  }

  function main() {
    // console errors/warnings
    [["error", "console-error", "error"], ["warn", "console-warning", "warning"]].forEach(function (cfg) {
      var fn = cfg[0], kind = cfg[1], sev = cfg[2];
      var orig = console[fn].bind(console);
      console[fn] = function () {
        var args = Array.prototype.slice.call(arguments);
        var first = args[0];
        report(kind, sev, args.map(describe).join(" "), undefined, first instanceof Error ? first.stack : undefined);
        return orig.apply(null, args);
      };
    });

    // page errors + resource errors + rejections
    window.addEventListener(
      "error",
      function (e) {
        var t = e.target;
        if (t instanceof HTMLElement && t !== window) {
          var src = t.getAttribute("src") || t.getAttribute("href") || "(unknown)";
          report("resource-error", "error", "Failed to load <" + t.localName + ">: " + src);
          return;
        }
        report(
          "uncaught-error",
          "error",
          e.message || "Uncaught error",
          e.filename + ":" + e.lineno + ":" + e.colno,
          e.error instanceof Error ? e.error.stack : undefined
        );
      },
      true
    );

    window.addEventListener("unhandledrejection", function (e) {
      var r = e.reason;
      report("unhandled-rejection", "error", describe(r), undefined, r instanceof Error ? r.stack : undefined);
    });

    // blocked-UI detection (perf evidence for bug reports)
    try {
      if (typeof PerformanceObserver !== "undefined") {
        var po = new PerformanceObserver(function (list) {
          var entries = list.getEntries() || [];
          for (var i = 0; i < entries.length; i++) {
            var dur = Math.round(entries[i].duration || 0);
            if (dur >= LONGTASK_MS) {
              report("slow-task", "warning", "Main thread blocked for " + dur + "ms");
            }
          }
        });
        po.observe({ entryTypes: ["longtask"] });
      }
    } catch (e) {}

    // fetch failures (with method)
    var rawFetch = window.fetch;
    window.fetch = function () {
      var args = arguments;
      var input = args[0];
      var init = args[1] || {};
      var url = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
      var method = (init && init.method) || (input instanceof Request && input.method) || "GET";
      return rawFetch.apply(this, args).then(
        function (res) {
          if (!res.ok) {
            report("http-error", res.status >= 500 ? "error" : "warning", res.status + " " + res.statusText + " — " + url, undefined, undefined, method);
          }
          return res;
        },
        function (err) {
          report("network-failure", "error", "fetch failed — " + url, describe(err), undefined, method);
          throw err;
        }
      );
    };

    // XHR failures (with method)
    var rawOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var rest = Array.prototype.slice.call(arguments, 2);
      var m = typeof method === "string" ? method : "GET";
      var u = typeof url === "string" ? url : (url && url.href) || String(url);
      this.addEventListener("load", function () {
        if (this.status >= 400) {
          report("http-error", this.status >= 500 ? "error" : "warning", this.status + " " + this.statusText + " — " + m + " " + u, undefined, undefined, m);
        }
      });
      this.addEventListener("error", function () {
        report("network-failure", "error", "XHR failed — " + m + " " + u, undefined, undefined, m);
      });
      return rawOpen.apply(this, [method, url].concat(rest));
    };
  }

  try {
    main();
  } catch (e) {
    console.error('The content script "probe" crashed on startup!', e);
    throw e;
  }
})();
