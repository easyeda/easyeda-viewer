# easyeda-viewer

A lightweight, offline, embeddable viewer for **EasyEDA Pro / 嘉立创EDA专业版** projects. Parsing and rendering are performed 100% locally in the browser — no upload, no server required. A single HTML file is all you need: double-click it and drop a project.


---

## Highlights

- **Fully local parsing**: Uses `fflate` and a custom row-record decoder; all parsing and rendering happen in browser memory, with no network upload.
- **Single-file artifact**: `npm run build` produces `dist/index.html` (~334 kB, all JS/CSS inlined), ready to open directly or embed via iframe.
- **Multiple input formats**:
  - `.eprj3` folder projects (also accepts the folder packaged as `.zip`)
  - `.epro2` single-file projects (standard ZIP container), including **reuse-block / CBB projects** (`cbb_project`)
  - Single documents: `.esch2`, `.epcb2`, `.epan2`, `.esym2`, `.epru`
- **Complete preview**: project tree, object tree, properties panel, and LeaferJS canvas rendering for schematics, PCBs, and panels.
- **Visual fidelity**: pixel-level regression against official client PNG exports (sheet frames/title blocks, power-symbol orientation, net-label placement, PCB round-cap strokes, pour/drill layering — all aligned with the client).
- **Two-way locate**: click an object-tree node to center it on canvas; click a canvas primitive to highlight the corresponding tree node.
- **Modern UI**: dark/light themes, Chinese/English bilingual UI, resizable and hideable panels.
- **Embeddable API**: `createViewer` JS API plus `postMessage` protocol for integration into third-party pages.
- **Optional desktop app**: install-free Windows executable (Go + WebView2, ~7 MB) with native dialogs and drag-and-drop.

> Note: v0.2 is a **read-only viewer**. It does not support editing, saving, DRC/ERC, BOM, 3D view, Gerber export, or `.efp2` files.

---

## Supported Formats

| Format | Description |
| --- | --- |
| `.eprj3` (folder) | EasyEDA Pro folder project: `*.eprj3` index JSON + `sch/`, `pcb/`, `panel/` subdirectories |
| `.zip` (project package) | A packaged `.eprj3` folder; the viewer unzips and recognizes it automatically |
| `.epro2` | Legacy EasyEDA Pro single-file project: a standard ZIP containing `project2.json`, `.epru` record stream, and `IMAGE/*.webp` |
| `.esch2` | Single schematic page (including simulation pages) |
| `.epcb2` | Single PCB document |
| `.epan2` | Single panel document |
| `.esym2` | Single symbol document |
| `.epru` | Project record stream (commonly found inside `.epro2`) |


## TODO

- [ ] 1. Support hierarchical graph
- [ ] 2. Support network tree
- [ ] 3. PCB replacement display engine, performance optimization

## Known Issues

- The default font is inconsistent with that in EDA: This is because the default font in EDA is a self-drawn path, which is not saved in the file. The viewer uses a different default font, leading to inconsistency


---

## Quick Start

### 1. Use the single-file build

```bash
npm install
npm run build
```

Open `dist/index.html`:

- **Double-click**: drag an `.eprj3` folder, `.epro2`, `.zip`, or single document onto the canvas.
- **HTTP serve**: append `?file=<url>` to load a same-origin or CORS-allowed file (only works in http(s) environments).

### 2. Development server

```bash
npm install
npm run dev
```

The Vite dev server starts; drop a project into the browser to preview live.

---

## UI and Interaction

- **Project tree**: upper-left panel showing project → Board → schematics (with pages) / PCB / panel / simulation, with search filtering; **arrow keys** select and open documents.
- **Object tree**: lower-left panel grouping primitives by type (components, pads, tracks, text, etc.), with visibility toggles and search.
- **Properties panel**: right panel that opens when you click a canvas primitive, showing translated key attributes (type, designator, value, net, layer, coordinates, etc.).
- **Layer list**: bottom of the properties panel for PCB/footprint/panel documents, listing file-defined layers that actually contain primitives, with eye toggles and primitive counts; layer stacking follows the copper stack (Top Paste below the Top copper, drills/slots on top).
- **Canvas**:
  - Wheel zoom centered on the mouse pointer
  - Pan with right/middle mouse drag or space+left drag
  - Left-click to select primitives; hit tolerance adapts to zoom level
  - Toolbar: fit-to-window, 1:1, zoom in/out, editable zoom percentage
- **Theme and language**: toolbar toggles for dark/light theme and Chinese/English UI. Canvas primitive colors always follow the source file.

---

## Embedding

### JS API

```ts
import { createViewer } from './src/embed'; // or from the built artifact

const viewer = createViewer(document.getElementById('host'), {
  theme: 'light',          // 'light' | 'dark'
  lang: 'zh',              // 'zh' | 'en'
  chrome: { left: true, right: true, toolbar: true, status: true },
  onLoaded(model) { console.log('project loaded', model); },
  onSelect(obj) { console.log('selected', obj); },
  onError(err) { console.error(err); },
});

// Load files from your own file picker
const input = document.getElementById('file');
input.addEventListener('change', () => {
  viewer.loadFiles(Array.from(input.files));
});

// Or load from a path→bytes map (iframe / server scenarios)
viewer.loadMap(new Map([['PCB1.epcb2', uint8Array]]));

// Open a document by tree-node id
viewer.open('node-id');

// View controls
viewer.fit();
viewer.setTheme('dark');
viewer.setLang('en');
viewer.setChrome({ right: false });

// Get current project model
const model = viewer.getModel();

// Cleanup
viewer.destroy();
```

### iframe + postMessage

```html
<iframe id="viewer" src="dist/index.html?theme=light&lang=zh" width="100%" height="600"></iframe>
<script>
  const iframe = document.getElementById('viewer');

  // Load a file encoded as base64 (avoids cross-origin File transfer issues)
  function loadFile(name, base64) {
    iframe.contentWindow.postMessage({
      source: 'easyeda-viewer',
      cmd: 'load',
      files: [{ name, dataBase64: base64 }],
    }, '*');
  }

  // Listen for viewer events
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'easyeda-viewer') return;
    if (msg.event === 'ready') console.log('viewer ready', msg.version);
    if (msg.event === 'load-ok') console.log('loaded files:', msg.count);
    if (msg.event === 'error') console.error(msg.message);
  });
</script>
```

Supported `cmd` values: `load` | `open` | `fit` | `theme` | `chrome` | `lang`. The viewer emits `ready`, `load-ok`, `open-result`, and `error` events.

### URL Parameters

Append to `dist/index.html` or the iframe `src`:

| Parameter | Description |
| --- | --- |
| `?theme=light\|dark` | UI theme, default `light` |
| `?lang=zh\|en` | UI language, default `zh` |
| `?toolbar=0&left=0&right=0&status=0` | Hide toolbar / left panel / right panel / status bar individually |
| `?chrome=canvas` | Hide all panels, keep only the canvas |
| `?file=<url>` | Load a remote file in http(s) environments |

---

## Windows Desktop App

The `desktop/` directory contains an install-free Windows executable built with Go + [webview_go](https://github.com/webview/webview_go). It embeds `dist/index.html` and serves it over a local HTTP endpoint.

Build output: `desktop/build/easyeda-viewer.exe` (~4 MB, requires the host WebView2 runtime).

### Build the desktop app

Prerequisites:

- [Go](https://go.dev/) 1.22+
- Windows environment
- Optional: `windres` (MinGW resource compiler) to refresh the icon and version metadata; if unavailable, the committed `rsrc_windows_amd64.syso` is used as a fallback.

```bash
npm run build              # build the single-file viewer first
node scripts/build-desktop.mjs
```

After building, open `desktop/build/easyeda-viewer.exe` and use the native dialogs or drag-and-drop to open projects.

---

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Type check
npm run check

# Run unit tests
npm test

# Run smoke tests (headless full-render regression)
npm run smoke

# Visual reference diff (renders sample pages and pixel-diffs against official client PNGs)
npx vite-node -c vite.smoke.config.ts scripts/ref-diff.mjs

# Build artifact (dist/index.html)
npm run build

# Build only, without type checking
npm run build:only
```

### Script Reference

| Script | Description |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit && vite build`, outputs `dist/index.html` |
| `npm test` | Vitest unit tests |
| `npm run smoke` | `vite-node -c vite.smoke.config.ts scripts/smoke.mjs` |
| `npm run check` | TypeScript type check |

---

## Project Structure

```
easyeda-viewer/
├── dist/                  # Build output (single-file dist/index.html)
├── docs/                  # PRD and format notes
│   └── PRD.md             # v0.2 product requirements (authoritative feature list)
├── desktop/               # Go + WebView2 desktop app source
│   ├── main.go            # Desktop entry
│   ├── files.go           # File/directory read bridge
│   ├── dialogs.go         # Native file dialogs
│   ├── versioninfo.rc     # Windows version and icon resources
│   └── build/             # Built .exe
├── samples/               # Local test projects (not shipped)
│   ├── RA6E2-eprj3/       # Folder project sample
│   ├── RA6E2-epro2/       # Single-file project sample (GBK entry names)
│   ├── ReuseBlock_A3967-epro2/  # Reuse-block / CBB project sample
│   ├── ESP32S31-epro2/    # Mid-size real project (main ref-diff regression sample)
│   ├── png/               # Reference render screenshots (official client exports)
│   └── ...
├── qa/                    # Smoke tests and screenshots
│   ├── shots/             # UI screenshots
│   ├── diff/              # ref-diff output (ours/ref/diff PNGs + report.json baseline)
│   └── viewer.html        # QA test page
├── scripts/               # Build and test scripts
│   ├── build-desktop.mjs  # Desktop build script
│   ├── smoke.mjs          # Smoke tests (headless full-render regression)
│   ├── ref-diff.mjs       # Visual reference diff (render vs official PNG)
│   └── gen-icons.mjs      # Icon generation
├── src/
│   ├── main.ts            # Standalone app entry (includes postMessage bridge)
│   ├── embed.ts           # Library entry (createViewer)
│   ├── core/
│   │   ├── parse/         # Container probing, record parsing, worker
│   │   ├── render/        # LeaferJS scene rendering (SCH/PCB/PANEL)
│   │   └── ...
│   └── ui/                # Tree, properties panel, toolbar, i18n
├── package.json
├── vite.config.ts
└── LICENSE
```

---

## Screenshots

Reference render screenshots are located in `samples/png/` and `qa/shots/`:

- `samples/png/PCB_PCB1_2026-09-14.png` — PCB render
- `samples/png/Panel1_2026-09-14.png` — Panel render
- `samples/png/Schematic1/SCH_Schematic1_1-P1_2026-09-14.png` — Schematic render
- `qa/shots/welcome-light.png` — Welcome screen (light theme)
- `qa/shots/pcb.png` / `qa/shots/pcb-dark.png` — PCB preview
- `qa/shots/canvas-only.png` — Canvas-only mode

---

## Disclaimer and Trademarks

- The viewer only reads exported project files locally and does not modify or write back to any source files.

---

## License

[Apache License 2.0](LICENSE)
