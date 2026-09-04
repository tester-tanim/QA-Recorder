# QA Test Case Recorder (v0.8.0)

Chrome MV3 extension: record test cases with XPath + accessible names, generate automation scripts, and catch page bugs as they happen.

> Status note (2026-09-04): this repo currently tracks the **built extension only**. No `src/`, `package.json`, or test runner is committed. The `entrypoints/ core/ selector-engine/ …` TypeScript layout described in older revisions of this file does not exist in the repo — see “Source vs. build” below. No new runtime features were added in this session; this README was corrected to match what is actually shipped.

## What’s in this repo (actual)

```
QA-Recorder/
├── manifest.json                  # MV3 manifest (v0.8.0)
├── background.js                  # Service worker: sessions, issues, variables, context menus
├── sidepanel.html + chunks/ + assets/  # Built sidepanel UI (sidepanel-C2FYPBbR.js, sidepanel-DGQ9olvv.css)
├── content-scripts/
│   ├── probe.js                   # MAIN-world probe: console / error / fetch / XHR
│   └── recorder.js                # Isolated-world recorder: clicks, fills, selects, asserts, frames
├── icon/ fonts/                   # Extension icons, Vazirmatn font
└── README.md
```

Install: `chrome://extensions` → Developer mode → Load unpacked → select this folder.

Permissions (`manifest.json:1`): `storage, unlimitedStorage, tabs, scripting, contextMenus, sidePanel` + `<all_urls>` (all-frames recording, MAIN + isolated injection at `document_start`).

## Current features

- **Recording** (`content-scripts/recorder.js:1`): `click, dblclick, change→select/check/uncheck/fill, press, scrollTo/scrollToBottom`, debounced `fill` with `upsertKey`, password fields stored as `sensitive:true`, SPA URL snapshot per step, recording badge + toast.
- **Selectors**: `data-testid/data-test-id/data-test/data-cy/data-qa(-id)/data-automation-id` first, stable `id` filter, unique CSS (`querySelectorAll==1`) + XPath (`evaluate==1`), absolute XPath + text XPath fallback, `aria-label/labelledby`, role/placeholder/alt, `elementKind`, `unique` flag, `testId` passthrough.
- **Iframes**: `whoami/youare` frame-path chain (`qa-plugin-frame`), frame-aware codegen (`frameLocator`), `FIXME` comment when unresolved.
- **Assertions** (6, via right-click context menu in `background.js:1`): `assertTextPresent, assertText, assertValue, assertVisible, assertHidden, assertUrl`.
- **Bug detection** (`content-scripts/probe.js:1`): `console.error/warn`, `uncaught-error`, `unhandled-rejection`, `resource-error`, `http-error (>=400)`, `network-failure`; 40 events / 5 s throttle; dedup `kind::message`, capped 200 issues, linked `nearStepId`.
- **Sessions** (`background.js:1`): per-tab `session:{tabId}` in `chrome.storage.local`, 500-step cap, `deleteStep/annotateStep/rename/clear`, auto-`navigate` step, `sessionChanged` broadcast.
- **Variables**: named test-data variables (`variables` key), `setVariables` broadcast, `cypress.env.json` / `.env` download with secrets blanked.
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
- No in-panel playback runner yet; no step reorder/edit/disable/duplicate.

## Roadmap (proposed, not implemented)

- **Playback + healing**: in-panel run/step/pause with fallback `testId → role+name → css → xpath → text` and `healedFrom` badge + apply-back.
- **Bug evidence + UX**: error screenshots, failed-request HAR snippet, slow-resource/a11y checks, inline step edit/reorder/disable, extra asserts.

## Source vs. build

To add features you need the original TypeScript source (wxt/vite + React). If lost, recover by prettifying `background.js`, `content-scripts/recorder.js`, `content-scripts/probe.js`, `chunks/sidepanel-C2FYPBbR.js` into `entrypoints/`, `core/`, `selector-engine/`, `codegen/`, `export/`, `library/` per the old layout, then add `package.json` + `vitest` harness. Until then `npm test` does not apply — there is no test runner in this repo.
