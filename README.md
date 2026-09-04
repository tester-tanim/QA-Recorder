# QA Test Case Recorder (v0.9.0)

Chrome MV3 extension: record test cases with XPath + accessible names, generate automation scripts, replay them in-tab with self-healing locators, and catch page bugs as they happen.

> Repo note: this repo tracks the **shipped extension** (no `src/` build step — `background.js`, `content-scripts/`, `playback-panel.js` are hand-maintained; `chunks/` + `assets/` are the prebuilt React sidepanel bundle).

## What’s in this repo (actual)

```
QA-Recorder/
├── manifest.json                        # MV3 manifest (v0.9.0)
├── background.js                        # Service worker: sessions, issues, variables, playback, screenshots
├── sidepanel.html + playback-panel.js   # Sidepanel host + QA Plus companion panel (Run/Steps/Issues)
├── chunks/ + assets/                    # Prebuilt React sidepanel bundle (record/export UI)
├── content-scripts/
│   ├── probe.js                         # MAIN-world probe: console / errors / fetch / XHR / long-tasks
│   ├── recorder.js                      # Isolated-world recorder: clicks, fills, selects, asserts, frames
│   └── playback.js                      # Isolated-world executor: self-healing playback (NEW v0.9.0)
├── icon/ fonts/                         # Extension icons, Vazirmatn font
└── README.md
```

Install: `chrome://extensions` → Developer mode → Load unpacked → select this folder.

Permissions (`manifest.json:1`): `storage, unlimitedStorage, tabs, scripting, contextMenus, sidePanel` + `<all_urls>` (all-frames recording, MAIN + isolated injection at `document_start`).

## Current features

- **Recording** (`content-scripts/recorder.js:1`): `click, dblclick, change→select/check/uncheck/fill, press, scrollTo/scrollToBottom`, debounced `fill` with `upsertKey`, password fields stored as `sensitive:true`, SPA URL snapshot per step, recording badge + toast.
- **Selectors**: `data-testid/data-test-id/data-test/data-cy/data-qa(-id)/data-automation-id` first, stable `id` filter, unique CSS (`querySelectorAll==1`) + XPath (`evaluate==1`), absolute XPath + text XPath fallback, `aria-label/labelledby`, role/placeholder/alt, `elementKind`, `unique` flag, `testId` passthrough.
- **Iframes**: `whoami/youare` frame-path chain (`qa-plugin-frame`), frame-aware codegen (`frameLocator`), `FIXME` comment when unresolved.
- **Assertions** (6, via right-click context menu in `background.js:1`): `assertTextPresent, assertText, assertValue, assertVisible, assertHidden, assertUrl`.
- **Bug detection** (`content-scripts/probe.js`): `console.error/warn`, `uncaught-error`, `unhandled-rejection`, `resource-error`, `http-error (>=400)` with **HTTP method**, `network-failure`, **`slow-task` long-task warnings (>=200ms)**; 40 events / 5 s throttle; dedup `kind::message`, capped 200 issues, linked `nearStepId`. **Error issues capture a tab screenshot** (JPEG, 3 s cooldown, newest 20 kept) shown in QA Plus → Issues.
- **Sessions** (`background.js`): per-tab `session:{tabId}` in `chrome.storage.local`, 500-step cap, `deleteStep/annotateStep/updateStep/reorderSteps/toggleStep/duplicateStep/rename/clear`, auto-`navigate` step, `sessionChanged` broadcast. Disabled steps are skipped by playback.
- **Variables**: named test-data variables (`variables` key), `setVariables` broadcast, `cypress.env.json` / `.env` download with secrets blanked. Playback substitutes `${VAR}` values (secrets must be bound to a variable).
- **Playback + self-healing (NEW v0.9.0)**: `content-scripts/playback.js` executes steps in the page; locator fallback `testId → CSS → XPath → absolute XPath → text` (shadow-DOM aware); per-step `passed/failed/skipped` + `healed via <fallback>` badges, single-step run, strategy (`smart/xpath/css`), speed, stop-on-fail. Recording is auto-paused during playback so no echo steps are captured.
- **Codegen** (sidepanel chunk): Playwright TS, Playwright Python, Cypress JS, Selenium Python; `smart/xpath/css` locator strategy; `TEST_PASSWORD` / `process.env` / `os.environ` / `Cypress.env` substitution.
- **Export**: CSV (UTF-8 BOM), XLSX (Steps + Issues sheets), Zephyr Scale CSV/XLSX shape, Markdown, `qa-plugin-testcases v1` JSON, bug-report copy, Reset-site-state helper.

## How it works

```
probe (MAIN) --postMessage--> recorder (isolated) --runtime.sendMessage--> background (sessions/issues)
                                                                               ↑↓ sessionChanged / setRecording / setVariables
                                                                            sidepanel (record / assert / codegen / export)
```

## Known limitations (audited, not yet fixed)

- `click` + `change` double-records checkboxes/radios/selects; `dblclick` leaks an extra `click`.
- Typing is `keydown`-only: IME/paste/autofill/password-manager fills can be missed or partial; inner scroll containers and SPA `pushState` navigations are not recorded as steps.
- Iframe assertion routing has no `frameId` filter (duplicates possible); unresolved frames emit `FIXME`.
- Ambiguous locators show a badge but codegen still emits them (strict-mode risk); Cypress `.type()` doesn’t escape `{}`; CSV export has no `=,+,-,@` formula-injection guard; multiline notes are injected raw into code comments.
- In-panel playback exists (QA Plus → Run) but cross-origin iframe steps report “not supported” — same-origin frames only.
- Service workers can suspend on very long runs; progress resumes per step message, summary included.

## Roadmap (next, not implemented)

- Adopt-healed-locator button (write fallback back into the step), visual diff/a11y-missing-label checks, TestRail/Xray exports.

## QA Plus panel

`playback-panel.js` (loaded by `sidepanel.html` next to the React bundle) adds a **QA Plus** section with three tabs — **Run** (run all / run single / stop, strategy, speed, results with healed badges), **Steps** (enable toggle, edit value/key/url/note, reorder, duplicate, delete), **Issues** (severity/kind/method/count + error screenshots). It uses only the documented background message protocol, so it keeps working if the React bundle is rebuilt.
