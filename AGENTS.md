# Cherry Blossom — Agent Guide

Vendor-neutral guide for any coding agent (Claude Code, Codex, Cursor, Aider, etc.).
`CLAUDE.md` is a symlink to this file — edit here, not there.

Read [`README.md`](README.md) first for what the editor is and how to run it.
This file covers how it is built and the parts that are easy to get wrong.

## What this is

A browser-based schematic and PCB editor: **the editor** of
[Cherry Blossom](https://www.trycherryblossom.com), on its own.

- **It owns its document model.** `src/model` is a typed ECAD project —
  components, wires, labels, blocks, drawings, traces, vias, pours — edited by
  pure functions that return a new `Project`. There is no build step behind it.
  UI edits go through `projectApi().commit` so every change can be undone.
- **It is written to be mounted by a host.** `src/` is the editor, and it knows
  nothing about where it runs: everything that needs a backend (where projects
  are kept, the AI copilot, supplier part data, the 3D models parts come with)
  is a prop of `App` that the host may leave out. `host/main.tsx` is this
  repo's host, and it leaves out all of them but a copilot session with no one
  signed in (see [The host](#the-host)).
- **Projects are edited together.** Every edit travels through the host's
  storage as what it changed, so several people, or several tabs, can have one
  project open and see each other's cursors, selections and edits live (see
  [Working together](#working-together)). Here the storage is this browser's,
  and the others are its other tabs. A project is stored as a project file, a
  versioned JSON format of its own (see
  [Projects: storage and the file format](#projects-storage-and-the-file-format)).
- **Its pages are paths under the host's `basePath`**: the dashboard is the
  base itself and a project is `<basePath>/p/<id>`, so the host routes both to
  the same mount. The editor moves between them with `history.pushState`,
  without a page load. Here the base is the site's root.
- **The hosted app at trycherryblossom.com mounts the same editor with a
  backend**: accounts with projects in the cloud that are shared and edited
  together, version history, Sakura (the AI copilot) on managed AI, supplier
  part data, KiCad's 3D models and a parts database. That backend is not part
  of this repository, and nothing here calls it.

The bar is professional EDA, and the aim is to beat it: real Gerbers, checks
that pass, boards that look manufacturable, and an editor that makes the
incumbents feel like old software.

## Commands

```bash
npm install
npm run dev             # the editor on http://localhost:5173
npm run check           # typecheck + unit tests + production build: run before committing
npm run typecheck       # tsc, strict, with noUnused*
npm run test            # vitest over tests/: node, or jsdom where a suite says so
npx vitest run --changed main   # only the tests that import what the branch changed
npm run test:e2e        # Playwright, against the dev server (npm run test:e2e:install once)
npm run test:corpus     # tests/corpus, over a local KiCad corpus (KICAD_CORPUS=<dir>)
npm run examples        # rebuild the shipped examples (see below)
npm run library-models  # rebuild the built-in parts' KiCad models (fetches KiCad's libraries)
npm run build           # production build into dist/, a static site
```

No environment variables, no services, no secrets. A fresh clone runs as-is.
`E2E_PORT` moves the browser suite's dev server off 5173.

**The examples ship already routed.** `src/model/examples/*.json` are the
templates built, routed and poured, so the dashboard draws and opens them at
once instead of routing for seconds. `tests/templates.test.ts` rebuilds each
one and fails when it no longer matches its file, so a change to a template, a
part, a footprint, the router or the pours means `npm run examples` and
committing the JSON. Builds are reproducible for that: `withStableIds`
(`lib/id.ts`) numbers a template's ids, and the router has no time limit.
Every other test takes an example from `tests/built.ts`, which reads the
shipped file rather than routing the template again in each test file.

Before finishing a change: `npm run check`, then look at it in a real browser.
Use a GPU-enabled Chromium for the 3D view. There is no lint step.

## Repository layout

```
src/        the editor: model, canvases, panels, exports, the copilot's tools,
            the KiCad import
tests/      unit tests (vitest), with their fixtures; tests/corpus runs over a
            local KiCad corpus, against the independent oracles of
            tests/kicad-census (plain Node, no install)
host/       the standalone host: main.tsx mounts App; contract.ts and
            ai-models.ts stand in for two packages of the hosted app, and
            project-changes.ts is a copy of a third
e2e/        the browser suite (Playwright), driving the dev server
public/     the logo and icons, served at the site's root
docs/       images for the README
```

## The host

`host/main.tsx` mounts `App` from `src/index.ts`, loads `src/index.css`, and
`vite.config.ts` puts `themeScript` (`src/store/themeScript.ts`) in the page's
`<head>` so the first paint has the right theme. `App` takes:

| Prop | What | This build |
|---|---|---|
| `storage` | Where projects are kept (`ProjectStorage`, `src/store/storage.ts`), with the sources that come with them, each optional: `sharing` (the Share dialog), `presence` (faces, cursors, selections), `history` (version history), `locks` (the board lease) and `chats` (Sakura's chats, `ChatSource`, `src/store/chats.ts`) | absent: this browser's `localStorage`, with `presence` between its tabs (`browserPresence`, a `BroadcastChannel`), chats kept for the page, and no sharing, history or lease |
| `modelFiles` | Where the 3D model files a user adds are kept (`ModelFileStore`, `src/store/modelFiles.ts`) | absent: this browser's IndexedDB |
| `partModels` | Where the 3D models parts come with are fetched from: the supplier's and KiCad's, the built-in parts' included (`PartModelSource`, `src/store/partModels.ts`) | absent: those parts show only their pads |
| `managedAi` | The session Sakura calls models with (`ManagedAiHost`, `src/ai/managedAi.ts`) | one with no token, so Sakura asks to sign in; signing in opens the hosted app |
| `supplierParts` | Supplier pins, land patterns and datasheets by LCSC number, and the parts index (`SupplierPartsSource`, `src/ai/supplierParts.ts`) | absent: parts come from the built-in library, and Sakura's from memory |
| `web` | The web, for Sakura's web tools: a search, the text of a page or a PDF at a link, and a 3D model file at a link (`WebSource`, `src/ai/webSource.ts`; see [Sakura's web](#sakuras-web-aiwebtoolsts)) | absent: those tools say the web isn't available |
| `account` | Who is signed in, and the host's pages for projects, settings and signing out (`EditorAccount`, `src/store/account.ts`) | absent: the editor's own dashboard is the home page |
| `feedback` | Where the top bar's Feedback form sends a topic and a message, with the project and view (`FeedbackSink`, `src/store/feedback.ts`) | absent: no Feedback button |
| `initialPrompt` | A request to open a new project with, in Sakura's composer | absent |
| `basePath` | Where the editor is mounted: the dashboard is this path and a project `<basePath>/p/<id>` | absent: the site's root |

Every prop is optional. `src/index.ts` exports `App` and the types a host
implements them with (`ProjectStorage`, `SharingSource`, `PresenceSource`,
`HistorySource`, `LockSource`, `ChatSource`, `ModelFileStore`,
`PartModelSource`, `SupplierPartsSource`, `WebSource`, `EditorAccount`,
`FeedbackSink`, `ManagedAiHost`).

What that arrangement relies on:

- **`src/` stays host-agnostic.** The hosted app bundles the same source with
  a bundler of its own, so `src/` reads `process.env.NODE_ENV`, never `import.meta.env`
  (`vite.config.ts` defines it), imports nothing from `host/`, and loads its
  workers and WASM through `new URL(..., import.meta.url)`, which both bundlers
  understand.
- **Three packages of the hosted app are answered by `host/`.** The editor
  imports types from `@cherryblossom/api-contract` (the shapes its host
  answers in: `host/contract.ts`) and the model picker's names from
  `@cherryblossom/ai-models` (`host/ai-models.ts`, which names a model by its
  id): both are stand-ins. `@cherryblossom/project-changes`
  (`host/project-changes.ts`) is a copy of the change format live editing runs
  on, which the hosted app's server applies too, so a change to it is a change
  to the format (see [Working together](#working-together)). `vite.config.ts`
  aliases the three (`hostAliases`, which `vitest.config.ts` imports) and
  `tsconfig.json` maps the same paths; keep the two in step.
- **The model and Sakura's tools also run on a server.** The hosted app runs
  the tools on stored projects for a user's own assistant (see
  [MCP](#mcp-sakuras-tools-for-the-users-own-ai)), many people's at once in one
  process, each call in a scope of its own (`model/scope.ts`). So module state
  that depends on what a project defines (the parts and land patterns
  `findPart` and `getFootprint` resolve, and caches of what is worked out from
  them) is declared with `scoped`, never as a bare module-level `Map`.
- **Client-only.** Every store reads `localStorage` or `location` as it is
  created, and importing `src/index.ts` starts the editor (theme sync, and in
  development the `window.__cherryblossom` hook the browser suite drives).
  `src/projects.ts` is what a host's own projects page needs, and starts
  nothing: `LazyPreview` with `projectPicture` and `examplePreview` (drawn in a
  worker, and a picture kept with each project: `pages/previews.ts`), the
  examples, the project actions (`store/projectActions.ts`: create, import,
  duplicate, download, rename, delete) the editor's dashboard runs too, and the
  KiCad import's controller and report.
- **`account` makes the host the editor's home.** It carries who is signed in
  (name, email, picture) and three of the host's pages: projects, settings and
  sign-out. With it, the top bar's account menu (`panels/AccountMenu.tsx`)
  appears at its right, "All projects" (`goHome`) is a navigation to the
  host's projects page, and the home route (`basePath` with no project) replaces
  itself with that page rather than drawing the dashboard — except while a
  handed-over prompt's project is being made, which is a home route with
  somewhere to go. Every item in the menu is a link, since the session and
  those pages are the host's. Its `user.id` tells the user's own other tabs
  apart from other people's. This build passes none.
- **The logo is the host's** `/logo.svg`, from `public/`.
- **Workers are invisible to Vite's dependency scan**, so `optimizeDeps.entries`
  lists them; without it the first STEP file or Tidy in a fresh dev server
  re-optimises mid-request and the worker fails.

## Tests

| Tier | Where | What it's for |
|---|---|---|
| Unit | `tests/*.test.ts` (vitest, node) and `tests/*.test.tsx` (each declares `// @vitest-environment jsdom`) | The model, routing, pours, checks, Tidy, exports, the project file format, the KiCad import and export, the live sync, the copilot's tools and loop against a scripted model; the `.tsx` suites mount panels (the Inspector's sections, the sheet tabs, version history, the KiCad import screens) |
| Corpus | `tests/corpus/` (`npm run test:corpus` with `KICAD_CORPUS=<dir>`) | The KiCad import and export over a local corpus of real projects, against the independent oracles in `tests/kicad-census/`; skipped without `KICAD_CORPUS` |
| Browser | `e2e/` (Playwright, Chromium) | The editor bundled and running: the stylesheet, the lazy 3D chunk, the workers and WASM, the examples' JSON, autosave and reload (`editor.spec.ts`), and two tabs on one project, live (`collaboration.spec.ts`) |

`tests/chips.ts` is the unit tests' setup file: it registers the chips and
modules the library used to list under their old ids, so a test can place a
familiar chip without making one (see [Library parts](#library-parts)). CI
(`.github/workflows/ci.yml`) runs the typecheck, the unit tests, the build and
the browser suite on pull requests and on pushes to `main`.

The copilot's tests stub `fetch`, so no model and no supplier is ever called:
`tests/copilot-parts.test.ts` scripts a model turn by turn against recorded
supplier answers (`tests/fixtures/supplier/recorded.json`), and
`tests/fixtures/imagePolicy.ts` restates the managed-AI proxy's rules on
pictures with the caps in `src/ai/vision/limits.ts`. The browser suite stands in
a session and a parts source through the development hook, against mocked
`/api/v1` routes.

## Dependencies

- **Declare every package `src/` imports, including other packages' peers.**
  `circuit-json` imports `format-si-unit` as a peer; it is in `package.json` for
  that reason. The KiCad export's converter declares none of what it needs, so
  `kicadts` and `schematic-symbols` are listed too.
- **React resolves one copy.** It is a direct dependency at a pinned version.
- **`occt-import-js`** (OpenCascade's STEP reader in WebAssembly, LGPL-2.1) is a
  7.6 MB WASM file, loaded in a worker only when a STEP model is first drawn, and
  by the tests to read exported files back. Being LGPL, it stays a separate file
  a user could replace; don't inline it into a bundle.
- **`clipper2-wasm`** (Clipper2 in WebAssembly, BSL-1.0) is the other WASM file,
  214 KB, loaded by the fill worker for its big offsets and booleans
  (`model/wasmClipper.ts`); the page and the tests use the TypeScript port
  (`@countertype/clipper2-ts`). Its loader imports Node's `module` on the
  branch it takes under Node, so a host's bundler has to make that an empty
  module in the browser, as Vite does for Node's built-ins.
- **`THIRD-PARTY-NOTICES.md`** lists the third-party components and the code
  ported from KiCad, with their licences.

## Branding

Product name, logo, palette and fonts are Cherry Blossom's, and are not
licensed for forks (see the README). The chrome uses warm neutrals (cream by
day, plum-dark at night) with the brand cherry as the one accent, as the `brand`
token; canvas colours are in `src/editor/theme.ts`. The PCB and 3D views stay
dark in both themes, and the light schematic keeps the classic EDA sheet
(cream paper, blue wires, dark red symbols on pale yellow) that Altium and
KiCad users read without thinking.

## Conventions

- TypeScript strict, with `noUnused*`. Don't introduce `any` without a good reason.
- Named exports; PascalCase components, camelCase modules.
- Tailwind utility classes in `src/`; the stylesheet only generates what
  `src/` names (`@source "."` in `src/index.css`).
- 2-space indent. Match the style of the file you're in.
- Commit titles only by default; add a body when the change needs explanation.
- No AI co-author trailers or "Generated with …" footers in commits.

## Features

- **Dashboard** (the home page here; a host with a projects page of its own
  does the same through `src/projects.ts`): a blank project and the examples to start from, each drawn
  as the bare board; your projects as cards with a board preview or as rows,
  with search (`/`), rename, duplicate, download and delete; import by button
  or by dropping a project file on the page. The list is live: a project saved
  or deleted in another tab or on another computer shows up without a reload.
- **Examples**: five routed, poured boards, including a 38-part ATmega328P board
  with a 7805 supply and a 74HC595 LED bar, and an ESP32 robot controller. Their
  schematics are grouped in blocks and laid out by Tidy when they are built
  (`group` in `templates.ts`). Their chips and modules are parts of their own
  (`examples/parts.json`), as a project's are, since the library has none.
- **Schematic**: about 70 basic library parts (see [Library parts](#library-parts)),
  power and ground ports, orthogonal wires, labels in Altium's three kinds:
  net labels (on vertical wires they run along the wire, so labels on
  neighbouring pins sit side by side), global labels (one net on every sheet,
  each drawn with the other sheets that have its name, `[Power, MCU]`) and
  ports (a hierarchical label, which joins the entry of its name on the sheet
  symbol above; see [Sheets](#sheets-s1-in-project-file-version-3)),
  junction dots, rubber-banding when parts move, copy/paste, undo/redo.
  Everything is at KiCad's proportions, with 0.1 for its 50 mil grid: two
  terminal parts are 300 mil from pin to pin, chips have their pins on a
  100 mil pitch, and designators, values, labels and port names are 50 mil.
  The discrete symbols are our own drawings (`model/discreteSymbols.ts`); a
  pin of a shipped one never moves without a file migration, since saved
  projects place parts by their origin and wires end where the pins were.
- **Sheets are pages** (`model/paper.ts`), as in Altium and KiCad: each sheet
  has a paper size (KiCad's named ones, A5 to A0, ANSI A to E, US Letter,
  Legal and Ledger, or a custom width and height in mm), landscape unless
  portrait, and its top-left corner on the sheet, on the 0.1 grid
  (`SchematicSheet.paper`, read with `paperOf`; A4 landscape about the origin,
  `DEFAULT_PAPER`, for a sheet that has none). The page is drawn under
  everything as KiCad's default drawing sheet draws it, so the canvas shows
  what KiCad shows for the exported file: a frame on a 10 mm margin and
  another 2 mm inside it, zones every 50 mm between them (1, 2, 3... across,
  A, B, C... down), and a 108 by 32 mm title block against the inner frame's
  bottom-right corner that fills itself in (`titleBlockOf`: the project's
  name, Sheet N of M, the sheet's name, the size, the date it was last saved,
  and the Revision, Company and Author properties; a KiCad sub-sheet's own
  title block instead, where it has one). The canvas outside the page is a
  step darker than the paper (`outside` in `SchPalette`), which hides the
  grid there; the border is `frame`. `editor/schematic/pagePaint.ts` paints
  it for the canvas (`PageView`, memoised on the page, its title block and
  the zoom, so a drag doesn't redraw it) and for `look`'s picture alike. The
  first view, showing another sheet, a whole-sheet Tidy and `F` fit the page
  and anything drawn off it (`pageView`). The page never moves or grows by
  itself while drawing: the Inspector's Sheet section changes its size and
  orientation, Fit to drawing makes it the smallest of its family that holds
  the drawing, placed around it (`fitSheetPaper`), and a whole-sheet Tidy
  lays the drawing out on it and grows it when it must. A new project and a
  new sheet start on `DEFAULT_PAPER`; Move to new sheet puts A4 landscape
  about what moved. "On the page" is each thing drawn (`sheetItemBoxes`)
  inside the inner frame and clear of the title block (`holds`,
  `drawingOnPage`), so a drawing may fill the room beside the title block.
- **Schematic blocks** (`model/blocks.ts`): named groups of parts (USB-C
  INPUT, 3.3V POWER, MCU) drawn as thin frames with a big title, like an
  engineering sheet. A block stores its name and its components, one block
  per component; the frame is computed from the parts, their text and the
  wires, labels and power ports drawn for them alone, so it follows them and
  a layout pass only ever moves parts. The toolbar's Block tool (`B`) frames
  the parts whose middle is inside the box dragged around them and puts the
  name in place to type; `⌘G` groups the selection (into the selected block,
  if one is), `⇧⌘G` ungroups, `Del` on a block removes only the frame,
  dragging a title moves the whole block, with the drawings inside its frame,
  and double-clicking the title renames it. Copying a selected block pastes a
  new block around the copies; parts copied alone land in none. Sakura groups
  by function with `group_parts` and `edit_block`, which also moves a block
  whole (`move_by`, checked like a drag of its title; a move of nothing
  answers with the frame), and puts blocks in rows of its choosing with
  `arrange_blocks` (`ai/arrangeTool.ts`): left to right and top to bottom,
  frames top-aligned with `gap` between them, starting at the named blocks'
  top-left, blocks not named in a last row below. Each moves whole through
  `dragSelection`; with more than one to move they first go together, as they
  stand, clear of the sheet and the layout, then each to its place, so none
  lands on one that hasn't left yet. A refused move refuses the call. An
  assistant asked for it after a whole-sheet tidy put its inputs on the right,
  and fixing that took one `edit_block` per block, each from frames it had to
  read first.
- **Schematic drawings** (`model/drawings.ts`): text, lines, arrows,
  polygons and rectangles, as Altium's drawing tools make, for
  sheet titles, notes, callouts and the boxes that explain a sheet. Graphics
  only: connectivity and checks never read them, so a line drawn
  from pin to pin connects nothing (the KiCad export writes them; Circuit JSON leaves out the ones the tools made). Colours are named (`ink`, `gray`, `red`,
  `orange`, `yellow`, `green`, `blue`, `purple`) and drawn in a shade of each
  for the light sheet and another for the dark one (`theme.ts`); a fill is a
  soft tint of one. Lines are thin, medium or thick, solid, dashed or dotted;
  texts have a size typed in mm or mil (the Inspector's unit), with five named
  ones to pick from beside it (small 1.27 mm to title 6.35 mm), bold, italic,
  monospace,
  alignment, a border and a background, and turn to read upwards. They sit
  under the circuit, in their own order (Bring to front, Send to back). A
  drawing tool draws on the grid (`Alt` for off it), `Shift` makes a square or
  a 45° line, a line closes into a polygon on its first corner, and
  the tool goes back to Select unless `Shift` is held at the end. The Text
  tool is `⇧T`, since `T` is Tidy. A selected box or line has handles to
  resize it or move its corners, `R` turns it, and copy, paste, undo and
  marquee select (which takes a drawing only whole) work as for parts. The Inspector (`panels/DrawingInspector.tsx`) styles
  one or many; the colours, line and border set there are what the next
  drawing of its kind starts with (`DrawDefaults` in the UI store), but not a
  text's size. Tidy moves a drawing inside a block's frame with its block
  (`carryDrawings` in `model/tidy/index.ts`) and leaves the rest where they
  are. **Sakura has the same drawings**, through `draw` and
  `edit_drawings` (`ai/drawingTools.ts`): it reads the user's in `get_design`,
  edits them by id, sizes a text by name or in mm (`size_mm`, which is how
  `get_design` reports a size that isn't a named one), and is asked to draw only
  the notes a reader needs (the title block names the sheet, so it draws no
  title). `editor/schematic/drawingPaint.ts` is what both
  the canvas and `look`'s picture draw them with.
- **Tidy** (`model/tidy`, see [Tidy](#tidy-arranging-the-schematic)): the
  schematic redrawn as an engineering sheet, blocks in reading order, from
  the toolbar's broom, `T`, or Sakura's `tidy_schematic`. With one block
  selected it tidies that block where it is. A whole-sheet tidy lays the
  blocks out on the sheet's page and grows it a size when they don't fit
  (see [Tidy](#tidy-arranging-the-schematic)). One undo step, and it never
  changes what is connected.
- **Clean up** (`model/cleanup`, see [Clean up](#clean-up-grouping-the-schematic)):
  the toolbar's labelled button. It puts the parts that are in no block into
  blocks by how they are wired and then tidies the whole sheet, after a
  preview that asks first, as one undo step. On a plan with managed AI it
  reads "Clean up with AI": Sakura proposes blocks by function, the Sakura
  panel asks, and the same Tidy finishes.
- **PCB**: footprints from `@tscircuit/footprinter` plus data-defined ones for
  modules and odd packages, automatic placement (`model/autoplace.ts`: each
  power stage of a switching regulator or LDO at its pins, found by pin name
  in `model/powerStage.ts` (input capacitors of any value at VIN, the inductor
  at SW with its far end pointing away, the bootstrap capacitor across BST and
  SW, output capacitors at the inductor's far end or at VOUT, the feedback
  divider at FB away from SW), each
  decoupling capacitor beside the supply pin it serves, found by
  `model/decoupling.ts`, then chips with their capacitors packed as blocks and
  nudged to shorten the wiring; Re-pack clears unlocked copper and stitches
  the pours again, copper drawn by hand in the PCB editor is locked so Re-pack
  keeps it and the parts it reaches, and a part can be locked in the Inspector
  so no placement, drag, rotation or flip moves it; opening the PCB view places
  the parts this tab added since it opened the project, and the toolbar names
  the rest with a Place them button, see
  [Working together](#what-working-together-needed-solving-panelscollabnoticestsx)), ratsnest, interactive
  routing on two layers with 45° bends and vias, bottom-side placement, a
  resizable board outline, corner mounting holes and silkscreen text. Both copper layers are
  drawn opaque over a black substrate in EDA colours (red top, blue bottom), so
  the clearance gaps of the front pour show the layer behind and every trace and
  pad stands out. Designators are placed automatically beside each part (turned
  with upright parts), clear of pads, board text and each other, and are drawn
  exactly as the Gerber silkscreen. Big pads show their pin names even with the
  whole board in view, and traces repeat their net name when zoomed in; a
  floating bar on a selected part shows its position with rotate and flip
  buttons; the layer menu toggles copper, silkscreen, courtyards, ratsnest and
  labels.
- **Reshaping a trace by hand** (`model/traceDrag.ts`), as Altium drags one: pressing a straight track
  with Select and dragging moves the segment under the pointer square to itself (only that part of the
  move counts; a segment along x, along y or at 45° lands with its line on the grid, Alt is off the grid).
  An end joined by one straight segment slides along that segment's line, so a 45° bend stays one; once
  that segment would shrink past nothing the end carries on along the one before it, past corners nothing
  else meets (a short stub the grid left in a route is swallowed), and with none left a 45° jog from the
  last corner takes over, so a bump pulled flat and on through turns over. Where a track tees into, or a
  via or pad sits on, the middle of a segment an end slides along, the end stops there and jogs, as at a
  corner something meets (`cutsFor` puts a corner in for it), so a branch routed from the middle of a
  track is never left behind. An end on a pad, a via, a junction of several tracks, an arc or a segment in
  line stays, and a 45° jog joins it to the segment (square when two would cross); an end nothing joins
  moves with it; a track ending on the segment's middle keeps its end on it at its own angle; and a
  segment is never pulled through itself (it stops). A neighbour can be another track: a route committed
  in pieces is reshaped across them. The corners of a single selected straight track are handles, and a
  corner goes where it is dragged with the ends of the tracks there. A drag leaves each track's lock as it
  was: an autorouted track reshaped by hand stays unlocked, so Sakura's `clear_routing` and Re-pack still
  clear it, and asking before they do is the user's or Sakura's call, not the drag's. Clearances are not kept: the checks say what a drag ran
  into. A track in a group still moves with its group; an arc track keeps its three handles. The plan is
  worked out once at the press (`planSegmentDrag`, against the board's pads and vias in
  `PcbAnalysis.items`) and applied each frame to the drag's base (`dragSegment`); on a big board the drag
  keeps the board's drawing and draws the changed tracks over it, as a part drag does. Tests:
  `tests/trace-drag.test.ts`.
- **Autorouter**: grid A* on every copper layer, one grid per layer, changing layer
  by through vias (a board of two layers is routed exactly as it was before
  inner layers were added), with net-aware clearances; on a board from KiCad
  it also keeps KiCad's hole clearance (`min_hole_clearance`) from every hole,
  as Checks hold it there. **Connections still open after the passes are
  repaired** (`repair` in `attempt`): each is searched again crossing the
  copper the run laid for other nets at a cost, what it crosses is taken up,
  it is laid and what was taken up is routed again around it, kept only when
  fewer connections are open after; under a limit of a minute or more the
  passes get 70% of it and the repair the rest, under the editor's 10 s all
  of it. The first pass keeps to the outer layers, at a two-layer board's
  speed; the passes after it route what is left on every layer. A board that routes whole never reaches the
  repair, so the examples route as they did.
  **A routing that is not clean is routed again other ways** (`VARIANTS`,
  `compareResults` in `autoroute`): while the best so far leaves a connection
  open or a net narrower than its width, the board is routed again with the
  wide nets first, the failed nets first, longest first, shuffled orders,
  cheaper or dearer vias, the old whole-connection fallback and the other
  fine-pitch modes, each repaired, and the best is kept: fewest open, then
  least length narrower, then fewest vias, then least track. Open
  connections get the whole limit; a narrowing alone gets four times the
  first routing's time (3 s at least) and six variants without improvement
  (with no time limit, as the examples are built, the six variants alone, so
  the result doesn't depend on the machine).
  A board that routes clean is routed once, as before; `optimize` searches
  the whole limit for fewer vias. Nets can
  have their own trace width (set in the Inspector's net list, e.g. 1 mm for
  motor and battery current), supply nets get wider traces by default, a
  trace wider than a pad it ends on leaves the pad by a **neck** as wide as
  the pad (to the grid), as far as the wide copper is clear of the pad
  (`neckDown`: the search starts in the pad where the wide trace would be
  clear, so the narrower neck is too). **A net with a width of its own, or a
  supply, that has no room for it somewhere is held at it everywhere else**:
  the search runs at two widths at once (`Router.route` with `narrow`, a
  node is a cell, a layer and a width), each cell at the narrower one
  costing `NARROW_EXTRA` more, so it necks down for the stretch with no room
  only, to the widest of a half, a quarter, the rules' preferred widths and
  the supply or default width that gets through (the narrowest is probed
  first, `dry`, so a hopeless connection costs one search). It used to lay
  the whole connection at the next width: a user's 0.4 mm VBUS went 0.25 mm
  from its capacitor to its pin, through two vias. A narrower stretch of
  under 0.6 mm out of copper no wider than it (a fine-pitch row's pad, the
  neck out of one) and one between two pads of one part that are both
  narrower than the width (a USB-C receptacle's VBUS pair) are no narrowing.
  `route_pcb` names each connection that is narrower anywhere, by its pins,
  with how much of it and where (`narrowed[].spans`), a pad its net's pour
  does not reach joins the nearest piece of it, by a trace on the pour's
  layer or a via into another layer's, an inner plane's too (`fanout`), and failed nets are
  retried first. A surface-mount pad on its pour's own layer used to be left
  out of that, so it was joined pad to pad by a trace over its own pour.
  Necks used to be missing:
  a trace started only where it fitted in a pad whole, so 3 mm on a 10 A
  board with 2.6 mm terminal pads came out at the default width end to end,
  and nothing said so but a clause of `set_net_width`'s reply. A neck is no
  narrower than the default trace width, so a pad smaller than that is left
  to the narrower widths and the fine-pitch retry as before.
  Boards with 0.65 mm pitch parts switch to a 0.1 mm grid, and the cells in front
  of fine-pitch pads are kept clear for their own nets. Locked (hand-routed)
  copper is kept. **Connections still open at fine-pitch pads get a second
  try** (`autoroute` in `model/autoroute.ts`, "fine-pitch mode"): each such
  pad gets a short straight escape stub from its exact centre to a grid cell
  (a pad a fraction of a cell off the grid has no cell centre in front of it),
  as wide as the clearance to its neighbours allows and never below the rules'
  minimum trace width, alternate pads of a row leaving in opposite directions;
  those nets are routed first, signal nets may use thinner traces down to the
  minimum (supply nets and nets with a width set keep theirs away from the
  pads), and what is still open gets one rip-up of the copper beside it, then
  copper that connects no pad is dropped. It runs first when a pad of an open
  connection has no grid cell to leave from (retrying the normal way cannot
  help), after the normal pass when something fine-pitch stayed open, and
  never when the pads leave no room at the board's rules or when everything
  routed, so boards that route are unchanged. One time budget (10 s) covers
  the lot, checked inside every search and between steps. In this mode a new
  via keeps its drill clear of every existing via's, the repair's too.
  `route_pcb` names every connection left open by its pins and coordinates
  (`open`, `ai/routeReport.ts`), as `run_checks` names every unrouted one,
  says how many routings it tried and which ends are at fine-pitch pads, and
  tells Sakura not to clear and re-route the same layout (the router is
  deterministic) but to change the layout at those pins, draw the connection
  or loosen the rules. It takes `clear` (take up the unlocked routing first:
  "route from scratch" in one call), `priority` (nets first, in order, in the
  one call: `order` in the router) and `optimize`. It used to give counts
  only and say fine-pitch connections were "not a shortage of room", and the
  guide told Sakura to route current-carrying nets in a call of their own
  first: on a user's USB-C bridge it spent an evening moving capacitors 0.1
  mm at a time without learning which connection was open, and the two-call
  order routed fewer of that board's layouts whole than one call did.
- **Copper pours**: board-wide fills per net and layer (Clipper2; zones of any shape: see Zones (X3) under Reading KiCad boards), with
  clearance to other nets, thermal spokes (2 or 4, square or at 45°, on
  through-hole pads or all pads, or none) across a thermal gap of their own
  (`rules.thermalGap`, the pour clearance when not set, as it always was),
  minimum-width cleanup and island removal. Pours count for connectivity and
  DRC, and export as Gerber regions. A through-hole pad joins a fill where a
  point of its copper round the hole is in it, not only its centre
  (`joinsFill` in `model/pcb.ts`): a fill that joins it by spokes has the
  drill cut out, so every relieved through-hole pad in a polygon pour, or in
  any zone with settings of its own (every pour of a KiCad board), used to
  read as unconnected and got a trace from `route_pcb`. `set_pour` and
  `set_design_rules` name the pads a pour leaves out (`model/pourReach.ts`:
  no fill of it joins them to another pad of the net), with the thermal gap
  and clearance: an assistant set a 2.5 mm pour clearance on a 10 A board,
  which made a 7.6 mm ring round each 2.6 mm terminal pad in a 7 mm strip of
  pour, and the pads were dropped without a word. Stitching vias tie the top and bottom pours of a net together
  on a 4 to 8 mm grid (wider on bigger boards), away from pads, traces, parts and
  silkscreen; pour islands the grid misses get a via of their own so they aren't
  removed.
- **Checks**: unconnected pins (with no-connect flags for unused pins), unrouted
  connections, shorts, clearance, parts off the board, courtyard overlap (a
  part at an angle that isn't a quarter turn by its turned courtyard, not the
  box around it), a decoupling capacitor more than 3 mm from every supply pin
  it could serve (of an IC, a regulator, an RF module or an LED with a supply
  pin, the WS2812B: an assistant's LED chain had each LED's 100 nF reported
  far from the one IC on 5 V), and
  against the design rules: trace width, drill size, annular ring, hole to
  hole, copper to the board edge, vias in SMD pads and floating copper. Project
  parts made from memory are warnings ("U3 (TPS61023): pinout and footprint not
  verified against a supplier") and ones a supplier contradicts are errors, and
  a button checks the unverified ones against supplier data (see
  [Project parts](#project-parts)). The Checks panel groups identical findings,
  and a click steps through them.
- **Checks of a project from KiCad** (`model/checkRules.ts`, `fromKicad`) say what KiCad's DRC and ERC say, at the
  severities its project file sets (`KicadCarry.checks`, kept by the import: the severities of the KiCad rules the editor
  maps, the ERC pin table when it is not KiCad's, `min_hole_clearance`, and the minimums set to 0). A rule set to `ignore`
  is not reported; KiCad's default stands for one the file does not name. The editor's own opinions (a via in an SMD pad, a
  part past the outline, a decoupling capacitor's distance, an LED with no resistor, a two-pin part on one net) are not run
  there. What KiCad does differently and the editor follows there: a gap within KiCad's 0.5 um of a clearance passes
  (0.2 um more for the import's rounding), courtyards are the outlines the land draws (none when it draws none), a pad or
  via joins a fill that touches it and fills of one net that overlap are one, pads of one number are joined only on a
  footprint that says they are jumpers (and the pads the file put on a net of their own must be), a short is each two
  items that touch, a hole is held to `min_hole_clearance` against copper of another net, a no-connect flag on a wire
  leaves that net open. Measured against `kicad-cli` 10 on moteus and 34 corpus boards.
  A project drawn here keeps every check as it was.
- **Electrical checks** (`model/erc.ts`, whether the circuit is right rather
  than drawn right): an LED with no series resistor, followed along strings of
  LEDs, diodes and switches to the one they share; a two-pin part with both
  pins on one net; a pin whose label no other pin has; one net with several
  names. Always warnings, never errors. A click selects the part (for a net
  with several names, its odd labels and ports); **Ignore** keeps a false
  alarm quiet for good in `Project.ignoredChecks` (keyed by component id, so a
  rename keeps it; a net with several names by those names), listed under
  Ignored to restore. Sakura sees them in `run_checks` and
  is told not to try to fix ignored ones.
- **Project, board and design rules** (the Inspector with nothing selected):
  name, description, stats and free-form properties (revision, author...);
  board size, standard thickness, copper weight, finish (ENIG, HASL, lead-free
  HASL, OSP), solder mask and silkscreen as hex colours (green and white by
  default), mounting holes and the stackup; and the rules, grouped as traces,
  clearance, vias and holes, mask and paste, and pours, with fab capability
  classes that set a fab's limits in one step. Every rule is used by routing,
  pours, checks or the Gerbers (`model/rules.ts`). Lengths show in mm or mil.
- **3D view**: every part is drawn with a real 3D model file, or not at all:
  a part with no model shows only its pads, silkscreen and courtyard outline
  when selected, as in KiCad and Altium, never a body made up from its
  footprint. The built-in parts come with KiCad's models where the host
  fetches them (`partModels`; this build doesn't, so they show their pads; see
  [Real 3D models](#real-3d-models-and-the-step-export)). The board shows glossy mask over
  copper relief, gold, solder or bare copper pads, plated holes and slots and silkscreen, with
  soft shadows, a studio floor with a mm grid, a view cube, any mask and
  silkscreen colour, the four finishes, open or tented vias, and PNG export.
  **A part's model is a real file** (STEP, OBJ, WRL, STL, GLB): one the user
  adds in the Inspector, the supplier's model of the part, which parts Sakura
  builds from an LCSC record get on their own, KiCad's, which KiCad parts from
  the parts database get, or the KiCad model a built-in part comes with. The
  status line names the parts with none; see
  [Real 3D models](#real-3d-models-and-the-step-export).
- **Export**: RS-274X Gerbers (copper with pours, mask and paste with the rules'
  expansions, silkscreen, edge cuts), Excellon drill (slotted holes, such as
  USB-C shell tabs, as G85 slots), BOM CSV, pick-and-place CSV (a part marked
  virtual, do not populate or left out of the BOM or the position file, as boards
  brought in from KiCad can have, is left out of the file it is marked out of), fabrication
  notes (the board spec, the smallest features, the rules and the project's
  properties), the project file (re-importable), and, for other tools,
  Circuit JSON (tscircuit) and a KiCad project (see
  [Taking boards to other tools](#taking-boards-to-other-tools)), and the board
  as a STEP assembly for mechanical CAD (from the Export menu or the 3D view's
  toolbar). None of them involves the AI.
- **Light and dark themes**: follows the system setting until you pick one with
  the theme button in the top bar, which cycles System, then the scheme the
  system isn't showing, then the other (`nextThemePref`).
- **Parts search**: understands values ("10k", "4k7", "100nF", "16 MHz"),
  packages ("0805", "SOT-23"), pin counts ("6 pin header"), part-number
  fragments ("555", "328p", in the project's own parts), synonyms ("ldo",
  "op-amp") and typos. A value or package in the query is applied to the part
  it places, so "10k 0603" places a 10k 0603 resistor. The library holds basic
  parts only (see [Library parts](#library-parts)); a specific chip or module
  is the database's to find, and basic parts that match only some of the words
  ("op amp" finding a push button) give way to its hits. Three letters inside
  a longer word don't match ("ldo" is not in "pulldown"). The panel's footer
  says the order while a search is typed: the basic parts, then our parts
  database, then LCSC for a part number neither has. In a host that hands the
  editor a parts source (the hosted app does; this build doesn't), under the
  library's results come the parts database's
  (`panels/IndexResults.tsx`): KiCad's library parts and the supplier records
  the database kept, searched 150 ms after typing pauses, only those stored
  whole. Picking one reads it (`GET /api/v1/parts/index/{id}`), makes it a
  project part with its own land and 3D model (`model/indexPart.ts`) that says
  where it came from and the credit in the Inspector, and places it. A hit
  that matches as a typo says "Close match" and a family hit "Same family,
  check the package" (`panels/partSearch.ts`); a search that really fails says
  so in one muted line, and a deployment with no database says nothing. For a
  part number neither the library nor the database has an exact, family or
  prefix hit for, the panel offers "From LCSC" (`panels/SupplierResults.tsx`):
  the supplier is searched after a 700 ms pause, or on Enter as soon as the
  database has answered (it is free, and a part it has never costs a
  lookup), never twice for one query in a session and never thrown away once sent (each
  search spends one of the account's supplier lookups), up to 6 candidates
  with a named pinout and a land, not user uploads. A family hit by ordering
  letters doesn't stop the offer (`NE555P` is not the `NE555PW` asked for); a
  KiCad wildcard that covers the query does. Picking one reads the record and builds the part with
  `model/supplierPart.ts` (what `create_part lcsc` builds, with the supplier's
  3D model), and the server keeps it, so the next search finds it in the
  database. The credit lines under database results link to `/credits`. Arrow
  keys and Enter pick from all three lists; a part none has is one click from
  Sakura, or from importing its KiCad files (`NotFound` in
  `panels/LibraryPanel.tsx`).
- **Sakura, the copilot**: adds parts, creates the ones the library doesn't
  have from supplier data (LCSC's catalogue, with EasyEDA's symbols and land
  patterns) or the parts database (KiCad's libraries), wires nets, groups and
  draws on the schematic (blocks, titles, notes, arrows, boxes), lays out,
  pours and routes the board, and runs checks
  through tool calls. It also does the hand work on the PCB: `place_parts`
  moves, turns, flips and locks parts (by millimetres or beside a pin, such as
  "C1 beside U1.VIN within 1 mm", with the gap it reached reported; a part a placement
  area holds is kept inside it), `set_net_width`
  sets a net's trace width like the Inspector's net list, `set_net_class`
  makes and changes net classes (a clearance of their own to every other net,
  a width and a via size) like the Inspector's Net classes,
  `set_clearance_rule` gives one pair of nets, or one part's pads, a clearance
  of their own in place of the classes', smaller or larger, like the
  Inspector's Clearance rules, `draw_trace` draws
  a locked trace from pin to pin (`from`, `to`: it starts and ends on their
  pads' centres, and the net is theirs) or through given points, and `pcb_text` puts, changes or removes a
  board text like the PCB editor's route and text tools, and `clear_routing`
  deletes copper so it can be routed again (`src/ai/pcbTools.ts`; the search for
  a free spot beside a pin is `model/placeNear.ts`). `draw_trace` and copper
  text are refused where they would short a net, touch nothing of theirs, or
  bring a clearance, edge or keepout error the board did not have. An
  assistant over MCP asked for all three on its first 10 A board: it kept
  mains nets apart by raising every net's clearance, carried current in
  polygon pours for want of a wide trace, and could not label a terminal
  block's pins. It went on choosing pours after `draw_trace` came (a
  rectifier board with VBUS and three phases poured as strips, with traces of
  their own nets laid over them): `draw_trace` took only
  coordinates, which start on a pad's centre, and no tool says where a pad's
  centre is, while `route_pcb`'s answer for a net that went in narrower said
  to carry it in copper with `set_pour polygon`. So `draw_trace` takes pins,
  `route_pcb` takes `nets` (a net's open connections only) and `priority`
  (nets first, in the one call), and the narrowed answer and the design
  guide point at those instead of a pour. `get_design` reports each
  part's PCB position, side, rotation and lock. Every change is a separate undo step, which Sakura's
  own `undo` can take back; it saves named versions before a risky change and restores them to go back
  (`save_version`, `list_versions`, `restore_version`; see [Version history](#version-history-panelshistorypaneltsx-storehistoryts-storehistoryactionsts)). It reads the web
  (`web_search`, `read_web_page`, `read_datasheet url`) and gives a part a 3D model file from a link
  (`set_3d_model`), see [Sakura's web](#sakuras-web-aiwebtoolsts), and marks pins left open on purpose
  (`set_no_connect`, the Inspector's no-connect flag). It is a panel of its
  own on the left, between the parts library and the canvas. "Sakura" is the
  product's name for it; the code still calls it the copilot. It needs a
  managed-AI session from the host (see [The host](#the-host)): this build has
  none, so the panel shows its sign-in notice and never makes a request.
- **Working together**: a Share button (in a host with sharing) invites
  people by email as editors or viewers, or opens the project to anyone with
  its link; faces in the top bar for everyone on
  the project, with their view and whether Sakura is working for them, and a
  click to follow one; their cursors and selection outlines on the canvas in
  their colours; edits that land live, undo that takes back only your own, and
  a view-only mode for viewers. In this build the others are this browser's
  other tabs on the project. See [Working together](#working-together).
- **Panels**: the parts library and Sakura on the left, Inspect and Checks on
  the right. A project opens with Sakura and the side panel open (both closed
  in windows under 1180 px) and the parts library closed. Sakura open from the
  start leaves the focus to the canvas; opened by asking (its tab, `⌘L`, a
  hand-off), it puts it in the composer (`copilotAsked` in the UI store).
  Each panel's own header button is the only thing that closes it,
  and a closed panel leaves a tab hanging off that edge of the canvas, in its
  upper half, with an icon and its name written down it ("Parts", "Ask AI") to
  reopen it. There are no panel toggles in the top bar. The library's
  categories fold away from their headings. Sakura's panel is as wide as its
  right edge is dragged (`ui/PanelResizer.tsx`: 280 to 800 px, leaving the
  canvas 360), kept in this browser's settings (`copilotWidth`); a
  double-click on the edge puts it back to 368, and the arrow keys move it
  when the edge has the focus.
- **Project parts**: a part the copilot makes (`create_part`) is stored in the
  project, so it opens the same in any browser and from an exported file. It
  is listed under "This project" in the library and placed like any other.
  The project's parts are a library the user keeps, as Altium's project
  library is: a part nothing is placed from says "Unused" and a row's trash
  button removes it. A row's
  pencil (or a double-click, or the Inspector's pencil on a placed one) opens
  the part editor, its details and the place to change them. See [Kept by the
  user](#kept-by-the-user-the-part-editor).
- **Importing KiCad parts**: the library's import button (or files dropped on
  the panel) takes a part's own KiCad files, a vendor's zip of them
  included, and makes project parts of them, the 3D model too. It needs no
  backend, so this build has it. See [Imported from KiCad
  files](#imported-from-kicad-files).

## Speed on big boards

CERN's Macbeth (1,566 parts, 5,798 tracks, 5,215 vias, 127 zones; a public
KiCad board) is what the PCB and 3D views are measured on. What keeps them
quick, and what to keep when changing them:

- **The board is a still layer** (`StillLayer` in `editor/viewport.tsx`). The
  PCB view draws the board and its marks in a layer of its own, under the
  rest, and the pad and net labels in another over it. A pan or a zoom only
  changes the CSS transform of those layers, which the graphics card applies
  to what it drew; the board is drawn again once a zoom stops (250 ms), the
  labels once any move stops. What changes with the pointer (the lit net, the
  selection, the tools' previews) is in the view's own SVG, which is small.
- **Few elements, few faint ones** (`editor/pcb/boardPaths.tsx`). Tracks of
  one width, pads of one colour, drills and vias are each one path, every
  filled shape wound the same way round so overlapping pads fill where they
  overlap, and faint things are grouped (`byOpacity`). Each element the page has is gone through on every
  move of the pointer (to find what is under it), and each element with an
  opacity of its own is a piece the page sorts into layers again on every
  frame: Macbeth had 110,000 elements, 18,586 of them faint, and a frame took
  a quarter of a second. Group faint things in one `<g opacity>` for each
  opacity; never give one element of the board an opacity or a transform of
  its own.
- **Nothing on every move of the pointer goes through the whole board.**
  Picking asks a grid (`lib/cellGrid.ts`: `hitIndex` for copper and parts,
  `hitShape`, `hitText`), the lit net comes from each net's copper found once
  (`netCopper`), and the cursor is React state only while a tool draws at
  it. The lists the render draws from are memoised on the project.
- **The page does not analyse a big board** (more than 3,000 parts, tracks
  and vias, `store/analysis.ts`). It opens with its copper and KiCad's kept
  fills drawn as they are (`openingAnalysis`), shows an edit at once
  (`followEdit`), and takes connections, checks and fills from the workers.
  A pour with no fill yet leaves its net's connections out until it has one
  (`connectionsPending`), which Checks says.
- **The 3D view compiles its shaders off the page** (`compileFirst` in
  `boardScene.ts`): nothing is drawn until `compileAsync` is done, so the
  page doesn't wait on the graphics driver where it offers
  `KHR_parallel_shader_compile`. Without it (SwiftShader, as in CI's headless
  Chromium) three.js compiles on the page's thread, and the environment map
  (`studioEnvironment.ts`) is drawn there in any case.
- **A big board's 3D board is made in a worker** (`boardBuild.worker.ts`):
  its geometry and the drawings of its faces, sent back as arrays and bitmaps
  (`boardTransfer.ts`), which the page puts together (`assembleBoard`); the
  board shown stays until the new one comes. A rebuild of Macbeth's held the
  page for 4 s, and now for 1. The worker reads a pixel of each drawing
  before sending it, so the page's first frame of the board does not also
  wait for the graphics process to finish drawing them.
- **A canvas path of many rings is left open, and in Chromium the copper is
  blurred once** (`ringsPath`, `blurOnce` in `boardTextures.ts`). Chromium's
  `closePath` reads the whole path built so far (16,000 rings took 4.6 s, and
  30 ms left open; a fill closes them anyway), and it spends about 20 ms on
  each blurred draw the size of a big board, so a side with pours or tracks
  has its copper drawn sharp on a canvas of its own and laid on each map with
  one blur (Macbeth's faces: 6.3 s, now 1.3 s). Firefox blurs each draw for a
  tenth of that, and the extra canvas saved it nothing, so it and Safari draw
  as before. Time such a change in both engines, each run in turn: the one
  run second came out a fifth slower here whatever it was.
- **The pours are filled by Clipper2 compiled to WebAssembly** in the fill
  worker (`model/wasmClipper.ts`, `clipper2-wasm`, BSL-1.0): the offsets and
  booleans of 4,000 points or more (`setFastClipper` in `zoneGeom.ts`);
  smaller ones, the bevel join and the page stay with the TypeScript port.
  Macbeth's pours filled in 149 s where they took 377, to the same copper
  (0.0138 mm² differs of 876,387). Its loader imports Node's `module` on the
  branch it takes under Node, which the bundler makes an empty module in the
  browser (see [Dependencies](#dependencies)).

`tests/big-board-speed.test.ts` holds the parts that can be tested without a
browser. To measure the views, open a big board in the dev server
(`npm run dev`) through the development hook (`parseProjectFile` and
`projectStore` on `window.__cherryblossom`: this browser's storage holds about
5 MB, and Macbeth's project is 26), wait for `getLiveAnalysis` to have no
`checksPending` or `zonesPending`, and time each input to the frame after it.

## Library parts

- **Generic**: resistors, ceramic, electrolytic and tantalum capacitors,
  inductors, trimmers, crystals, diodes, Schottkys, Zeners, LEDs, BJTs and
  MOSFETs, power and ground ports, a battery.
- **Power**: a CR2032 holder.
- **Connectors**: 2.54 mm headers (1x2 to 1x10 male and female, 2x3 ISP, 2x5,
  2x20), DIP-8/14/16/28 IC sockets, screw terminals, Phoenix MKDS 1,5 (5.08 mm)
  and PT 1,5 (3.5 mm) terminal blocks, Phoenix MC 1,5 (3.81 mm) and MSTBA 2,5
  (5.08 mm) pluggable headers, JST PH and XH (2 to 4 pins), Qwiic / STEMMA QT,
  USB-C (USB 2.0, 16 contacts), micro-USB, a 5.5 x 2.1 mm barrel jack, a
  microSD socket.
- **Electromechanical**: tact switches, a slide switch, a 5 V relay, a buzzer.

**The library holds basic parts only**: the generic parts, symbols, connectors
and switches, the same for the library panel and for Sakura's `search_parts`.
A specific chip, regulator or module is found in the parts database (the
panel's search, Sakura's `find_part`), made by Sakura (`create_part`) or
imported from KiCad files, and becomes a project part. Until October 2026 the
library also listed 25 chips and modules (the NE555, the ATmega328P, the
AMS1117, the ESP32 modules and dev boards, the WS2812B...). Project file
version 4 gives a project that placed one the part as its own, drawn exactly as
the library drew it (`migrations/libraryParts.ts`, frozen in
`libraryParts.json`), with the provenance `library`: unreported in Checks, as
it was, and allowed the other packages the library offered for it. The
examples' chips are the same parts (`examples/parts.json`). The tests still
place them by their old ids (`tests/chips.ts` registers them), so a test can
use a familiar chip without making one.

Conventions:

- Connectors face -y (wire entries, plug openings, card slots), and edge
  connectors' courtyards stop at the face that sits on the board edge, so they
  can go flush with it without an outside-board error.
- Contacts that are separate on the part stay separate pins, even with the same
  name: the USB-C receptacle's two D+ (A6, B6) and two D- (A7, B7). The PCB
  treats pads of one pin as connected inside the part, so merging them would
  hide the trace that has to join them. Pads that really are one metal part (a
  connector shell, a ground paddle split for paste) share a pin through
  `padAlias`.
- Pads can have slotted holes (`PadDef.slotLength`), drawn, modelled and
  drilled as slots.

## Shortcuts

| Schematic | | PCB | |
|---|---|---|---|
| `V` | select | `S` | select |
| `W` | wire | `W` | route |
| `L` / `Tab` | label: net label, global label or port / the next kind (`⇧Tab` the one before) | `V` | via tool / via while routing |
| `R` | rotate | `R` / `F` | rotate / flip side |
| `X` / `Y` | mirror top to bottom / left to right | | |
| `/` | flip wire bend | `L` | switch layer |
| `B` | block tool | `W` (routing) | next preferred trace width |
| `⇧T` / `P` | text / line | | |
| `⇧R` | rectangle | | |
| `⌘D` / `⌘C` `⌘V` | duplicate / copy, paste | `/` | flip trace bend |
| `⌘G` / `⇧⌘G` | group as a block / ungroup | | |
| `F` | fit the page | `F` (nothing selected) | fit board |
| `T` | tidy the sheet, or the selected block | | |

The PCB toolbar also has autoroute and ground-pour buttons (the pour button also
adds stitching vias); the Inspector sets the board, the design rules, pours and
stitching.

The less used tools are grouped behind a chevron, as Figma keeps its shapes
(`ui/ToolGroup.tsx`): on the schematic bus and bus entry, block, sheet and
sheet entry, line and rectangle; on the board copper zone and keepout, the shapes with the slot,
and text with dimensions and reference images. A group's button is its last
used tool and picks it again; a key still picks any tool, and the group then
shows that one, lit.

Both editors: `Del` deletes, `Esc` cancels, `⌘Z` / `⇧⌘Z` undo/redo, Space-drag
or middle-drag pans, the wheel or a pinch zooms. `[` and `]` show or hide the
parts library and the side panel, and `⌘L` opens or closes Sakura (from
anywhere, its composer included, and it lands in the composer).
The schematic's sheets (the root is `Main`, never named after the project) are
tabs docked under it (`panels/SheetTabs.tsx`), as Altium's document tabs: one
per use of a sheet, in tree order, by name alone, the sheet shown raised;
pointing at one says where it is in the tree, and a double-click renames it.
A right-click on a tab (or the context-menu key, or `⇧F10`) opens its menu
(`role="menu"`, the `MenuItem` rows of `ui/controls.tsx`): Rename (the tab's
own field), Open the sheet above, Use again and Delete for a sheet below Main,
Rename alone for Main, and only Open the sheet above for a viewer (nothing on
Main). Use again and Delete are the symbol's own actions
(`editor/schematic/sheetActions.ts`: `reuseSheet`, `deleteSheetSymbols`), the
ones the symbol's Inspector and the `Del` key run, each one undo step: Delete
says what went with the symbol (`removalNote`, worked out before the edit; the
`Del` key worked it out after and so never said it) and shows the
sheet above when the use shown went. The `Del` key and the Inspector's Delete
selection are one function (`deleteSelectedHere`), so a selection of symbols,
entries and parts goes the same way from either: the button once knew nothing
of sheet entries and cleared the selection with them still there. The `+` after them makes a new empty sheet (`addSheetInFreeSpace`: its symbol
in free space on the sheet shown, 2 by 1.2), shows it, and has its tab ready
to be named. A sheet is a name: no file name is shown or asked for, and the
KiCad export names each sheet's file after it (`sheetFileNames`), except a sheet
brought in from KiCad, which keeps the file it came from (`SchematicSheet.file`,
set by the import, never shown) so a KiCad project's history in git stays
whole; a name Windows keeps for a device (`CON`, `aux.txt`) or one that ends in
a dot or a space is made safe. **Move to new
sheet** (the Inspector, with parts or a block selected;
`model/sheetRefactor.ts`, `editor/schematic/sheetActions.ts`) is Altium's
"Move Selected Sub-Circuit to Different Sheet" with the sheet made for it and
the connections kept: the parts, what hangs off their pins alone, and the
wires, labels and drawings selected go to a new sheet below the one shown, in
every use of it, and each net that ran between what moved and what stayed
leaves through a pin of its name (a label that already joined both sides by
name; else the net's own name; else one made from its pins, `U1_OUT`), with a
hierarchical label inside where the drawing was cut (or the label that named
it, made hierarchical) and a label of the name outside at the pin and at each
loose end. A supply crosses by its name instead: a copy of its power symbol
where it was cut (a global label along a wire's side, where a pin would join
nothing). The symbol goes where the parts were when nothing that stays is
there, else in free space. The result is compared pin for pin with the
netlist before and refused, changing nothing, if anything differs
(`tests/sheet-refactor.test.ts` moves every block of every example, and
seeded random selections, once and then again inside a sheet used twice).
The symbol is then selected (the Inspector lists its entries) and its tab is
ready to be named. The button at the tabs' left, or `⌘B` (from either view),
once there are two sheets, opens the menu of every sheet
(`panels/SheetMenu.tsx`) above it, which lists the same uses as rows with no
folds, since a sheet is never a folder: the sheets on Main sit beside it, a
sheet drawn on one of those is set in under it with a guide line, and a sheet
used again says how many uses it has (`×2`). A click (or the arrows and Enter)
shows that use and closes the menu, a double-click or F2 renames it, and with
nothing selected the Inspector's Sheet section, on every schematic (one sheet
included), names and goes up from the sheet shown (`renameSheetUse` in
`model/sheetOps.ts`) and holds its page (size, a custom width and height,
orientation, Fit to drawing: `setSheetPaper`, `fitSheetPaper`) and its title
block (Title, Revision, Company and Drawn by typed in, `setTitleField`: the
project's name and properties, or a KiCad sub-sheet's own entries; Sheet N of
M, the size and the date to read), each edit one undo step of the whole
project. A sheet's number is its use's place in tree order (`SheetUse.page`),
which the title block shows as Sheet N of M and the KiCad export numbers its
pages by. A
project of one sheet has the `Main` tab and the `+` only, and nothing for a
viewer; its Sheet section is in the Inspector all the same.

## Layout

- `src/index.ts`: the entry a host imports (`host/main.tsx` here) — starts theme sync and, in
  development, exposes `window.__cherryblossom` for driving the editor from
  browser automation.
- `src/model`: document types, design rules and the stackup (`rules.ts`),
  parts library (`library.ts`, basic parts only, with the connectors in
  `partsConnectors.ts`, built with `partKit.ts`),
  discrete symbols (`discreteSymbols.ts`) and box symbols (`symbols.ts`),
  the footprint adapter, data-defined footprints
  (`footprintLibrary.ts`, `footprintModules.ts`, `footprintConnectors.ts`, on
  `footprintKit.ts`), connectivity, schematic blocks and Tidy (`tidy/`),
  sheets' pages and title blocks (`paper.ts`),
  PCB analysis/DRC, copper pours, autorouter, pure editing operations,
  templates and the shipped examples (`examples.ts`, `examples/*.json`).
- `src/editor`: SVG viewport, schematic and PCB editors (the schematic's
  drawings are painted by `schematic/drawingPaint.ts`, its page by
  `schematic/pagePaint.ts`), canvas palettes
  (`theme.ts`), three.js board (`three/files` holds the readers for model
  files and their cache).
- `src/pages`: dashboard and editor. What the dashboard does to stored
  projects is `src/store/projectActions.ts`, shared with the hosted
  app's projects page through `src/projects.ts`.
- `src/panels`: the top bar and its account menu, toolbars, inspector, checks, library, copilot,
  settings and export menu.
- `src/export`: Gerber, Excellon, BOM, PnP and zip bundling, and the exits to
  other tools: `circuitJson.ts`, `kicad.ts`, and `step3d.ts` over the STEP
  writer in `step/`. The KiCad export writes the `.kicad_pcb` of a project that came
  from a KiCad board natively (`kicadBoard.ts`, X16: KiCad 9's format, in the file's
  own frame, so the board imports again as the same project); a project drawn in the
  editor goes through the converter and the text writers (`kicadPads.ts`,
  `kicadShapes.ts`, `kicadTexts.ts`, `kicadObjects.ts`, `kicadZones.ts`), as before.
  `tests/kicad-roundtrip-check.ts` compares a project with the one its written file
  imports as; `tests/corpus/roundtrip.test.ts` does it over a local corpus.
- `src/ai`: copilot tool schemas and executors (`tools.ts`; the part tools in
  `partTools.ts`, the drawing tools in `drawingTools.ts`, name lookups in
  `partLookup.ts` and in the parts database in `databaseLookup.ts`, what
  every tool is made of in `toolKit.ts`), the agent loop, `managedAi.ts`, the only code that talks to
  `/api/v1` for models, and `supplierParts.ts`, the host's parts source (the
  3D models parts come with are `store/partModels.ts`'s).
- `src/model/kicad`: KiCad's symbol and footprint files as parts:
  the S-expression reader (`sexpr.ts`), symbols (`symbol.ts`), footprints as
  lands (`footprint.ts`) and the two paired pin for pad, with the reason when
  they can't be (`convert.ts`). `library.ts` walks a library directory for the
  tests. The hosted app's parts database runs it when it is filled, and the
  editor runs it on the KiCad part files a user imports (`model/kicadImport.ts`);
  `model/indexPart.ts` builds a project part from what the database stores.
- `src/model/kicad/board`, `src/model/kicad/schematic` (KiCad 4 and 5's files
  in `schematic/legacy`) and `src/model/kicad/project`: KiCad boards,
  schematics and whole projects as projects (see
  [Reading KiCad boards](#reading-kicad-boards-built) and
  [Reading KiCad schematics](#reading-kicad-schematics-built)).
- `src/kicadImport`: the dashboard's "Import KiCad": picking the files, the
  import in a worker, and the report (see the end of
  [Reading KiCad boards](#reading-kicad-boards-built)).
- `src/lib`: geometry, ids and values, and KiCad's text layout
  (`kicadText.ts`) with KiCad's stroke font (`kicadFont/`, loaded only for a
  project with KiCad text).
- `src/model/supplier`: supplier part data in the editor's terms: pin roles
  (`roles.ts`), the pin map and land comparisons (`pinmap.ts`, `land.ts`),
  footprint names that draw another package (`footprintGuard.ts`), building a
  part's pins and land from a record (`build.ts`) and checking a drawing
  against one (`verify.ts`). `model/partChecks.ts` is what Checks says about
  project parts.
- `src/store`: zustand stores (project with history, UI state, theme),
  memoised analysis, the storage interface and this browser's implementation
  of it (`storage.ts`), and browser settings (`settings.ts`). Working together:
  the live sync of the open project (`sync.ts`, with what a project's fields
  are in `changes.ts`), presence and following (`presence.ts`) and the sharing
  interface (`sharing.ts`). Their UI is `panels/ShareDialog.tsx`,
  `panels/Collaborators.tsx` (faces, following, offline), `panels/CollabNotices.tsx`
  and `editor/PeerLayer.tsx` (cursors and selections on the canvas);
  `model/designators.ts` settles a designator two people took at once.
  Version history is `history.ts` and `historyActions.ts`, the board lease
  `boardLease.ts`, and the edits a reload keeps `keptEdits.ts`.
- `src/model/projectFile.ts`: the project file format, its migrations and the
  tolerant reader (`normalizeProject`).

## Not included yet

Simulation,
schematic drawings of the drawing tools in the Circuit JSON export (the KiCad export writes them), blind and buried vias made by the router, taking up
traces the board had before autorouting (the repair takes up only what the run laid), dragging a database or supplier part onto the
canvas (click or Enter), and product analytics (the editor's one event is the
KiCad import's, sent only to a sink the host connects, besides what the
Feedback form hands its host). Working together, still to
come: seeing a part move while someone drags it (it moves when they let go),
following someone's camera in the 3D view (following switches to the view),
comments, handing a project to another owner, and Sakura for
viewers (it changes the board, so it is an editor's). For 3D: checks against the real
models (part heights, parts that collide, a model that doesn't sit on its
pads), copper, mask and silkscreen as layers of the STEP export, 3D models in
the KiCad export, model files inside a downloaded project file, and models for
the built-in parts KiCad has none of (the ESP32 DevKits, Arduino Nano, D1 Mini,
XIAO and OLED modules, the slide switch, barrel jack, micro-USB, coin cell
holder, trimmer and the screw terminals of no particular maker). For parts: drawing a symbol or a land by hand in the
part editor (it chooses a box or a discrete symbol, and a footprint by name),
and the details of the built-in library's parts.

## Projects: storage and the file format

**Storage is the host's.** `App` takes a `ProjectStorage`
(`src/store/storage.ts`): a live list, `load`, `create`, `push` (a batch of
changes), `watchChanges` (everyone's batches, live), `replace` (the whole
file over a revision) and `remove`, with `sharing`, `presence`, `history` and
`locks` beside them, each optional. The hosted app's keeps projects in the
signed-in account; without one the editor uses `browserProjectStorage`, this
browser's `localStorage`, which is what this build and the tests run on.
Storage never reads the project's model: it stores the file as text and
applies changes to its JSON with `@cherryblossom/project-changes`
(`host/project-changes.ts` here), which addresses lists and items by name.

**The format is `model/projectFile.ts`**, one format for the account, the
browser and a downloaded file:

```json
{ "format": "cherryblossom.project", "version": 6, "project": { "name": "…", "components": [], … } }
```

- `project` is `Project` without `id`, `createdAt` and `updatedAt`, which
  belong to where it is stored. A copy is a new project, and an imported file
  gets a new id.
- **Reading** (`parseProjectFile`) runs the file through `MIGRATIONS` from its
  version to `PROJECT_FILE_VERSION`, then through `normalizeProject`, which
  fills what an older or hand-written file leaves out and drops project parts
  that no longer build. Fields it doesn't know are kept, so they survive a save.
  A file **newer** than the reader is refused (`too_new`) rather than opened:
  it would drop what it can't read, and the next autosave would write that loss
  over the original.
- **Version 0** is the bare `Project` written before the envelope (October
  2026: browser storage and downloaded files). It still reads.
- **Version 1** drew the discrete symbols up to twice KiCad's size. Reading one
  (`migrations/kicadSymbols.ts`) reconnects whatever met a pin that moved: a
  wire that ended there is lengthened, a label there moves with the pin, and
  anything else gets a short wire. A pin whose new place is on another net's
  wire (a wire drawn across the part) is left unconnected, which Checks
  reports, rather than shorted to it. `tests/fixtures/project-v1` holds files
  written then, with the netlists they had.
- **Version 2** drew the discrete symbols at KiCad's proportions.
- **Version 3** is the KiCad import, in one step from 2 (the step is `MIGRATIONS[2]`, which runs its sub-steps in order).
  Everything it added is an optional field whose absence is its default, except two rewrites: a version 2 file reads as it was,
  with the root sheet listed. It gave:
  - **Boards:** a component footprint flags and net ties (`flags`), a trace the net it is on (`net`), a via its (`routedNet`), the board
    drawings (`graphics`), a land its drawings (`shapes`, `noCourtyard`), text objects (`texts` with a `layer`, a part's own `texts`), any angle
    (`pcb.rot`) and any outline (`board.outline`), net classes and the rules with them (`netClasses`, `defaultClass`,
    `viaSizes`, `diffPairSizes`, `minViaDrill`, `minClearance`, `maskMinWidth`, `pasteRatio`, `maxError`, `maskBridgesInParts`),
    dimensions, groups and reference images, zones as any polygon with their own settings, the pad model, copper layers and the stackup
    (`board.stack`), arc tracks and via kinds, via protection, backdrills and post-machining on a via (`protect`, `backdrill`, `tertiary`, `post`)
    and on a land's pad (with `dieLength` and `dieDelay`), the board's own protection rule (`rules.viaProtect`), a group's
    generator (`gen`), net chains (`netChains`), text in a TrueType font (`face`, the `outline` KiCad cached) and the fonts a board embeds (`fonts`, with the bytes in the
    file store).
  - **Schematics:** a placed symbol a unit, a body style, a mirror (`sch.mirror`), fields with a place of their own (`fields`) and a
    chosen alternate per pin (`pinAlt`), a project the symbol drawings its parts are drawn from (`Project.symbols`, `CustomPartSpec.drawing`), a part the
    `@sub` twin its other units are placed as, a label a kind, shape, look and fields, a wire a look, a block a lock, the project KiCad's net names
    (`netNames`) and the wider drawings (arcs, curves, circles, text boxes, pictures, tables, junction dots, no-connect flags, exact strokes and fills);
    hierarchical sheets (`sheets`, `sheetSymbols`), directive labels and rule areas, buses (`bus`, `busentry`, `busAliases`), variants
    (`Project.variants`, `ComponentInstance.variants`, `SheetSymbol.variants`) and KiCad's joining rules (`SchematicSheet.kicadRules`).
  - **Two rewrites** (`migrations/schematicUnits.ts`, `migrations/sheetsRoot.ts`). `schematicUnits` changes two shapes that only a development
    build of the schematic track wrote: a symbol's flags (`inBom: false`, `onBoard: false`, `inPosFiles: false`, `fieldsAutoplaced` inside `flags`) become the
    one `PartFlags` set, and a sheet's `items` become `drawings`. `sheetsRoot` lists a one-sheet project's sheet as `[{id:"root"}]`.
    `normalizeProject` drops a drawing the editor cannot draw with the parts that name it, drops the drawings no part names, and promotes a unit
    left with no part of its reference.

- **Version 3 also holds the extras of the KiCad import**, as optional fields whose absence is none: the zone family (X29, X30, X31: a zone's `other`, a land's `zones`, a land pad's
  `zoneLayers`) and X20 (`placement` on a rule area, `classes` and `sheetPath` on a part), beside the fields listed above. The extras were one import split in
  several PRs, so they have no version of their own.
- **Version 4** took the chips and modules out of the library (`migrations/libraryParts.ts`): a component placed from one of the 25 now names
  a project part drawn exactly as the library drew it, added to `Project.parts` with the provenance `library`, and so does a 3D model assigned to
  it (`models[].part`). Components keep the footprints they had. See [Library parts](#library-parts).
- **Version 5** lets a schematic picture be a file in the host's file store (`DrawingImage.file`, the SHA-256 of the PNG,
  with `px`, `py` and `ppi` so the sheet is laid out before the file is read) instead of base64 in the project (`data`).
  The KiCad import stores every PNG a schematic draws so (`storePictures` in `kicad/schematic/build.ts`) and hands the
  files to the import screen, which keeps them as it keeps a board's pictures: pictures do not compress, and were what
  took schematics over the stored project's limits. A version 4 document reads as it was (`MIGRATIONS[4]` changes
  nothing); the bump keeps a version 4 reader from opening, and dropping, a stored picture. The canvas loads them with
  `useImages`, the KiCad export and `look` with `preloadImages`, and a picture whose file is not here draws as a frame
  and is left out of the export. Version 5 is also the first a version 4 reader would not read whole for the KiCad import's later fields
  (generated groups, via protection, a zone's kept fill), which it would drop and save the loss back.
- **How a project is written** (`serializeProject`): every list the live sync edits item by item (`PROJECT_SHAPE` in `store/changes.ts`) is a list of its items,
  and every value is under the key the model gives it, because storage applies an edit to the stored file by those paths. Only a value an edit always
  replaces whole is compact, under its own key: a part's `units`, a land's `shapes`, `pads` and `zones`, a zone's `outline` and `kept` fill. Until November 2026 much more
  was compact (`tx`, `gr`, `kt`, `kp`, `textStyles`, `dm`, `dimStyles`, `grp`, `gd`, `vx`, `im`, the outlines' `ol`, a zone's `ff`, the board's drawings in runs),
  and an edit of one of those, by the model's path, was lost when the project was read again; the reader still reads them, and an object an edit put beside them
  stands for the stored entry of its id. `tests/stored-edits.test.ts` applies every kind of edit to a stored file and reads it back.
- **Schematic drawings** (`Project.drawings`, the lines, boxes and text of the
  drawing tools) were added to the format without a version of their own; their
  absence is the default, so every version reads as having none.
- **Version 6** makes every sheet a page (`SchematicSheet.paper`, see
  [Features](#features)). Reading a version 5 document (`migrations/sheetPaper.ts`)
  lists the root and gives each sheet the smallest landscape A4 to A0 that
  holds its drawing (estimated from the stored points, a part's reach taken
  as 1.5 units), centred on it, and a drawing too big for A0 gets A0 centred
  on it. A project the KiCad schematic import made is recognised by
  `Project.netNames` (only it sets it; the `KiCad file version` property is
  no test, since the board import writes it too, and a board-only import is
  centred like any other project): its page keeps its corner at the origin,
  where KiCad has it, sized by the smallest landscape A4 to A0 whose inner
  frame reaches the drawing's right and bottom (its overflow past the left
  and top is the estimate's margin), A0 when none does. The
  first copy to open a project writes it whole, so the page is stored once and
  never worked out again on load. `normalizeSheets` reads `paper` and drops a
  malformed one (the sheet is then drawn on the default page); the bump keeps a
  version 5 reader, which would drop the pages and save the loss back, from
  opening one.
- **Writing** (`serializeProject`) always writes the current version, so a
  project is upgraded the first time it is saved after a format change.

**To change the format** (the next version is 7), bump `PROJECT_FILE_VERSION` and add the migration from
the previous one — plain JSON in and out, importing nothing from the live
model, since it describes a format as it was — with a document of the old
version in `tests/project-file.test.ts`. A new optional field that
`normalizeProject` can default needs no bump; a rename, a move, or a new unit
or meaning does. Never change or remove a shipped migration: stored projects and
files stay at whatever version wrote them until they are next saved.

**Saving is sending changes**, not saving files: every edit is sent as what it
changed, live, and the stored file is always current (see
[Working together](#working-together)). A drag in progress is never sent, and
a tab closed with a batch on its way asks before leaving. Refusals are said in
the strip under the top bar: an older editor writing over a newer format
(`outdated`, reload), an edit that would take the project over the size cap
(`too_large`: in the hosted app's storage, 32 MB of JSON; the examples are 8 to 60 KB, a big
imported board about 1 MB and the largest of 1,145 open-source KiCad projects
25 MB with its pours; the edit is undone on screen), a user made a
viewer meanwhile (`forbidden`, the
edit is undone). A project deleted or unshared while open (`not_found`) is a
dialog that offers a download of what is on screen. **A document in an older
format is upgraded before anything is sent to it**: the first copy to open it
writes it whole in the current format (`replace`), since changes worked out on
the migrated project could mean something else applied to the old one, and
every other copy loads it again.

**Projects from before accounts.** On the first visit with account storage,
`moveBrowserProjects` uploads every project left in `localStorage`, in the
current format with its dates, and deletes each from the browser only once it
has landed. One it can't read is left where it is.

## Working together

Several people (or tabs) can have one project open, and each sees the others'
edits as they land, as in Onshape or Figma. It is built so that nobody has to
think about it: no locks, no "someone else is editing", no merge step.

### How an edit travels (`store/sync.ts`)

- **An edit is what it changed.** `commit` and the end of a drag work out the
  changes from the project before to the project after (`store/changes.ts`,
  over `@cherryblossom/project-changes`): lists of items (parts, wires, labels,
  traces, vias, pours, texts, blocks, schematic drawings, project parts, land
  patterns) item by item and value by value, everything else value by value.
  Moving a part sets `pcb.x` and `pcb.y` of that part; someone changing its
  value at the same moment sets `props.value`; both stay. No edit operation had
  to change for this: the edits are still pure functions of a `Project`.
- **The KiCad model travels too.** Sheets and sheet symbols, bus aliases, board
  graphics, dimensions, groups, reference images and project properties are
  lists of items (`PROJECT_SHAPE`); the schematic variants are a list inside an
  object (`variants.list`, by name; `variants.active` is a value beside it);
  the board (its layer stack, stackup, net classes), the rules, the symbol
  drawings and `importMarks` are values down to each key, and a list with no ids
  in it (the stack's layers, `models`, `ignoredChecks`) is one value that the
  later edit wins. `tests/sync-kicad-model.test.ts` has a table of every field
  of `Project` that fails to compile when one is added without saying how it
  travels. What keeps a KiCad sheet right (`settleEdit`: the S11 joining rules,
  net renames, import marks, groups) and the copies of a reused sheet
  (`syncCopies`) run where the edit is made; only their result travels. What
  merges can still break is settled on every copy (`model/settleStructure.ts`,
  run by the store after an undo, a redo and each remote batch, and the
  difference is sent): what is drawn on a sheet or use the tree no longer has
  goes (`dropUnusedSheets`), each use of a reused sheet gets the parts another
  use has and it lacks (`fillCopies`: additive only, ordered by path and key,
  ids made from the template and the use, so two copies settling one state
  write the same items and do not trade edits), and nothing stays on a copper
  layer the board no longer has (`dropDeadLayers`). Not in the sync table above:
  the pins of a sheet symbol and `models` still travel as one value.
- **Storage orders them.** A tab sends one batch at a time, numbered, and
  storage applies each to the stored file and gives it the project's next
  revision. Every tab follows that log and applies everyone's batches in the
  same order, so every copy ends up the same. The same value edited by two
  people at once ends as the later one storage applied.
- **What is on screen is storage's copy with this tab's unsent batches on
  top.** A local edit shows at once; someone else's batch is applied under the
  tab's own pending ones, so the user never sees their own edit flicker back to
  someone else's value and then return. A drag in progress stays where the
  pointer has it while others' edits land underneath.
- **Deletion wins.** A change to something someone else deleted does nothing.
- **Resends are safe.** A batch whose answer was lost is sent again under its
  number, and storage answers with the revision it landed at instead of
  applying it twice.
- **Editing pauses while edits can't land** (`editingPaused` in
  `store/projectStore.ts`): offline (`watchConnection`, the top bar's
  "Offline") or batches that keep failing (`retrying`, as when the server drops
  a session the sign-in still has), for `PAUSE_AFTER_MS` (8 s, `store/sync.ts`).
  A blip shorter than that (a sign-in renewed in a second, one server error,
  Wi-Fi changing networks) pauses nothing, so a drag or Sakura carries on.
  Unsaved edits live in this tab only, so the store then refuses new ones as
  it does a viewer's, with a toast and the save strip saying why, rather than
  pile up work a closed tab would lose (a user once lost hours that way). The
  strip offers **Reload** and **Download a copy** (the project file, queued
  edits and all). Sakura waits up to two minutes for the pause to end and then
  makes its change as if nothing happened; past that its tool result tells it
  to stop and say so rather than call again. The part editor keeps its dialog
  and draft open. What was already queued goes out in order when the
  connection is back.
- **A reload keeps the edits** (`store/keptEdits.ts`). As the page goes
  (`pagehide`, or the strip's Reload) the batches that haven't landed are
  written to the tab's `sessionStorage`; the next page in that tab (reloaded,
  or back from signing in again, which a reload with an ended session leads
  to) opens the project with them on top and sends them first, under the old
  page's tab id and numbers, so one that landed after all is applied once.
  It costs no edit a write (an earlier IndexedDB copy of every batch was
  dropped for that), and only a tab's own next page reads it, so two tabs
  never take each other's. A closed tab takes it along, which is why leaving
  still asks first, except for the strip's own Reload. Batches kept by an
  editor of another file format are dropped; a viewer's open leaves them for
  when the tab opens the project as someone who can edit.
- **A gap reloads.** A tab further behind than the log reaches, or a whole-file
  write (a rename from the projects page, a format upgrade), loads the project
  again and puts its unsent batches back on top.

### Undo is yours

`past` and `future` hold each step as the changes that undo and redo it, not
as copies of the project. Undo applies a step's undo changes to the project as
it now is, which puts back the values this user's step replaced and leaves
everyone else's edits alone; a part someone else deleted meanwhile stays
deleted. What isn't the user's own doing (`patch`: a designator renumbered after
someone else's edit, a background check's verdict on a part) isn't a step; it
is written into every item a step puts back whole instead, so Undo then Redo of
the part's placement brings the part back with it.

Undo of a step that removes a sheet (a new sheet, say) keeps the sheet when
someone else has put parts or wires on it (`keepSheetsWithWork`): the step was
only ever this user's own sheet, and removing it would delete a collaborator's
work or leave it on no sheet. An empty sheet goes as the step said.

### Seeing each other (`store/presence.ts`, `editor/PeerLayer.tsx`)

- **Each tab says what it is doing**: its view, pointer, selection, what its
  canvas shows, whether Sakura is working and whom it follows. Alone on a
  project it says so only when that changes and every 15 s; with company it
  sends its pointer too, at most every 90 ms, and cursors glide between the
  points that arrive. A tab that stops saying anything is gone after 40 s.
- **Faces** in the top bar, in each person's colour, with their view or
  "Sakura is working for them"; the user's own other tabs aren't company.
  Colours are the same in all of a person's tabs and differ between people
  while there are colours to go round (`PEER_COLORS`, chosen against the
  selection blue and the copper colours).
- **Cursors and selections** on the canvas, for people on the same view: what
  someone has selected is outlined in their colour with their name, which is
  how everyone sees who is working on what without asking.
- **Following**: a click on a face mirrors that person's view and what their
  canvas shows, framed to fill this one, until the user pans, zooms, clicks the
  canvas or presses Esc. Two people can't follow each other: each would frame
  the other's frame, a little wider every time.

### Sakura with several people (`store/boardLease.ts`)

- **Sakura is working for them**: while a user's run is active their presence
  carries `copilot` and a one or two word `copilotLabel` ("Routing",
  "Thinking"; `toolPhase` in `ai/tools.ts`, never the user's own text). Others
  see a chip "Sakura for Ada: Routing" after the faces and the label beside
  that person's cursor. It clears when the run ends, is stopped or fails.
- **The board lease**: whole-board actions take a per-project lease first, so
  two people (or one person's two tabs) never rewrite the board at once.
  Sakura's tools: `layout_pcb` (and `relayout_all`), `route_pcb`,
  `clear_routing` without nets or refs, `tidy_schematic` without blocks,
  `restore_version` (`wholeBoardAction`). The toolbar: Re-pack, Autoroute, Tidy (button and `T`),
  Clean up (free and with AI). Left out because each touches what the call
  names: `place_parts`, `set_board`, `set_pour`, `set_net_width`,
  `group_parts`, `edit_block`.
- **Refused, not queued**: a tool that finds the lease taken does not run; its
  result says who and what ("Ada's Sakura is routing the board right now. Wait
  for it to finish, or work on something else.", "Your other tab is ...") and
  Sakura tells the user. The toolbar buttons are off and a note under the
  toolbar says who holds it. The system prompt and tool definitions are
  unchanged (the golden tool size test).
- **Lifetime**: held while the action runs, renewed every 20 s (`RENEW_MS`),
  released when it finishes, errors or is stopped; a tab that dies loses it
  after 60 s (`LEASE_MS`). Actions in one tab share it (Clean up tidies under
  its own). The host's `ProjectStorage.locks` provides it; without one (this
  build) every action goes ahead, and so does one when the lease can't be
  reached (offline), since it is coordination, never access.

### What working together needed solving (`panels/CollabNotices.tsx`)

- **Something you have selected is deleted by someone else**: it leaves the
  selection and a note says who deleted what.
- **Two people add a part at once and both take R3**: the tab that added the
  later one (by id, which starts with the time) renumbers it and says so
  (`model/designators.ts`); both tabs reach the same answer without asking. A
  designator typed by hand to match is left alone.
- **Typing in a field while someone else changes it**: the field keeps what
  is being typed (`CommitInput`, the project name) and the user's value lands
  when they commit it, as the later edit.
- **Someone joins**: a note, and their face.
- **Made a viewer, or an editor, while it is open**: a note, and the editor
  changes at once.
- **Someone else is placing parts**: opening the PCB view used to place every
  part not on the board, and an assistant over MCP placing them one call at a
  time found all the ones it hadn't reached placed by the user's tab between
  two calls. A tab now places only the parts it added (`isCreatedHere`,
  `autoPlacePcb`'s `only`); the PCB toolbar names the others, which the view
  doesn't draw, with a Place them button (`UnplacedNote` in
  `panels/CanvasToolbar.tsx`, under the board lease as Layout).
- **Viewers** (`role` in the project store): edits are refused before they
  happen, with a note each time; the Inspector's controls are disabled (a
  `fieldset`), the library and the editing tools too, and Sakura says it works
  on projects the user can edit. Viewers can select, measure, run checks,
  follow and export.

### Sharing (`panels/ShareDialog.tsx`, `store/sharing.ts`)

The Share dialog invites addresses (typed, pasted, or several at once) as
editors or viewers, with an optional note, and lists the owner, the members
and open invitations with what the user may do about each: copy an
invitation's link, send it again, withdraw it, change a member's role, remove
them, or leave. Under them, "General access" is who the project's link
opens it to (`SharingState.link`): the owner switches "Only people invited" to
"Anyone with the link" as "Can view" or "Can edit". The link is the project's
own address (`projectLink` in `App.tsx`), so there is nothing to make or
reset, and everyone with access can copy it. The dialog's link is always the
bare address, which opens on the schematic. Any project address takes
`?view=pcb`, `?view=3d` or `?view=sch` when the project opens, and the address
bar follows the view shown (`replaceState`, nothing for the schematic), so the
address in it is always a link to what is on screen. Someone who has the project only
through the link (`viaLink`) is told so, and invites no one. What the user may
do comes from the host (`SharingState`), and the host decides; the dialog only
draws it. Given an `account` with a user and no `storage`, `App` gives this
browser's storage a Share dialog that keeps invitations and the link's setting
in memory (`localSharing`); this build passes no account, so it has no Share
button.

Signed out, a host may still open a project its owner shares by link, view
only: it passes an `account` with `signIn` (`EditorAccount`), and the top bar
shows "Sign in" in place of the account menu and no way back to projects.
Storage refuses every write then; the editor never asks, as with any viewer.

### Version history (`panels/HistoryPanel.tsx`, `store/history.ts`, `store/historyActions.ts`)

- **Where it opens**: the clock button in the top bar (only where storage has a `history` source; this browser's has none). A column on the left like the sheet tree: "Current version", then the copies the server kept, newest first, each with when, who edited in its span and what changed since the one before (parts, wires, traces, vias, zones, labels, other items: added, removed, changed). A named version carries a tag.
- **What is kept** is the host's to decide (`HistorySource` in `store/history.ts`: the list (`watch`), `open`, `name`, `unname`, `remove`, `restore` and `keep`); the editor draws what it is given. The hosted app keeps copies as a project is edited, one before each restore, and the ones an editor names, which are never pruned but can be deleted; the rest it thins as they age.
- **Preview**: a click shows a version in place of the project, read-only (`projectStore.startPreview`). The store's `role` reads `viewer` while it is open, so every edit path refuses with no sync traffic; `preview.live` follows everyone's edits behind it, and "Back to current" shows it. The banner over the canvas (`PreviewBanner`) says so and carries the way back and the restore.
- **Each version's ⋮ menu** (`VersionMenu`): **Rename** types over the title (Enter or leaving keeps it, Escape drops it; an empty name takes a name off, `unname`); **Fork to a new project** (`forkVersion` in `historyActions.ts`) reads the version and stores it as a new project of the user's own, named "<project> (<version name or date>)", as Duplicate on the projects page does: the open project and its history are untouched, and the panel links to the fork (a new tab, so nothing here closes). Viewers fork too, signed out no one (no menu). **Delete…** (editors and owners) asks once more inside the menu, then `history.remove` deletes the version and its document; what it said changed and who edited pass to the next newer version, as the thinning does, and a preview of it is left.
- **Restore** (editors and owners): this tab's pending edits land first, then `history.restore` keeps the current document as a version and writes the old one whole at the next revision, logged with no changes, the same write as `replace`. Every open copy (this one too) hears a gap, loads the document again and carries on, with no page reload. The restoring tab's undo history is dropped (its steps were worked out against a state that is gone). Restoring the "Before restoring" version undoes a restore.
- **Sakura's checkpoints, and an assistant's** (`ai/versionTools.ts`): `save_version` names the project as it is now (or an older version), `list_versions` reads the history, `restore_version` brings a version back, and `undo` takes back Sakura's own last changes. They exist because a session spent 110 of its 212 replies rebuilding earlier states by hand (moving parts back, clearing and redrawing one trace 61 times, rerouting), some of it wrongly (a board it said had never routed fully had; another came back off centre), and Sakura said none of its tools could save or snapshot the project. The host gives the tools the history (`ToolContext.versions`: `copilotVersions` in `historyActions.ts`, which lets this tab's edits land first so a checkpoint holds them; the hosted app's MCP server gives its own). **A restore by a tool is an edit, not `history.restore`**: `HistorySource.keep` keeps the project as it is now as the "Before restoring" version, then the version's document is read and the change from the project to it is committed (`projectChanges`): one undo step in the editor, which the user's Undo and Sakura's `undo` take back, and one batch over MCP, which every open copy applies as a collaborator's, with no reload and nobody's undo history dropped. It takes the board lease. **`undo` is the editor's alone** (`undoOwn` in `projectStore.ts`): every step Sakura commits is marked `by: "sakura"` with its transcript line as `label` (Clean up with AI's one step too), and `undo` takes back the newest steps while they are Sakura's, as the user's Undo would (they stay redoable), stopping at a step of the user's own. The change happens in the tool's `prepare`, so its `run` reports and `applied` tells the copilot to show a change with nothing to commit. Tests: `tests/sakura-versions.test.ts` (a scripted model saves, undoes, restores; the user's own edit stops undo).
- **Not done**: a diff of two versions on the canvas, restoring part of a version, version comments.

### Testing it

`tests/sync.test.ts` runs the store against `tests/memoryStorage.ts`, which
behaves as the hosted app's storage does (ordering, resends, roles, a trimmed
log, format versions): live edits under a drag, a pending value over someone
else's, undo of only your own steps, editing paused offline, refusals, reloads
and upgrades, and two tabs converging. `e2e/collaboration.spec.ts` runs two
tabs of this build on one project in a real browser: edits, cursors and
selections both ways, undo of only your own, a deleted selection, following,
and a viewer's refused edit.

## Managed AI (the copilot)

- **The host provides the session.** `App` takes a `managedAi` prop
  (`ManagedAiHost` in `src/ai/managedAi.ts`): a `getAccessToken` that returns
  a fresh access token for the signed-in user, an analytics distinct id,
  `signIn`, and the upgrade and account links. This build's (`host/main.tsx`) has no token, and its
  `signIn` opens the hosted app. `App` connects it during render, not in
  an effect, because the copilot panel's first account fetch runs in an effect
  of its own and child effects run first.
- **No plan logic here.** `GET /api/v1/me` says which models the plan has
  (`store/accountStore.ts`); the picker (`panels/ModelPicker.tsx`, an outlined
  button beside Sakura's name) lists them by their product names from
  `@cherryblossom/ai-models` (here `host/ai-models.ts`, which names a model by
  its id and has no roster, so nothing is locked), each with its tagline and a
  weighted model's credits ("4× credits", `creditWeightLabel`) in the list
  itself rather than a tooltip, and opens with one model too, to say what it
  is. Under them, locked, are the roster's models the plan doesn't have, each
  tagged with the first plan that grants it (`firstPlanWith`, so a Pro user
  sees "Sakura 2 High" with "Ultra") and linking to the host's `upgradeUrl`;
  nothing there picks one. The default is the plan's last, strongest one. The
  gauge in Sakura's header, after the chat history (`panels/UsageMenu.tsx`),
  opens the same `/me` as the host's account page: this period's credits and
  today's actions against the plan's, gift credits and credits bought
  (`MeResponse.credits`), fetched again each time it opens, with a link to the
  host's `accountUrl`; it only shows, and changes nothing. Everything else is
  the proxy's error contract:
  `401` asks to sign in, `403 plan_required | model_not_allowed` offers plans,
  `429` shows the
  server's sentence and, for a day or month limit (`error.limit`), what gets
  past it (`limitOffer` in `store/accountStore.ts`, from `/me` fetched again at
  the refusal, `LimitOffer { upgrade, buyCredits }`): Ultra for a Pro user,
  which is the host's `upgradeUrl`, and "Buy credits", which is its
  `accountUrl`, the account's usage page, where credits are bought and
  auto-refill turned on (never in the editor). The offer is kept on the error
  entry as it was when made, so an old notice doesn't change once credits are
  bought. A minute limit, or a
  plan with nothing to buy, links to usage as before. A plan without managed AI — Free, which is
  the editor without the AI — keeps every editing tool and loses only the
  composer. In its place Free gets two offers (`GateNotice` in
  `panels/CopilotPanel.tsx`): Pro, and the user's own AI through MCP
  (`panels/OwnAiNotice.tsx`), a card naming Claude, ChatGPT, Claude Code,
  Codex and Cursor, each linked to its own steps (`assistantGuides`, the
  host's; `assistantsUrl` when it has none). A conversation that loses its
  plan midway shows them under the thread.
- **The user's own assistant has a chip above the composer**, on every plan
  (`panels/AssistantChip.tsx`, words in `panels/assistantActivity.ts`): which
  one it is, from the name it gave the hosted app's MCP server (`assistantClient`, with the
  mark `panels/assistantLogos.tsx` shares with the Free notice), and what it
  is doing: at work on this project with its latest tool's phase
  (`toolPhase`), at work elsewhere, or when it was last used. "At work" is a
  call in the last minute (`WORKING_MS`), since the server never hears a turn
  end. The host feeds it live through `ManagedAiHost.watchAssistant`
  (`AssistantActivity`); without one there is no chip.
- **Chats are kept, several per project**, as in Cursor. The
  panel's header starts a new chat and opens the history (a list of the
  project's chats, newest first, searched by title, deleted on a second
  press); a new chat lists the three newest under its welcome. A chat is the
  user's own: a collaborator's are theirs. The host keeps them through
  `ProjectStorage.chats` (`ChatSource`, `store/chats.ts`): the hosted app's
  keeps them in the account, so they follow the user to any device; without
  one (this build, the tests) `memoryChats` keeps them for the page. Each chat
  has its own conversation (`RunOptions.chat`; a run without one is the open
  project's), so a new chat tells the model nothing of the others, and one
  opened again carries on with the trace id and messages it had. A chat is
  stored as a chat file (`ai/chatFile.ts`): the panel's entries and the
  model's messages, without pictures or entry ids, with only each request's
  last reasoning, fitted to 2 MB by shortening the oldest tool results and
  then dropping the oldest requests from what the model is told. **The file is
  in parts**, a header and one part a request, and a save sends only the parts
  that changed since the tab last saved or read the chat (`ChatWrite`, on top
  of its `updatedAt`): carrying a chat on sends the request added, not the
  whole chat again, and a part emptied to fit keeps its place so the parts
  after it aren't sent again. A chat carried on elsewhere meanwhile answers `stale`, and
  the tab writes it whole: the last write wins. It is saved when its first
  message is sent (so it is listed at once), when Sakura is done, when a
  plan's status changes, and while Sakura works at the first tool call to end
  15 s after the last save (`CHECKPOINT_MS`), so a tab closed during a long
  request keeps what was done so far; saves of one chat go one after another.
  A call still running when it is saved is stored with a result saying so
  (`UNFINISHED_RESULT`), so the chat carries on like any other. A new chat's
  conversation id is its chat id, so its header is written once. A run carries on in its chat while another is shown, and the
  running chat can't be deleted. Tests: `tests/chat-history.test.ts`.
- **The wire is Chat Completions, through the hosted app's proxy.** Tools are
  OpenAI function tools; the proxy refuses provider routing and server-tool
  fields, so nothing here may send them. Sakura's web is its own function
  tools over the host's `WebSource` (below), not a provider's server-side web
  search. Reasoning is on (`medium`), and each
  assistant turn's `reasoning_details` go back with it, merged from their
  stream fragments first: Claude splits a thinking block across chunks, and
  replaying the pieces fails its signature check. One UUID per conversation is
  the `X-Trace-Id` (one trace in the host's analytics) and the `session_id`
  (cache affinity).
- **Stop stops the batch.** The loop checks the signal before every tool call
  in a turn (each skipped call still gets an error result, so the conversation
  stays valid) and `executeTool` before and after a call's lookups, so a turn of
  `find_part` plus two `add_component` pressed Stop during the lookup adds
  nothing. A turn is at most 32 rounds (`MAX_ITERATIONS`): a specific part is
  three or four rounds on its own (find, read, build, place).
- **A long chat is kept small** (`ai/compact.ts`). Every round sends the whole
  conversation, so a long chat's input, mostly old `get_design` answers sent
  again on every round, is most of what it costs. At the start of a request,
  results of the tools that only
  read (`get_design`, `get_wiring`, `run_checks`, `look`, the lookups and web
  reads) from before the last two requests become a line saying to read again,
  and other tools' results past 2,000 characters are cut to their first 700.
  Never within a request, whose rounds keep the history byte for byte for the
  prompt cache; and only when the cache has gone cold anyway (the chat was
  quiet longer than `CACHE_COLD_MS`, 4.5 minutes, since the provider keeps a
  cache 5) or the history is past `COMPACT_ABOVE_CHARS` (about 140k tokens).
  The stored chat is the compacted one. Tests: `tests/agent-friction.test.ts`.
- **Flailing is stopped** (`ai/repeatGuard.ts`). Besides an identical call
  failing twice, a tool failing `STREAK_LIMIT` (4) times in a row on one thing
  (the same pins, part, net, name or link, whatever else changes) is refused
  the fifth time with a sentence to change approach or tell the user. The
  identical-call limit alone hardly ever fired, while one request drew the
  same trace 24 times with its points moved half a millimetre each time.
- **A declined request is said to the model too.** On `content_filter` the
  history keeps an editor note that the provider declined the last message, so
  asked about it later Sakura doesn't say "I haven't declined anything", as it
  did; a chat declined twice running is told to start a new chat.
- **The system prompt's design rules are `ai/designGuide.ts`**: the design,
  parts and good practice sections (and the KiCad, units and sheets notes),
  which the hosted app's MCP server teaches too (see
  [MCP](#mcp-sakuras-tools-for-the-users-own-ai)), so the two can't teach
  different rules. Sakura's prompt is those sections joined in the order they
  always were, so an edit to the guide is an edit to Sakura's prompt (and a new
  prompt cache) as well; `copilot.ts` adds who Sakura is, when it looks and how
  it replies.
- **It wires paths and names what travels.** The guide has Sakura connect a
  block's own path (a divider into a pin, an LED and its resistor, a driver to
  its connector) two pins at a time with no `net_name`, so Tidy draws it as
  wire, and name only supplies, buses, nets that leave their block and nets the
  board refers to by name; it groups a path's parts in one block. It used to
  say to prefer `net_name` beyond a short hop, and since Tidy labels every
  piece of a named net, Sakura's sheets came out labels everywhere, an LED and
  its resistor included. `connect` and `tidy_schematic` say the
  same in their descriptions.
- **Sakura can look at its own work** (`ai/lookTool.ts`, the `look` tool, with
  its drawing and measuring code in `ai/vision/`). It takes a picture of the
  schematic, the PCB (top, bottom or both, with layers named) or the 3D board,
  whole or zoomed to `refs`, the user's selection or a `region`, and returns the
  numbers behind it as the tool result: overlaps, wires through symbols, texts
  drawn over symbols, unconnected pins, parts off the board, unplaced parts,
  unrouted connections, bounds. The board's courtyard overlaps are the ones
  `run_checks` reports (`measurePcb` reads the analysis's, which name their
  two parts in `items`), and its picture draws a courtyard turned with its
  part: `look` compared the boxes around them, and told an assistant of
  overlaps between parts at 72 degrees that didn't touch and Checks didn't
  have. The schematic's picture has the block frames
  and the drawings, as the user sees them. Models act on numbers more than on pictures, so every problem the
  picture can show is also written out, and a failed picture still leaves them.
  - **Off screen.** The schematic and PCB are drawn as SVG built from the
    project (`schematicSvg.ts`, `pcbSvg.ts`) and rasterised on a canvas that is
    never attached; the 3D board gets a `BoardScene` of its own in a hidden box
    (`BoardScene.capture`) that is disposed afterwards. The user's view, camera
    and selection never move.
  - **How the picture reaches the model.** A Chat Completions tool result is
    text, so the picture goes in a **user message right after the turn's tool
    results**, an `image_url` part holding a base64 PNG (JPEG for a heavy 3D
    view) data URL (`vision/messages.ts`), which the provider hands to Claude
    as an image. The text part says it is not from the user. Pictures are counted
    one by one across the whole history (`pruneImages`): the newest
    `KEEP_IMAGES` (2) stay, or all of a turn's if it made three, and older ones
    become a line of text, since a picture rides in every later request. Before
    every send the history is also trimmed to the proxy's limits, oldest first,
    so a conversation can never be left holding pictures the proxy refuses (it
    would refuse every later request too). Only the oldest pictures change, so a
    request's start stays byte for byte as it was and its prompt cache holds;
    what follows a dropped picture is read once at full price, which is the
    cost of not paying for a stale picture on every round.
  - **Caps, in code** (`vision/limits.ts`). A picture is at most 1280 px on a
    side and 1.1 megapixels (`detail: "high"`: 1600 and 1.7 MP) and 450 KB
    before base64, redrawn smaller until it fits (`encode.ts`). Claude bills
    about width x height / 750 tokens: a 4:3 picture is about 1,440 tokens
    (about 2,270 for high), the shapes of real boards 700 to 1,500. A request
    gets `MAX_LOOKS_PER_REQUEST` (3) pictures; the fourth look is refused with a
    plain message that tells the model to report, and the count is per
    `runCopilot` call, so the user's next message starts fresh. A refused or
    failed look still counts, so a broken view cannot be retried forever.
    The repeat guard (`repeatGuard.ts`) does not count the cap's refusal: it already
    says what to do, so a model that keeps asking gets the same message each time.
    A look that really failed (an empty 3D board, say) does count, so an identical
    one is refused on the third try without spending a picture.
  - **The proxy** (the hosted app's) accepts these pictures and nothing wider:
    only `text` parts in every role, plus an `image_url` part in a user
    message, only as a PNG or JPEG data URL whose bytes start like one (never a
    link, which the provider would fetch), at most 640,000 characters each, 8 and
    3.2 MB per request; any other part type is a 400. `limits.ts` holds those
    caps (`PROXY_MAX_*`), `tests/fixtures/imagePolicy.ts` restates the proxy's
    rules with them, and `tests/look-images.test.ts` runs what the editor sends
    through it.
  - **When it looks** is in the system prompt in `copilot.ts`: after a big step
    only (building or extending a circuit, tidying, `layout_pcb`, `route_pcb`),
    read the numbers first, fix with the normal tools, look once more at most,
    and say in plain words what it saw and changed.
  - **It reads a sheet's layout too** (`ai/vision/measure.ts`): block frames
    over each other, and a drawn text over a block's title or across its frame,
    are problems, outlined in the picture (a text wholly inside a frame is a
    note, and fine). A `Sheet use:` line says how much of the drawn area is
    used (frames count whole), where the largest empty area is, and which
    frames sit nearer than Tidy's 0.5 gap; below 45% on a sheet with blocks, or
    12% on one without, it calls the sheet sparse. The thresholds were measured
    on the examples and the blog boards tidied, against the same sheets pushed
    apart. An assistant had a sheet title over a block's title and nothing in
    the numbers said so; `tests/look-sheet-layout.test.ts` holds the examples
    to none of it.
  - **Tests**: `tests/look-render.test.ts` (sizes, byte cap, framing, the
    numbers, the SVG), `tests/look-tool.test.ts` (the tool, its cap and its
    failure modes), `tests/look-loop.test.ts` (a scripted model builds, looks,
    fixes, looks, and is stopped by the cap, with the wire checked; many
    batches over many requests, a stop mid-batch), `tests/look-images.test.ts`
    (pictures counted part by part, the proxy's limits).
- **An answer stays where an assistant shows it.** Claude Code warns about a
  tool's output past 10k tokens, and puts one past 25k tokens or 50,000
  characters in a file. `get_design` grows with the board, about 430
  characters a part (27k on a dense 41-part board), so it answers at most
  45,000 (`DESIGN_BUDGET` in `ai/tools.ts`, room left for the notes the MCP
  server adds):
  past that, about 100 parts, it lists each part as its designator, part id and
  value, each net by name and the blocks without their ports, and asks again
  with `block` or `refs`, which read those parts with their pins and every net
  they touch. A 600-part design's list fits (`tests/design-budget.test.ts`).
  `get_wiring` is held to 30,000 the same way (see
  [Schematic edits by the copilot](#schematic-edits-by-the-copilot)).
- **The prompt knows the editor around it** (`EDITOR_GUIDE` in
  `designGuide.ts`, in Sakura's prompt and the hosted app's MCP server's
  instructions alike): the views, the Export menu's files, the imports, and
  that the chat holds text only. Users asked "how do I get the Gerbers" and
  "where is the PCB view" again and again and were told Sakura hadn't checked
  what the editor offers. The guide also says that what the user fixed (the
  board's size, a placed part) is fixed and to do only what was asked (Sakura
  kept proposing to grow a board that "cannot change"), to name a module's
  pins by name (an ESP32 wired to pad 19, its flash pin CMD, for GPIO19), and
  the reply rules: each listed item marked done or not, never ending on a line
  written while tools ran.
- **Tests stub `fetch`** (`tests/copilot.test.ts`), so they pin the request
  the proxy receives as well as the loop's behaviour. `tests/copilot-parts.test.ts`
  scripts the model turn by turn (find, read, build, place) against recorded
  supplier answers, so no model and no supplier is called.
- **Supplier answers are recorded**: `tests/fixtures/supplier/recorded.json` is
  what the hosted app's parts API answered for the 13 production parts and the
  lookup traps (`tests/fixtures/supplier/production.ts` lists them, with what
  each must do). It is recorded against the real endpoints on the hosted app's
  side, which checks that replaying the raw answers still gives exactly this
  file.

## Sakura's web (`ai/webTools.ts`)

Users asked Sakura to read links they pasted (a vendor's docs, a Digi-Key
page, a datasheet PDF), to look up a part, a reference design or a price, and
to find a part's 3D model, and it answered that it couldn't browse and went
on from memory. The host's `WebSource` (`ai/webSource.ts`; this build has
none, so these tools say the web isn't available) gives it:

- **`web_search`**: up to 6 pages with an excerpt each, `site` to keep to one
  website. A search counts against the user's credits on the hosted app, and
  the guide says to search once with good words.
- **`read_web_page`**: the text at a link, about 2.5k tokens a call, a PDF by
  its pages and with the datasheet reader's sections, a web page cut into
  pages; `find` starts at the first page with some words. `read_datasheet url`
  reads a datasheet PDF at a link the same way, and keeps its `confirm_part`
  (only when the text names the part).
- **`set_3d_model`**: a model file at a link (STEP, WRL, OBJ, STL, GLB, or a
  zip of one; a maker's file or KiCad's 3D library on GitLab), the supplier's
  model of an LCSC part, or none; then `rotate` or `offset_mm` to adjust it
  after a `look` at the 3D board. The host fetches and checks the file; the
  page reads it, keeps it like a file the user added (the host's
  `modelFiles`) and fits it to the footprint
  (`editor/three/files/addModelFile.ts`, the Inspector's path, handed to the
  tool as `ToolContext.addModelFile` since it needs three.js, which a server
  can't load).
- **What comes back is quoted data**, between `[web text begins ...]` and
  `[web text ends]` markers nothing inside can close (`quoteWeb`), and
  `WEB_GUIDE` (Sakura's prompt only) says it is never instructions, to cite
  the site, to try the supplier and the parts database first for parts, and to
  read a pasted link before answering about it.
- **Not on the hosted app's MCP server**: an assistant the user brings has the
  web of its own, and these spend Sakura's credits (`WEB_TOOL_NAMES` names
  them).

## MCP: Sakura's tools for the user's own AI

The hosted app also runs Sakura's tools, on its server, for an AI assistant
the user brings (Claude, ChatGPT, Cursor, Claude Code or any MCP client),
through an MCP server that is not part of this repository; a tool added to
`TOOL_SPECS` is on it too, with the same description. What the tools keep for
it is here: a call there is a request of its own (`ToolContext.standalone` in
`ai/toolKit.ts`), so a tool that would act on what the request made asks to be
told instead (`tidy_schematic` with neither `blocks` nor `whole_sheet` tidies
nothing on a sheet with parts), `look` draws with the `ToolContext.renderer`
the server gives it, and the model's per-project state is scoped (see
[The host](#the-host)).

- **Not every tool is on it.** `show_sheet` only changes which sheet the
  user's editor shows; `undo` takes back steps on the editor's undo stack,
  where an assistant's calls are not (it saves and restores versions instead);
  and Sakura's web tools are left out (see [Sakura's web](#sakuras-web-aiwebtoolsts)).
  The lookups that read nothing of the user's (`find_part`, `get_part_data`,
  `read_datasheet`, `search_parts`) take `project_id` optionally there and
  run on a blank project without one: assistants looking a part up before
  making a project were refused for leaving it out.
- **A description stays under 4096 characters**, where Claude Code cuts off
  one it loads up front. `create_part`'s ran past it, so an assistant never
  saw its last paragraph, the one on `land`, and found the field only through
  an error message.
- **What assistants got wrong, and the fixes**: `draw_trace` failed most
  often, its refusals naming no place ("Short between GND, 5V"), so a
  refusal now lists what is in the way in order along the trace, with where
  and how close (`obstaclesAlong` in `ai/pcbTools.ts`), and points at
  `route_pcb nets` for that one net. Field names agents reach for are renamed
  (`ALIASES` in `ai/tools.ts`: `look view`, `group_parts name`, `get_design
  ref`, `find_part q`), a placed part named by `ref` or `part_id` to
  `get_part_data` or `read_datasheet` is read by the LCSC number it was built
  from (`normalizeInput`), and a missing required field's error names the
  fields given that the tool ignored. `get_design` with `refs` reads the ones
  the design has and names the others, and a scoped answer leaves out the
  page, board, rules and drawings and counts other parts' pins on a net like
  GND. `create_part` takes no
  `category` when the record says what the part is (`categoryFor`), names a
  connector's contacts by number when the supplier's symbol names none, and
  takes a non-plated hole drawn with a pad's fields. `set_board` keeps the
  other side when given one, removes cutouts by the numbers the board had
  before a new outline, and says where the board is when a cutout misses it.
  `find_part` strips characters the parts search can't take.

## Schematic edits by the copilot

Sakura's tools (`src/ai/tools.ts`) may not join nets nobody asked to join. Pins join through wire ends, labels and names (`model/connectivity.ts`), so a wire or label that lands on another net is a short, and none of the tools may draw one or leave one behind.

- **`model/merges.ts`** compares the nets before and after an edit (`unrequestedMerges`): a net may join another only when the call named it (the pins it was given, the net it was told to name). Pins, wires and labels all count, so a stray label's name appearing on a net is reported, and so is a new name clash. `pinsUnderOtherNets` finds pins left under another net's wire, which look connected. `connectionsLost` finds pins an edit cut loose.
- **`connect`** (`model/attach.ts`) judges each way of drawing against an index of the sheet instead of recomputing connectivity: a drawn wire for two pins, then labels. A label is tried as a straight stub (0.3, 0.5, 0.9), bent, and last on the pin itself. Nothing may touch the 0.3 in front of another pin (`PIN_CORRIDOR`), so no wire leaves a neighbour without a way out. The result is checked once more with the full connectivity. Pins that cannot be reached are left out and named with what is in the way; the rest are connected (`Partly connected: ...`). If fewer than two pins (one with `net_name`) can be connected nothing changes. The reply offers a spot for the blocked part only after trying it.
- **`update_component`** checks every move, turn and power port rail against the same rules and refuses (changing nothing) with the pins and nets, and a spot or turn that was tried (`model/spots.ts`). What hangs off a part's pins and is nobody else's moves and turns with it (`partFollowers` in `model/ops.ts`): the drawing is cut into fragments of wires, labels and power symbols that touch, and a fragment that reaches the part's pins and no other part's goes whole (a stub to a net label, a symbol on a pin, a comb joining supply pins with a tee to a symbol). Wires that reach other parts stretch (moves) or follow the pin (turns), and wires that end on a wire that moves follow it. Whatever sat on a wire that was reshaped and is no longer on it (a net label in the middle of the wire, the end of a wire that tees into it) is put back on the net (`reseat` in `model/ops.ts`, inside `moveSchematicItems` and `rotateComponent`, so a canvas drag gets it too): on the same run of the wire when it can, only where it touches nothing of another net, never pulling a wire end off a pin that stays, and when it cannot move (it is still held by another wire it crossed, or sits on a pin) with a short wire from it to the wire it lost. A wire stretched into a hook or a doubled-back spur is simplified first, so a label on the spur is reseated rather than left floating. A pin that touched another part's pin directly, with no wire between them to stretch (a power symbol set right on a pin, as Tidy draws them, or two parts pin to pin), gets a short wire to the pin that stayed (`bridgePinContacts`, in the same two functions), as KiCad's drag does, so neither is stuck; a wire that would land on another net is refused like any other. Fragments, an index of the sheet and its connectivity are built once per sheet, so a drag frame is under a millisecond. A move or turn that would still cut a pin off its net, or take a name (a label, a power symbol) off it, is refused like a join is (`pinsCutOff` in `model/merges.ts`, one check with the joins in `moveProblems`), naming the pins, each pin once: a pin already named among the nets it would join is not named again as cut. Dragging a part on the canvas carries and reseats the same things (`dragPlan`, used by `SchematicEditor.tsx`), and is checked when it is dropped (below).
- **The canvas has the same rules, by hand** (`model/schematicEdit.ts`). The R key, the Inspector's rotate button, a drag's drop, paste and duplicate, and placing a part (click or drag from the library) are built with the carrier above and checked with `moveProblems`, then returned or refused with a sentence that says what to do (`CanvasNotice`, `uiApi().showNotice`) and nothing changed. Drawing is not refused: only two nets that each already stand for something (they have a name, or hold 2+ pins) joined, a pin cut off its net, or a pin left lying on another net's wire (`lenient` in `unrequestedMerges`). A symbol dropped on a pin or a wire end, a label naming an unnamed wire, a pin meeting a loose wire, all go through; so does a two-pin part dropped with both pins on the middle of a wire, which cuts the wire at its pins and runs the net through it (`spliceInline`; with anything else touching that stretch it is refused with "cut the wire first"). A single part whose quarter turn is blocked goes to the next position that is not and says so. The check takes the store's memoised `getConnectivity` for the sheet it started from (`Guard.conn`) and computes the result once. `tests/net-rules.ts` writes the rules out for `tests/schematic-edit-fuzz.test.ts` and `tests/examples-turns.test.ts`; `tests/schematic-edit-speed.test.ts` holds a drop and a turn to a time on a 315 part sheet.
- **`add_component`** with x/y, **`create_part`** with `replaces` and **`remove_component`** are checked too; removing a part says which pins it cut loose. A part `replaces` switches keeps its wiring on each pin by number (`switchPart` in `model/ops.ts`): what hangs off one pin alone moves with that pin, a label or power symbol right on a pin goes to it, and a wire ending on a pin is stretched to where the new symbol draws it, then `reseat` and `bridgePinContacts` as for a turn. It used to keep the wires where they were: pins of a symbol drawn anew fell off their nets without a word, or landed on another net's wire and the switch was refused, even for a part whose pin numbers and footprint had not changed (an assistant hit it rebuilding a bridge rectifier from supplier data). A switch that still joins nets is not made: the new part is still stored, beside the old one whose components stay as they were, and the result says why and to place it with `add_component` instead. It used to be refused whole while naming the new part_id to place, which no project held: `search_parts` couldn't find it and `replaces` said it "wasn't made in this project". Pins it still cuts off, and pin numbers the new part lacks, are said in the result. `create_part` again with a part the project already has and `replaces` is the switch to it.
- **`remove_wiring`** (`model/unwire.ts`) is how a wire or a label is deleted, which no tool could do before (an assistant over MCP was left with the ports, labels and wire a tidy kept, and only `remove_component` for the ports). `pins` takes each pin off its net: from the pin, the wire as far as the first junction, label, port, sheet pin or other pin (on Tidy's wire graph, `wireGraph` in `tidy/cut.ts`), labels and ports right on the pin, and a label or port that leaves standing on nothing; a pin touching another pin directly stays on it, and the reply says so, as it names every other pin cut off. `loose` deletes each island of drawing that reaches no part (what Tidy keeps below the blocks and counts, so a tidy's result that kept some points to it), except one with a hierarchical label or at a sheet pin, and except one whose going would cut pins off: two names on one wire join their nets, so it is kept and said. It only deletes, so it never joins nets: a piece left of a wire cut short ends where the cut was, and where that end would join something the wire only passed over (a pin under its middle, another wire's end at its side), the wire goes whole instead. `tests/remove-wiring.test.ts` holds that on every example. `get_design` says when there is any (`loose_wiring`, counted once per sheet): it lists no plain wires or labels, so a sheet of two stray ports, two labels and a wire read as empty to the assistant that hit this, and Tidy then kept them below its blocks, as it should.
- **`get_wiring` and `draw_wiring`** (`ai/wiringTools.ts`) are the schematic by its coordinates, for when where things go matters (an assistant matching one block's drawing to another's measured pins in `look`'s picture, and `connect` refused a wire for passing in front of a pin on its own net). `get_wiring` lists pin ends (with the way each faces and its net), wires, labels, ports, junctions and frames, for a block, an area or the sheet; `get_design` stays without coordinates, which would double it. An answer is at most 30,000 characters (`WIRING_BUDGET`, about 10k tokens, where Claude Code starts warning about a tool's output; see [Managed AI](#managed-ai-the-copilot)): a whole sheet past that (a dense 41-part board's is 32k) answers with its frames, to ask again by block or area, and every block of the examples and the blog boards fits. `draw_wiring` draws exactly the wires (horizontal and vertical segments) and labels (a point and the side the text runs to) it is given, and is refused whole, with nothing drawn, when it would join anything but what its wire ends and labels touch (`schematicEditProblems` with those nets allowed), join two named nets (a name clash), leave a pin under another net's wire, run a wire along one already drawn, or leave a label on nothing. It doesn't keep pins' corridors as `connect` does: the caller chose the geometry. Its reply says what each end touched, the net each wire is on, a wire end left on nothing, and a wire through a symbol. `connect` itself was left alone: letting it pass in front of a same-net pin drew a wire along that pin's stub and across its wire, worse than the labels it falls back to.
- **`edit_net`** (`ai/wiringTools.ts`, `model/netEdit.ts`) renames a net keeping every wire: each label and power port carrying its name takes the new one, and what the board keeps by its name (pours, vias, widths, net classes, the copper's net, its style) follows (`renameNets`). Refused, with nothing changed, when another net has the new name (that is a join, which `connect` makes), when the name is one the editor makes up, or when the pins would not be on the same nets after (a hidden power pin or a hierarchical label joining by the old name would stay behind). A net with no name gets one from a label `connect` puts on one of its pins, checked the same way first (`renameTargetProblem`): `connect` with another net's name would join the two. `draw_as` sets `Project.netStyles` (below, under Tidy); `port` is refused for a net a local or hierarchical label names, which Tidy keeps as labels, and the Inspector doesn't offer it there. An assistant renamed a net with a temporary name, a tidy and rewiring by hand.
- **Names `connect` makes up** (`NETn`) never count as a name clash, and are renamed when their net is joined under another name: by `connect` for the joins it draws, and by the store for every other edit (`settleMadeUpNames` in `model/madeUpNames.ts`, in `settleEdit`), so a power port or a part moved onto such a net leaves no `NET3` label on `GND` for Checks to report.
- **The tests**: `tests/connect-shorts.test.ts` and `tests/schematic-edits.test.ts` pin the cases. `tests/connect-fuzz.test.ts` runs random designs through every tool with an oracle (`tests/schematic-fuzz.ts`); set `FUZZ_DESIGNS=300` for the full run. `tests/sakura-move-drops-connections.test.ts` and `tests/sakura-session-fuzz.test.ts` replay a Sakura session in which a move cut a BME280's supply pins loose, and `tests/tidied-move-fuzz.test.ts` moves and turns random parts on sheets drawn the way Tidy draws them (`tests/tidy-shapes.ts`): each call keeps every pin on its net, or is refused and changes nothing (`FUZZ_SHEETS=200` for more). `tests/drag-keeps-nets.test.ts` pins drags that used to cut a net, and `tests/examples-moves.test.ts` drags every part of every example 18 ways (the shipped ones and the ones drawn before Tidy, `tests/frozen-examples.ts`; rates such as fewer than 5% refused are held on the latter only, since a tidied sheet packs parts closer and a big jump lands on a neighbour, which is refused as it should be), and none is left out of the count: each drop keeps the netlist, connects only by the lenient rule, or is refused with the sheet untouched (the drops an unchecked drag would have broken are the refused ones), and fewer than 5% of nudges by update_component are refused. `tests/reseat.test.ts` holds `reseat` to doing no harm of its own on hand-drawn sheets.

## Project parts

`model/customParts.ts`. The library has the generic parts and the common
specific ones (see [Library parts](#library-parts)); anything else (an LDO by
part number, a sensor, an odd connector) the copilot makes with `create_part`,
**from supplier data when a supplier has the part, and from the pinout it
remembers only when none does.** Without a supplier source they are made from
memory and marked unverified, and the library panel's search finds only the
built-in library and the project's own parts. This build has neither a
supplier source nor a session for Sakura.

### Built from supplier data

Parts made from memory are wrong too often to ship: of 13 that Sakura made
with `create_part` and that were checked against LCSC, three had pin maps that
kill the board (a TPS61023 with its input on its output pin, an AD8318 with its
supply on its ground pins, a filter with its RF output on a ground pad) and
eight sat on the wrong land. So:

- **The tools.** `find_part` searches the supplier catalogue, `get_part_data`
  reads one part (pins with their roles, the land in millimetres, its size on
  the board: the courtyard create_part's land will have, the silkscreen's
  outline and the body its 3D model's or package's name gives, stock,
  datasheet), and `create_part` takes `lcsc` and builds the part's pins and
  land from that record. Without `lcsc`, `create_part` looks the name up
  itself (`ai/partLookup.ts`) and builds from what it finds. `verify_parts`
  checks parts made earlier: ten a call, parts not checked yet first, the
  count of those left over said, and a part whose lookup failed reported with
  the reason ("Checked 3, couldn't check 7: ...") and moved to the back of the
  line rather than read as nothing to check. They reach the supplier through the host's
  `SupplierPartsSource` (`ai/supplierParts.ts`), which is the hosted app's
  `/api/v1/parts`.
- **The parts database answers beside the supplier** (`ai/databaseLookup.ts`):
  KiCad's libraries and the supplier records the server kept, through the
  same source's `index` (`/api/v1/parts/index/*`), which spends no supplier
  lookups. `find_part` lists its parts after the supplier's with a
  `database_id`, and still answers from it when the supplier search fails;
  `get_part_data` and `create_part` take a `database_id`. `create_part` by
  name asks both at once: the supplier's part is built when it has one (with
  a note when KiCad's drawing of it disagrees), unless it is only a user's
  upload or has no land and a stored part is the name. Otherwise a stored
  part, before memory, in this order: the same number, or a KiCad wildcard
  that covers it (`STM32F103C8Tx` for `STM32F103C8T6`, built with the asked
  number as its part number); a stored LCSC record of an orderable number of
  it whose drawings agree (`TPS61023DRLR` for `TPS61023`); and only when
  nothing nearer is stored and the drawing's footprint names the same package,
  the name less its ordering letters (`NE555P` for `NE555PW`, the DIP for the
  TSSOP). The drawing's footprint narrows a choice and never overrides the
  name. Stored parts that are different parts (package, body size, pin map:
  `samePart`) are listed for Sakura to choose. A KiCad part built by
  `database_id` is compared with the supplier when it is built (a KiCad
  wildcard under the name asked, which is also its part number, and not at all
  without one), one built while the supplier is failing is left `pending`, and
  the verdict is kept on it: on the part the project already has too, where a
  real comparison replaces whatever it held.
- **One comparison with the supplier** (`ai/supplierVerdict.ts`): verify_parts,
  `create_part database_id` and the library panel's check all ask it, so a part
  gets one verdict whoever asks. The drawing's pins and footprint choose the
  package first (a KiCad SOT-223 is compared with LCSC's SOT-223, not a SOT-89
  its pins happen to fit); a stored part's own land is not compared pad by pad,
  since a supplier draws the same package with other pads.
- **`read_datasheet` reads what the datasheet says about the circuit**
  (`ai/datasheetTool.ts`): `lcsc` or `name`, a `section` (`pins`, `ratings`,
  `application`, `overview`) or a `page`, through the host's
  `SupplierPartsSource.datasheet` (the hosted app's
  `/api/v1/parts/{lcsc}/datasheet`; absent in this build, where the tool says
  so). It is for a chip's recommended support values, ratings near a limit, and
  supplier data that is missing or disputed, and returns about 2.5k tokens of
  pages with their numbers so Sakura can cite "datasheet p.12". **The text is
  untrusted**: wrapped in `[datasheet text begins ...]` and `[datasheet text
  ends]` markers that nothing inside can close (lookalikes are replaced), with
  the system prompt and the result both saying it is data, never instructions.
  It is async with the abort checks and the repeat guard like the other
  lookups, and never changes the project except through `confirm_part`: a pin
  table compared with a project part and found to agree is recorded as
  `source.datasheet` (pages, LCSC number), which Checks says in words ("Sakura
  compared its pins with the datasheet (p.4), which is not a supplier check")
  and which never makes the part verified. Pin tables are not parsed into pins.
- **A name resolves to a part family, not to an orderable number.** A name is
  rarely the number a supplier sells under (`TPS61023` is `TPS61023DRLR`,
  `ADS1115` is `ADS1115IDGSR`, `SHT31-DIS` is `SHT31-DIS-F2.5kS`, `MPU6050` is
  catalogued `MPU-6050`), so `partLookup.ts` reads the records whose number is the
  name (ignoring punctuation and a packaging note) and, when it has no record
  of its own, its ordering-suffix variants
  (`model/supplier/partNumber.ts`: a number that merely goes on with digits,
  `INA2191` for `INA219`, is another part). They are **grouped by package and
  by function on every pin number**: one group is one part, resolved to its
  best stocked member (the first listed when no stock is known), and the answer
  says which LCSC number and part number was chosen. Variants are one part only
  when no pin number carries another function in one than in the other: a rail
  that is another rail (VIN and VOUT) or a signal that is the other record's
  name for another pin (SDA and SCL swapped) splits them, with the differing
  pins spelled out; a name spelled two ways on one pin (`OD` and `DOUT`, `VDD`
  and `VCC`) doesn't. More than one group is a real choice (`ADS1115` in
  VSSOP-10, X2QFN-10 and WLCSP-12; `INA219` in SOT-23-8 and SOIC-8), refused
  with a short list, best stocked first, and what differs; a package nobody has
  in stock isn't a choice while another is. When stock is unknown for all of them
  the most common package comes first (one with a footprint of its own, then the
  family most candidates come in) and the text says the stock is unknown, never
  "best stocked". An exact record whose stock is unknown (not sold, or not
  looked up) doesn't outrank the name's stocked variants: they join it (the
  WS2812B's stocked 5.0 x 5.0 mm part is listed first). The drawing narrows it
  first: its footprint's family and size (`led5050` is the 5.0 x 5.0 mm record,
  not the 3535 that is better stocked), its pin count, and the records its pins
  don't contradict. `WS2812B-2020` is another size and another pin order, so it
  never joins `WS2812B`'s group, and a name whose own records name no pins
  builds nothing from a variant, however well it is drawn (the variants in its
  package still refuse a wrong drawing, below).
  A package is the same one when its length, width and pitch agree within a
  fraction of a millimetre (suppliers call one package SOT-23-5 and SOT-25-5),
  and a symbol with fewer pins than its package has leads is an unfinished
  drawing, passed over. A reviewed LCSC record outranks an EasyEDA user's
  upload (`C99...`) even when the upload is the exact name; an upload is the
  part only when nothing reviewed is, marked lower confidence wherever it is
  used. Records the supplier couldn't be read for are unknown, and a name left
  with only those is "couldn't check", never "no pinout". Known limit: the first
  listed of a choice is the best stocked package, not always the commonest one
  (W25Q128JV lists its 16-pin SOIC "FIQ TR" before the 8-pin SOIC).
- **A drawing's pins are checked whenever there are candidates**, which is what
  `from_memory` once skipped (production TPS61023 pins, wrong, with
  `from_memory: true`, were made; `verify_parts` then said "no record" although
  C919459 exists). The drawn pins are compared role by role with the family
  the name resolves to, or with every package it is sold in: a mismatch is
  refused in `create_part` and is `contradicted` (an error in Checks) in
  `verify_parts`, including when the records numbered exactly like the name
  name no pins: its pinned ordering variants in the same package (by size, so
  not another size) still refuse a wrong map, though they build nothing.
  `from_memory` is honoured only when no supplier part numbered
  like the name has the drawn pin count (`different`: those are other parts),
  and a name with no supplier part at all needs no flag. "No record" is said
  only when there is none, and a name with parts of another pin count is
  `different_part`. **A lookup that fails builds the part only as plainly
  unverified**, with `source.check.verdict: "pending"`: Checks warns that it
  was made while the lookup was failing, and `verify_parts` and the Checks
  button take it first once the supplier is back.
- **What it refuses, with numbers.** Pins or a footprint passed with a record
  are compared with it (`model/supplier/verify.ts`). Pins are compared by role,
  not spelling (`pinmap.ts`): a supply or ground pin of the real part drawn as
  anything else, a supply or ground drawn on a named signal, a supply input on
  a supply output (TPS61023), a name the supplier uses on another pin, a pin
  number the part doesn't have. Spellings (`1B` for `IN1`, `VDD` for `VCC`,
  `I/O1` for `IO1a`) are reported and the supplier's names used. Lands are
  compared pad by pad after centring, over the four quarter turns
  (`land.ts`): each supplier lead position has to be on the drawn pad's copper
  and the drawn pad's middle on the supplier's. The refusal quotes pad counts,
  pitch, row spacing and the worst pad in millimetres, and says when the pads
  fit but are numbered the other way round.
- **Footprint names that draw another package** are refused even with no
  record to compare (`footprintGuard.ts`), each with what it draws:
  `dfn8` (a SOIC-8 land), `ssopN` (1.27 mm pitch), `tssopN` (0.5 mm),
  `msop8`/`msop10` (the footprinter numbers their second row top to bottom, so
  pin 6 sits opposite pin 1: `vssop8`/`vssop10` are the same pads numbered the
  right way), and `qfnN`/`sonN` with no size.
- **The land is the supplier's own copper**, as a project land pattern
  (`model/supplier/build.ts`) named after its package family and LCSC number
  (`sot563_c919459-1a2b3c`) so the 3D view picks a body for it; a chip-sized
  part whose pads the footprinter's `0603` (say) matches uses that instead.
- **Diodes keep the supplier's numbering**: pad 1 is the cathode, as on LCSC
  and in IPC land patterns, where the library's own diodes number the anode 1
  on lands drawn for that. Both are right because the symbol finds `A` and `K`
  by name; a drawing numbered the other way from its supplier is reported as a
  convention, not refused.
- **Exposed pads take a pin number**: the footprinter's thermal pad is
  numbered one past the last lead (17 on a QFN-16, `PadDef.exposed`), as
  datasheets and supplier lands number it, so a part can wire it to ground. A
  part that leaves it without a pin still builds, as before.
- **Provenance is stored on the part** (`CustomPartSpec.source`): where the
  pins and the land came from, the supplier record and how many of its
  drawings agree, why a part was made from memory, and the latest check of a
  memory part. A part placed from the parts database has `pins` and `land`
  `database` and `database` naming the KiCad part or supplier record, its
  release, licence and credit; it counts as built from data, so Checks says
  nothing about it and `verify_parts` leaves it alone, unless a comparison
  with the supplier found it contradicted, which is an error. A KiCad part
  placed from the panel is compared in the background
  (`model/placedPartCheck.ts`, one at a time through a small queue, never for
  a KiCad wildcard name, which no supplier number is), recorded with the
  store's `patch`: not an undo step, but written into the part as the undo
  and redo steps put it back too, so Undo then Redo keeps the verdict, even for
  a part undone while its lookup ran. A failed lookup, or a check the queue had no room for,
  records `pending`, which `needsCheck` counts, so `verify_parts` and the
  Checks button take it up later. A part built straight from a supplier's
  record keeps the record's credit (`source.supplier.attribution`), shown in
  the Inspector. A part whose pins or land the user changed in the part editor
  has them as `user` (see [Kept by the user](#kept-by-the-user-the-part-editor)).
  A chip the library used to list has them as `library` (see [Library
  parts](#library-parts)): Checks says nothing about it, on any footprint.
  It is an optional field, so no format
  version: a part saved before it has none, and reads as made from memory. The reader checks it field by field (`normalizeSource` in `projectFile.ts`): a malformed `check` or `supplier` is dropped or given neutral values, so a damaged file can't crash Checks. It is left out of the
  part's id, so a part checked later keeps its id. `model/partChecks.ts` turns
  it into what Checks and `run_checks` say: memory parts are warnings,
  contradicted ones errors, and parts built from data say nothing unless the
  supplier's drawings disagree or the component's footprint was swapped.
- **Copilot tools can be async.** A tool with lookups has a `prepare` that
  awaits them, and its `run` then makes the change to the project as it is at
  that moment (`executeTool` in `tools.ts`), committed only if it is still the
  open project: an edit the user makes during a lookup is kept, as its own undo
  step. `runTool` runs a tool with no lookups at all, as with no supplier.

### Imported from KiCad files

`model/kicadImport.ts` reads them, and `panels/kicadImport.ts` hands them
over; the button and the result line are in the library panel
(`panels/ImportKicad.tsx`).

- **The same converter as the parts database's** (`model/kicad`): a symbol
  is paired with its footprint pin for pad, or refused with the reason
  (`SKIP_TEXT`). What the import adds is finding the footprint, since a
  user's files aren't in KiCad's library layout: the file the symbol's
  Footprint field names, matched by name with the library left off; one
  symbol given with one footprint is paired whatever the field says, and the
  result says so (vendors' names rarely agree); among several, only names
  pair them, or a symbol could land on another part's pads. A symbol may
  extend one in another file given with it (KiCad 10 keeps a library as a
  directory of one-symbol files), and a base given in a file of its own only
  for that is not imported itself. Footprints given with no symbol at all are parts with a
  pin per pad. Power symbols are passed over.
- **The part is the user's own land**, never swapped for a footprinter one,
  named like a database part's (`sot23_5_file_sot_23_5-<hash>`) and carrying
  its package's name. Part number, maker and LCSC number are
  read from the fields vendors use (`MPN`, `MP`, `Manufacturer`, `MF`,
  `LCSC Part`...), the part number defaulting to the symbol's name.
- **Provenance is `pins: "file"`, `land: "file"` and `source.file`**
  (the symbol as `Library:Name` and the footprint's name). It counts as
  built from data, as a database part does: Checks says nothing about it and
  `verify_parts` leaves it alone unless named, and then compares its pins
  only, since its land is the user's own. The Inspector says "Imported
  KiCad files". Not to be confused with `import`, a part that came in with
  a whole KiCad schematic (the dashboard's import, `source.imported`).
- **Its 3D model**: a file given for the model the footprint names (by
  name, a STEP of the same name preferred over a WRL), placed as the footprint
  places it (the angles negated as for KiCad's own, a WRL's tenths of an
  inch); else the one model file given for the one part, fitted to the land;
  else KiCad's own STEP when the footprint names a model in KiCad's 3D
  library, at `KICAD_MODELS_RELEASE`. Given files are read before they are
  kept, as the Inspector's are, and a file that doesn't read leaves the part
  without a model, said in the result. A part already in the project
  keeps its model, unless a file is given with it again. KiCad 5 footprints
  (`(module ...)`, a model's `at` in inches, `${KISYS3DMOD}`) read too.
- **Zips are opened in the browser** (jszip): every KiCad and model file in
  them, whatever folder it is in, and nothing else. KiCad 5 libraries
  (`.lib`, `.mod`) are refused with a sentence; KiCad 8's models embedded in
  a footprint are not read.
- The parts land as one undo step, in the project the import started in. One
  part is placed at once; several are listed under "This project".

### Kept by the user: the part editor

`model/projectParts.ts` (pure functions on the project) and
`panels/PartEditor.tsx` (the dialog), with what the library panel shares with
it in `panels/partActions.ts`.

- **Removing a part** (`removeParts`) takes out the spec, every component
  placed from it (through `removeItems`, as deleting them does), its 3D models,
  and the land patterns and symbol drawings nothing left in the project names.
  One undo step. A part nothing is placed from goes at once from the panel; one
  that is placed asks first, in the part editor, naming the components that go
  with it.
- **The part editor** is a dialog over the canvas: the symbol and the land
  drawn live from the draft on the left, and General (name, description,
  category, designator prefix, symbol, search keywords, parameters and which
  one is the value), Pins (number, name, type, side; read only for a part with
  a KiCad drawing, whose drawing has them), Footprint (the name, shared
  pads, each pad with the pin it carries) and 3D model on the right. The 3D
  model tab is the Inspector's controls (`ModelControls` in
  `panels/ModelSection.tsx`: a file, the supplier's model, the built-in model
  or none, the placement) over a 3D view of the part alone on a scrap of board in the
  project's colours (`editor/three/PartPreview3D.tsx`, the 3D view's own
  `BoardScene`, loaded on demand), so a model is placed by eye before it is
  saved. A model sat on a footprint the draft moves the part off is left out,
  unless "Keep it anyway" carries it over. What
  `customPartProblems` says is wrong shows under it and holds Save back. The
  footer names the components placed from it, a click shows one. A viewer
  reads it all and changes nothing.
- **Saving is `editPart`**, one undo step. A part's id follows from its
  definition, so the edit is a new spec in the old one's place in the list, and
  every component placed from it switches over: to the new footprint unless it
  was given another, and to the new parameters where it still has the old
  ones (a value set on one component stays). Its 3D models follow while the
  footprint stays; a model fitted to a footprint that changed is dropped. A
  model chosen in the dialog (`model`) is the part's on its footprint after
  the edit, and is the whole edit when nothing else changed. An
  edit that comes out the same as another part of the project switches to that
  one. It is refused, with the reasons, when the spec doesn't build or when
  its pins would join nets on the sheet (`schematicEditProblems`, as
  `create_part replaces` is), and it says whose pins moved with the symbol.
- **Provenance after an edit** (`editedSource`): the name, description,
  parameters, pin types and sides and the symbol say nothing about where the
  pins and the land came from, so they keep it. Pins (numbers and names) or a
  land changed by hand become `user`, the user's word for the part as their
  own KiCad files are: Checks says nothing about them, `verify_parts` leaves
  them alone unless named, and the Inspector says "Edited by hand", still with
  the credit of what it started from. A part made from memory stays `memory`
  however it is edited, so its warning stays until a supplier settles it, and
  any edit of the pins or land drops the check (and a datasheet reading of the
  pins) that was about what was there before.

### The spec

- **A part is a spec, stored in the project** (`Project.parts`), and built into
  a `PartDef` when the project is opened or imported. Its id is a slug of the
  name plus a hash of the definition, so one id never names two different
  parts; that is what lets `findPart` keep a registry (`registerPart` in
  `library.ts`, one per scope: `model/scope.ts`) instead of threading the
  project through every renderer, and why a corrected part (`replaces`) gets a
  new id.
- **The footprint is a footprinter string**, or the name of one of the
  project's own land patterns (below), and `customPartProblems` checks that
  the pins and the package's numbered pads match one to one (shared pads, like
  a SOT-223 tab, go through `pad_alias`). The error names the pads or pins that
  don't match, which is what the model needs to fix it on the next round.
- **A footprint whose pads aren't numbered like the part's pins is refused**
  by `add_component` and `update_component` (`footprintPinProblem` in
  `footprints.ts`): every pin needs a pad of its number, through the part's
  `padAlias`, and every numbered pad a pin (an exposed pad may have none),
  with the pins and pads that don't match. What the part's own first
  footprint already leaves unmatched is not held against another, since a
  KiCad symbol need not match its footprint. An assistant gave a connector
  another part's land and nothing checked it.
- **A footprinter option its family doesn't take is refused**
  (`footprintOptions` in `footprints.ts`, `footprintOptionProblem` in
  `supplier/footprintGuard.ts`), by `create_part`, `add_component` and
  `update_component`, with the land it would draw and the sizes the family
  takes. The footprinter itself drops such an option without a word: an
  assistant over MCP asked for a Phoenix 1777558 (three pins, the middle one
  9 mm behind the others) wrote `pinrow3_p6.35mm_zigzag9mm_...`, then
  `_stagger9mm_`, and got three pads in a row both times. An option counts as
  taken when the family's parameters read it back, or when leaving it out
  changes the copper (`smtpad_circle_d1` spells its parameters otherwise,
  `sot23_5` reads its pin count from the string); a bare pin count the family
  has anyway (`to220_3`) is fine. `res`, `cap`, `led` and `diode` read back
  whatever they are given, so theirs is a list. The same check found that
  `dfn` reads no `h`, which the tool description had been recommending.
- **A land no footprint string draws is given pad by pad**: `create_part`'s
  `land` (`model/drawnLand.ts`), each pad's number, place, shape (`rect`,
  `roundrect`, `circle`, `oval`) and size, with `drill` and `slot_length` for
  through-hole, `plated: false` for a bare mounting hole, a turn, and paste and
  mask settings; pads given one number are one pin. The body's two corners
  draw the silkscreen and, with a margin, the courtyard. Millimetres, y up, the
  origin wherever the pads put it. What can't be drawn as given is refused
  with the pad it is about (a hole with no copper round it, a circle given two
  sizes, paste on a through-hole pad, copper of two pins overlapping), and a
  field the schema doesn't name is refused by `validateInput`
  (`additionalProperties: false`), not read past, so `hole` for `drill` can't
  quietly make a surface-mount pad. `land.kicad_mod` takes a KiCad footprint
  file's text instead (`kicadFootprintLand`, the import's reader). Either way
  the part is from memory, marked unverified like any other, and compared
  with the supplier's land when the supplier has one.
- **Symbols**: a box with power pins on top, ground below, inputs left and
  outputs right by default; discretes can use a library symbol
  (`CUSTOM_SYMBOLS`), with polarized pins matched by name (A/K, +/-, B/C/E,
  G/D/S) rather than by number, since packages disagree about numbering.
- A spec that no longer builds is dropped on load rather than breaking the
  project; its components show as unknown parts. Pasting a project part into
  another project copies its spec along (`withPartsFrom`), and its land
  pattern if it has its own.
- **Project land patterns** (`Project.footprints`) are pads, silkscreen and a
  courtyard as data, for a package neither the library nor the footprinter
  draws. Any component or project part names one like any other footprint;
  `registerProjectFootprints` (in `footprints.ts`) makes the names resolve, as
  `registerPart` does parts, and `normalizeProject` drops one with a malformed
  pad whole rather than drawing it without that pad. Their names end in a hash
  of the pattern, like a project part's id. Imported boards and imported KiCad
  footprints make them, and so does the copilot when it builds a part on a
  supplier's land or is given one (`land`, above); other parts made from
  memory are on footprinter strings.

## Tidy: arranging the schematic

`tidySchematic` in `model/tidy/index.ts` lays the schematic out again, the way
the blog boards' sheets are drawn, and runs only when asked. It moves and turns
parts and draws the wires, labels and power ports anew; it never moves a pin
within a symbol, and every tidy is checked against the netlist pin for pin
(names included) and refused with the project unchanged if anything differs.
A block of a whole-sheet tidy that can't be laid out is kept exactly as it was
drawn (its parts, its block and the drawing that is its alone), the other
blocks are tidied and placed beside or below it, clear of it, and the message
(and Sakura's reply) names the block and why; drawing it shares with a tidied
block is cut where it leaves the tidied part, as one block's tidy cuts it. Where
the rest goes is read from the kept block's frame as the next tidy will find it
(without the tidied parts where they were drawn), so a second tidy changes
nothing. A cut on wire drawn off the grid moves along that wire, or on a bit
of wire of its own, to the grid before its label or port goes there, where that
has room. Loose parts kept so are not made a block. A sheet none of whose
blocks can be laid out, or one block tidied on its own that can't be, is
refused as before.
Wires, labels and ports that connect no part, and wire from a pin to nowhere,
are kept as drawn (moved below the blocks by a whole-sheet tidy) and the
message says so. A tidy from the toolbar or `T` runs in a Web Worker
(`editor/schematic/tidy.worker.ts`, the project sent as a project file, which
registers its parts there), with a spinner meanwhile; one that takes over 30
seconds is stopped with the sheet unchanged, and closing the editor shuts the
worker down. A tidied block that moved is brought into view. Tidying one block
(`cut.ts`) removes the wire from its pins to the first junction or pin of
another part, then whatever is left of that drawing that reaches no part
outside the block (its own labels and ports, which it draws anew); what still
reaches another part stays, with a label or port where it was cut, placed
where it has room. Wire that leads to no pin at all (a stub, or wire a part
was dragged off) is not cut: it stays where it was drawn with any label or
port on it, and the message counts it. The cut reads the drawing as it was, so the order of the
parts changes nothing. Sakura tidies the whole sheet only on a sheet that was
empty, else the blocks it added or changed parts in. What a tidy keeps that
reaches no part, `remove_wiring` with `loose` deletes, and the tool's result
says so.

- **On the page**: a whole-sheet tidy lays the blocks out on the sheet's page
  (`paperOf`), from the inner frame's top-left a block gap in, packed to the
  page's shape and clear of its title block (`packRows` with a target: an
  arrangement that fits beats one that doesn't). Everything it places is then
  held to the page (`holds`, each on its own): the tidied frames, the blocks
  it kept as drawn, what reaches no part stowed below them and what a KiCad
  sheet drew. When something isn't, the page grows one size in its family
  (A4 to A3, US Letter to US Ledger, a custom page to just big enough), its
  top-left corner kept, and the blocks are packed again, until it holds;
  the message says so ("The sheet grew from A4 to A3 to hold it."), and when
  even the largest of the family can't, that it doesn't fit. What stays as
  drawn left of the page or above it no size reaches, so the page isn't
  grown for it and the message points at Fit to drawing. The page is stored
  on the view's sheet, so every use of it shares it. A one-block tidy leaves
  the page alone. `tests/tidy-page.test.ts` holds it.
- **Between blocks** (`flow.ts`): reading order by signal flow, from the nets
  and the parts on them: the connector on the highest supply first, then
  regulation, the controller (the chip with the most pins), the chips it talks
  to, then connectors and indicators, then test points. Frames go in rows with
  even gutters, the row width chosen for a compact sheet of the page's shape; a short
  frame goes under the one before it rather than alone on a row. Parts in no
  block are gathered into a block named OTHER.
- **Inside a block** (`clusters.ts`): each chip, connector or module is drawn
  about itself with the small parts that serve it: a part joins the chip it is
  wired to through the fewest small parts, along two-pin nets first (so a
  divider wired to its connector stays with the connector), and a part between
  rails alone (a decoupling capacitor) joins a chip on its supply. Chains that
  serve no chip (a power LED) are drawn on their own. A supply that one to
  three small parts of its own path serve (`wiredSupplyPins`: a regulator's
  capacitors, a connector, diode and regulator in a line, a chip's one or two
  decoupling capacitors) is wired like a signal, and the chips it joins are one
  cluster. Chips and connectors that meet point to point are one too
  (`joinLinked`): a signal net whose pins in the block lie in the clusters of
  exactly two of them (a driver's output and its terminal, a USB connector and
  its ESD chip) is a link, and the two are drawn as one cluster, wired on it.
  A net on three or more (a bus) is no link. A cluster holds at most three
  chips, connectors and modules (`LINKED_SEEDS`), links are taken in the order
  of their nets' keys, and only pin counts and the netlist decide. A joined
  cluster is drawn once, as it comes first; unless every link is wired whole,
  the clusters it was made from are drawn apart, as before, with the links
  labelled, so one that can't be wired (a terminal facing away from its
  driver, or with its pins the other way round, since Tidy never turns or
  mirrors a box part) costs one attempt and nothing that tidied before fails
  to. One link that can't be wired leaves every link of the cluster labelled. The clusters of a block are packed like frames
  on the sheet, nets between them labelled.
- **About a part** (`block.ts`): the main part first, then decoupling
  capacitors in rows above it (upright, supply port on top, ground below),
  chains on neighbouring pins (an LED and its resistor) fanned out into
  columns, then parts across two of its pins (a crystal), and then each other
  part at the cheapest spot near what it connects to, a two-pin part on a port
  upright where it can be, every spot tried for real: drawn, wired (`route.ts`, A* on the 0.1 grid
  with a cost per bend) and given room for its labels and ports, and refused if
  anything would touch anything else (`space.ts`). A small part is wired to
  all it shares with the cluster; a chip, connector or module only on a supply
  the block wires and on its links, and a spot for one with a link is looked
  for twice as far out, since it is big. Supplies get power and
  ground ports at their pins, except a supply the block wires, which gets one
  port per wired piece; a net that leaves the cluster, has a name (one
  `connect` made up, `NET3`, counts as none), or couldn't be wired whole gets
  a label, reading across (its stub turns off a pin on the
  top or bottom, or off a wire across). A port stands the rail's way, on a stub
  that bends if it must; it is turned aside only where neither fits (a cost,
  not a rule). A wire may tee into another at a bend as well as along it, but
  never a step from another junction, so two dots never run together (the
  bar joining pins side by side is the exception: it is where their supply
  tees in). A label found room on a way out of its own never lies over that
  way. A part nothing near can take goes further out, unwired, reached by
  labels.
- **Templates** (`block.ts`): what an engineer draws the same way every time,
  drawn about a chip before the rest of its cluster: a crystal with its load
  capacitors (across, below and out from the two pins, each capacitor hanging
  to ground under its pin's wire, the crystal teeing into both); a 555's
  timing parts side by side (the part to the supply on the discharge pin's
  row, the capacitor outermost, wired over the top to the threshold pins, the
  resistor between teeing into both, since stacked in one column their taps
  would cross); a pin's pull-up and button off its straight wire; and the
  capacitors of a supply the block wires, hanging off that supply's wire. The
  chip's labels and ports near the template move out of its way and find room
  again; one that won't read across, or a wire that can't be drawn, undoes the
  template, and its parts are placed like any other.
- **Fallbacks**: a cluster that can't be drawn with templates is drawn without
  them, then as Tidy drew before any of this (`LayoutStyle` "first": the old
  costs, no templates, no tees at bends, labels and ports placed and moved as
  they were), so a sheet that tidied before still does. Then with a port at
  each pin of a supply it wires instead of the wire (`supplyDrops`), fewest
  supplies first: a wire joining a chip's supply pins can wall in the pins
  between them (the BME280's CSB tied to 3V3 under SDI and SCK), whose labels
  then have nowhere to go.
- **Same choices every time**: while parts are placed, a name Tidy gave a net
  (`U1_XTAL1`, or the editor's `Net-(R1-2)`) or `connect` made up (`NET3`)
  counts for nothing; only names someone else gave do (`TidyNet.given`). So a
  second tidy, which finds those names drawn, makes every choice the first one
  did.
- **Names**: an unnamed net that needs a label is named after its most telling
  pin (`U1_OUT`), as the tscircuit importer names them, and a pour, stitching
  via or trace width follows it to its new name. A named net keeps the name it
  goes by, and every other name it had (a 5V label and a VCC port) is drawn as
  a label of its own, so the merge stays visible in Checks: beside the net's
  label where it fits, else on another of its pins or its wires once the sheet
  is drawn (`room.ts`), never on wire that reaches no part (stowed below the
  blocks, it would move with that wire next time). A name with no room anywhere
  is left out and the message says so; it never stops the rest of the sheet
  being tidied. A net whose one name is one `connect` made up (`NET3`, for
  three pins joined with no name; `madeUpNets` in `nets.ts`) is drawn as an
  unnamed net: it keeps `NET3` on the labels it needs (where it leaves its
  block, so the labels a one-block tidy leaves outside still match), and where
  it is wired whole the name goes with its labels, the netlist check allowing
  it, and a pour, via, width or net class on `NET3` follows the net to the name
  it goes by now.
- **Labels or ports, by choice** (`Project.netStyles`, by the name a net's
  labels and ports give it): `label` draws a net with labels even when its
  name or pins make it a supply, `port` with power or ground ports;
  `styledRail` in `nets.ts` applies it over what Tidy would choose. Set by
  `edit_net draw_as` and the Inspector's net list ("on the schematic"), kept
  through a rename, and travelling between copies as a value. Tidy drew any net
  named VBUS as ports, a 10 A path through a fuse included, and nothing could
  tell it otherwise.
- **Ports** (`model/blockPorts.ts`): each block's ports, the nets crossing its
  frame with a direction from pin kinds and flow (in, out, both, power,
  ground) and a bus (I2C, SPI, USB...) where the name says so. Computed, never
  stored: Tidy faces labels by them (in from the left, out to the right), and
  `get_design` lists them, for a block diagram or hierarchical sheets later.
- **Held to** (`tests/tidy.test.ts`, on the examples, the version-1 files, the
  eight blog boards as imported, and made-up designs from `tests/tidy-designs.ts`):
  the same netlist; nothing drawn over anything else; no wires of two nets
  crossing; everything on the grid; frames around their parts and clear of each
  other, in reading order; tidying twice changes nothing, and a copy under new
  ids comes out the same; the 38-part example in under 150 ms and a 150-part
  design in under a second. Made-up designs of chips and connectors that meet
  point to point (`LINKED_DESIGNS`: a motor driver and its terminals, turned to
  face it and not, a USB-C connector and its ESD chip, an op-amp into an ADC, a
  bus over three chips, four shift registers in a chain) hold the links: wired
  where they can be, labelled where they can't, never more than three chips to
  a cluster. The shipped examples gain no link: the esp32-robot's motor
  driver and its two terminals are joined, tried and drawn apart, labelled.
  Its terminals are wired opposite ways round (MOTA in the driver's pin order,
  MOTB reversed), and mirroring either terminal or both still leaves the
  outputs labelled, so mirroring them in the template doesn't make a wired
  example. `tests/tidy-metrics.ts` measures all of it from a project alone.

## Clean up: grouping the schematic

The toolbar's "Clean up" (`panels/CleanupButton.tsx`) turns a sheet of loose
parts into named blocks and tidies it. Two versions, one button, chosen by what
`GET /api/v1/me` says (`ai/cleanupMode.ts`, which asks `copilotAccess` and has
no plan logic of its own): a plan with managed AI gets "Clean up with AI";
everything else, signed out and unreachable included, gets the free one, and
where Pro would change that its preview ends with "AI version on Pro", linking
to the host's `upgradeUrl`. The button is disabled with a reason on a sheet with
no parts, shows a spinner while it works, and Esc (or Cancel) stops it with the
sheet as it was. Neither version ever changes what is connected, and a cleanup
is one undo step.

- **Free** (`model/cleanup/group.ts`, `index.ts`; the toolbar side in
  `editor/schematic/cleanupAction.ts`). `planCleanup` groups the parts in no
  block and changes nothing; the preview says "Group 31 parts into 5 blocks and
  tidy the sheet?" with each block and its parts, Apply or Cancel. Apply tidies
  the grouped sheet in Tidy's worker, `finishCleanup` compares the whole result
  with the netlist once more (`netlistChanges`) and refuses it, leaving the
  sheet as it was, if anything differs, and the sheet is taken in with one
  `commit`. A sheet edited meanwhile is left as the user left it.
- **Grouping rules.** A part is a *main part* (a chip, module, regulator, or a
  connector with three pins or more, `cleanup/roles.ts`) or a small one. Every
  small part joins the main part it is wired to most directly: cost 1 along a
  net of just the two, else 2, or 0.8 from a resistor, so a divider follows its
  connector, a pull-up and reset switch stay with the chip and a coupling
  capacitor from a header does not drag them away. Ground joins nothing. A
  supply four or more parts share joins nothing by wire: a part on one (a
  decoupling capacitor) goes to the main part with a pin on that supply nearest
  to it on the sheet, regulators preferred for bulk capacitors and avoided for
  decoupling ones, and wire always beats rail. Where a regulator or charger is on
  the supply, a capacitor never goes to a connector or an ESD protector
  (`isHelper` in `roles.ts`) however far the sheet is spread, so an LDO keeps its
  output capacitors and an I2C header keeps only its pull-ups; a real chip, even a
  5-pin one, keeps the capacitor beside it. A bulk capacitor leans to a regulator
  (its distance counts 0.8) but stays with a chip it stands in the decoupling row of. A regulator is told
  by its part, not its category: the Power category, a name that says so, or the
  pins of one (an input, an output and ground; or a switch node, an input and
  feedback), so an LDO or buck brought in as an IC counts, and takes bulk
  capacitors over a chip that merely runs on the supply. A switching
  regulator's output is the net behind its inductor, and the caps there go to it. A chain with an LED that no wire
  ties to a main part (a power LED and its resistor) is a block of its own;
  what nothing is wired to goes to the nearest main part if within 3 units,
  else to OTHER. The OTHER block Tidy makes for parts in no block carries
  `leftover: true` (`SchematicBlock`), so its parts still count as loose: Clean
  up after the Tidy broom groups them, and `groupOf` (`model/blocks.ts`) is the
  lookup that ignores such a block. Renaming it makes it the user's. A part left
  over stays in that block; a block the user named OTHER is never added to (the
  leftovers get `OTHER 2`). Tidy also remembers, on that block (`origins`), where
  every part was drawn before and where it left it, so the distances above are
  measured on the sheet as it was drawn and Tidy then Clean up groups exactly as
  Clean up alone (every part must still be where Tidy left it, else the parts are
  read where they are). Chains wired alike (seven sensor inputs with their dividers)
  are one block, "SCREW TERMINAL 3P x7". A block is named after its main part:
  its role, designator and value, as `REGULATOR U2 LM7805`, `MCU U1
  ATMEGA328P-AU`, `CONNECTOR J4`, `LED D2`. Blocks the user made keep their
  names, ids and every part, and loose parts wired to a chip in one join it.
- **With AI** (`ai/cleanupAi.ts`, state in `store/copilotStore.ts`). Two
  requests in one conversation with the user between them. The plan request
  sends a fixed prompt and offers only `get_design` and `propose_blocks`, which
  checks the plan against the sheet (every designator a part, in one block,
  none in a block of the user's under another name), records it and changes
  nothing; the Sakura panel shows it as a card with Apply and Cancel. Apply
  checks the plan against the sheet again and sends the apply request, which
  offers only `group_parts` and `tidy_schematic` (whole sheet: the user asked
  for it), refuses any call that is not in the confirmed plan, and commits
  everything as one undo step (`ToolSet.oneUndoStep` in `ai/copilot.ts`), or
  nothing if it is stopped, fails, runs out of steps or finds the sheet edited.
  Before the commit `ToolSet.check` (`planProblem`) looks at the sheet the changes
  make: every part of every block of the plan must be in its block and the sheet
  must have been tidied after the last grouping (a request that is complete on its
  last step is kept, without a report), or nothing is committed and the panel says "Sakura did
  not group X as planned, so nothing was changed." The plan request stops after
  three plans that do not fit (`ToolSet.halt`) instead of spending its steps. With every part already in a block there is nothing to
  propose, so the model is not asked: the panel says so and the toolbar asks the
  free flow's question ("Every part is already in a block. Tidy the sheet?"), and
  nothing changes until it is answered; an empty sheet just says there are no
  parts. When an apply is rolled back the model gets an editor note in its
  history that nothing was kept, and the panel drops Sakura's report and marks her
  steps "Not kept". `finishCleanup` adds "Kept X as it was drawn: why." for each
  entry of Tidy's optional `kept` list (Tidy's own `keptNotes`), and
  `rememberOrigins` leaves a kept block's `origins` alone.
- **Tests**: `tests/cleanup.test.ts` (the groups written down for the examples
  with their blocks taken off, and the netlist, every part in a block, user
  blocks untouched and one undo step on every drawing to hand),
  `tests/cleanup-supply.test.ts` (spread-out sheets, seeded: regulators brought in
  as Power parts or ICs, a buck with an inductor, an I2C header, USB-C with VBUS
  capacitors, 24 seeds of each),
  `tests/cleanup-ai.test.ts` (a scripted model, no request leaves the test) and
  `tests/cleanup-mode.test.ts` (the plan gating, with `/me` stubbed).

## Real 3D models and the STEP export

**A part is drawn with a model file or not at all.** Where a part has one, the
3D view draws it once it is read and the STEP export writes it; where it has
none, the 3D view shows only its pads and the STEP export leaves it out, as
KiCad and Altium do. The editor used to draw a body made up from the footprint
(`three/models`, procedural, until November 2026): a black box the size of a
courtyard reads as the part, and in a STEP file someone designs an enclosure
around, it is worse than a gap. It is gone, and nothing may bring one back.

### In the document

- **A model belongs to a part on a footprint** (`Project.models`, a list of
  `ModelAssignment`; `model/models3d.ts`), as a KiCad footprint carries its
  model: every component of that part on that footprint is drawn with it. An
  optional field, so no format version; `normalizeModels` drops a malformed
  entry. Paste copies a part's model with it (`withModelsFrom`).
- **A `Model3D` names a file and says where it sits**: `source` `file` (one the
  user added, by the SHA-256 of its bytes), `supplier` (the supplier's model,
  by its id) or `kicad` (a STEP file in KiCad's 3D library, by
  `<release>/<path>`, through `PartModelSource.kicad`; `format` is always
  `step`), the file's `format`, and a placement in the footprint's frame
  (mm, z up from the board's top): `rotation` in degrees about x, then y, then
  z, then `offset`. `origin: "model"` places the file's own origin, as KiCad
  does; `origin: "center"` first stands the turned model on the board, centred
  on the footprint, which is how a supplier places its models (their origins
  are anywhere). `scale` is for meshes only (KiCad's VRML is in tenths of an
  inch, glTF in metres); a STEP file says its own units. glTF is y up, so the
  reader stands a GLB up on the board's z before anything places it. The maths is
  `three/files/placement.ts`, and the export uses the same function.
- **The files are the host's, never the project's**: a STEP file is often
  megabytes, and one file used by ten boards is kept once. The host gives `App` a
  `ModelFileStore` for the user's own (`store/modelFiles.ts`: `put` and `get`
  by hash, each given the open project; the hosted app's keeps a file added on
  a project in its owner's account, this build's in this browser's IndexedDB),
  and a `PartModelSource` for the supplier's and KiCad's
  (`store/partModels.ts`: `supplier(id, "obj" | "step")` and `kicad(id)`, each
  given the open project too; the hosted app's is `/api/v1/parts/models`, and
  this build has none, so those parts show only their pads). That one is apart
  from `SupplierPartsSource` on purpose: looking parts up needs an account and
  drawing a project's parts doesn't, so a host can give someone signed out on a
  project shared by link the one without the other. A project file downloaded
  and opened on another account names files that account doesn't have: those
  parts show only their pads, and the status line says why.

### Where models come from

- **Sakura's parts get the supplier's model with their land.** A part built
  from an LCSC record (`create_part`) is given the record's `model3d` on the
  footprint it is built on (`model/supplier/model.ts`). When that footprint is
  not the supplier's own land (the footprinter's `0603`, or a land the copilot
  drew and the supplier's pads were checked against), the model follows the
  pads: `landTransform` finds the quarter turn and move that put the
  supplier's pads on the footprint's, number by number, and a footprint whose
  pads don't all match gets no model rather than a wrong one.
- **Parts from the parts database get their model with them**
  (`model/indexPart.ts`). A KiCad part gets `kicadModel` of the model its
  footprint names: `origin: "model"`, the offset as written, and the rotation
  negated, because KiCad turns a model clockwise by the written angles
  (scale, then x, then y, then z, then the offset). A scale other than 1
  is the model's `stretch`, drawn as KiCad draws it (a STEP export writes a
  stretched model as its mesh, since an assembly's transforms are rigid); a
  scale of zero or less leaves no model. A stored supplier record gets
  `supplierModel`, or, when its land was swapped for a footprinter name, the
  model moved with the pads (`supplierModelOnLand`), or none if they don't
  match. Only a part newly added gets a model: one the project already has
  keeps what the user chose for it, no model included. KiCad model
  ids follow one rule (`model/supplier/kicadModel.ts`), which the hosted app's
  model route shares.
- **Imported KiCad parts bring their own**, or KiCad's when their footprint
  names one of its library models: see [Imported from KiCad
  files](#imported-from-kicad-files).
- **The built-in parts come with KiCad's models** (`model/libraryModels.ts`,
  read by `componentModel` when the project gives a part on a footprint none of
  its own), fetched through the host's `partModels`: this build has none, so
  they show their pads. `model/libraryModelSources.ts` says which KiCad
  footprint each is:
  the same part where KiCad has it by part number (the TL3342, the SRD relay,
  the Phoenix MKDS, PT, MC and MSTBA blocks, the GCT USB4105, the Hirose
  DM3AT), else the standard package the footprint is (an 0603 resistor,
  capacitor, inductor or LED; SOD-123, SMA/B/C; SOT-23, SOT-223, SOIC, TQFP-32,
  DIP, TO-220; pin headers and sockets; JST PH and XH). Packages are listed
  under the part `*` too, so a chip on `soic8` (the 555 the v4 migration made a
  project part, or one Sakura drew) gets KiCad's SOIC-8; a two-pad chip
  footprint isn't, since an `0603` says nothing of what is on it. A part or
  footprint that is neither has no model: no screw terminal of no particular
  maker is drawn as a Phoenix. `npm run library-models` reads each KiCad
  footprint from KiCad's libraries at `KICAD_LIBRARY_RELEASE` (the release the
  parts index serves), puts its pads on ours by number (by position for a land numbered
  another way, such as a tact switch's four legs; a diode's or LED's pad 1 is
  KiCad's cathode and our pin 2, so those turn half way), refuses one whose
  pads miss ours by more than 0.35 mm, and writes the placed models to
  `libraryModels.json` and KiCad's pads to `tests/library-model-pads.json`,
  which `tests/library-models.test.ts` checks our footprints against without
  fetching anything. The footprinter's `tqfp32_p0.8mm` rows are 1.3 mm wider
  than a 7×7 TQFP's, which is allowed for that one and shows in 3D: the
  ATmega328P's leads stop short of its pads. The crystal is HC-49/S, the
  low-profile one, since its footprint takes both.
- **The Inspector's 3D model section** (`panels/ModelSection.tsx`, whose
  controls the part editor's 3D model tab shares, keeping the choice in its
  draft until Save): add a file
  (STEP, OBJ, WRL, STL or GLB, 40 MB at most; read before it is kept, so a
  file that doesn't read is neither stored nor assigned), take the supplier
  model of the part's LCSC number, or search the supplier for one; edit the
  placement; or remove the project's model, which leaves the built-in one if
  the part has one (shown as "built in", and not removable) and else none. A file placed by its own origin that lands off
  its footprint (a manufacturer's model drawn about some other point) is
  centred on the footprint instead.

### Drawing them

- `three/files/library.ts` reads each file once for the page and every part
  is a copy sharing its geometry (`userData.shared`, which `disposeGeometries`
  leaves alone). `BoardScene` adds each part's model as its file is read
  (`refreshModels`), without rebuilding the board; a part with no model has
  nothing in the scene, and when selected its courtyard is outlined on the
  board. The soft shadow on the board under a part belongs to its model
  (`three/contactShadow.ts`, sized from the model's own box, in the holder
  beside it, cut off at the board's box and never hit by a click): the board's
  texture used to bake one under every courtyard, which left a dark patch where a
  part with no model would be. A status line counts files loading, names ones that failed, with
  Retry, and otherwise names the parts with no model ("No 3D model: J1, SW1
  and U2"). Sakura's `look` at the 3D board waits up to 4 s for them.
- **A supplier model is drawn from its OBJ and exported from its STEP**: the
  same model in one frame (checked on EasyEDA's: the SOT-563's OBJ is 105 KB
  and its STEP 2.4 MB). The OBJ carries its materials inline (`obj.ts`).
- **STEP files are read by OpenCascade** (`occt-import-js`, LGPL-2.1, a 7.6 MB
  WebAssembly file) in a Web Worker (`step.worker.ts`), fetched the first time
  a STEP file is drawn; the bundler emits the worker and the WASM through `new
  URL(..., import.meta.url)`. A file's triangles are kept in IndexedDB
  (`stepCache.ts`), so it is triangulated once per browser. Meshes are merged
  by colour, one draw call per colour per part. CAD files rarely say what is
  metal, so pale greys and golds are (`looksMetallic`).
- **EasyEDA's placement rule** was checked against through-hole pins: turn the
  model by its `c_rotation` about its bounding box's centre, then put that
  centre on the centre of the model outline the record draws, and its bottom at
  `z`. On the XH-3A the pin tails land on the holes to 0.00 mm. (`c_origin` is
  sometimes nonsense: -861 mm on an SOT-23.)

### The STEP export (`export/step3d.ts`, `export/step/`)

The board and every placed part as one AP214 assembly, for mechanical CAD:
from the Export menu, or the 3D view's toolbar.

- **What each part is in the file** (`step3d.ts`): its model (a supplier's or
  KiCad's STEP fetched for the export, or the STEP file the user added, copied
  whole and exact; a mesh file as its mesh), or nothing. A part whose model
  file can't be read is left out, and a STEP file that can't be fetched (a
  supplier's over the rate limit, say) is written as the mesh the 3D view drew;
  the export's notes say which parts. Every part with no model is listed in one
  note ("3 parts have no 3D model and are left out: J1, J2, SW1"), twelve
  designators at most, so nobody takes the gap for free space. Each distinct model is written
  once and placed per component, so the tree reads R1, R2, U1 in the other
  program. STEP's frame: the board's bottom face at z = 0, x and y the
  project's. Placement uses the same `placementMatrix` as the 3D view, so the
  export is where the view draws it.
- **The writer** (`step/`, `writeStep`) is pure data in, text out, no three.js;
  its colours are sRGB (the numbers a hex code gives), not three's linear ones.
  - The board is an exact solid: planes and cylinders, every drill a hole, slots
    as slots, rounded corners as cylinders. Above 150 holes its top and bottom
    are cut into strips of about 100 holes, because OpenCascade reads one face
    with 3,000 holes in a minute and strips of them in 9 s. Holes that overlap or
    reach the edge are left out and counted in a note.
  - A STEP file is copied whole under new numbers, with its own units, colours
    and assembly; its root product takes the model's name, its application
    contexts are merged into ours and AP203's own entities are dropped. AP242 and
    other schemas are kept and noted.
  - Meshes are welded on a 1e-6 mm grid and flat regions merged into polygon
    faces (a box is 6 faces): closed pieces are `FACETED_BREP`, open ones
    surfaces, all with `POLY_LOOP` faces. About 175 bytes a triangle.
- **Tests read the file back with OpenCascade** (`occt-import-js` in node):
  `tests/step-*.test.ts` (the writer, with the CAx-IF files occt-import-js ships,
  read from `node_modules`) and `tests/export-step3d.test.ts` (a board, a
  supplier STEP placed where the view draws it, a model that can't be read).
  occt-import-js names tree nodes after their product, not their instance, and
  finds no colour below an instance, so designators are checked in the text. A
  faceted mesh of 100k triangles read as no triangles at all: very large meshes
  should be a supplier's STEP instead. Nothing has been opened in SolidWorks,
  Fusion or KiCad yet; do that by hand before relying on a release of it.

## Taking boards to other tools

Circuit JSON, tscircuit's netlist-and-geometry format, goes both ways, and the
two directions are each other's inverse: `model/circuitJsonImport.ts` reads it
into a project (`projectFromCircuitJson`) and `export/circuitJson.ts` writes
one (`projectToCircuitJson`, with `circuitJsonFile` for the text). The importer
is how the boards of the hosted app's earlier, tscircuit-based editor came
across in October 2026; the export is the way out
for someone who wants to leave, or to use another tool beside this one. Both
return `notes`, in sentences, for what did not carry over. The export menu
shows only a line saying what was exported: the notes are for the tests and
these docs, not a list after every download.

### Writing Circuit JSON (`export/circuitJson.ts`)

- **Every element is one `circuit-json` accepts**, with no field it would strip:
  `tests/circuit-json-export.test.ts` runs each element through the schema
  circuit-json exports for its type and fails on a field the schema does not
  have, so a new field has to be one tscircuit knows.
- **Parts** are source components of the kind tscircuit has for them
  (`simple_resistor` with `resistance` in ohms and `display_resistance`,
  `simple_capacitor` with farads and `max_voltage_rating`, inductors, diodes,
  LEDs, crystals, transistors and MOSFETs with `transistor_type` and
  `channel_type`, push buttons, switches, pin headers), else `simple_chip`;
  the part number is `manufacturer_part_number` and the LCSC number
  `supplier_part_numbers.jlcpcb`. Properties with no field are left out and
  named in the notes. A part's pins are source ports: numeric pin numbers are
  `pin_number`, others (USB-C's `A6`) are the first `port_hints` entry, and
  transistor and polarity roles ("collector", "pos", "cathode") are hints
  tscircuit's tools look for. No-connect pins are `do_not_connect`.
- **Nets**: a named net is a `source_net` with a `source_trace` joining its
  ports and the net; an unnamed one is a `source_trace` between ports, as
  tscircuit writes it (`nameAllNets` names those too, for KiCad, which has no
  unnamed nets).
- **The board** is at the editor's own coordinates: a part's `pcb_component`
  `center` and `rotation` are its origin and turn, which is how the importer
  takes pads back into the part's own frame; its pads are in board
  coordinates (SMD pads, plated holes with round or slotted holes, polygon
  pads, bare holes), with silkscreen, a courtyard and its designator. Traces
  keep their layer and width, vias their sizes, and **pours are written as the
  copper they fill** (`brep` with holes), since tscircuit's pour refills in
  its own way. A rounded board is an `outline` (`roundedOutline` in
  `model/board.ts`, which the importer recognises again). The design rules the
  board can state (`min_trace_width`, clearances, drills) are on `pcb_board`.
- **The schematic** is in the editor's units, drawn as paths, circles and text
  of each component (`is_box_with_pins: false`) rather than named after
  tscircuit's symbol library, since our symbols are our own drawings, with
  wires as `schematic_trace` edges, net labels, and power ports as net labels
  with `vcc_*` or `ground_*` symbols.
- Not kept: the 3D view, trace widths by net, pour and mask settings, thermal
  spokes, the project's description and properties (Circuit JSON has no field
  for them), parts' own descriptions. `cad_component`s carry
  the footprinter string where the footprint is one, which is what lets the
  importer give the library's footprint back.

**Cherry Blossom is its own editor, not a KiCad front end.** KiCad import and
export are exits, and what a trip through KiCad must keep is the physical
board and its circuit: the netlist, parts and where they are, pads, holes,
copper, outline. A round trip also keeps the user's data: a sub-sheet's title
block, a pad on silkscreen or another non-copper layer, a symbol item KiCad
hides on a sheet (`private`), a text or table cell left out of simulation, the
places of labels' and sheets' fields, hyperlinks, and the design block a group
came from. Only KiCad's own bookkeeping is regenerated: uuids (the export makes
them from the editor's ids), page numbers (the export numbers pages in tree
order) and the board-wide `castellated_pads` flag KiCad 8 dropped. The
import reads past those (`not-needed` in the decision tables,
`tests/kicad-census/decisions*.mjs`), and a saved project that still has one
loads and ignores it. KiCad's conventions (how a project is split into files,
its naming) are the exporter's to deduce: the editor never shows them, and a
project that comes back different in those alone is a good round trip.

**The round trip is a test, not a hope.** For every example, the v1 fixtures
and 30 seeded random boards, export then import must give the same netlist, pin
for pin (nets the original named keep their names), and the same pads, in
position, size and hole. The importer was widened for it where it had no
reading for what the editor writes: slotted holes under rectangular pads, polygon
pads with holes, polarised capacitors by their port hints, `do_not_connect`,
standalone plated mounting holes, rounded outlines, and port numbers that are
not numbers. What does not come back is the schematic's drawing: the importer
draws it anew, from the netlist.

### KiCad (`export/kicad.ts`)

KiCad files come from [`circuit-json-to-kicad`](https://github.com/tscircuit/circuit-json-to-kicad)
(MIT, tscircuit's), which the export feeds the same Circuit JSON. It is loaded
by `import()` when someone asks for KiCad, and it brings `kicadts`,
`schematic-symbols` and a few more (all MIT; the converter declares none of
them, so they are in `package.json`): about 4 MB of JavaScript
that no one editing a board downloads.

- The converter draws a schematic unit as 15 mm and ours is 12.7 mm (ten of
  KiCad's 50 mil), so the schematic is scaled by 12.7 / 15 first, which puts
  every pin on KiCad's grid exactly.
- **Every sheet's file is on its own page** (`paperOf`, `model/paper.ts`):
  the converter's `(paper ...)` is replaced with the sheet's (`applyPaper`,
  `kicadPost.ts`), and its `circuitOrigin` puts the page's top-left corner at
  KiCad's (0, 0) (`pageOrigin` in `kicad.ts`: an editor point (x, y) lands at
  (origin.x + 12.7x, origin.y − 12.7y) mm), for every project. The corner is
  on the 0.1 grid, so the grid stays KiCad's; a sheet imported from KiCad has
  its page at (0, 0) and comes back at the millimetre it had.
- Its floating point leaves a pin and the wire on it a fraction of a nanometre
  apart, which KiCad reads as one point and other readers do not; numbers are
  rounded to a nanometre (`tidyNumbers`).
- Unnamed nets get names (`Net-(R1-1)`), since KiCad has none without.
- **What the converter drops is put back in `export/kicadPost.ts`**, by editing
  the S-expressions it wrote (the library itself stays untouched): a
  `(no_connect)` at each pin flagged unused (the converter ignores
  `do_not_connect`, and every pin is typed passive, so ERC would otherwise
  report them all), each symbol's Footprint (the board's library id), MPN,
  LCSC, Manufacturer, voltage and other properties as hidden fields, the
  design rules, default sizes, net classes (every class with all its sizes, its nets as patterns that match them exactly) and per-net widths (as net
  classes of their own that set only the width and come first) in the
  `.kicad_pro`, the mask web, paste ratio and mask bridges in the board's setup, each pour's clearance, thinnest neck and thermal gap and
  bridge, the mask and paste openings, the title block of each sheet's file as
  the page shows it (`titleBlockOf` in `model/paper.ts`, of the sheet's first
  use: the project's name, revision, company, date, description and properties,
  or a KiCad sub-sheet's own entries) and the project's text
  variables. Pours arrive filled (the converter writes the computed fill);
  KiCad refills them with B. `tests/kicad-export.test.ts` reads the files back
  to check each, including that a flag is where KiCad puts the pin (the symbol's
  place plus the pin's place in its library symbol). Not carried: vias in pads,
  via tenting, thermal spoke count and angle (the notes say so).
- There is no KiCad in this repo's CI. The output was checked with scripts
  that read the files back and report their nets and footprints, and compared
  with the netlist; a real
  KiCad open is still to be done by hand before relying on a release of it.

### Reading Circuit JSON (`model/circuitJsonImport.ts`)

Nothing in the UI calls the importer yet.

- **Pads land exactly where they were.** Each part's pads are taken back into
  its own frame from the board, and the part uses the footprinter's land when
  that draws the very same pads (so a resistor is still an `0603` you can
  change), else the board's own as a project land pattern. A part turned by
  other than a quarter turn keeps the turn in its land.
- **Parts**: resistors, capacitors, inductors, diodes and LEDs become library
  parts; everything else a project part with a box symbol laid out as
  tscircuit drew it (or a discrete symbol for transistors, fuses, crystals and
  switches). Pins with no pad on the board are left off, and parts with no
  pads at all are left out: tscircuit never placed them either.
- **The schematic is drawn anew**: every connected pin gets a label naming
  its net (tscircuit's name, or `REF_PIN` of its most telling pin), parts keep
  tscircuit's arrangement and are pushed apart only where labels would
  collide, and the result is checked against the netlist pin for pin.
  tscircuit's named groups become blocks; the board's own group and groups
  tscircuit named itself don't.
- **Copper** comes across on every layer the board has (X1: `num_layers`, `inner1` and beyond; a via's `from_layer` and `to_layer` make it a blind or buried via, X5): traces, vias and pours of
  a net. A board of more than 32 layers comes across unrouted.
- What didn't come across as it was is returned as `notes`, in sentences.

### Reading KiCad boards (built)

`src/model/kicad/board/` reads a `.kicad_pcb` of any release (stamps 3 to 11) and imports it exactly or not at all. The dashboard's "Import KiCad" runs it (`src/kicadImport/`, below);
`importKicadBoard(text or bytes, options)` is the entry and never throws for a file.

- `sexpr.ts` (parser: skips a byte order mark, decodes UTF-16, names a truncated or unbalanced file and a nesting that is too deep), `read.ts` (24 numbered version switches, each tested in `tests/kicad-board-read.test.ts`, into the
  typed `KicadBoard` of `types.ts`, which keeps every node's own list), `outline.ts` (Edge.Cuts pieces, the repair, loops; a loop is a rectangle or rounded rectangle only when every piece lies on it to
  0.001 mm and each corner bends the right way), `account.ts` (every node of the file looked up in `decisions.ts`: imported, not needed with its reason, pending an extension, reported, or unknown, which
  is a refusal; every bare word of every list is scanned, and a word no row allows is unknown), `carried.ts` (which extension nodes the builder writes into the project, which only say what the editor
  works out for itself, and the `setup` settings that equal KiCad's defaults), `needs.ts` (which of X1 to X31 a board needs, pad by pad for X7: a pad's copper, mask and paste against what the editor
  draws for its type and side, pads of one number that disagree on net), `graphics.ts` (below), `models.ts` and `stockModels.ts` (which 3D model a part holds, and the STEP models of KiCad's library at
  the release the parts index serves, so a model that does not resolve is named in the report), `build.ts` (the project: a land per footprint, the library's, the same on both sides, and a part, with
  the placement turned half a turn on the bottom; nets drawn as a generated schematic with a label on every connected pin, keyed by the net's raw name, and checked pad by pad against the file; tracks
  joined into polylines, design rules, stock 3D models), `import.ts` (the gate, the notes, and the size refusal measured with `serializeProject`).
- `BUILT_EXTENSIONS` (`needs.ts`) is X1 to X15, X19, X20, X21, X22, X23, X24, X25, X27, X29, X30 and X31. A board that needs anything else is refused with "This board uses ..., which is not supported
  yet". X24 is what KiCad 9 and 10 add to a drawing that the shapes do not hold: hatched fills, line end shapes, colours, a filled drawing with a negative width, a track exposed through the mask. X25 is
  tables, barcodes, drill charts, text boxes inside footprints and text a board file cannot resolve. X19 (text in a TrueType font) is built and has no need rule.
- `decisions.ts` is generated from `tests/kicad-census/decisions.mjs` by `node tests/kicad-census/emit-decisions-ts.mjs`, and `stockModels.ts` from a listing of KiCad's 3D repository by
  `tests/kicad-census/emit-stock-models.mjs`; a test fails when `decisions.ts` and the table differ.
- **A node counts as imported only where the builder writes it.** To build an extension: add it to `BUILT_EXTENSIONS`, to the project builder, to `carried.ts` and to the check list of the "a node counted
  as imported is in the built project" test in `tests/kicad-board-exactness.test.ts`; the gate itself does not change. `tests/kicad-board-nets-and-flags.test.ts`, `tests/kicad-board-shapes.test.ts` and its `-edit`
  and `-checks` siblings are the early tests of this (X13, X15, X8, X9).

**The pad model (X7, in project file version 3).** `PadDef` (`model/types.ts`) holds what a KiCad pad has, each field optional and absent for a pad drawn before: `rot` (its own turn), `round` (corner
ratio), `chamfer`, `custom` (an anchor and drawings, written compactly by `model/padCodec.ts`), `holeOffset` and `holeAxis`, `layers` (copper, mask, paste, silk and other layers, relative to the part's own
side; `model/padFaces.ts` has the defaults of each kind), `maskMargin`, `pasteMargin`, `pasteRatio`, `clearance`, `zoneConnect`, the thermal settings, `property`, and `number` (the number the KiCad file
gives a pad whose pin has another: pads of one number on different nets, and pads with no number that carry a net, each have a pin of their own, `planPins` in `kicad/board/build.ts`). `pcbPads`
(`model/instances.ts`) gives a pad with none of these exactly the world pad it always gave (the golden test and `tests/kicad-board-pads.test.ts` pin that); one with any is built by `x7WorldPad` with
`corner`, `rings`, `hole`, `mask`/`paste`/`silk`, `ring` (copper round a non-plated hole), `opening` and `x7` (the land's pad and its placement, which the plot's openings and the KiCad file are made
from). Geometry: `padGeom.ts` (the land's rings), `padDistance.ts` (distances, the box, the annular ring), `padOpening.ts` (the mask and paste openings as KiCad plots them). Writers: `export/gerber.ts`
and `maskMerge.ts` (regions for any X7 pad but a plain circle), `excellon.ts` (the hole's own place), `kicadPads.ts` (every pad of a part that has any X7 field, as KiCad has it). The Inspector's Pads
section (`panels/PadPanels.tsx`, `model/padOps.ts`) edits a pad's own margins, clearance and pour connection in the part's land. A KiCad 9 pad stack, and a through-hole pad that drops its copper on
layers nothing connects to, are X1; a pad that joins a pour on some layers only is `PadDef.zoneLayers` (X31: the layers its copper stays on when its unused layers go, `pruneUnused`); its own tenting is
X5. The oracle is `tests/kicad-census/pad-detail.mjs`, checked over the corpus by `tests/kicad-x7-check.ts`. Checks has one error, `mask-bridge` (openings of two nets that run together), on a board that
has pads with X7 features or states a minimum mask web.

- **Net classes and design rules (X10).** `netClassImport.ts` writes a KiCad 4 or 5 board's net classes and the rules of `setup` into `DesignRules` (`model/netClasses.ts` is the model: which class a net
  is in, the clearance of two nets, the Inspector's edits, and `mapKicadProjectNetClasses`, which the schematic track's `.kicad_pro` reader calls to put a project file's classes into the same fields).
  The Default class is the rules (a class named Default only; any other class is a `NetClass`); its own description, micro via size and differential pair go to `defaultClass`; KiCad's own defaults (the
  English description, a micro via of 0.3 and 0.1, a `max_error` of 0.005) are stored as nothing. A class the model cannot hold exactly is a refusal naming it (two of one name, a net in two classes, a
  field the block leaves out). `creepage` is X26, which is not built: a non-zero one refuses the board by name. The router (`autoroute.ts`, `RouteRules`) keys its keepout cells by trace width and class
  clearance, and its via keepouts by via size and class clearance; a board with no classes has one of each and routes as it always did (the golden test holds that). Checks (`analyzePcb`) look as far as
  the largest clearance and test each pair at its own; pours (`fillZones`) keep a class's clearance where the zone sets none of its own, and a zone's own clearance is a local override that wins, as in
  KiCad; the mask Gerber merges openings closer than `maskMinWidth` (`export/maskMerge.ts`). Tests: `tests/kicad-board-net-classes.test.ts`, `tests/net-classes.test.ts`, `tests/net-class-fab-output.test.ts`,
  `tests/net-classes-ui.test.tsx` and the corpus test's X10 check (`tests/kicad-x10-check.ts`, against `tests/kicad-census/rules.mjs`).
- **Board and footprint drawings (X8).** `graphics.ts` reads each `gr_*`, `fp_*` and `target` in KiCad's own frame and sends it through one map into the editor's (y negated; a bottom footprint's y kept,
  as `landPad` does, and its layers swapped), so an arc stays its three points, a circle its centre and radius, a curve its four points, an ellipse its radii and angle (the map turns the angle and flips
  the sweep when it mirrors). KiCad's rules are applied: a polygon off Edge.Cuts with no `fill` is filled, an unfilled shape with no width gets 0.1 mm, a polygon's arc corners are kept, a shape on a
  copper layer and its mask is the copper and an opening grown by the mask margin, a `target` is its circle and two lines, translated layer names (Italian, Polish, French, as KiCad maps them) are read,
  a footprint's private layers and a polygon with fewer than three corners are named in the report and not brought. Drawings on Edge.Cuts are the outline's (X2), not shapes. A footprint's drawings are
  its land's `shapes` (the land is the library's, so one footprint has one land on either side), its courtyard is the box of the drawing on its courtyard layer, and a footprint with no pad is a part
  with no pins on a land with no pads (`noCourtyard` when it has no courtyard of its own). Board drawings are `Project.graphics`. The accounting counts `stroke`, `width` and `fill` of an Edge.Cuts
  drawing as not needed (the board is cut along its centre) and those of every other drawing as written (`carried.ts`, `edgeNodeCounts`). `tests/kicad-census/graphics.mjs` is the oracle that shares no
  code with `src`, and `tests/kicad-graphics-check.ts` compares a built project with it, drawing by drawing, to 0.001 mm.
- **Text objects (X9).** `texts.ts` (importer) turns `gr_text`, `gr_text_box`, `fp_text` and a footprint's `property` nodes into `BoardText` (the board's, with a `layer`) and `PartText` (a part's, in
  its land's frame: `landAngle = bottom ? rot - world : world - rot`); `read.ts` reads face, bold, italic, knockout, line spacing, `unlocked` (keep upright off), `hide`, boxes, `%R` and `%V`. A part
  with `texts` has the file's reference, value and fields and no designator of the editor's (`silk.ts` skips it); a part drawn here has none and its designator is placed as always. `lib/kicadText.ts`
  is KiCad's layout rewritten (markup, advance, tabs, italic, overbar, sub and superscript, line spacing, justification, mirror, turn, pen width and knockout margin; a port of KiCad's GPL code, so each
  such file starts with KiCad's copyright and licence notice and the KiCad files it ports). **KiCad's own stroke font is shipped** (listed with the rest of what is ported from KiCad in `THIRD-PARTY-NOTICES.md`):
  `lib/kicadFont/glyphsBase.ts` (U+0020 to U+2FFF) and `glyphsCjk.ts` (U+3000 to U+FFEE), each with KiCad's licence header, written by `tests/kicad-census/emit-newstroke.mjs`, imported only through
  `lib/kicadFont/load.ts` (`loadKicadFont`) when a project has KiCad text: `model/textFont.ts` (`ensureTextFont`), the project store's watch, the import engine and the exports call it. Until it has
  loaded `editorStrokeFont` is used; the editor's own silkscreen text (`strokeFont.ts`) never uses KiCad's font, so editor-drawn boards are unchanged. A text box's stored rectangle is read by the
  file's version (`BOX_LIB_FRAME_FROM`, 20260616: older files store it as drawn, newer ones unturned), and its knockout is its own node `(knockout yes)`. `${LAYER}`, `${FOOTPRINT_NAME}`,
  `${FOOTPRINT_LIBRARY}` (from `ComponentInstance.fpid`) and `${FILENAME}` resolve from the board. `DesignRules.minViaDiameter` is KiCad's `via_min_size` (absent on a board drawn here; Checks
  `via-size`); a KiCad 4 or 5 board opens with no annular-ring minimum. `model/texts.ts` (variables, world place, ink, knockout polygons, by layer), `textOps.ts` (edits), `textCodec.ts` (compact storage
  in project file version 3: `textStyles`, per-part `tx`, board `kt`). Text on a copper layer is copper of no net (`CopperItem` `what: "text"`) for checks, pours and the router. Gerber (`plotTexts`:
  silk, copper, mask, paste, Edge.Cuts, knockout as a region, text box borders), KiCad export (`export/kicadTexts.ts`), Circuit JSON (`circuitJsonTexts.ts`), Sakura's picture, 3D, fabrication notes
  (TEXT block) and `get_design` (`texts`, only when there is text) draw or list them; the PCB view has a Text tool (T), the Inspector a `TextInspector` and a part's `PartTextsSection`
  (`panels/TextPanels.tsx`). Tests: `kicad-text-layout.test.ts`, `kicad-board-texts.test.ts`, `texts-model.test.ts`, `texts-outputs.test.ts`; the oracle is `tests/kicad-census/texts.mjs`, the check
  `tests/kicad-texts-check.ts`.
- **Text outlines and embedded fonts (X19).** A text in a TrueType font keeps its `face` and the polygons KiCad cached (`render_cache`) as `TextAttrs.outline` (`model/textOutlines.ts`: packed rings,
  the pose they were drawn at, a signature of what they depend on). They are the text's shape (`currentOutline`, `outlineInk` in `model/texts.ts`: drawn, plotted as Gerber regions, copper of no net on a
  copper layer) while the text shows what they were drawn for and its signature holds; a move, turn, mirror or part flip maps them rigidly (`outlineRings`), and any other edit leaves the text in the
  stroke font with a dashed amber box, an Inspector note (`fontNotes`, and the button that drops the face), a line in the fabrication notes and an import report entry (`textFontState`: `outline`,
  `edited`, `uncached`). Edited text is not re-rendered: no TrueType rasteriser is shipped, and KiCad's embedded fonts are zstd compressed (kept as they are, `Project.fonts`, bytes in the model file
  store like a reference image's, written back by `export/kicadBoard.ts`). `effects()` in `export/kicadTexts.ts` writes `face` and `render_cache` for both writers. Tests: `kicad-x19.test.ts` and the
  corpus test `corpus/fonts.test.ts` (the oracle reads the raw file with the census's reader).
- **Drawing extras (X24).** `Zone.hatch` and `Zone.hatchAt` (KiCad's hatched fill and KiCad 10's hatch position), `Trace.bare` (a track open through the mask), line `ends` (KiCad 11 development's line
  end shapes) and a drawing's `color`; all optional fields of version 3. The hatch fill is not stored: `model/zoneHatch.ts` ports KiCad's `addHatchFillTypeOnZone` and `fillOne` calls it where KiCad
  does. The writer puts the KiCad 9 words and notes the ones it cannot (hatch position, line ends). Tests: `kicad-board-hatch.test.ts`, `corpus/zones-hatch.test.ts`.
- **Tables, barcodes and text boxes in parts (X25).** `model/kicad/board/flatten.ts` turns a table into the lines KiCad draws (`PCB_TABLE::DrawBorders`) and a text box per cell, a QR code into one
  filled polygon (`lib/qrCode.ts`, after zint), in the same place and layer; the report names what was flattened. A cell with `start` and `end` and an angle that is not a quarter turn is the rectangle
  turned about its centre. A text box inside a part is a part text with a `box` and is written back as `fp_text_box`. Data Matrix, Code 39, Code 128, Micro QR and drill maps are refused by name. Tests:
  `kicad-board-tables-qr.test.ts`.
- **A dimension inside a part (X27).** KiCad keeps its points as the board's in every file, so it comes over as the board's dimension of the same points and no longer moves with the part (the report
  says so). Its prefix, suffix and text are filled in from the part's own value at import and do not follow a later variant switch. Tests: `kicad-board-objects.test.ts`.
- **Any angle (X6).** `pcb.rot` is any number of degrees. `lib/geometry.ts` has the rotation (`rotate90` and `transformPoint` take any angle and stay exact on a quarter turn; `normalizeAngle`,
  `isQuarterTurn`, `cosSin`). `pcbPads` (`model/instances.ts`) gives a part on a quarter turn the pads it always gave (a level `rect` or `pill`, swapped sizes) and a part at any other angle polygons for
  its rectangular and pill pads (`WorldPad.points`, with `oriented` for the size and angle an exporter that has a turned pad of its own wants, and `slotAxis` for a slot), so every distance, the pour
  (`padPaths`), the router (`padInset`), the Gerber (a region), the drill file (`slotEnds`), Circuit JSON (`rotated_rect`, `rotated_pill`) and the 3D board read the turned copper. A part's courtyard is
  the box of its turned one (`pcbCourtyard`) with the turned ring itself for the outside-board and overlap checks (`pcbCourtyardRing`, `partOutsideBoard`, `convexOverlap`). The importer places a part
  at the file's own angle, taken to a millionth of a degree (`placementRotation`); a pad's own turn is the stored angle less the part's (`needs.ts`), so a pad that follows its part is no X7 need at any
  angle. The Inspector has an angle field, the R key and the part bar turn a quarter turn from wherever the part is, Sakura's `place_parts` takes `rotation` in degrees, the position file writes the
  angle KiCad's does (`positionAngle`: the footprint's own, the editor's bottom half turn taken off, for a part from a KiCad board; a part drawn here as ever). Tests: `tests/any-angle.test.ts`; the
  corpus compares every pad, text and drawing of a turned part with the oracle's.
- **Board outline (X2).** `BoardDef.outline` (`BoardOutline.paths`: `ShapePath`s of lines, arcs, curves and elliptical arcs, closed or not) is the board's shape when it is not the rectangle `width` by
  `height` with `cornerRadius`; the box follows it (`syncOutlineBox`). No `outline` is the rectangle, and every consumer keeps its own rectangle code for it, so an editor-drawn board is byte for byte
  what it was (`tests/golden`). Closed paths are loops that nest (a loop inside the board is a hole, inside that board again, and so on); a path that does not close is kept as drawn, and an outline of
  no paths is a board with no outline: `outlineState` says `closed`, `open` or `missing`, Checks reports one error (`outline`) for the last two, and the exports that need the board cut out refuse with
  a sentence (`export/outlineGuard.ts`: Gerber and drill, STEP). `model/outline.ts` is the geometry (`outlineGeometry`: rings, regions, `contains`, `nearest`, `signedDistance`, `rasterizeInside`,
  `copperEdgeClearance`, `outsideBoxes`, `boxOnBoard`), `model/outlineOps.ts` the edits (`addOutlinePaths` joins drawn pieces and decides cutout or board, `moveOutlineVertex`, `toggleOutlineArc`,
  `splitOutlineSeg`, `addSlot`, `outlineSlots`, `resetOutline`), `model/outlineCodec.ts` the stored form (a flat array per path, `board.ol`), `model/outlineText.ts` the text Sakura reads and writes.
  Consumers: DRC edge clearance and outside-board (`pcb.ts`), the pour area (`pour.ts` `boardArea`), the router's edge cells (`autoroute.ts` `markEdge`), placement (`boardObstacles` adds
  `outsideBoxes`), designators (`silk.ts`), Gerber Edge_Cuts (arcs exact, `gerber.ts`), the drill file (a stadium cutout is routed as a G85 slot in the non-plated file too), the 3D board
  (`buildBoard.ts`, a shape per piece, cutouts cut), the STEP solid (`step/board.ts` `writeRegions`: one solid per piece, arcs either way round), the KiCad export (`export/kicadOutline.ts` writes
  `gr_line`, `gr_arc` and `gr_curve`), Circuit JSON (the biggest piece as the outline, `pcb_cutout` for each cutout, a note for what it cannot hold), the fabrication notes, Sakura's picture and
  numbers, and `get_design` (`board_mm.outline` and `cutouts` as text, only when there is an outline). The PCB view draws it (`OutlineDraw`), picks a piece (`o:<path>:<piece>`), drags its corners, arc
  middles and whole shapes, and has a bar to bend an edge into an arc, add a corner or delete the shape; the drawing tools work on the Edge.Cuts layer of the layer picker (a closed shape inside the
  rectangle is a cutout, one that reaches outside replaces it, a piece waits to be closed) and a Slot tool (O) cuts a stadium. Sakura's `set_board` takes `outline`, `add_cutouts` and `remove_cutouts`.
  The importer holds a plain or rounded rectangle as before and any other outline as these paths; where the file's pieces meet by a gap of up to 0.1 mm a straight connector closes the loop (no piece
  of the file moves; `outline-joined` says how many), and what does not close stays open. Tests: `tests/outline-model.test.ts`, `tests/outline-outputs.test.ts`; the corpus compares the outline with
  the file's Edge.Cuts both ways (`tests/kicad-census/edge.mjs`, `tests/kicad-edge-check.ts`).
- **Dimensions, groups and reference images (X11, X12, X14).** `BoardDimension`, `PcbGroup` and `ReferenceImage` (`model/types.ts`; ops in `model/boardObjects.ts`, group moves in
  `model/groupMoves.ts`, compact storage in `model/dimCodec.ts`: `dimStyles` and `dm`, `grp`, `im`, a part's `gr`; project file version 3). **A dimension's drawing is never stored**:
  `model/dimensions.ts` (a port of KiCad's `pcb_dimension.cpp`, so it carries KiCad's licence notice) works it out in KiCad's frame and unit, and `worldShapes` (`dim`, ids `m:<id>:<i>`) and
  `worldTexts` (owner `#dim`) hand it to the Gerber, SVG, 3D (silkscreen only), checks and Circuit JSON code; the KiCad export and the notes skip those derived entries (`!s.dim`,
  `isDimensionText`) and write the dimension itself (`export/kicadObjects.ts`, KiCad 9 format). A group's members are project ids (a part's own groups name `p<i>` pads, `s<i>` shapes, `t<i>` texts,
  `g<i>` groups); the store's `settleEdit` prunes dead members and empty groups (`pruneGroups`, identity without groups); selecting a member selects its group (`expandToGroups`; Ctrl or Cmd click
  picks one); a locked group locks its leaf members. A reference image's bytes live in the model-file store, never the project JSON (`store/imageFiles.ts`, `lib/imageFacts.ts`); it is never plotted.
  The importer reads them in `model/kicad/board/{dimensions,groups,images}.ts` (`BuildResult.files` are stored before the project is saved); a footprint's dimension is X27 and an image that is not
  PNG or JPEG is X28 (a refusal). The oracle is `tests/kicad-census/dimensions.mjs` and the check `tests/kicad-dimensions-check.ts`. Tests: `board-objects-model`, `kicad-board-x11`,
  `board-objects-outputs`, `board-objects-editor`. Sakura has no tool for these: `get_design` lists `dimensions`, `groups` and `images` only when a board has them.
- **Nets on copper (X13).** `Trace.net` and `Via.routedNet` (not `Via.net`, which marks a stitching via the stitcher owns) are the net of the project's own name that the file puts the item on. Stored
  names follow a rename (`copperNets.ts`, run by the store's `commit`, and `renameNets`). `analyzePcb` treats copper that names its net as copper of it: another net's pad under it is a short, and a
  stub on a net is an island of it for the ratsnest, the pours and the router. `derivedCopperNets` is what the editor works out from the pads alone; the import compares the two for every item and puts
  each difference in one `copper-net-differs` report entry, whose `items` lists them all. A trace drawn or routed in the editor has no `net` and is as it was.
- **Zones (X3).** `Zone` (`types.ts`) is the editor's whole-board pour when it has only `id`, `net`, `layer` and `clearance` (`isWholeBoardPour`, `model/zones.ts`), and then `pour.ts` fills it,
  `stitch.ts` stitches it, the toolbar's ground pour button and Sakura's `set_pour` add and remove it, as ever. Any other field makes it a zone of its own shape: `outline` (the first closed path is the
  outline, the rest are holes; lines and arcs), `layers` (both copper layers), `priority`, `minWidth`, `connect` (thermal, through-hole only, solid, none), `thermalGap`, `spokeWidth`, `smoothing`,
  `islands`, `edgeGap`, `holeGap`, `teardrop`, `name`, `locked`, and `keepout` (a rule area: tracks, vias, pads, pour, footprints; no net, no fill). `fillZones` hands a project that has one such zone to
  `fillPolygonZones` (`model/zoneFill.ts`, geometry in `zoneGeom.ts`, in tenths of a micron), which fills every zone, the whole-board pours too, by KiCad's rules:
  zones in priority order, thermal reliefs of four spokes, the minimum width by shrinking and growing, same-net zones
  joined, islands by the zone's rule. **The fill is never stored**: it is computed from the zone and the copper round it, and **kept while those are the same**: `fillPolygonZones` splits the zones into
  groups that can touch each other and keeps each group's fill under a key made of the zones, their resolved settings, the board's outline and the copper (with its nets) whose box reaches them, so a
  part moved away from a zone, or an edit that is no copper, fills nothing again (`clearZoneFillCache`, `takeFilled`, `setZoneFillCacheLimit` are for tests and measures). The views take
  `getLiveAnalysis` (`store/analysis.ts`) and not `getPcbAnalysis`: where a group has to be filled again it shows the last fill, sets `zonesPending` (the PCB view and Checks say so) and has the zone fill
  worker (`store/zoneFill.worker.ts`) make the new one after the edits settle, then `useFillTick` changes and the views ask again; `getPcbAnalysis`, which Sakura, the exports and the exit checks use,
  waits for the exact fill. While something is dragged the last fill is kept and refills on drop. Autoroute shares the fill the board had at the start across its steps with the copper it adds cut out
  of it (`carveFills`) and fills again for the result. A zone's outline is stored by `model/zoneCodec.ts` (`ol` on the zone, a straight ring as `["p", x, y, ...]`, project file version 3). An imported
  KiCad file's `filled_polygon` is read for the corpus test and not kept; the report says the copper is the editor's own. Rule areas are checked (`zoneChecks.ts`: a track, via, pad or part inside one
  that keeps it out is an error), kept out of by the router (`autoroute.ts` `markKeepouts`), by placement (`boardObstacles`) and by pours. The PCB view has the Zone (Z) and Keepout (K) tools, picks a
  zone by its edge or its copper (`z:<id>`; a placement area by its edge only), drags corners, adds one by dragging an edge's dot, removes one by a right click, moves a whole zone
  (`editor/pcb/zoneEditing.ts`, `ZoneDraw.tsx`), and the Inspector (`panels/ZonePanels.tsx`) sets every property. Sakura's `set_pour` takes `polygon`, `keepout`, `priority`, `places` (X20) and `id`, and
  `get_design` lists `zones` only for a project that has one of its own shape. The KiCad export writes the zones of such a project itself (`export/kicadZones.ts`, filled as the editor filled them),
  Circuit JSON gets a `pcb_keepout` outline per rule area and the pours as the copper they fill, and a zone's net follows a rename in the schematic (`copperNets.ts`). The fill's gaps join the net
  classes (X10) and the pad model (X7), as KiCad does: the gap to copper of another net is the largest of the zone's own clearance, the larger of the two nets' class clearances and the board minimum
  (a local clearance is max'ed with the class value and never replaces it, `drc_engine.cpp` 9.0 `:1451-1540`; the whole-board path does the same), a pad's own clearance raises it, a pad's own
  `zoneConnect`, thermal gap, spoke width and spoke angle replace the zone's, and a pad's rounded corners, custom rings and hull are what is cleared (`zoneGeom.ts`); a class's clearance or members
  changing, and a pad's fields, are part of the key a fill is kept under, and the fill worker is sent the project file, which holds both. A group (X12) cannot hold a zone yet: the importer counts a
  zone a group lists as "not brought in". Tests: `tests/zones-*.test.ts`; the corpus compares every zone with the raw file (`tests/kicad-census/zones.mjs`, `tests/kicad-zones-check.ts`) and the
  editor's fill.
- **Copper layers, arc tracks and via kinds (X1, X4, X5; in project file version 3).** A layer is an id by position in the stack (`CopperLayer` in `model/types.ts`: `top`, `in1` to `in30`, `bottom`);
  `model/stack.ts` is the one place that knows the stack (`copperLayers(board)`, `layerAt`, `viaLayers`, `flipLayer`, `viaBetween`, KiCad's names both ways). A board with no `board.stack` is two plain
  layers and every consumer keeps its old two-layer behaviour, byte for byte (the golden test); never assume two layers, ask `copperLayers`. `BoardDef.stack` (`BoardStack`) holds the copper rows
  (label, type), the stackup rows, the finish and the edge settings; `model/stackCodec.ts` repairs it on load and `projectFile.ts` fits traces and vias to it (`fitCopperToStack`). `model/layerOps.ts`
  is every edit (layer count, names, the stackup, via kind and span, arc tracks): the editor and Sakura call it. An arc track is a `Trace` with `arc: true` and exactly three points
  (`model/arcTracks.ts` has the exact distances; `pcb.ts` items stay `segment` with an `arc`); draw one with `traceD` (`editor/pcb/traceGraphics.ts`) and never flatten one for a check. A via has an
  optional `kind` (blind, buried, micro), `from`, `to`, per-side `tent`, `unused`, `zoneLayers`, `free` and a `stack` of diameters; absent kind is a through via; use `viaLayers`, `viaDiameterOn` and
  `viaTentedOn` (`model/viaRules.ts`). A pad has `layers.inner` and an optional `stack` (padstack) that `padVariants` in `instances.ts` turns into the shape on each layer; `pruneUnused` in `pcb.ts`
  is KiCad's flashing rule. The router routes every copper layer and its new vias are through vias; `clear_routing` clears traces on every layer and keeps blind, buried and micro vias. Outputs: Gerber and drill per layer and span (`gerber.ts`, `excellon.ts`: `drillSets`), STEP and 3D drill only the through vias (a note says how many are not
  drawn), Circuit JSON has `num_layers` and `inner1` to `inner8`, and the writer (`kicadBoard.ts`) writes layers, stackup, arcs, via words and padstacks back (a project with a stack goes by the native
  writer). The corpus checks them against the raw file with an independent oracle (`tests/kicad-census/layers.mjs`, `tests/kicad-layers-check.ts`). Not built: blind holes in the STEP solid, inner
  copper in the 3D view, blind, buried and micro vias made by the router.
- **Tuning patterns, pad lengths, net chains, via protection, backdrill and post-machining (X21, X22).** A KiCad `generated` item (a tuning pattern, a via stack, via stitching) is a `PcbGroup` with a
  `gen` (`PcbGenerator`: its kind, copper layer and KiCad's own property list, points in the project's frame, `model/generators.ts`): moving or turning the group carries its points
  (`carryGenerators`, called by `moveObjects` and `rotateObjects`), and Ungroup takes it apart into plain tracks and vias. The importer (`kicad/board/drilling.ts` reads KiCad 10's grammar,
  `build22.ts` builds) resolves a generator's members like a group's (`groups.ts`, after the plain groups, as KiCad's `resolveGroups` does) and drops a tuning pattern or via stack with no members, as
  KiCad does. A pad's `dieLength` (mm) and `dieDelay` (ps) and a net's length (`model/netLengths.ts`: tracks, vias by the stackup distance between their layers, and the lengths inside the packages of
  its pads) feed the fabrication notes and Checks' `length` finding (a tuning pattern whose two-pad, unbranched net is outside its target range). Via protection (`Via.protect`, a tri-state for
  filling, capping, covering and plugging of each side over `rules.viaProtect`), backdrills (`Via.backdrill`, `tertiary`; a pad's, in the part's own frame) and post-machining (`post`) follow KiCad 10's
  drill enumerator (`model/machining.ts`): the Excellon writer makes KiCad's two files for each backdrill span and its post-machining comments (`export/excellon.ts`), Gerber files `-filling-`,
  `-capping-`, `-covering-` and `-plugging-` carry the protection (`export/viaProtection.ts`), the notes list all of it with a pad's (KiCad's drill files carry vias only), and the pour keeps out of
  the hole a backdrill or post-machining cuts (`CopperItem.cut`, `zoneFill.ts`). **The writer does not write KiCad 10's words** (the 9.0 parser refuses them: `unknownNodes`): a tuning pattern and
  `die_length` are KiCad 9's and are written; the rest stays in the project and is a named difference of the round trip (`BY_DESIGN`). Edits: `model/machiningOps.ts` (the Inspector and Sakura's
  `get_design` use them). Tests: `kicad-board-x21`, `kicad-board-x22`, and over the corpus `kicad-extras-corpus` (oracle `tests/kicad-census/extras.mjs`, check `tests/kicad-extras-check.ts`).
- **Board variants, footprint units and PCB points (X23).** A KiCad 10 board variant is a schematic variant (S9): `Project.variants` lists them, `ComponentInstance.variants` says per name what each
  changes on a part (`dnp`, `excludeFromBom`, `excludeFromPos`, `excludeFromSim` as true or false, and `fields`), and `model/variants.ts` (`resolvedComponents`) is the one resolver the BOM, the position
  file, the do not populate marks and the exports follow, so nothing reads `c.flags` of a board part without it. `ComponentInstance.units` (`{ name, pins }`) and `points` (`PcbPoint`, in the footprint's
  own frame like a pad, an older file's brought in from the board's frame) and `Project.points` (the board's frame) are optional fields of version 3 (`model/pcbPoints.ts`). **The writer does not write
  KiCad 10's words** (`variants`, `variant`, `units`, `point`): the footprints are written as the variant shown makes them and the rest stays in the project and is a named difference of the round trip
  (`BY_DESIGN`). Sakura's `get_design` has `variants`. `custom_property` (KiCad 11 development) is X23X, not built. Tests: `kicad-board-x23`, and over the corpus `x23-corpus`.
- **Flags and net ties (X15, joined with the symbol's flags S7).** `ComponentInstance.flags` (`PartFlags`, `model/partFlags.ts`) is the one set, for the symbol and the footprint of a part: mounting,
  virtual, not in the BOM or position file, not on the board, left out of simulation, board only, do not populate, allowed missing courtyard and mask bridges, jumper pad groups, net ties; every key is
  `true` and present only when it differs from KiCad's default (`fieldsAutoplaced` is on the component, not in the flags). `partFlags.ts` also has the rules: `onBoard` (a part with a footprint, unless
  `notOnBoard`), `inBom`, `inPositionFile` (do not populate and virtual leave both, board only alone stays in the BOM; the paste layer is unchanged, as KiCad plots it), `cleanFlags`, `setFlags` (every
  unit of a part carries them; taking a part off the board also removes its unlocked traces and vias), `joinFlags` and `kicadAttributes`. Nothing asks `isPhysical(findPart(...))` for "is it on the
  board": it asks `onBoard`. The fabrication notes state each rule; a net tie exempts its pads from the short check and the clearance check (`pcb.ts`); the Inspector has one Flags section for a part, in
  both views, and a panel each for a trace and a via; `get_design` lists a part's flags (`flags`, in words, and `net_ties`) and `update_component` sets them (`dnp`, `in_bom`, `on_board`,
  `in_pos_files`, `board_only`, `virtual`); the KiCad export writes the footprint's `attr` and the groups (`applyFootprintFlags`, `export/kicadPost.ts`) and the symbol's `dnp`, `in_bom`, `on_board`,
  `exclude_from_sim` (`applySymbolFlags`, `export/kicadSheet.ts`). The KiCad 9 schematic has no `in_pos_files`, so "not in the position file" goes on the footprint only. A project import has both the
  symbol and the footprint for a linked part: the symbol wins for do not populate, the BOM, the position file, simulation and being on the board, the footprint for the rest, and a report note
  (`symbol-footprint-flags-differ`) says where they disagreed (`joinFlags`).
- **Drawings in the editor (X8).** `model/shapes.ts` is the geometry (exact pieces, flattening within 0.0002 mm, mapping onto another frame, KiCad's dash patterns, SVG and canvas paths),
  `shapeLayers.ts` the layers by KiCad's name, `shapeItems.ts` every drawing in the board's frame with its selection id (`g:<id>` on the board, `s:<component>:<index>` in a part's land), `shapeOps.ts`
  the edits. A drawing has a layer, a stroke width, a dash, a fill (solid, also outlined by the width), a net and a lock. Behaviour by layer: copper drawings are copper (`CopperItem` kind `shape` in
  `pcb.ts`: they join their net's copper when they name one, and a drawing with no net connects nothing and keeps clear of nets; pours clear around them or take them in; the router keeps off them;
  edge clearance applies), mask and paste drawings go to those Gerber files, silkscreen drawings to the silkscreen Gerber (designators keep clear of a filled one and avoid the runs of an outline,
  `silk.ts`; a part with no pins has no designator), fab, courtyard, adhesive and user layers are drawn muted and plotted nowhere (KiCad's default). A net tie excuses only the tie's own copper
  (`tieExempt`). The PCB view draws them, selects, moves and deletes board drawings, and has line, arc, circle, rectangle and polygon tools (D, A, C, B, P) on a layer picked in the toolbar; the
  Inspector edits a drawing's layer, width, dash, fill, lock and net, and lists a part's land drawings (a land is shared: every part with it changes). Exports: Gerber (arcs exact with G02 and G03,
  circles, rounded rectangles, polygon holes bridged, curves and ellipses flattened, dashes), KiCad (`gr_*` and `fp_*`), Circuit JSON (silkscreen, fabrication, courtyard, copper), Sakura's picture,
  the 3D board (silk, copper and mask openings); STEP has no copper or silkscreen, so it does not change. `get_design` counts drawings per layer and lists the copper ones.
- **Single-pad nets, pads with no net and pin types.** Every net keeps a label, so a net with one pad would show "goes only to a label no other pin has" in Checks: the import sets each of those
  findings to ignored (`ignoredChecks`, listed under Ignored, restorable) and says how many in one note. A pad the file puts on no net is a pin left unconnected, which Checks would list one by one as
  "isn't connected": it is marked no connect (`ComponentInstance.nc`) and one note says how many; clearing the flag in the Inspector brings the check back, and `Project.importMarks`
  (`importMarks.ts`) records what the import set so one action hands the no-connect pins back and an ignored key is retired once its finding is gone, never touching the user's own. A pin type the
  editor's seven roles fold (tri-state, open collector, power output, free, unspecified) is listed in a `pin-type-folded` note; the file's own type stays in the `KicadBoard` that was read.
- KiCad's own code settled the semantics the importer depends on (a pad's stored angle, how a bottom footprint is stored and drawn, text angles, `unlocked`, a 3D model's transform, inches in
  `(at (xyz))`, the overbar conversion).
- Every test that needs the local corpus is in `tests/corpus/` (shared walk, env and report helpers in `tests/corpus/shared.ts`); `KICAD_CORPUS=<corpus> npm run test:corpus` runs them all, and without `KICAD_CORPUS` they skip, so `npm test` and CI are unchanged.
- `KICAD_CORPUS=<corpus> npx vitest run tests/corpus/board.test.ts` prints the per-board pass or fail table over a local corpus.
- Corpus tests (`tests/*corpus*.test.ts`): `KICAD_CORPUS_SAMPLE=N` runs about N boards (every k-th, the same ones each run); unset runs them all. A board stuck for `KICAD_BOARD_TIMEOUT_S` (300)
  seconds is named and the run ends. An opt-in on-disk cache of imports and exports (`KICAD_CORPUS_CACHE=1`, in `.corpus-cache` at the repository's root, which is not to be committed) exists but is NOT trusted yet: a warm hit
  changes the extras test result. See `tests/corpus/shared.ts`.
- **The store's commit hooks** (`followNetRenames`, `pruneImportMarks`) share `model/connectivityCache.ts`, whose `getConnectivity` reuses the schematic's connectivity across edits that leave the
  schematic alone (`sameSchematic`: wires, labels, and each part's id, part, reference, properties, place and no-connect pins); a drag ends through the same hooks. "Use the net it touches" clears every
  trace and via of the same connected copper that names the same net (`sameStoredNet`).

**The dashboard's import (`src/kicadImport/`).** "Import KiCad" takes `.kicad_pcb`, `.kicad_sch`, `.kicad_pro`, `.kicad_dru`, KiCad 5's `.sch`, `.lib` and `.pro`, a legacy `.brd`, a `.zip`, several
files at once, and a dropped folder.

- `pick.ts` opens the zips and picks the board and what sits beside it (several boards: the user
  chooses); `engine.ts` is one job (pick, read, import, summarize) and `worker.ts` runs it off the
  main thread, `client.ts` starts a worker per job and cancel ends it. `protocol.ts` is the messages.
- A KiCad 4 or 5 project (its `.sch`, `.pro` and `.lib`, with no `.kicad_sch` beside them) imports
  with its schematic through the same project importer. When the schematic cannot
  be read (most often a symbol its libraries do not have, about one project in four) the board comes in
  alone, with a schematic drawn from its connections, and the report says why for each file. Beside a
  `.kicad_sch` they are an older copy, set aside as such. Over 1,400 boards of open projects came in
  without their schematic before this; 1,017 of them now come in whole.
- Limits: a file is read up to 64 MB (`MAX_FILE_BYTES`; the import takes about 26 MB of memory per MB
  of board), a zip entry is counted as it unpacks, KiCad's `-backups/` folders and the zips in them are
  skipped unread, and a worker that says nothing for 2 minutes is ended (`WATCHDOG_MS`).
- Dialogs (`focus.ts`, `useModal`): focus moves in and back out, Tab stays in, and no key reaches the
  editor's shortcuts behind it; a running import is ended only by its Cancel button.
- The importer is loaded by a dynamic `import()` in `engine.ts` only, when a job starts, so its code
  and `stockModels.ts` stay out of the page's bundle. A test fails if any other module of the editor
  imports the importer for more than a type.
- **The schematic and project importer plugs in at one place**: `loadProjectImporter` in
  `engine.ts`. While it is `null`, `.kicad_pro` and schematic files are named in the report as not
  read yet and the board is imported alone.
- `summary.ts` turns a result into plain data (extension ids into `PLAIN_NAMES`, the one table of
  plain names; a test pins its keys to the importer's), and the text and JSON downloads.
  `ReportView.tsx` is the report screen and `KicadImportDialog.tsx` the dialog around it (choose, progress
  with cancel, report). **A saved import opens the project at once** (both hosts' dialogs mark it,
  `justImported.ts`, and call `onOpen`), and the editor says so in one line that fades,
  "Imported from KiCad. See the report." (`ImportedNote.tsx`): the report window is only for a refused
  import or a save that failed. The report is kept in this browser and, as a zip of one `report.json`,
  in the host's file store, which the project names (`KicadCarry.report`, left out of `contentHash`), so
  it opens on any computer and for the people the project is shared with (`reportStore.ts`,
  `ReportDialog.tsx`); the Inspector's KiCad import section shows it again.
- `controller.ts` is the flow as plain state (tested without React; `useKicadImport` puts it on a
  page); `save.ts` measures the stored text against the 32 MB limit before `createStoredProject` (how a host's storage keeps a big one is its own affair; the editor sends it as any other).
- `analytics.ts`: the editor sends no events of its own. The import sends one `kicad_import` event
  (outcome, KiCad stamp and release, missing extension ids, board KB, duration; never a name) to a
  sink the host connects with `connectAnalytics` (exported by `src/projects.ts`); the hosted app's
  projects page connects its analytics. The editor's own dashboard, this build's home, connects none, so
  it sends nothing.
- **Two pages run it.** The editor's `Dashboard.tsx` (this build's) and the hosted app's projects
  page each draw the same controller and the same report (`sections.ts`, as data) in their own style.

The census behind the import:

- The decision for every board node, value atom and keyword is the data in `tests/kicad-census/decisions.mjs`; `node tests/kicad-census/gap-table.mjs <census-out>` prints it as a table.
- The same for schematics (extensions S1 to S12) is `tests/kicad-census/decisions-sch.mjs`; its node table comes from `node tests/kicad-census/gap-table-sch.mjs <census-out>`.

`tests/kicad-census/` has the scripts (plain Node, no install) and `decisions.mjs` and `decisions-sch.mjs`, the tables the importer reads.

### Reading KiCad schematics (built)

`src/model/kicad/schematic/` reads a `.kicad_sch` (KiCad 6 on, or a KiCad 4 or 5 `.sch`: see "KiCad 4 and 5 schematics" below) and the sheets below it, and `src/model/kicad/project/` imports a board,
its schematic and its project file as one project. The dashboard's "Import KiCad" runs them (`src/kicadImport/`). `importKicadSchematic(text, bytes or { files, root }, options)` and
`importKicadProject(files, options)` never throw for a file: what cannot be imported is a refusal with its report. The model types of S5, S6 and S10 and the optional fields of S2, S4 and S7 are in the
project file, version 3 (see "Symbols with units, mirrors, fields and drawings" and "KiCad net names, sheet items and symbol flags" below).

- `read.ts` reads one file into the typed `KicadSchematic` of `types.ts` (every object keeps its own list), through the board's `sexpr.ts` (BOM, UTF-16, named errors for a cut file or too deep a
  nesting), with its version switches numbered in order. `tree.ts` follows the sheet files (KiCad 6's `Sheet file`, KiCad 7's `Sheetfile`, reused sheets, any
  depth): a missing, unreadable or self-containing sheet is a named `SheetError`, never a throw and never a hang.
- `account.ts` looks up every node in `decisions.ts`, generated from `tests/kicad-census/decisions-sch.mjs` by `node tests/kicad-census/emit-decisions-sch-ts.mjs` (a test fails when they differ). A list
  the table has no atom row for holds names and identities, as in the census, so its words are not checked. `carried.ts` says which extension nodes say nothing more than the editor already draws
  (`Plainness`: a default wire, a label of KiCad's default size, a symbol used once on the root sheet, a junction of the default size, a no-connect on a pin), `needs.ts` which of S1 to S12 a file needs:
  the census's rules of `needs-sch.mjs`, and on top of them every extension node that is not settled, which is how a label of its own size needs S2. `BUILT_EXTENSIONS` is S1 to S12; what still refuses
  is S9X (the KiCad 11 development words) and S11L (KiCad 5's own rules). A file that needs something not built is refused with "This schematic uses ..., which is not supported yet".
  `tests/kicad-sch-carried.test.ts` looks every node counted as imported under `lib_symbols` and every placed symbol node up in the project, with no list of paths let through.
- `symbols.ts` turns a cached symbol into a `SymbolDrawing` (`drawingFromLib`: every shape with its width, dash, colour and fill, every pin with its type, shape, alternates and visibility, units, body
  styles, jumpers, the place and look of each field, all in the editor's units and KiCad's own numbers to 0.001 mm) and into the spec of a part (`specFromSymbol`); `link.ts` links footprints to symbols:
  path, then timestamp, then reference, then nothing (KiCad 6's root list and KiCad 7's instances give the same board path; a reused sheet links several footprints to one symbol). `build.ts` makes the
  project of a flat sheet, listing every sheet with its page (the file's `(paper ...)`, read whole by `read.ts`: GERBER is a `User` page 812.8 mm square, an unknown
  name A4; its corner at (0, 0), where KiCad has its page): a symbol is a component of a part drawn from its drawing (one part per drawing and footprint, the drawing stored once under its hash in `Project.symbols`), placed with its
  turn, mirror, unit, body style, fields and chosen pin alternates; the units of one reference are several components, the one the board's footprint is linked to being the part and the others its twins;
  a power symbol of one power-input pin is a power port that keeps KiCad's drawing; a junction on a wire's body cuts the wire, a no-connect pin is left out of the nets by connectivity, a hidden
  power-input pin joins the global net of its name by connectivity as well. What the editor would join or name differently from KiCad is a `lossy` need with its extension, and the importer refuses a
  schematic that has one that is not built: a wire end on a wire's side with no junction, a label on a pin on a wire, two points closer than the editor tells apart (S11), a symbol the cache lacks
  (S12). What the drawing cannot hold (a power symbol with other pins, a pin of an unknown type) is a refused report entry, never a drop. A power symbol is named by its hidden pin before stamp
  20230221 and by its Value from it. The object count is limited to 25,000.
- `project/import.ts` imports the board with the board importer, links, builds the schematic with the footprints it linked, and replaces the generated schematic (the schematic's parts and drawings
  come into the project; a board part a loose footprint uses stays). A footprint with no symbol stays a part with a stub and a label of its board net on each pad. Footprints are matched to the board
  importer's parts by place, side and reference, and an ambiguous one refuses. It compares every pad's net on the board with its pin's net (power ports and units included) and lists each difference by
  part and pin as a board not updated from its schematic. If the schematic is refused and the board is fine, the project is refused and the message says that the `.kicad_pcb` alone imports with a
  generated schematic. `pro.ts` and `dru.ts` read `.kicad_pro` and `.kicad_dru` and account for every key and node: net classes, assignments, custom rules and any design setting that is not the
  editor's own are pending X10 (a project that has them is refused until it is built), the rest is not needed with its reason.
- `tests/kicad-census/netlist-sch.mjs` derives a schematic's nets from the raw file, sharing no code with `src`, and `boardPadNets` reads the board's own: the nets test and the corpus test compare the
  editor's `computeConnectivity` with the first, and the first with the second. `tests/kicad-census/drawing-sch.mjs` reads the cached symbols from the raw file the same way, and the corpus test
  compares every symbol drawing with it, number by number.
- `KICAD_CORPUS=<corpus> npx vitest run tests/corpus/schematic.test.ts` prints the per-file and per-project table.

#### KiCad 4 and 5 schematics

`.sch` (`EESchema Schematic File Version` 1 to 5), `.lib` (2.3, 2.4), `name-cache.lib` or `name.cache.lib` and the legacy `.pro` go through the same reader, accounting, needs, link and build as a
`.kicad_sch`. Nothing in the editor, Sakura or the model is specific to them.

- `schematic/legacy/sch.ts` parses every record strictly (KiCad 5.1 skips a line it does not know; this refuses it, naming the record: `unknown-node`, reason `unknown`), `legacy/sexpr.ts` writes the
  sheet as the text of a `.kicad_sch` (the KiCad 6 form KiCad converts it to), and `readKicadSchematic(text, legacyInfo)` reads that, so nothing downstream knows the difference except where KiCad 5
  differs (`root.legacy` in `build.ts`). The file's own version is the stamp, so the reader's switches for files before 20230221 and before 20210606 apply to every legacy file.
- Files are read as UTF-8 first, else Latin-1 (said in the report and in `legacy.encoding`). Lengths are exact (mils to millimetres). Records KiCad ignores in a version 1 file are counted and said,
  not dropped.
- `legacy/lib.ts` reads a `.lib` and writes each symbol as the KiCad 6 symbol KiCad converts it to; it is read by the `.kicad_sch` reader at stamp 20230221 (so a lone `~` is empty and no arc is
  complemented). `legacy/sources.ts`: the cache first (`Lib_name`, then `Lib:name`), then the libraries the `.pro` lists in order. A symbol in none is S12 and refuses naming it; **nothing is drawn that
  the files do not have**. A symbol from a library, not the cache, is refused when a wire ends near it where it has no pin (`symbol-may-have-changed`).
- KiCad 5 rules in `build.ts`: a power symbol is named by its pin (shown or not); a label on a pin on a wire's side joins both, as the editor does (no S11); a pin of the type no connect with anything
  drawn at it joins it in KiCad 5 and not here: S11.
- `project/legacyPro.ts` accounts every `.pro` line; net classes and design rules are pending X10 like the `.kicad_pro`'s. `pickProjectFiles` picks a legacy project when there is a `.sch` and no
  `.kicad_sch` (its project file is a `.pro` or a `.kicad_pro`).
- Tests: `tests/kicad-schematic-legacy.test.ts` (unit), `corpus/schematic-legacy-demos.test.ts` and `corpus/schematic-legacy.test.ts` (corpus; `KICAD_CORPUS=<corpus>`), with the independent
  `tests/kicad-census/census-legacy.mjs` and `netlist-legacy.mjs`.

#### Symbols with units, mirrors, fields and drawings (S5, S6, S10)

- **The drawing is the source.** `SymbolDrawing` (`types.ts`, stored in `Project.symbols` by a hash, a part names it in `CustomPartSpec.drawing`) is KiCad's symbol in the editor's units.
  `model/symbolDrawing.ts` makes everything the editor works with from it: `drawnPart` (pins, the `SymbolDef` of each unit and body style as `PartDef.units`, jumpers, field places), `pinGraphics` (the
  line and the mark on the end of a pin as KiCad's painter builds them), `pinTexts` (names and numbers laid out as `pin_layout_cache.cpp` does, by the pin's way on the sheet, not the symbol's),
  `readDrawing` (a file's drawing, or null). `symbolOf(part, c)` is the symbol a placed component draws: never read `part.symbol` for a placed component.
- **Shapes** (S6): `SymbolPrimitive` has arc, bezier and ellipse besides path, circle and text, and a `look` (width, dash, colour, background or colour fill). `model/primitiveGeometry.ts` gives path
  data and sample points; an arc is KiCad's three points and a filled arc is a pie. The editor's own symbols have no `look` and draw as before.
- **Placement** (S5): `ComponentInstance.sch.mirror` (`x` flips top to bottom, `y` left to right, after the turn, as KiCad applies them: `orientPoint`, `orientBox`, `orientDir`); `unit`, `bodyStyle`,
  `pinAlt`; `fields` (a place, size, justification and visibility for Reference, Value and every other field). A field's `x`, `y` is its drawn anchor from the symbol's origin; its angle and
  justification are the symbol's own, as the file has them. KiCad's rules (`SCH_FIELD::GetDrawRotation`, `GetBoundingBox`, `GetPosition`) are in `textOnSheet`, `fieldPlaceOf` and `fieldBox`
  (`symbolDrawing.ts`): a quarter turn swaps across and up, the box goes through the turn and mirror, and turning or mirroring a symbol moves its fields with it (`reorientFields` in `ops.ts`; Tidy's
  `reseat` does the same when it turns a part). `tests/kicad-census/drawing-sch.mjs` `rawFields` derives every field's angle and box from the raw file, sharing no code with `src`, and the corpus test
  compares them. `ops.ts` `reorientComponent` turns or mirrors a part with its stubs and wires (`rotateComponent` and `mirrorComponent` are its two faces; `composeOrientation` is the algebra);
  `schematicEdit.ts` has `mirrorSelection`, `setSymbolVariant` (unit, body style, pin function), `addUnit`, `setFieldPlace`, `renameReference`, all guarded like the canvas edits: refused with the reason
  when they would change a net.
- **Units**: a part with several units is several components of one reference. The one with the footprint is the part; the others are placements of its twin (`unitTwinId`, `PartDef.unitOf`, no
  footprint), so everything that counts boards, BOM and footprints skips them by itself. `unitOwners(components)` maps a twin to the part, matching by reference and by the symbol the twin is drawn from
  (so duplicated designators cannot hand a unit to another part); connectivity lists a twin's pins under the part and keeps both keys in `pinNet`. `removeItems` promotes the next unit when the part is
  deleted (`units.ts`).
- **Real parts**: an imported symbol is a part of the sheet whether or not it has a footprint (a footprint is linked later). `isSchematicPart` (`instances.ts`) is the test for everything schematic
  (nets, ERC, Tidy, Clean up, BOM, Circuit JSON); `isPhysical` stays the test for the board. The file's Footprint field is carried as text (`props.Footprint`) and is the BOM's footprint column until a
  land pattern is linked.
- **Connectivity**: pins of a KiCad symbol are separate nodes by place (`PartDef.jumpers` present: pins of one number are one pin only when the symbol says so, and `jumpers.groups` join numbers), a pin
  of the type `no_connect` is on no net, a hidden power-input pin is on the global net of its name. The editor's own parts have no `jumpers` and behave as before.
- **Other subsystems**: ERC has `missing-unit` and `pin-conflict` (KiCad's pin-type table; only pins with a `type` take part); Tidy keeps mirror, unit, fields and pin functions, draws a net's ports
  with the imported power part when it has one (`portShape`, `portInstance` in `tidy/shapes.ts`) and never wires a hidden pin; `get_design`, `add_component`, `update_component` (with `placed_unit`),
  `connect` know units, mirrors, fields, hidden pins and functions; the BOM counts a multi-unit part once; Tidy that has no room says whose text is in the way when that is the cause
  (`textInTheWay`, found by laying the block out again without it); Circuit JSON writes every unit as a schematic component of one source component (`symbols` on the export carries the links) and the
  KiCad export merges the units into one library symbol and writes each pin's name and electrical type (`export/kicadPost.ts` `writeSymbolLinks`, `patchPins`), with notes for what does not come
  across (text inside a symbol is written on the sheet, other pin functions are left out). Sakura's prompt gets the note about units (`UNITS_NOTE`, `systemMessageFor` in `ai/copilot.ts`) only for a
  design with KiCad parts; for any other the prompt is byte for byte the old one. Symbols in a file's cache that nothing places are stored as drawings (`Project.symbols`) but not listed as parts,
  with one report entry.
- **Editor**: `X` and `Y` mirror the selection (or the part being placed); the Inspector has Unit, Body style, mirror buttons, Place unit, the function of a pin with alternates, and the fields (place,
  hide); a field of an imported part is dragged by its text.

### KiCad net names, sheet items and symbol flags (S2, S4, S7)

- `Project.netNames` (`"kicad"` or `"kicad6"`, set by the importer) switches `computeConnectivity` to KiCad's naming (`model/netNames.ts`): driver priority global label 7, global power 6, local power 5,
  local label 4, pin 1; a name with `-Pad` last, then the name that sorts first. Local label or local power nets are `/NAME`, global ones `NAME`. Unnamed nets take a pin's name (`Net-(R1-Pad2)`,
  `Net-(U1A-VCC)`, `unconnected-(...)`); `kicad6` always adds `-PadN`; an empty power Value is `<NO NET>`. `bareName(net)` is the text to type to get a net's name; `labelTextFor` maps a name back to
  label text (`connect` uses it). A project with no `netNames` is named exactly as before.
- `NetLabel` has `kind`, `shape`, `look`, `fields`, `fieldsAutoplaced`; `labelShapes.ts` draws them. `Wire.look` holds a wire's stroke; `SchematicBlock.locked` locks a group. All optional, read only
  when they say something, a malformed one is dropped.
- **One model of the sheet's drawings** (`Project.drawings`, `SchematicDrawing`, `model/types.ts`). The drawing tools' lines, boxes and text and everything a KiCad sheet draws are one list, in one
  order, selected as `d:<id>`. A KiCad polyline is a `line` and a rectangle a `rect` (by its lower-left corner and size); they say what the file said in `stroke` (width, dash, colour; an empty one says
  "KiCad's own line", 0.012 wide, in wire blue) and `paint` (the outline's colour, the sheet's, or one of its own), which win over the named `color`, `weight`, `dash` and `fill` until the editor
  restyles the drawing (`applyStyle`). Only a KiCad sheet has the rest: `circle`, `arc`, `bezier`, `textbox`, `image`, `table`, `junction` (a dot of its own size and `dotColor`) and `noconnect`
  (`isKicadOnly`, `model/sheetItems.ts`, which has their geometry, reading and hit tests). A text from KiCad always has `valign` (KiCad's own default is the middle; the editor's texts are anchored at
  the top and have none), says its justification, turn and look in its own fields (`lookOfText`, `kicadText`), and is drawn and written back as KiCad has it. `isExact` is a drawing that says
  something exactly (a KiCad kind, a stroke, a fill or a `valign`); the Inspector gives it the exact controls (`ExactDrawingInspector`, millimetres, a colour of any value), and Tidy leaves it where it
  is unless a block's frame holds it (`sheetFixed`). Both the canvas and Sakura's pictures paint every drawing with `editor/schematic/drawingPaint.ts`. Drawings of the drawing tools and Sakura's
  drawing tools behave as they always did; the file's migration turns the old `items` (each with a `kind`) into drawings.
- A symbol's flags are the part's flags (`PartFlags`, above); `fieldsAutoplaced` is on the component. A symbol not on the board gets no footprint in the project import.
- Tidy and Clean up keep names: no power ports for a net a local label names, a global label of its own KiCad name for an unnamed net, labels restyled by text, the drawings a KiCad sheet gave
  treated as obstacles (the drawing tools' own go with the block that holds them), a dropped junction noted. Clean up's refusal lists the pins and the off-grid note.
- The KiCad export (`export/kicadSheet.ts`) writes labels, **every drawing** (a drawing the tools made is written with exact strokes and fills: its named colours as the light sheet draws them, an
  arrowhead as a small filled triangle, a text with a border or a background as a text box, `exactForm`), wire strokes and flags; a local power symbol is written local (`(power local)`,
  `localizePower`), so its net has its sheet's path in the schematic and the board. Circuit JSON leaves out the drawings the tools made (its note says so) and writes the ones a KiCad sheet gave.
- Parts imported from a KiCad file have `source.pins/land = "import"`, so no "made from memory" warning.
- Sakura: `KICAD_NET_NOTE` is added to the system message only when `project.netNames` is set; `update_component` takes `dnp`, `in_bom`, `on_board`, `in_pos_files`, `board_only`, `virtual`;
  `get_design` lists a part's `flags` and the sheet's `drawings` (the first 100, then `drawings_more` counts the rest; the board's own drawings are `board_drawings`); `layout_pcb` and `route_pcb` say
  so when an imported design has no footprints.
- Independent checks: `tests/kicad-census/netlist-sch.mjs` (names) and `items-sch.mjs` (drawing geometry) share no code with `src`; `tests/kicad-sch-net-names.test.ts` holds the unit tests.

### Sheets (S1, in project file version 3)

A schematic can have several sheets: `Project.sheets` (a project of one sheet has `[{id:"root"}]`, which migration gives it; the root is `Main` until it has a `name` of its own, never the project's name), `Project.sheetSymbols` (a rectangle on a sheet with
pins, standing for another sheet) and the hierarchical label (`NetLabel.kind: "hierarchical"`). `model/sheets.ts` is the one place to read:
a **use** of a sheet is a path of sheet symbol ids (`` for the root, `/h1/h4`); a wire, label, drawing or sheet symbol belongs to a **sheet**
(`sheet`), a part's symbol to a **use** (`inst`, and `tpl` on the copies a reused sheet makes). Anything that works on one sheet runs on a
`sheetView(project, path)` (the project with only that use's items, `scope` set) and goes back with `commitOnUse` (merge, then `syncCopies` so
every use of a reused sheet stays alike); for a project of one sheet the view is the project and nothing changes. In the editor `store/sheetScope.ts`
(`commitHere`, `dragHere`, `dropHere`, `commitFor`, `shownProject`) is how a schematic edit is made: use it, not `projectApi().commit`, for anything
that edits parts, wires, labels or drawings. `computeConnectivity` works per use (a name joins by use, a sheet pin joins the labels of its name on the
sheet below its symbol, a global name joins everywhere; `byUse` has what a reused sheet's wire ids mean per use); `sameSchematic` must say a sheet symbol
changed, or the connectivity cache would be stale. Sakura's `get_design`, `get_wiring`, `connect`, `draw_wiring`, `tidy_schematic`, `add_component`, `group_parts`, `edit_block`, `arrange_blocks` and `draw` take `sheet` (`ai/sheetTools.ts`; the sheet shown when none is named), and builds sheets with `add_sheet` (new, or `reuse` for another use), `edit_sheet` (rename, move, resize, pins, delete, and any sheet's page, the root's included: `page_size`, `orientation`, `page_width_mm` and `page_height_mm` for a custom page, `fit_page`), `add_hier_label`, `wire_sheet_pin` and `show_sheet`, all through the `sheetOps` functions the editor uses. `get_design` lists each sheet with its box and pins, and every sheet's `page` (its size, orientation, the area inside its border and its title block, in sheet units; top-level for a project of one sheet). A sheet's page is `SchematicSheet.paper`, shared by every use of the sheet. Copper layers have a colour each, up to 32 (`copperColor` and `pourColor` in `editor/theme.ts`, the only place that decides one; `panels/CopperLayerList.tsx` is the list with swatches and eyes). Circuit JSON
and the board are flattened (`export/flatten.ts`); the KiCad export writes a file for each sheet, named after it (`export/kicadSheets.ts`).
A flag on a sheet symbol reaches the parts through `withSheetFlags`
(BOM, position file, exports), not the PCB view. Several top level sheets (KiCad 10) are refused by name (`S1T`).

**Drawing the hierarchy by hand**, as in Altium, in its words: a **port** is a hierarchical label and a **sheet entry** a sheet pin (`SheetPin`). The label tool
(`L`) places a net label, a global label or a port (`uiStore.labelKind`, kept for the session, picked in the `LabelOptions` bar under the toolbar or with `Tab`
and `⇧Tab`, in the name box too); Port is off on Main, which has no sheet above, and the tool places a net label there. `addLabel` takes the kind, and gives a
global label or a port a shape (bidirectional unless given). In a project drawn here a net label has no `kind` at all: `setLabelStyle` back to "This sheet"
clears it, since `local` would draw it as KiCad's (`isKicadLabel`). Every name typed for a label or an entry goes through `typedLabelName` (`model/busNames.ts`):
upper case in a project drawn here, so an entry `data` meets its port `DATA`, the case kept in a KiCad project. Every label has the label Inspector
(`LabelInspector`: text, Joins, Shape, the text style only where something draws it), and a port's has "Go to the sheet entry". **Entries are on the canvas**:
selected as `e:<symbol id>:<pin id>` (picked before the symbol's rectangle and before a wire ending at its point; `PeerLayer` draws a collaborator's), slid
along the edges and round the corners by a drag (`moveSheetPin`, at the free place nearest the pointer, `edgeSpot` and `sheetPinSpot` in `model/sheetOps.ts`:
on the grid, a grid step from each corner, never on another entry; the wires and labels at it follow as they follow a moved symbol, and the drop is checked as
any drag is, `guardDrop`), deleted by `Del`, ended on by the wire tool, and a double-click on one shows its port (`revealPort`). The Sheet entry tool (in the
block and sheet group) adds one where the edge is clicked, through the label tool's name box; the symbol's Inspector adds one in an inline field with its side.
**Entries and ports are kept in step, adding only** (Altium's Synchronize Sheet Entries and Ports): a port placed or a label switched to Port gives its entry
to every symbol of its sheet, and an entry added on the canvas or in the Inspector gets its port inside, in a column beside the sheet's drawing
(`syncSheetEntry`; the canvas says what it added, in a plain `info` notice). Each is one commit of the edit on the sheet shown (`commitOnUse`) followed by
`syncSheetEntry` **on the whole project**, never inside a view: `mergeSheetView` tags every new label with the view's sheet, so a port made for another sheet
inside a view would land on the wrong one (it throws on a view). A rename or a delete is not kept in step; the checks say when the two sides differ. `addSheetPin`
stays a plain primitive, which Sakura's `edit_sheet add_pins` and `add_hier_label` rely on. **Intersheet references**: in a project of several sheets drawn
here, each global label draws after its flag the other uses whose sheet has a global label of its name (`model/intersheetRefs.ts`, `globalLabelUses` worked
out from the whole project and kept per project), and a click on a name shows that use with its label selected. They are worked out and never stored, and stay
out of `labelBox`, so hit tests, Tidy, frames and every export are as they were; a KiCad project's labels draw none.

### Directive labels, rule areas and symbols from libraries (S8 and S12, in project file version 3)

A **directive label** (`netclass_flag`) is a drawing of the type `directive` (`DrawingDirective`: its anchor, turn, flag shape, pin length, look and every property it has, as `LabelField`s) and a
**rule area** is a closed `DrawingLine` with `ruleArea` (its flags). They are drawings, so select, move, rotate, delete, copy, the sheet tag and the save are the drawings' own
(`model/sheetItems.ts` has the geometry, `directiveShape` the pin and flag as KiCad's painter draws them; `panels/SheetInspectors.tsx` the Inspector). What they mean is worked out, never stored as the
user's: `model/directives.ts` (`labelClassClaims`, `withLabelNetClasses`, `settleLabelNetClasses`) gives each net the classes a `Netclass` field says (a directive label, or a plain label's own
property, or a directive on a rule area's edge for the wires, labels and pins inside it) and keeps them in `NetClass.labelNets` (a class only a label names is `implicit: true`, KiCad's class that
sets no size, and goes with the label); the store runs it after every commit (`settleEdit`, a no-op returning the very same object for a project with none). A net two classes claim is a refusal at
import (`netclass-conflict`), since the model has one class per net. `model/ruleAreas.ts` (`ruleAreaFlags`, `withRuleAreaFlags`) puts a rule area's flags on the symbols whose box touches the polygon
(`model/polygonHits.ts`: KiCad's collide rules), read by the BOM, the position file and the exports like `withSheetFlags`, and drawn on the symbol by the editor. Tidy leaves a sheet with either alone
(it draws wires anew). The KiCad 9 export writes `(netclass_flag ...)` and `(rule_area (polyline ...))` only: KiCad 9's parser reads nothing but the polyline in a rule area, the flags came with file
version 20250610, so the flags go on the symbols the area touches. Symbols the schematic's cache lacks are looked up by `schematic/libraries.ts` (`SymbolLibraries`, `tree.libraries`): the project's
`sym-lib-table` and `.kicad_sym` (or `.lib`) files, then `databaseSymbols` (what a host fetched from the parts database for the ids a first import named).

### Buses (S3, in project file version 3)

A bus is a drawing (`SchematicDrawing` of type `bus`: a polyline of segments, each a KiCad `(bus ...)`) and a bus entry another (`busentry`: a corner, `dx` and `dy`, and `toBus` for KiCad 5's
bus-to-bus entry); both are KiCad-only drawings (`isKicadOnly`), so the drawing tools, selection, moves, copies, sheets and the export carry them with no code of their own. `Project.busAliases` holds
the aliases. A label or sheet pin whose name is a bus (`model/busNames.ts`: KiCad's `ParseBusVector`, `ParseBusGroup` and `ConfigureFromLabel`, with a `kicad9` and a `kicad10` grammar) and that touches
a bus line or no wire is a **bus label**: it names no net (`labelNet` has none for it) and gives its bus's members. `model/busConnectivity.ts` finds the buses of a sheet; `computeConnectivity` joins
the members of every name of a bus (a vector's by position, a group's by the member's own name without its prefix: `matchBusMember`), through a sheet pin and a hierarchical label of one bus name (a
chain), names every net on a member by the chain driver's member as a driver of its own (below a global name), and lets a bus entry join what is at its ends except at an end on a bus. A net joins a
bus **only by name**, as in KiCad: nothing about an entry's geometry decides a net. `sameSchematic` compares bus drawings and aliases by identity, or the connectivity cache would go stale on a bus
edit. The ERC has `bus-entry-no-bus` and `net-not-bus-member`. The KiCad export writes `(bus ...)`, `(bus_entry ...)` (a bus-to-bus one as a short bus segment, which KiCad 6 and later have no entry
for), `(bus_alias ...)` and the labels the converter does not write (`addBusItems`). The importer refuses a bus name on a wire, a name KiCad 9 and 10 read differently and a bus over 4,096 nets by name (`S3B`).

### Variants and KiCad's joining rules (S9 and S11, in project file version 3)

**Variants** (`model/variants.ts`, the one resolver): `Project.variants` (`list`, `active`), `ComponentInstance.variants` and `SheetSymbol.variants` (by the use of the parent sheet) hold what each
KiCad 10 variant changes on a symbol (only what differs from the symbol: `dnp`, `excludeFromBom`, `notOnBoard`, `excludeFromSim`, `excludeFromPos`, and `fields`). The symbols are never rewritten by a
variant: what the BOM, the position file, the do not populate marks, the board side and the exports use is `resolvedComponents(project)` (`model/ruleAreas.ts`), the one chain in KiCad 10's order: the
symbol's own flags with the active variant's true or false for each (`resolveVariant`, `overlayFlags`, which touch the symbol's own flag only), then the flags of the sheet symbols above it
(`applySheetFlags`, each use asking its own variant, `variantSheetFlags`), then the rule areas' (`ruleAreaFlags`). The sheets' and the areas' flags are only put on, so a variant never clears one of
them. It returns `project.components` itself when no variant is active and no sheet symbol or area is flagged, and keeps its answer per components array, drawings, sheets, variants and active name, so
switching the variant is never answered with the last one's flags. Every reader of `c.flags`, `c.props` or on-board goes through it (never `resolveVariant` alone: there is no `variantComponents`); the
exports that keep the variants in the files (KiCad 10) use `withRuleAreaFlagsOnly`. Read a new consumer of `c.flags` or `c.props` through it. Operations: `addVariant`, `renameVariant`,
`removeVariant`, `setActiveVariant`, `setVariantOverride` (a rename or remove moves what is keyed by the name); the Inspector sections are in `panels/VariantPanels.tsx`. The importer reads a variant of
a symbol or sheet instance (`read.ts`, `link.ts`, `build.ts` `overridesOf`); `in_bom` in a variant is the exclusion itself before stamp 20260306 and the positive word from it. KiCad 9 and Circuit JSON
have no variants: they are written from the active variant and the notes say so; a project written as KiCad 10 files (a local power symbol) keeps its variants in the instance data (`writeVariants`,
stamp 20260306). Sakura does not know variants. `S9X` (`delegate`, `symbol_override`, `custom_property`, `default_instance`) is refused by name.

**KiCad's joining rules** (`SchematicSheet.kicadRules`, `model/kicadJoin.ts`): the importer builds a sheet again, with the flag and six digits per coordinate, when KiCad and the editor would join
different things (a wire end on a wire's side with no junction, a label on a pin on a wire's side, a point a hair from a wire, two points the editor cannot tell apart). On a flagged sheet
`computeConnectivity` keys points by KiCad's integers of 100 nm, joins a wire's side only through a junction item or a label (a label with a pin at its point skips the wires that pass), and does not
probe wire ends. A point KiCad has on a pin is put where the editor has the pin (`kicad-pins-snapped`), so edits that recompute pins keep the join. `addWire` cuts wires at a T on a flagged sheet;
other edits do not. A sheet with none of these has no flag and its connectivity is untouched (`tests/golden` is the guard). KiCad 5's own differences are `S11L`, refused.
`tests/corpus/sch-joining.test.ts` changes real files to have the cases and compares with the independent oracle.
