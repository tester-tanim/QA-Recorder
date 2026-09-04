/* QA Test Case Recorder — playback executor (isolated world, all frames).
 * v0.9.0: executes recorded steps on demand with self-healing locator fallback.
 *
 * Protocol (chrome.tabs.sendMessage to frame 0):
 *   { type: "qa-ping-executor" } -> { alive: true, executor: "qa-playback-v1" }
 *   { type: "qa-execute-step", step, variables, requestId }
 *     -> { requestId, ok, healedFrom?, ambiguous?, error?, actual? }
 *
 * Healing order (smart): testId -> css -> xpath -> xpathAbsolute -> xpathByText.
 * CSS/text matching pierces open shadow roots. Synthetic playback events are
 * untrusted, so the recorder (isTrusted checks) ignores them — no echo steps.
 */
(function () {
  "use strict";

  var EXECUTOR_VERSION = "qa-playback-v1";
  var TEXT_LIMIT = 60;

  function normText(s) {
    return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  }

  /* ---------- deep DOM search (pierces open shadow roots) ---------- */

  function deepQueryAll(root, selector) {
    var out = [];
    var seen = new Set();
    function walk(node) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      var list = [];
      try {
        list = node.querySelectorAll ? node.querySelectorAll(selector) : [];
      } catch (e) {
        list = [];
      }
      for (var k = 0; k < list.length; k++) out.push(list[k]);
      var all = [];
      try {
        all = node.querySelectorAll ? node.querySelectorAll("*") : [];
      } catch (e) {
        all = [];
      }
      for (var q = 0; q < all.length; q++) {
        if (all[q].shadowRoot) walk(all[q].shadowRoot);
      }
    }
    walk(root);
    return out;
  }

  function evalXPath(xpath) {
    try {
      var res = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      var els = [];
      for (var i = 0; i < res.snapshotLength; i++) {
        var n = res.snapshotItem(i);
        if (n instanceof Element) els.push(n);
      }
      return els;
    } catch (e) {
      return [];
    }
  }

  function findByText(tag, text) {
    var want = normText(text);
    if (!want || want.length > TEXT_LIMIT) return [];
    var hits = [];
    // iterative deep scan with cap (pierces open shadow roots)
    var stack = [document.documentElement];
    var seen = new Set();
    var scanned = 0;
    while (stack.length && hits.length < 12 && scanned < 4000) {
      var cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      scanned++;
      if (
        cur !== document.documentElement &&
        cur.localName === tag &&
        normText(cur.innerText || cur.textContent) === want
      ) {
        hits.push(cur);
      }
      var kids = cur.children || [];
      for (var j = kids.length - 1; j >= 0; j--) stack.push(kids[j]);
      if (cur.shadowRoot) stack.push(cur.shadowRoot);
    }
    return hits;
  }

  function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /* ---------- candidate building + healing resolution ---------- */

  function buildCandidates(target, strategy) {
    var c = [];
    if (!target) return c;
    function push(label, kind, value, finder) {
      if (value == null || value === "") return;
      c.push({ label: label, kind: kind, value: value, finder: finder });
    }
    if (strategy === "xpath") {
      push("xpath", "xpath", target.xpath, evalXPath);
      push("xpathAbsolute", "xpath", target.xpathAbsolute, evalXPath);
      push("css", "css", target.cssSelector, deepQuerySelector);
      push("testId", "testid", target.testId, findByTestId);
    } else if (strategy === "css") {
      push("css", "css", target.cssSelector, deepQuerySelector);
      push("testId", "testid", target.testId, findByTestId);
      push("xpath", "xpath", target.xpath, evalXPath);
    } else {
      // smart: testId -> css -> xpath -> absolute -> text
      push("testId", "testid", target.testId, findByTestId);
      push("css", "css", target.cssSelector, deepQuerySelector);
      push("xpath", "xpath", target.xpath, evalXPath);
      push("xpathAbsolute", "xpath", target.xpathAbsolute, evalXPath);
      if (target.textName)
        push("text", "text", target.textName, function (v) {
          return findByText(target.tagName || "*", v);
        });
    }
    return c;
  }

  function deepQuerySelector(sel) {
    return deepQueryAll(document, sel);
  }

  function findByTestId(v) {
    var sels = [
      '[data-testid="' + cssEscape(v) + '"]',
      '[data-test-id="' + cssEscape(v) + '"]',
      '[data-test="' + cssEscape(v) + '"]',
      '[data-cy="' + cssEscape(v) + '"]',
      '[data-qa="' + cssEscape(v) + '"]',
    ];
    for (var i = 0; i < sels.length; i++) {
      var r = deepQueryAll(document, sels[i]);
      if (r.length) return r;
    }
    return [];
  }

  // Returns { el, healedFrom?, ambiguous? } or { el: null }.
  function resolveTarget(target, strategy) {
    var cands = buildCandidates(target, strategy || "smart");
    if (!cands.length) return { el: null };
    var firstHits = null;
    for (var i = 0; i < cands.length; i++) {
      var hits = [];
      try {
        hits = cands[i].finder(cands[i].value) || [];
      } catch (e) {
        hits = [];
      }
      hits = hits.filter(function (el) {
        return el && el.isConnected;
      });
      if (!hits.length) continue;
      if (i === 0) firstHits = hits;
      if (hits.length === 1) {
        return {
          el: hits[0],
          healedFrom: i === 0 ? undefined : cands[0].label,
          ambiguous: false,
        };
      }
      // multiple hits: keep looking for a unique fallback; remember first
      if (firstHits === null && i === 0) firstHits = hits;
      if (i === cands.length - 1 && firstHits) {
        return {
          el: firstHits[0],
          healedFrom: i === 0 ? undefined : cands[0].label + "+ambiguous",
          ambiguous: true,
        };
      }
    }
    if (firstHits && firstHits.length) {
      return { el: firstHits[0], healedFrom: undefined, ambiguous: true };
    }
    return { el: null };
  }

  /* ---------- action helpers ---------- */

  function highlight(el) {
    try {
      var prev = el.style.outline;
      el.style.outline = "2px solid #22c55e";
      el.style.outlineOffset = "2px";
      setTimeout(function () {
        try {
          el.style.outline = prev;
        } catch (e) {}
      }, 600);
    } catch (e) {}
  }

  function reveal(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (e) {}
    highlight(el);
  }

  function fire(el, type, init) {
    el.dispatchEvent(
      new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init || {}))
    );
  }

  function setValue(el, value) {
    el.focus();
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        var setter = desc.set;
        // React/Angular-friendly native setter
        setter.call(el, value);
      } else {
        el.value = value;
      }
    } catch (e) {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function doPress(el, key) {
    el.focus();
    var parts = String(key).split("+");
    var main = parts.pop();
    var init = {
      key: main.length === 1 ? main : main,
      bubbles: true,
      cancelable: true,
      ctrlKey: parts.indexOf("Control") >= 0,
      metaKey: parts.indexOf("Meta") >= 0,
      altKey: parts.indexOf("Alt") >= 0,
      shiftKey: parts.indexOf("Shift") >= 0,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (main.length === 1 && isEditable(el)) {
      insertText(el, parts.indexOf("Shift") >= 0 ? main.toUpperCase() : main);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function isEditable(el) {
    if (el.hasAttribute && el.hasAttribute("contenteditable")) return true;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
      return ["checkbox", "radio", "button", "submit", "reset", "file", "range", "hidden"].indexOf(
        (el.type || "").toLowerCase()
      ) < 0;
    }
    return false;
  }

  function insertText(el, ch) {
    try {
      if (el.hasAttribute && el.hasAttribute("contenteditable")) {
        document.execCommand("insertText", false, ch);
        return;
      }
      var s = el.selectionStart == null ? el.value.length : el.selectionStart;
      var e = el.selectionEnd == null ? el.value.length : el.selectionEnd;
      el.value = el.value.slice(0, s) + ch + el.value.slice(e);
      el.selectionStart = el.selectionEnd = s + ch.length;
    } catch (err) {
      el.value = (el.value || "") + ch;
    }
  }

  function isVisible(el) {
    try {
      var r = el.getBoundingClientRect();
      var st = window.getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        st.visibility !== "hidden" &&
        st.display !== "none" &&
        el.offsetParent !== null
      );
    } catch (e) {
      return false;
    }
  }

  function elText(el) {
    return normText(el.innerText != null ? el.innerText : el.textContent);
  }

  /* ---------- step execution ---------- */

  function resolveValue(step, variables) {
    if (step.variable) {
      if (variables && Object.prototype.hasOwnProperty.call(variables, step.variable)) {
        var v = variables[step.variable];
        if (v == null || v === "") return { error: 'Variable "' + step.variable + '" is empty' };
        return { value: String(v) };
      }
      return { error: 'Variable "' + step.variable + '" is not defined' };
    }
    if (step.sensitive) return { error: "Secret value is not stored — bind a variable first" };
    return { value: step.value == null ? "" : String(step.value) };
  }

  function executeStep(step, variables, strategy) {
    var action = step.action;
    if (action === "navigate") {
      if (location.href !== step.value) location.href = step.value;
      return { ok: true };
    }
    var needsTarget = [
      "click", "dblclick", "fill", "select", "check", "uncheck", "press",
      "scrollTo", "assertText", "assertValue", "assertVisible", "assertHidden",
    ].indexOf(action) >= 0;
    var r = { el: null };
    if (needsTarget) {
      r = resolveTarget(step.target || {}, strategy);
      if (!r.el) return { ok: false, error: "element not found (all locator fallbacks failed)" };
      reveal(r.el);
    }
    var base = {};
    if (r.healedFrom) base.healedFrom = r.healedFrom;
    if (r.ambiguous) base.ambiguous = true;

    switch (action) {
      case "click":
        fire(r.el, "mousedown");
        fire(r.el, "mouseup");
        if (typeof r.el.click === "function") r.el.click();
        else fire(r.el, "click");
        return Object.assign({ ok: true }, base);
      case "dblclick":
        fire(r.el, "dblclick");
        return Object.assign({ ok: true }, base);
      case "fill": {
        var v = resolveValue(step, variables);
        if (v.error) return Object.assign({ ok: false, error: v.error }, base);
        setValue(r.el, v.value);
        return Object.assign({ ok: true }, base);
      }
      case "select": {
        var sv = resolveValue(step, variables);
        if (sv.error) return Object.assign({ ok: false, error: sv.error }, base);
        if (!(r.el instanceof HTMLSelectElement))
          return Object.assign({ ok: false, error: "target is not a <select>" }, base);
        r.el.value = sv.value;
        r.el.dispatchEvent(new Event("input", { bubbles: true }));
        r.el.dispatchEvent(new Event("change", { bubbles: true }));
        return Object.assign({ ok: true }, base);
      }
      case "check":
      case "uncheck": {
        var want = action === "check";
        if (r.el instanceof HTMLInputElement && (r.el.type === "checkbox" || r.el.type === "radio")) {
          if (r.el.checked !== want) {
            if (typeof r.el.click === "function") r.el.click();
            r.el.checked = want;
            r.el.dispatchEvent(new Event("input", { bubbles: true }));
            r.el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return Object.assign({ ok: r.el.checked === want }, base);
        }
        return Object.assign({ ok: false, error: "target is not checkable" }, base);
      }
      case "press":
        doPress(r.el, step.key || "Enter");
        return Object.assign({ ok: true }, base);
      case "scrollTo":
        try {
          r.el.scrollIntoView({ block: "center" });
        } catch (e) {}
        return Object.assign({ ok: true }, base);
      case "scrollToBottom":
        window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
        return Object.assign({ ok: true }, base);
      case "assertTextPresent": {
        var vv = resolveValue(step, variables);
        var hay = document.body ? normText(document.body.innerText) : "";
        var needle = vv.value != null ? vv.value : step.value || "";
        if (hay.indexOf(needle) >= 0) return Object.assign({ ok: true }, base);
        return Object.assign({ ok: false, error: 'text not found: "' + String(needle).slice(0, 80) + '"', actual: hay.slice(0, 200) }, base);
      }
      case "assertText": {
        var cur = elText(r.el);
        if (cur === (step.value || "")) return Object.assign({ ok: true }, base);
        return Object.assign({ ok: false, error: 'expected "' + (step.value || "") + '"', actual: cur }, base);
      }
      case "assertValue": {
        var av = "value" in r.el ? r.el.value : elText(r.el);
        if (String(av) === String(step.value == null ? "" : step.value))
          return Object.assign({ ok: true }, base);
        return Object.assign({ ok: false, error: 'expected "' + step.value + '"', actual: String(av) }, base);
      }
      case "assertVisible":
        return isVisible(r.el)
          ? Object.assign({ ok: true }, base)
          : Object.assign({ ok: false, error: "element is not visible" }, base);
      case "assertHidden":
        return !isVisible(r.el)
          ? Object.assign({ ok: true }, base)
          : Object.assign({ ok: false, error: "element is visible" }, base);
      case "assertUrl": {
        var want = step.value || "";
        if (location.href === want) return Object.assign({ ok: true }, base);
        return Object.assign({ ok: false, error: "URL mismatch", actual: location.href }, base);
      }
      default:
        return { ok: false, error: 'unsupported action "' + action + '" for playback' };
    }
  }

  /* ---------- message wiring ---------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "qa-ping-executor") {
      sendResponse({ alive: true, executor: EXECUTOR_VERSION });
      return false;
    }
    if (msg.type === "qa-execute-step" && msg.step) {
      var out;
      try {
        out = executeStep(msg.step, msg.variables || {}, msg.locatorStrategy || "smart");
      } catch (e) {
        out = { ok: false, error: String((e && e.message) || e) };
      }
      out.requestId = msg.requestId;
      sendResponse(out);
      return false;
    }
    return false;
  });
})();
