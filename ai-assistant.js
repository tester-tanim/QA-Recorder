/* QA Test Case Recorder — on-device AI assistant (v0.10.0).
 * Zero-setup for the user: no installs, no terminal, no settings.
 *
 * Backend chain (first available wins, fully local):
 *   1. Chrome built-in AI (window.LanguageModel / Gemini Nano) — nothing to
 *      download on our side; Chrome manages its model.
 *   2. Bundled wllama (llama.cpp WASM) + a small GGUF (Qwen2.5-0.5B Q4, ~400MB)
 *      downloaded once from HuggingFace and cached in OPFS.
 *
 * Exposes window.QAPlusAI:
 *   status() -> { state, backend, detail }
 *   renderRunExtras(container, ctx)    // "Explain failure" button + result
 *   renderIssuesExtras(container, ctx) // "Draft bug report" button + result
 *
 * ctx shapes: { session, results, summary } / { session }.
 */
(function () {
  "use strict";

  var MODELS = {
    smallest: {
      label: "Smallest (~200MB)",
      repo: "bartowski/SmolLM2-360M-Instruct-GGUF",
      file: "SmolLM2-360M-Instruct-Q4_K_M.gguf",
    },
    balanced: {
      label: "Balanced (~400MB)",
      repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
      file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    },
  };
  var MODEL_KEY = "qa-ai-model"; // 'smallest' | 'balanced', persisted

  function getModelKey() {
    return chrome.storage.local
      .get(MODEL_KEY)
      .then(function (got) {
        var k = got && got[MODEL_KEY];
        return k === "balanced" ? "balanced" : "smallest";
      })
      .catch(function () { return "smallest"; });
  }

  function setModelKey(k) {
    var o = {};
    o[MODEL_KEY] = k;
    return chrome.storage.local.set(o).catch(function () {});
  }
  var MAX_PROMPT = 1400;

  var st = {
    state: "idle", // idle|busy|ready|error
    backend: null, // 'chrome' | 'wllama'
    detail: "",
    lmSession: null,
    wllama: null,
    wllamaReady: false,
    loadedKey: null, // which MODELS entry is currently loaded
    ensurePromise: null,
  };

  function clip(s, n) {
    s = s == null ? "" : String(s);
    s = s.replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function ensureStyle() {
    if (document.getElementById("qp-ai-style")) return;
    var css = [
      "#qa-plus .qp-ai{border:1px dashed #6366f1;border-radius:8px;padding:6px;margin:6px 0;font-size:11px;white-space:pre-wrap;word-break:break-word}",
      "#qa-plus .qp-ai-prog{height:6px;border-radius:99px;background:#e2e8f0;overflow:hidden;margin:6px 0}",
      "#qa-plus .qp-ai-prog>div{height:100%;width:0;background:#6366f1}",
      "#qa-plus .qp-ai-row{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}",
      "#qa-plus button.qp-ai-btn{font-size:11px;padding:5px 10px;border-radius:6px;border:1px solid #8b5cf6;background:#8b5cf6;color:#fff;cursor:pointer}",
      "#qa-plus button.qp-ai-btn:disabled{opacity:.45;cursor:default}",
      "#qa-plus .qp-ai-note{font-size:10px;opacity:.75}",
    ].join("\n");
    var tag = document.createElement("style");
    tag.id = "qp-ai-style";
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  /* ---------------- backends ---------------- */

  function tryChromeLM(progress) {
    var LM = window.LanguageModel;
    if (!LM || typeof LM.availability !== "function") return Promise.resolve(false);
    return LM.availability()
      .catch(function () { return "unavailable"; })
      .then(function (a) {
        if (a !== "available" && a !== "downloadable" && a !== "downloading") return false;
        progress("Preparing on-device AI…");
        var opts = {};
        if (a !== "available") {
          opts.monitor = function (m) {
            try {
              m.addEventListener("downloadprogress", function (e) {
                if (e.loaded && e.total) progress("Preparing on-device AI… " + Math.round((e.loaded / e.total) * 100) + "%");
              });
            } catch (e) {}
          };
        }
        return LM.create(opts).then(
          function (sess) {
            st.lmSession = sess;
            st.backend = "chrome";
            return true;
          },
          function () { return false; }
        );
      });
  }

  function tryWllama(progress) {
    var base = chrome.runtime.getURL("vendor/wllama/");
    return getModelKey().then(function (key) {
      var model = MODELS[key];
      progress("Selected model: " + model.label);
      var load = st.wllama
        ? Promise.resolve()
        : import(base + "wllama.js").then(function (mod) {
            var Wllama = mod.Wllama;
            if (!Wllama) throw new Error("bad vendor bundle");
            st.wllama = new Wllama({ default: base + "wasm/wllama.wasm" });
          });
      return load
        .then(function () {
          if (st.wllamaReady && st.loadedKey === key) return; // already cached in memory
          if (st.wllamaReady && st.loadedKey !== key && st.wllama.exit) {
            return st.wllama.exit().catch(function () {}); // unload previous size
          }
        })
        .then(function () {
          return st.wllama.loadModelFromHF(model, {
            n_threads: 1,
            progressCallback: function (p) {
              var t = p && p.total ? Math.round((p.loaded / p.total) * 100) : 0;
              progress(
                t > 0
                  ? "Downloading AI model once — " + t + "% (" + model.label + ", cached afterwards)"
                  : "Loading AI model (" + model.label + ")…"
              );
            },
          });
        })
        .then(function () {
          st.backend = "wllama";
          st.wllamaReady = true;
          st.loadedKey = key;
          return true;
        });
    });
  }

  function ensureAI(progress) {
    if (st.backend === "chrome" && st.lmSession) return Promise.resolve(true);
    if (st.backend === "wllama" && st.wllamaReady) return Promise.resolve(true);
    if (st.ensurePromise) return st.ensurePromise;
    progress = progress || function () {};
    st.state = "busy";
    st.ensurePromise = tryChromeLM(progress)
      .then(function (ok) {
        if (ok) return true;
        return tryWllama(progress);
      })
      .then(
        function (ok) {
          st.state = ok ? "ready" : "error";
          if (!ok) st.detail = "On-device AI is not available in this browser.";
          return ok;
        },
        function (err) {
          st.state = "error";
          st.detail = String((err && err.message) || err);
          return false;
        }
      )
      .finally(function () {
        st.ensurePromise = null;
      });
    return st.ensurePromise;
  }

  function ask(system, user) {
    var prompt = clip(user, MAX_PROMPT);
    if (st.backend === "chrome" && st.lmSession) {
      var lm = st.lmSession;
      // One session per question keeps system instructions fresh on small models.
      return lm
        .prompt(system + "\n\n" + prompt)
        .then(function (out) { return String(out).trim(); })
        .catch(function () {
          return lm.prompt(prompt).then(function (out) { return String(out).trim(); });
        });
    }
    return st.wllama
      .createChatCompletion(
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          nPredict: 160,
          temperature: 0.2,
          top_k: 20,
        },
        {
          onNewToken: function () {},
        }
      )
      .then(function (res) {
        var t = res && res.choices && res.choices[0] && res.choices[0].message;
        return String((t && t.content) || "").trim() || "(empty answer — try again)";
      });
  }

  /* ---------------- prompt builders (kept tiny for 0.5B models) ---------------- */

  var SYS_SHORT = "You are a QA helper inside a test-recorder. Reply in at most 3 short plain-text lines. No headers, no code blocks.";

  function failureContext(ctx) {
    var lines = [];
    var res = ctx.results || {};
    Object.keys(res).forEach(function (id) {
      var r = res[id];
      if (r && r.status === "failed") {
        var step = null;
        (ctx.session.steps || []).forEach(function (s) {
          if (s.id === id) step = s;
        });
        lines.push(
          "step #" + (step ? step.seq : "?") + " " + (step ? step.action : "?") +
            " target=" + clip(step && step.target && (step.target.textName || step.target.cssSelector || step.target.xpath), 120) +
            " error=" + clip(r.error, 200) +
            (r.healedFrom ? " healed-via=" + r.healedFrom : "")
        );
      }
    });
    var iss = (ctx.session.issues || []).slice(-3).map(function (i) {
      return "[" + i.kind + "] " + clip(i.message, 160);
    });
    return "Failed playback steps:\n" + lines.slice(0, 3).join("\n") + "\nRecent page issues:\n" + (iss.join("\n") || "none");
  }

  function sessionSummary(session) {
    var counts = {};
    (session.steps || []).forEach(function (s) {
      counts[s.action] = (counts[s.action] || 0) + 1;
    });
    var acts = Object.keys(counts).map(function (k) { return k + "x" + counts[k]; }).join(", ");
    var iss = (session.issues || []).slice(-5).map(function (i) {
      return "- [" + (i.severity || "?") + "/" + i.kind + "] " + clip(i.message, 140) + (i.count > 1 ? " (x" + i.count + ")" : "");
    });
    return { acts: acts, issues: iss };
  }

  /* ---------------- UI widgets ---------------- */

  function modelPicker() {
    var row = document.createElement("div");
    row.className = "qp-ai-row";
    var lab = note("Model:");
    var sel = document.createElement("select");
    [["smallest", "Smallest download " + MODELS.smallest.label], ["balanced", "Better answers " + MODELS.balanced.label]].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      sel.appendChild(opt);
    });
    getModelKey().then(function (k) { sel.value = k; });
    sel.onchange = function () {
      setModelKey(sel.value);
      // takes effect on next AI run (previous size is unloaded then)
    };
    row.appendChild(lab);
    row.appendChild(sel);
    return row;
  }

  function button(label) {
    var b = document.createElement("button");
    b.className = "qp-ai-btn";
    b.textContent = label;
    return b;
  }

  function note(text) {
    var d = document.createElement("div");
    d.className = "qp-ai-note";
    d.textContent = text;
    return d;
  }

  function runButtonFlow(btn, statusBox, outBox, job) {
    btn.disabled = true;
    outBox.textContent = "";
    statusBox.textContent = "";
    var bar = document.createElement("div");
    bar.className = "qp-ai-prog";
    var fill = document.createElement("div");
    bar.appendChild(fill);
    statusBox.appendChild(bar);
    var label = note("Starting…");
    statusBox.appendChild(label);
    function progress(t) {
      label.textContent = t;
      var m = /(\d+)%/.exec(t);
      if (m) fill.style.width = m[1] + "%";
      else fill.style.width = "30%";
    }
    ensureStyle();
    ensureAI(progress).then(function (ok) {
      if (!ok) {
        statusBox.innerHTML = "";
        statusBox.appendChild(note(st.detail || "AI unavailable."));
        btn.disabled = false;
        return;
      }
      label.textContent = "Thinking on-device…";
      fill.style.width = "80%";
      return job().then(
        function (text) {
          statusBox.innerHTML = "";
          outBox.textContent = text;
          var row = document.createElement("div");
          row.className = "qp-ai-row";
          var cp = button("Copy");
          cp.onclick = function () {
            try {
              navigator.clipboard.writeText(text);
              cp.textContent = "Copied";
            } catch (e) {
              cp.textContent = "Copy failed";
            }
          };
          row.appendChild(cp);
          row.appendChild(note("100% on-device" + (st.backend === "chrome" ? " (Chrome AI)" : " (GGUF)")));
          outBox.appendChild(row);
          btn.disabled = false;
        },
        function (err) {
          statusBox.innerHTML = "";
          statusBox.appendChild(note("AI error: " + clip((err && err.message) || err, 160)));
          btn.disabled = false;
        }
      );
    });
  }

  function renderRunExtras(container, ctx) {
    ensureStyle();
    var fails = Object.keys(ctx.results || {}).filter(function (id) {
      return ctx.results[id] && ctx.results[id].status === "failed";
    });
    if (!fails.length) return;
    var box = document.createElement("div");
    box.className = "qp-ai";
    var btn = button("✨ Explain failure (" + fails.length + ")");
    box.appendChild(modelPicker());
    var statusBox = document.createElement("div");
    var outBox = document.createElement("div");
    btn.onclick = function () {
      runButtonFlow(btn, statusBox, outBox, function () {
        return ask(SYS_SHORT + " Explain what most likely went wrong and suggest one concrete fix.", failureContext(ctx));
      });
    };
    box.appendChild(btn);
    box.appendChild(statusBox);
    box.appendChild(outBox);
    container.appendChild(box);
  }

  function renderIssuesExtras(container, ctx) {
    ensureStyle();
    var session = ctx.session;
    if (!session || !(session.steps || []).length) return;
    var box = document.createElement("div");
    box.className = "qp-ai";
    var btn = button("✨ Draft bug report");
    box.appendChild(modelPicker());
    var statusBox = document.createElement("div");
    var outBox = document.createElement("div");
    btn.onclick = function () {
      var sum = sessionSummary(session);
      runButtonFlow(btn, statusBox, outBox, function () {
        var user =
          "Write a short bug report. Title: " + clip(session.title, 80) +
          ". Flow: " + (session.steps || []).length + " steps (" + clip(sum.acts, 200) + ")." +
          " Observed issues:\n" + (sum.issues.join("\n") || "none") +
          "\nFormat: one title line, then 'Steps:' as 3-6 short lines, then 'Observed:' as short lines.";
        return ask("You are a QA helper. Write a concise plain-text bug report a developer can act on. No markdown headers.", user);
      });
    };
    box.appendChild(btn);
    box.appendChild(statusBox);
    box.appendChild(outBox);
    container.appendChild(box);
  }

  window.QAPlusAI = {
    status: function () {
      return { state: st.state, backend: st.backend, detail: st.detail, model: st.loadedKey };
    },
    models: function () {
      return { smallest: MODELS.smallest.label + " — " + MODELS.smallest.file, balanced: MODELS.balanced.label + " — " + MODELS.balanced.file };
    },
    renderRunExtras: renderRunExtras,
    renderIssuesExtras: renderIssuesExtras,
  };
})();
