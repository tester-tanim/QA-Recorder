# QA Recorder Extension - Organized Structure

This folder contains the complete QA Test Case Recorder Chrome extension codebase, organized by functionality and domain.

## Folder Structure

```
QA-RECORDER/
├── README.md                          # This file
├── ARCHITECTURE.md                    # System architecture & design decisions
│
├── entrypoints/                       # Extension entry points
│   ├── background-service-worker.ts   # Service worker managing storage & messaging
│   ├── content-probe-main-world.ts    # Page console & network probe (MAIN world)
│   ├── content-recorder-isolated.ts   # Event capture & bridging (isolated world)
│   └── sidepanel/
│       ├── sidepanel-controller.ts    # Side panel UI logic & state management
│       ├── sidepanel-recorder-views.tsx # Recording & playback UI components
│       ├── sidepanel-assertion-panel.tsx # Assertion editor UI
│       ├── sidepanel-export-panel.tsx    # Export format selector & download UI
│       ├── sidepanel-library-panel.tsx   # Test case library management
│       ├── sidepanel-variables-panel.tsx # Test data variables UI
│       └── session-controller.ts         # Session data management hook
│
├── core/                              # Core business logic
│   ├── session-store.ts               # In-memory session storage
│   ├── step-recorder.ts               # Event → RecordedStep conversion
│   ├── bug-detector.ts                # Issue detection & linking to steps
│   ├── assertion-builder.ts           # User assertion creation
│   └── variable-resolver.ts           # Test data variable substitution
│
├── selector-engine/                   # Locator generation (heart of the project)
│   ├── selector-engine-manager.ts     # Orchestrator for all selector strategies
│   ├── selector-xpath-generator.ts    # XPath generation & validation
│   ├── selector-css-generator.ts      # CSS selector generation
│   ├── selector-stability-filter.ts   # Reject framework-generated IDs/classes
│   ├── selector-text-name-extractor.ts # Human-readable element labels
│   └── selector-aria-analyzer.ts      # ARIA role & label extraction
│
├── codegen/                           # Code generation engines
│   ├── codegen-orchestrator.ts        # Selects & invokes appropriate generator
│   ├── codegen-shared-utils.ts        # Shared helper functions & constants
│   ├── codegen-playwright-typescript.ts # Playwright (TypeScript) generator
│   ├── codegen-playwright-python.ts   # Playwright (Python) generator
│   ├── codegen-cypress-javascript.ts  # Cypress (JavaScript) generator
│   ├── codegen-selenium-python.ts     # Selenium (Python) generator
│   └── codegen-markdown-export.ts     # Markdown export generator
│
├── export/                            # Export formats
│   ├── export-orchestrator.ts         # Selects export format & delegates
│   ├── export-rows-normalizer.ts      # Converts steps to spreadsheet rows
│   ├── export-csv-generator.ts        # CSV export (with UTF-8 BOM)
│   ├── export-xlsx-generator.ts       # Excel workbook (.xlsx) generator
│   ├── export-yaml-generator.ts       # YAML export with safe scalar quoting
│   ├── export-zephyr-folder.ts        # Zephyr Scale (Jira) CSV/Excel converter
│   ├── export-zip-archiver.ts         # ZIP file generator for bundled exports
│   └── export-env-downloader.ts       # .env file generation for variables
│
├── library/                           # Test case persistence
│   ├── library-store.ts               # Chrome storage API wrapper
│   ├── library-serializer.ts          # Save/load test cases from storage
│   ├── library-file-handler.ts        # Import/export library JSON files
│   ├── library-merger.ts              # Idempotent library merge logic
│   └── library-fingerprinter.ts       # Content hash for deduplication
│
├── iframe-support/                    # Cross-frame recording
│   ├── frame-path-resolver.ts         # Iframe locator chain from top document
│   ├── frame-messenger.ts             # Cross-origin frame communication
│   └── frame-locator-generator.ts     # Frame-aware selector generation
│
├── types/                             # TypeScript type definitions
│   ├── core-types.ts                  # Core domain models (Session, RecordedStep, Issue)
│   ├── selector-types.ts              # Selector engine types (TargetInfo, FrameRef)
│   ├── codegen-types.ts               # Code generation options & outputs
│   └── extension-types.ts             # Chrome extension messaging types
│
├── utils/                             # Shared utilities
│   ├── string-escaper.ts              # JavaScript/Python/XPath string quoting
│   ├── identifier-generator.ts        # IDs, slugs, unique names
│   ├── download-manager.ts            # File download coordination
│   ├── debouncer.ts                   # Debounce utility for typing/scrolling
│   └── logger.ts                      # Console logging with verbosity levels
│
├── tests/                             # Test suite
│   ├── codegen-playwright.test.ts     # Playwright generation tests
│   ├── codegen-cypress.test.ts        # Cypress generation tests
│   ├── codegen-selenium.test.ts       # Selenium generation tests
│   ├── export-csv.test.ts             # CSV export validation
│   ├── export-xlsx.test.ts            # Excel export validation
│   ├── export-yaml.test.ts            # YAML export validation
│   ├── export-zephyr.test.ts          # Zephyr Scale export tests
│   ├── selector-engine.test.ts        # Locator generation tests
│   ├── library-merge.test.ts          # Library merge logic tests
│   ├── frame-path.test.ts             # Iframe chain resolution tests
│   └── fixtures/                      # Test data & mock objects
│       ├── sample-sessions.ts         # Sample test case sessions
│       ├── sample-steps.ts            # Common test steps
│       └── sample-targets.ts          # Sample element targets
│
├── config/                            # Configuration
│   ├── extension-manifest.json        # Chrome MV3 manifest
│   ├── vitest-config.ts               # Test runner configuration
│   └── typescript-config.json         # TypeScript compiler options
│
└── docs/                              # Documentation
    ├── ARCHITECTURE.md                # Design decisions & system design
    ├── ASSERTION-TYPES.md             # Assertion reference & examples
    ├── CODEGEN-GUIDE.md               # Adding new code generators
    ├── EXPORT-FORMAT-GUIDE.md         # Adding new export formats
    ├── SELECTOR-ENGINE.md             # Locator generation internals
    └── TESTING-GUIDE.md               # Writing & running tests
```

## Key Design Patterns

### 1. **Orchestrator Pattern**
- `codegen-orchestrator.ts` - Selects the right code generator
- `export-orchestrator.ts` - Routes to appropriate export format
- Central decision point prevents scattered if/switch statements

### 2. **Type-Driven Development**
- All domain models in `types/` for single source of truth
- Step through type definitions to understand data flow
- Generates compile-time safety across generators

### 3. **Shared Utilities First**
- Common string escaping in `string-escaper.ts`
- Shared codegen logic in `codegen-shared-utils.ts`
- Export normalization in `export-rows-normalizer.ts`
- Reduces duplication across generators

### 4. **Separation of Concerns**
- **Selector engine**: Locator generation only
- **Codegen**: Statement generation from steps
- **Export**: Row/file formatting
- **Library**: Storage & persistence
- Each module has one reason to change

## Module Dependencies

```
entrypoints/
  ├── background-service-worker → core/, library/, types/
  ├── content-probe-main-world → core/, utils/
  ├── content-recorder-isolated → core/, selector-engine/, utils/
  └── sidepanel/ → core/, codegen/, export/, library/, types/

selector-engine/ → types/
codegen/ → selector-engine/, types/, utils/
export/ → codegen/ (for variable handling), types/, utils/
library/ → types/, utils/
core/ → types/, utils/
```

## Adding New Features

### New Code Generator
1. Create `codegen/codegen-<framework-name>-<language>.ts`
2. Implement the same interface as `codegen-playwright-typescript.ts`
3. Register in `codegen-orchestrator.ts`
4. Add test file `tests/codegen-<framework>.test.ts`

### New Export Format
1. Create `export/export-<format>-generator.ts`
2. Implement conversion to target format
3. Register in `export-orchestrator.ts`
4. Add test file `tests/export-<format>.test.ts`

### New Assertion Type
1. Add action to `core-types.ts` → `AssertAction` union
2. Implement in each codegen file
3. Add handling to `assertion-builder.ts`
4. Add UI in `sidepanel-assertion-panel.tsx`

## Running Tests

```bash
npm test              # Run all tests
npm run test:ui       # Open test UI
npm test -- selector  # Run only selector tests
```

## Naming Conventions

- **Files**: kebab-case (e.g., `session-store.ts`)
- **Classes**: PascalCase (e.g., `SessionStore`)
- **Functions**: camelCase (e.g., `createSession()`)
- **Types**: PascalCase (e.g., `RecordedStep`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `EXACT_TEXT_LIMIT`)

## Entry Points for New Developers

1. **Understanding flow**: Read `ARCHITECTURE.md`
2. **Adding assertions**: Start with `core-types.ts` + `codegen-playwright-typescript.ts`
3. **New code generator**: Copy `codegen-playwright-typescript.ts` as template
4. **New export format**: Copy `export-csv-generator.ts` as template
5. **Debugging**: Use `logger.ts` for output; check `tests/fixtures/` for test data
