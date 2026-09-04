/* QA Test Case Recorder — sidepanel companion panel (v0.9.0).
 * Loaded alongside the built React bundle (see sidepanel.html). It renders its
 * own isolated section (playback controls, step editor, issue evidence) and
 * talks to the background service worker with the same message protocol.
 * No dependency on the React bundle internals.
 */
(function () {
  "use strict";

  var CSS = [
    "#qa-plus{border-top:2px solid #6366f1;margin:0;font-family:inherit}",
    "#qa-plus .qp-wrap{padding:10px 12px}",
    "#qa-plus h2{font-size:12px;font-weight:700;margin:0 0 8px;color:inherit}",
    "#qa-plus .qp-tabs{display:flex;gap:4px;margin-bottom:8px}",
    "#qa-plus .qp-tab{flex:1;font-size:11px;padding:5px 4px;border:1px solid #cbd5e1;background:transparent;border-radius:6px;cursor:pointer;color:inherit}",
    "#qa-plus .qp-tab.on{background:#6366f1;border-color:#6366f1;color:#fff}",
    "#qa-plus .qp-row{display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap}",
    "#qa-plus button.qp-btn{font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid #6366f1;background:#6366f1;color:#fff;cursor:pointer}",
    "#qa-plus button.qp-btn.ghost{background:transparent;color:inherit;border-color:#94a3b8}",
    "#qa-plus button.qp-btn.warn{background:#dc2626;border-color:#dc2626}",
    "#qa-plus button.qp-btn:disabled{opacity:.45;cursor:default}",
    "#qa-plus select,#qa-plus input[type=text]{font-size:11px;padding:4px 6px;border:1px solid #94a3b8;border-radius:6px;background:transparent;color:inherit;max-width:100%}",
    "#qa-plus label.qp-cb{font-size:11px;display:flex;gap:4px;align-items:center}",
    "#qa-plus .qp-step{border:1px solid #e2e8f0;border-radius:8px;padding:6px;margin-bottom:6px;font-size:11px}",
    "#qa-plus .qp-step.off{opacity:.55}",
    "#qa-plus .qp-step .qp-head{display:flex;gap:6px;align-items:center}",
    "#qa-plus .qp-step .qp-act{font-weight:700}",
    "#qa-plus .qp-step .qp-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#qa-plus .qp-step .qp-grid{display:grid;grid-template-columns:52px 1fr;gap:4px 6px;margin-top:6px;align-items:center}",
    "#qa-plus .qp-step .qp-tools{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}",
    "#qa-plus .qp-step .qp-tools button{font-size:10px;padding:2px 7px;border-radius:5px;border:1px solid #94a3b8;background:transparent;color:inherit;cursor:pointer}",
    "#qa-plus .qp-badge{font-size:9px;padding:1px 6px;border-radius:99px;background:#fef3c7;color:#92400e}",
    "#qa-plus .qp-badge.ok{background:#dcfce7;color:#166534}",
    "#qa-plus .qp-badge.err{background:#fee2e2;color:#991b1b}",
    "#qa-plus .qp-badge.info{background:#e0e7ff;color:#3730a3}",
    "#qa-plus .qp-issue{border:1px solid #e2e8f0;border-radius:8px;padding:6px;margin-bottom:6px;font-size:11px}",
    "#qa-plus .qp-issue img{max-width:100%;border-radius:6px;margin-top:4px;display:block}",
    "#qa-plus .qp-issue code{font-size:10px;word-break:break-word;white-space:pre-wrap}",
    "#qa-plus .qp-empty{font-size:11px;opacity:.7;padding:8px 0}",
    "#qa-plus .qp-sum{font-size:11px;margin-bottom:6px}",
  ].join("\n");

  var state = {
    tabId: null,
    session: null,
    tab: "run",
    running: false,
    results: {}, // stepId -> {status, healedFrom, error, ambiguous}
    lastSummary: null,
  };

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(function () { return undefined; });
  }

  function refreshSession() {
    if (state.tabId == null) return Promise.resolve();
    return send({ type: "getSession", tabId: state.tabId }).then(function (s) {
      if (s) {
        state.session = s;
        render();
      }
    });
  }

  function activeTabId() {
    return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
      if (tabs && tabs[0] && tabs[0].id != null) return tabs[0].id;
      return chrome.tabs.query({ active: true }).then(function (t2) {
        return t2 && t2[0] ? t2[0].id : null;
      });
    }).catch(function () { return null; });
  }

  function stepLabel(s) {
    var t = s.target || {};
    return t.textName || t.testId || t.cssSelector || t.xpath || s.value || s.key || s.action;
  }

  /* ---------------- run ---------------- */

  function startRun(onlyStepId) {
    if (state.tabId == null || state.running) return;
    // Header Play button can fire while the Run tab (with these controls) isn't mounted.
    var stratEl = document.getElementById("qp-strategy");
    var delayEl = document.getElementById("qp-delay");
    var stopEl = document.getElementById("qp-stoponfail");
    var strategy = stratEl ? stratEl.value : "smart";
    var delay = delayEl ? parseInt(delayEl.value, 10) || 400 : 400;
    var stopOnFail = stopEl ? stopEl.checked : true;
    state.results = {};
    state.lastSummary = null;
    send({
      type: "startPlayback",
      tabId: state.tabId,
      options: { locatorStrategy: strategy, stepDelay: delay, stopOnFail: stopOnFail, onlyStepId: onlyStepId },
    }).then(function (res) {
      if (res && res.accepted === false) {
        state.lastSummary = { note: res.reason || "playback already running" };
        render();
      }
    });
  }

  function stopRun() {
    if (state.tabId == null) return;
    send({ type: "stopPlayback", tabId: state.tabId });
  }

  /* ---------------- render ---------------- */

  var root, body;
  function render() {
    if (!root) return;
    body.innerHTML = "";
    body.appendChild(renderTabs());
    if (state.tab === "run") body.appendChild(renderRun());
    else if (state.tab === "steps") body.appendChild(renderSteps());
    else body.appendChild(renderIssues());
    syncHeaderPlayButton();
  }

  function renderTabs() {
    var bar = el("div", "qp-tabs");
    [["run", "▶ Run"], ["steps", "✎ Steps"], ["issues", "⚠ Issues"]].forEach(function (t) {
      var b = el("button", "qp-tab" + (state.tab === t[0] ? " on" : ""), t[1]);
      b.onclick = function () { state.tab = t[0]; render(); };
      bar.appendChild(b);
    });
    return bar;
  }

  function renderRun() {
    var w = el("div");
    var row = el("div", "qp-row");
    var go = el("button", "qp-btn", state.running ? "Running…" : "▶ Run all");
    go.disabled = state.running || !state.session || !state.session.steps.length;
    go.onclick = function () { startRun(undefined); };
    var stop = el("button", "qp-btn warn", "⏹ Stop");
    stop.disabled = !state.running;
    stop.onclick = stopRun;
    row.appendChild(go);
    row.appendChild(stop);
    w.appendChild(row);

    var row2 = el("div", "qp-row");
    var strat = document.createElement("select");
    strat.id = "qp-strategy";
    ["smart", "xpath", "css"].forEach(function (s) {
      var o = document.createElement("option");
      o.value = s;
      o.textContent = s === "smart" ? "Smart (test-id → role → XPath)" : s === "xpath" ? "XPath only" : "CSS only";
      strat.appendChild(o);
    });
    var del = document.createElement("select");
    del.id = "qp-delay";
    [["200", "fast"], ["400", "normal"], ["1000", "slow"]].forEach(function (d) {
      var o = document.createElement("option");
      o.value = d[0];
      o.textContent = d[1];
      if (d[0] === "400") o.selected = true;
      del.appendChild(o);
    });
    var lab = el("label", "qp-cb");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "qp-stoponfail";
    cb.checked = true;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode("stop on fail"));
    row2.appendChild(strat);
    row2.appendChild(del);
    row2.appendChild(lab);
    w.appendChild(row2);

    if (state.lastSummary) {
      var s = state.lastSummary;
      var sum = el("div", "qp-sum",
        s.note || ("passed " + (s.passed || 0) + " · failed " + (s.failed || 0) + " · skipped " + (s.skipped || 0)));
      w.appendChild(sum);
    }

    var steps = state.session ? state.session.steps : [];
    if (!steps.length) {
      w.appendChild(el("div", "qp-empty", "No steps recorded yet."));
      return w;
    }
    steps.forEach(function (st) {
      var r = state.results[st.id];
      var line = el("div", "qp-row");
      var badge = null;
      if (st.disabled) badge = el("span", "qp-badge", "disabled");
      else if (r && r.status === "passed") badge = el("span", "qp-badge ok", r.healedFrom ? "healed via " + r.healedFrom : "passed");
      else if (r && r.status === "failed") badge = el("span", "qp-badge err", "failed");
      else if (r && r.status === "skipped") badge = el("span", "qp-badge", "skipped");
      line.appendChild(el("span", null, "#" + st.seq + " " + st.action));
      if (badge) line.appendChild(badge);
      if (r && r.healedFrom && r.status === "passed" && !st.disabled) {
        var hb = el("span", "qp-badge info", "healed: " + r.healedFrom);
        hb.title = "Original locator failed; fallback '" + r.healedFrom + "' matched. Edit the step to adopt it.";
        line.appendChild(hb);
      }
      var one = el("button", "qp-btn ghost", "run");
      one.style.fontSize = "10px";
      one.style.padding = "2px 8px";
      one.disabled = state.running;
      one.onclick = (function (id) { return function () { startRun(id); }; })(st.id);
      line.appendChild(one);
      if (r && r.error) line.appendChild(el("div", null, r.error));
      w.appendChild(line);
    });
    return w;
  }

  function renderSteps() {
    var w = el("div");
    var steps = state.session ? state.session.steps : [];
    if (!steps.length) {
      w.appendChild(el("div", "qp-empty", "No steps recorded yet."));
      return w;
    }
    steps.forEach(function (st, idx) {
      var box = el("div", "qp-step" + (st.disabled ? " off" : ""));
      var head = el("div", "qp-head");
      var dis = document.createElement("input");
      dis.type = "checkbox";
      dis.checked = !st.disabled;
      dis.title = "enabled";
      dis.onchange = (function (id) {
        return function () { send({ type: "toggleStep", tabId: state.tabId, stepId: id, disabled: !dis.checked }); };
      })(st.id);
      head.appendChild(dis);
      head.appendChild(el("span", "qp-act", "#" + st.seq + " " + st.action));
      head.appendChild(el("span", "qp-lbl", stepLabel(st)));
      box.appendChild(head);

      var grid = el("div", "qp-grid");
      function field(label, key, val) {
        grid.appendChild(el("span", null, label));
        var inp = document.createElement("input");
        inp.type = "text";
        inp.value = val == null ? "" : String(val);
        inp.onchange = (function (k) {
          return function () {
            var p = {};
            p[k] = inp.value;
            send({ type: "updateStep", tabId: state.tabId, stepId: st.id, patch: p });
          };
        })(key);
        grid.appendChild(inp);
      }
      if (st.action === "fill" || st.action === "select" || st.action.indexOf("assert") === 0 || st.action === "assertTextPresent") {
        field(st.variable ? "var" : "value", "value", st.variable ? "${" + st.variable + "}" : st.value);
      }
      if (st.action === "press") field("key", "key", st.key);
      if (st.action === "navigate") field("url", "url", st.value || st.url);
      field("note", "note", st.note);
      box.appendChild(grid);

      var tools = el("div", "qp-tools");
      function tool(label, fn) {
        var b = el("button", null, label);
        b.onclick = fn;
        tools.appendChild(b);
      }
      tool("↑", function () { moveStep(idx, -1); });
      tool("↓", function () { moveStep(idx, 1); });
      tool("duplicate", function () { send({ type: "duplicateStep", tabId: state.tabId, stepId: st.id }); });
      tool("delete", function () {
        if (confirm("Delete step #" + st.seq + " (" + st.action + ")?")) {
          send({ type: "deleteStep", tabId: state.tabId, stepId: st.id });
        }
      });
      box.appendChild(tools);
      w.appendChild(box);
    });
    return w;
  }

  function moveStep(idx, dir) {
    var steps = state.session ? state.session.steps : [];
    var ids = steps.map(function (s) { return s.id; });
    var j = idx + dir;
    if (idx < 0 || j < 0 || j >= ids.length) return;
    var t = ids[idx];
    ids[idx] = ids[j];
    ids[j] = t;
    send({ type: "reorderSteps", tabId: state.tabId, stepIds: ids });
  }

  function renderIssues() {
    var w = el("div");
    var issues = state.session ? state.session.issues : [];
    if (!issues.length) {
      w.appendChild(el("div", "qp-empty", "No issues detected during this recording."));
      return w;
    }
    issues.slice().reverse().forEach(function (is) {
      var box = el("div", "qp-issue");
      var head = el("div", "qp-row");
      var sev = el("span", "qp-badge " + (is.severity === "error" ? "err" : ""), is.severity || "info");
      head.appendChild(sev);
      head.appendChild(el("span", null, is.kind + (is.count > 1 ? " ×" + is.count : "")));
      if (is.method) head.appendChild(el("span", "qp-badge info", is.method));
      box.appendChild(head);
      var msg = el("code", null, is.message || "");
      box.appendChild(msg);
      if (is.screenshot) {
        var img = document.createElement("img");
        img.src = is.screenshot;
        img.alt = "error screenshot";
        img.loading = "lazy";
        box.appendChild(img);
      }
      w.appendChild(box);
    });
    return w;
  }

  /* --------- header Play button (beside Record, shown when not recording) --------- */

  function findRecordButton() {
    var rootEl = document.getElementById("root");
    if (!rootEl || !rootEl.querySelectorAll) return null;
    var btns = rootEl.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent || "";
      if (t.indexOf("Start recording") >= 0 || t.indexOf("Stop recording") >= 0) return btns[i];
    }
    return null;
  }

  function syncHeaderPlayButton() {
    if (typeof document.querySelector !== "function") return;
    var rec = findRecordButton();
    var ours = document.querySelector("[data-qa-plus-play]");
    var recording = !!(state.session && state.session.recording);
    if (!rec || !rec.parentNode || recording) {
      if (ours) ours.remove();
      return;
    }
    if (!ours) {
      ours = document.createElement("button");
      ours.setAttribute("data-qa-plus-play", "1");
      rec.parentNode.insertBefore(ours, rec.nextSibling);
    }
    ours.textContent = state.running ? "⏹ Stop" : "▶ Play";
    ours.title = state.running ? "Stop playback" : "Play recorded steps";
    try {
      ours.className = rec.className;
    } catch (e) {}
    var hasSteps = !!(state.session && state.session.steps && state.session.steps.length);
    ours.disabled = state.tabId == null || (!state.running && !hasSteps);
    ours.onclick = function () {
      if (state.running) stopRun();
      else startRun(undefined);
    };
  }

  var headerObsTimer = null;
  function watchHeader() {
    var rootEl = document.getElementById("root");
    if (!rootEl || typeof MutationObserver === "undefined") return;
    var obs = new MutationObserver(function () {
      if (headerObsTimer) return;
      headerObsTimer = setTimeout(function () {
        headerObsTimer = null;
        syncHeaderPlayButton();
      }, 120);
    });
    obs.observe(rootEl, { childList: true, subtree: true });
  }

  /* ---------------- boot ---------------- */

  function boot() {
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    root = el("section", null);
    root.id = "qa-plus";
    var wrap = el("div", "qp-wrap");
    wrap.appendChild(el("h2", null, "QA Plus — playback · steps · evidence"));
    body = el("div");
    wrap.appendChild(body);
    root.appendChild(wrap);
    document.body.appendChild(root);
    watchHeader();

    activeTabId().then(function (id) {
      state.tabId = id;
      return refreshSession();
    });

    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "sessionChanged" && msg.session) {
        if (state.tabId == null || msg.session.tabId === state.tabId) {
          state.session = msg.session;
          render();
        }
      } else if (msg.type === "playbackEvent" && msg.tabId === state.tabId) {
        var e = msg.event || {};
        if (e.phase === "started") {
          state.running = true;
          state.results = {};
          state.lastSummary = null;
        } else if (e.phase === "step") {
          state.results[e.id] = e;
        } else if (e.phase === "done" || e.phase === "stopped") {
          state.running = false;
          state.lastSummary = e.phase === "stopped" ? { note: "stopped" } : e;
        }
        render();
      }
    });

    chrome.tabs.onActivated.addListener(function (a) {
      state.tabId = a.tabId;
      state.results = {};
      state.lastSummary = null;
      refreshSession();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
