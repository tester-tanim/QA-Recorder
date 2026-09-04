/* QA Test Case Recorder — background service worker.
 * v0.9.0: sessions + issues + variables + context menus (as before),
 * plus: step editing (update/reorder/toggle/duplicate), in-tab playback
 * orchestration with self-healing executor, and error screenshots.
 *
 * Message protocol (all cases also accepted from before):
 *   step{step} / issue{issue} / getSession{tabId?}
 *   startRecording{tabId} / stopRecording{tabId}
 *   clearSession{tabId} / renameSession{tabId,title}
 *   deleteStep{tabId,stepId} / annotateStep{tabId,stepId,note}
 *   updateStep{tabId,stepId,patch} / reorderSteps{tabId,stepIds}
 *   toggleStep{tabId,stepId,disabled} / duplicateStep{tabId,stepId}
 *   getVariables{} / startPlayback{tabId,options?} / stopPlayback{tabId}
 *
 * Broadcasts: {type:"sessionChanged",session} and {type:"playbackEvent",tabId,event}.
 * Tab messages: setVariables / setRecording / captureAssertion.
 */

var __qa = (function () {
  "use strict";

  /* ---------------- ids + session model ---------------- */

  var __seq = 0;
  function uid(prefix) {
    __seq += 1;
    return prefix + "_" + Date.now().toString(36) + __seq.toString(36);
  }

  function blankSession(tabId, title) {
    return {
      id: "s_" + tabId + "_" + Date.now().toString(36),
      tabId: tabId,
      title: title || "Untitled test case",
      startedAt: Date.now(),
      recording: false,
      playbackActive: false,
      steps: [],
      issues: [],
      nextSeq: 1,
    };
  }

  var sessionKey = function (tabId) {
    return "session:" + tabId;
  };

  /* Serialize mutations per tab so storage read-modify-write can't interleave. */
  var chains = new Map();
  function chain(tabId, fn) {
    var prev = chains.get(tabId) || Promise.resolve();
    var next = prev.then(fn, fn);
    chains.set(tabId, next.catch(function () {}));
    return next;
  }

  function loadSession(tabId) {
    return chrome.storage.local.get(sessionKey(tabId)).then(function (got) {
      return got[sessionKey(tabId)] || blankSession(tabId);
    });
  }

  function saveSession(session) {
    var o = {};
    o[sessionKey(session.tabId)] = session;
    return chrome.storage.local.set(o).then(function () {
      return session;
    });
  }

  function mutate(tabId, fn) {
    return chain(tabId, function () {
      return loadSession(tabId).then(function (s) {
        return saveSession(fn(s));
      });
    });
  }

  function setRecording(tabId, on) {
    return mutate(tabId, function (s) {
      return Object.assign({}, s, {
        recording: on,
        startedAt: on && s.steps.length === 0 ? Date.now() : s.startedAt,
      });
    });
  }

  function setPlaybackActive(tabId, on) {
    return mutate(tabId, function (s) {
      return Object.assign({}, s, { playbackActive: on });
    });
  }

  function addStep(tabId, step) {
    return mutate(tabId, function (s) {
      if (!s.recording || s.playbackActive) return s; // never record our own playback
      var last = s.steps[s.steps.length - 1];
      if (last && step.upsertKey && last.upsertKey === step.upsertKey) {
        var merged = s.steps.slice(0, -1).concat([Object.assign({}, step, { seq: last.seq })]);
        return Object.assign({}, s, { steps: merged });
      }
      var stamped = Object.assign({}, step, { seq: s.nextSeq });
      return Object.assign({}, s, {
        steps: s.steps.concat([stamped]).slice(-500),
        nextSeq: s.nextSeq + 1,
      });
    });
  }

  function issueKey(issue) {
    return issue.kind + "::" + issue.message;
  }

  function addIssue(tabId, issue) {
    return mutate(tabId, function (s) {
      var k = issueKey(issue);
      var idx = -1;
      for (var i = 0; i < s.issues.length; i++) {
        if (issueKey(s.issues[i]) === k) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        var copy = s.issues.slice();
        copy[idx] = Object.assign({}, copy[idx], { count: copy[idx].count + 1 });
        return Object.assign({}, s, { issues: copy });
      }
      var lastStep = s.steps[s.steps.length - 1];
      var fresh = Object.assign({}, issue, {
        count: 1,
        nearStepId: issue.nearStepId != null ? issue.nearStepId : lastStep ? lastStep.id : undefined,
      });
      return Object.assign({}, s, { issues: s.issues.concat([fresh]).slice(-200) });
    });
  }

  function clearSession(tabId) {
    return mutate(tabId, function (s) {
      var fresh = blankSession(tabId, s.title);
      fresh.id = uid("s");
      fresh.recording = s.recording;
      return fresh;
    });
  }

  function renameSession(tabId, title) {
    return mutate(tabId, function (s) {
      return Object.assign({}, s, { title: title });
    });
  }

  function deleteStep(tabId, stepId) {
    return mutate(tabId, function (s) {
      return Object.assign({}, s, { steps: s.steps.filter(function (x) { return x.id !== stepId; }) });
    });
  }

  function annotateStep(tabId, stepId, note) {
    return mutate(tabId, function (s) {
      return Object.assign({}, s, {
        steps: s.steps.map(function (x) {
          return x.id === stepId ? Object.assign({}, x, { note: note }) : x;
        }),
      });
    });
  }

  var EDITABLE_FIELDS = ["value", "key", "url", "note", "variable", "disabled"];
  function updateStep(tabId, stepId, patch) {
    var clean = {};
    EDITABLE_FIELDS.forEach(function (f) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, f)) clean[f] = patch[f];
    });
    return mutate(tabId, function (s) {
      return Object.assign({}, s, {
        steps: s.steps.map(function (x) {
          return x.id === stepId ? Object.assign({}, x, clean) : x;
        }),
      });
    });
  }

  function reorderSteps(tabId, stepIds) {
    return mutate(tabId, function (s) {
      var byId = {};
      s.steps.forEach(function (x) { byId[x.id] = x; });
      var ordered = [];
      (stepIds || []).forEach(function (id) {
        if (byId[id]) {
          ordered.push(byId[id]);
          delete byId[id];
        }
      });
      // keep any steps missing from the list (shouldn't happen) at the end
      s.steps.forEach(function (x) {
        if (byId[x.id]) ordered.push(x);
      });
      // renumber seq so exports stay ordered
      ordered = ordered.map(function (x, i) {
        return Object.assign({}, x, { seq: i + 1 });
      });
      return Object.assign({}, s, { steps: ordered, nextSeq: ordered.length + 1 });
    });
  }

  function toggleStep(tabId, stepId, disabled) {
    return updateStep(tabId, stepId, { disabled: !!disabled });
  }

  function duplicateStep(tabId, stepId) {
    return mutate(tabId, function (s) {
      var idx = -1;
      for (var i = 0; i < s.steps.length; i++) {
        if (s.steps[i].id === stepId) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return s;
      var copy = Object.assign({}, s.steps[idx], {
        id: uid("step"),
        seq: s.nextSeq,
        note: undefined,
      });
      delete copy.upsertKey;
      var steps = s.steps.slice();
      steps.splice(idx + 1, 0, copy);
      // renumber
      steps = steps.map(function (x, j) {
        return Object.assign({}, x, { seq: j + 1 });
      });
      return Object.assign({}, s, { steps: steps.slice(-500), nextSeq: steps.length + 1 });
    });
  }

  function dropSession(tabId) {
    chains.delete(tabId);
    return chrome.storage.local.remove(sessionKey(tabId));
  }

  /* ---------------- variables ---------------- */

  var VARS_KEY = "variables";
  function loadVariables() {
    return chrome.storage.local.get(VARS_KEY).then(function (got) {
      return ((got && got[VARS_KEY]) || []).slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
      });
    });
  }

  /* ---------------- messaging helpers ---------------- */

  function sendToTab(tabId, msg) {
    chrome.tabs.sendMessage(tabId, msg).catch(function () {});
  }

  function broadcast(session) {
    chrome.runtime.sendMessage({ type: "sessionChanged", session: session }).catch(function () {});
  }

  function broadcastAndReturn(session) {
    broadcast(session);
    return session;
  }

  function emitPlayback(tabId, event) {
    chrome.runtime
      .sendMessage({ type: "playbackEvent", tabId: tabId, event: event })
      .catch(function () {});
  }

  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  /* ---------------- injection ---------------- */

  var FILES = {
    probe: "content-scripts/probe.js",
    recorder: "content-scripts/recorder.js",
    playback: "content-scripts/playback.js",
  };

  function injectOne(tabId, file, world) {
    var opts = { target: { tabId: tabId, allFrames: true }, files: [file] };
    if (world) opts.world = world;
    return chrome.scripting.executeScript(opts).catch(function () {});
  }

  // Recorder + probe (as before), now also the playback executor.
  function ensureInjected(tabId) {
    return chrome.tabs
      .sendMessage(tabId, { type: "ping" })
      .catch(function () {
        return injectOne(tabId, FILES.probe, "MAIN")
          .then(function () { return injectOne(tabId, FILES.recorder); })
          .then(function () { return injectOne(tabId, FILES.playback); });
      })
      .then(function () {
        // playback.js may be newer than the page's scripts; best-effort top-up
        return chrome.tabs
          .sendMessage(tabId, { type: "qa-ping-executor", }, { frameId: 0 })
          .catch(function () { return injectOne(tabId, FILES.playback); });
      })
      .catch(function () {});
  }

  function isHttp(url) {
    return !!url && /^https?:\/\//.test(url);
  }

  function seedNavigate(tabId, session) {
    if (session.steps.length > 0) return Promise.resolve(session);
    return chrome.tabs.get(tabId).catch(function () { return undefined; }).then(function (tab) {
      if (tab && isHttp(tab.url)) {
        return addStep(tabId, {
          id: uid("step"),
          action: "navigate",
          value: tab.url,
          url: tab.url,
          timestamp: Date.now(),
        });
      }
      return session;
    });
  }

  /* ---------------- bug evidence: error screenshots ---------------- */

  var lastShotAt = new Map();
  var SHOT_COOLDOWN_MS = 3000;
  var SHOT_KEEP = 20;

  function maybeScreenshot(tabId, windowId, issueId) {
    var now = Date.now();
    if (now - (lastShotAt.get(tabId) || 0) < SHOT_COOLDOWN_MS) return;
    lastShotAt.set(tabId, now);
    loadSession(tabId)
      .then(function (s) {
        if (!s.recording) return;
        return chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 40 }).catch(function () {
          return null;
        }).then(function (dataUrl) {
          if (!dataUrl) return;
          return mutate(tabId, function (cur) {
            var issues = cur.issues.map(function (x) {
              return x.id === issueId ? Object.assign({}, x, { screenshot: dataUrl }) : x;
            });
            // bound storage: keep screenshots only on the newest SHOT_KEEP issues
            var withShot = [];
            issues.forEach(function (x, i) { if (x.screenshot) withShot.push(i); });
            while (withShot.length > SHOT_KEEP) {
              var drop = withShot.shift();
              issues[drop] = Object.assign({}, issues[drop], { screenshot: undefined });
            }
            return Object.assign({}, cur, { issues: issues });
          }).then(broadcast);
        });
      })
      .catch(function () {});
  }

  /* ---------------- playback orchestration ---------------- */

  var playback = new Map(); // tabId -> { stop, token }

  function sendToExecutor(tabId, msg, timeoutMs) {
    function once(options) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (!done) {
            done = true;
            reject(new Error("executor timeout"));
          }
        }, timeoutMs);
        var p = options
          ? chrome.tabs.sendMessage(tabId, msg, options)
          : chrome.tabs.sendMessage(tabId, msg);
        p.then(
          function (res) {
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolve(res);
            }
          },
          function (err) {
            if (!done) {
              done = true;
              clearTimeout(timer);
              reject(err);
            }
          }
        );
      });
    }
    // Prefer the main frame so exactly one executor answers.
    return once({ frameId: 0 }).catch(function () { return once(); });
  }

  function waitForTabComplete(tabId, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        try {
          chrome.tabs.onUpdated.removeListener(onUpd);
        } catch (e) {}
        resolve(ok);
      }
      function onUpd(id, info) {
        if (id === tabId && info.status === "complete") finish(true);
      }
      try {
        chrome.tabs.onUpdated.addListener(onUpd);
      } catch (e) {
        finish(false);
        return;
      }
      setTimeout(function () { finish(false); }, timeoutMs);
    });
  }

  function doNavigate(tabId, url) {
    return chrome.tabs.update(tabId, { url: url }).then(
      function () {
        return waitForTabComplete(tabId, 20000).then(function (completed) {
          return completed
            ? { ok: true }
            : { ok: false, error: "navigation timed out waiting for page load" };
        });
      },
      function (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    );
  }

  function runPlayback(tabId, opts, token) {
    opts = opts || {};
    var delay = typeof opts.stepDelay === "number" ? opts.stepDelay : 400;
    var stopOnFail = opts.stopOnFail !== false;
    var strategy = opts.locatorStrategy || "smart";
    var onlyStepId = opts.onlyStepId;

    return loadSession(tabId)
      .then(function (s) {
        var steps = onlyStepId ? s.steps.filter(function (x) { return x.id === onlyStepId; }) : s.steps.slice();
        return loadVariables().then(function (vars) {
          var varMap = {};
          vars.forEach(function (v) { varMap[v.name] = v.value; });
          return { steps: steps, varMap: varMap };
        });
      })
      .then(function (ctx) {
        emitPlayback(tabId, { phase: "started", total: ctx.steps.length });
        var chain = Promise.resolve();
        var summary = { passed: 0, failed: 0, skipped: 0 };
        ctx.steps.forEach(function (step) {
          chain = chain.then(function () {
            var st = playback.get(tabId);
            if (!st || st.stop || st.token !== token) {
              var abort = new Error("__qa_stop__");
              abort.__qaStop = true;
              throw abort;
            }
            return loadSession(tabId).then(function (fresh) {
              var live = null;
              for (var i = 0; i < fresh.steps.length; i++) {
                if (fresh.steps[i].id === step.id) {
                  live = fresh.steps[i];
                  break;
                }
              }
              var cur = live || step;
              if (cur.disabled) {
                summary.skipped++;
                emitPlayback(tabId, { phase: "step", id: cur.id, action: cur.action, status: "skipped" });
                return null;
              }
              var exec = cur.action === "navigate"
                ? doNavigate(tabId, cur.value)
                : sendToExecutor(
                    tabId,
                    {
                      type: "qa-execute-step",
                      step: cur,
                      variables: ctx.varMap,
                      locatorStrategy: strategy,
                      requestId: uid("q"),
                    },
                    25000
                  ).catch(function (err) {
                    return { ok: false, error: "executor unreachable — reload the page and retry (" + String((err && err.message) || err) + ")" };
                  });
              return exec.then(function (res) {
                res = res || { ok: false, error: "empty executor response" };
                if (res.ok) summary.passed++;
                else summary.failed++;
                emitPlayback(tabId, {
                  phase: "step",
                  id: cur.id,
                  action: cur.action,
                  status: res.ok ? "passed" : "failed",
                  healedFrom: res.healedFrom,
                  ambiguous: res.ambiguous,
                  error: res.error,
                  actual: res.actual,
                });
                if (!res.ok && stopOnFail) {
                  var halt = new Error("__qa_fail__");
                  halt.__qaFail = true;
                  throw halt;
                }
                return sleep(delay);
              });
            });
          });
        });
        return chain.then(
          function () { return { stopped: false, summary: summary }; },
          function (err) {
            if (err && (err.__qaStop || err.__qaFail)) return { stopped: !!(err && err.__qaStop), summary: summary };
            throw err;
          }
        );
      })
      .then(function (out) {
        var st = playback.get(tabId);
        if (st && st.token === token) playback.delete(tabId);
        return setPlaybackActive(tabId, false).catch(function () {}).then(function () {
          emitPlayback(tabId, {
            phase: out.stopped ? "stopped" : "done",
            passed: out.summary.passed,
            failed: out.summary.failed,
            skipped: out.summary.skipped,
          });
        });
      })
      .catch(function (err) {
        var st = playback.get(tabId);
        if (st && st.token === token) playback.delete(tabId);
        return setPlaybackActive(tabId, false).catch(function () {}).then(function () {
          emitPlayback(tabId, { phase: "done", passed: 0, failed: 0, skipped: 0, error: String((err && err.message) || err) });
        });
      });
  }

  function startPlayback(tabId, options) {
    if (playback.has(tabId)) return Promise.resolve({ accepted: false, reason: "already running" });
    var token = uid("pb");
    playback.set(tabId, { stop: false, token: token });
    return ensureInjected(tabId)
      .then(function () { return loadSession(tabId); })
      .then(function (s) {
        var total = options && options.onlyStepId
          ? s.steps.filter(function (x) { return x.id === options.onlyStepId; }).length
          : s.steps.length;
        return setPlaybackActive(tabId, true).then(function () {
          // fire-and-forget: progress arrives via playbackEvent broadcasts
          runPlayback(tabId, options || {}, token);
          return { accepted: true, total: total };
        });
      });
  }

  /* ---------------- main message router ---------------- */

  var ASSERT_ITEMS = [
    { id: "assertTextPresent", title: "Assert this text appears on the page" },
    { id: "assertText", title: "Assert this element's text" },
    { id: "assertValue", title: "Assert this field's value" },
    { id: "assertVisible", title: "Assert this element is visible" },
    { id: "assertHidden", title: "Assert this element is hidden" },
    { id: "assertUrl", title: "Assert the page URL" },
  ];

  function buildMenus() {
    chrome.contextMenus.removeAll(function () {
      chrome.contextMenus.create({ id: "qa-assert-root", title: "QA — add assertion", contexts: ["all"] });
      ASSERT_ITEMS.forEach(function (it) {
        chrome.contextMenus.create({ id: it.id, parentId: "qa-assert-root", title: it.title, contexts: ["all"] });
      });
    });
  }

  function route(msg, sender) {
    var fromTab = sender && sender.tab ? sender.tab.id : undefined;
    var tabId = fromTab != null ? fromTab : msg.tabId;
    switch (msg.type) {
      case "step":
        if (fromTab == null) return undefined;
        return addStep(fromTab, msg.step).then(broadcastAndReturn);
      case "issue": {
        if (fromTab == null) return undefined;
        var winId = sender.tab.windowId;
        return addIssue(fromTab, msg.issue).then(function (s) {
          broadcast(s);
          var saved = null;
          for (var i = s.issues.length - 1; i >= 0; i--) {
            if (issueKey(s.issues[i]) === issueKey(msg.issue)) {
              saved = s.issues[i];
              break;
            }
          }
          if (saved && msg.issue.severity === "error") {
            maybeScreenshot(fromTab, winId, saved.id);
          }
          return s;
        });
      }
      case "getSession":
        return loadSession(tabId);
      case "getVariables":
        return loadVariables().then(function (v) { return { variables: v }; });
      case "startRecording": {
        var pb1 = playback.get(msg.tabId);
        if (pb1) pb1.stop = true;
        return ensureInjected(msg.tabId)
          .then(function () { return setRecording(msg.tabId, true); })
          .then(function (s) { return seedNavigate(msg.tabId, s); })
          .then(function (s) {
            return loadVariables().then(function (vars) {
              sendToTab(msg.tabId, { type: "setVariables", variables: vars });
              sendToTab(msg.tabId, { type: "setRecording", recording: true });
              return broadcastAndReturn(s);
            });
          });
      }
      case "stopRecording": {
        var pb2 = playback.get(msg.tabId);
        if (pb2) pb2.stop = true;
        return setRecording(msg.tabId, false).then(function (s) {
          sendToTab(msg.tabId, { type: "setRecording", recording: false });
          return broadcastAndReturn(s);
        });
      }
      case "clearSession":
        return clearSession(msg.tabId).then(broadcastAndReturn);
      case "renameSession":
        return renameSession(msg.tabId, msg.title).then(broadcastAndReturn);
      case "deleteStep":
        return deleteStep(msg.tabId, msg.stepId).then(broadcastAndReturn);
      case "annotateStep":
        return annotateStep(msg.tabId, msg.stepId, msg.note).then(broadcastAndReturn);
      case "updateStep":
        return updateStep(msg.tabId, msg.stepId, msg.patch).then(broadcastAndReturn);
      case "reorderSteps":
        return reorderSteps(msg.tabId, msg.stepIds).then(broadcastAndReturn);
      case "toggleStep":
        return toggleStep(msg.tabId, msg.stepId, msg.disabled).then(broadcastAndReturn);
      case "duplicateStep":
        return duplicateStep(msg.tabId, msg.stepId).then(broadcastAndReturn);
      case "startPlayback":
        return startPlayback(msg.tabId, msg.options);
      case "stopPlayback": {
        var pb3 = playback.get(msg.tabId);
        if (pb3) pb3.stop = true;
        return Promise.resolve({ stopped: true });
      }
      default:
        return undefined;
    }
  }

  function main() {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
    }
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      var out;
      try {
        out = route(msg || {}, sender || {});
      } catch (e) {
        out = Promise.reject(e);
      }
      if (out instanceof Promise) {
        out.then(respond, function () { respond(undefined); });
        return true;
      }
      return undefined;
    });
    buildMenus();
    chrome.runtime.onInstalled.addListener(buildMenus);

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes || !("variables" in changes)) return;
      loadVariables().then(function (vars) {
        chrome.tabs.query({}).then(function (tabs) {
          tabs.forEach(function (t) {
            if (t.id != null) sendToTab(t.id, { type: "setVariables", variables: vars });
          });
        });
      });
    });

    chrome.contextMenus.onClicked.addListener(function (info, tab) {
      if (!tab || tab.id == null) return;
      var id = info.menuItemId;
      for (var i = 0; i < ASSERT_ITEMS.length; i++) {
        if (ASSERT_ITEMS[i].id === id) {
          sendToTab(tab.id, { type: "captureAssertion", kind: id });
          return;
        }
      }
    });

    chrome.tabs.onUpdated.addListener(function (tabId, info) {
      if (info.status !== "complete" || !info.url) return;
      loadSession(tabId).then(function (s) {
        if (!s.recording || s.playbackActive) return;
        var last = s.steps[s.steps.length - 1];
        if (last && last.action === "navigate" && last.value === info.url) return;
        addStep(tabId, {
          id: uid("step"),
          action: "navigate",
          value: info.url,
          url: info.url,
          timestamp: Date.now(),
        }).then(function (updated) {
          broadcast(updated);
          sendToTab(tabId, { type: "setRecording", recording: true });
        });
      });
    });

    chrome.tabs.onActivated.addListener(function (active) {
      loadSession(active.tabId).then(broadcast);
    });

    chrome.tabs.onRemoved.addListener(function (tabId) {
      playback.delete(tabId);
      lastShotAt.delete(tabId);
      dropSession(tabId);
    });

    chrome.runtime.onStartup.addListener(function () {
      chrome.tabs.query({}).then(function (tabs) {
        tabs.forEach(function (t) {
          if (t.id == null) return;
          mutate(t.id, function (s) {
            return Object.assign({}, s, { recording: false, playbackActive: false });
          });
        });
      });
    });
  }

  return { main: main };
})();

try {
  var __out = __qa.main();
  if (__out instanceof Promise) {
    console.warn("The background's main() function return a promise, but it must be synchronous");
  }
} catch (e) {
  console.error("The background crashed on startup!", e);
  throw e;
}
