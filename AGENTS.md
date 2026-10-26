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
  are kept, the AI copilot, supplier part data) is a prop of `App` that the host
  may leave out. `host/main.tsx` is this repo's host, and it leaves all of them
  out (see [The host](#the-host)).
- **The hosted app at trycherryblossom.com mounts the same editor with a
  backend**: accounts with projects in the cloud, Sakura (the AI copilot) on
  managed AI, supplier part data and a parts database. That backend is not part
  of this repository, and nothing here calls it.

The bar is professional EDA, and the aim is to beat it: real Gerbers, checks
that pass, boards that look manufacturable, and an editor that makes the
incumbents feel like old software.

## Commands

```bash
npm install
npm run dev          # the editor on http://localhost:5173
npm run check        # typecheck + unit tests + production build: run before committing
npm run test         # vitest, node environment, tests/
npm run test:e2e     # Playwright, against the dev server (npm run test:e2e:install once)
npm run examples     # rebuild the shipped examples (see below)
npm run build        # production build into dist/, a static site
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

Before finishing a change: `npm run check`, then look at it in a real browser.
Use a GPU-enabled Chromium for the 3D view. There is no lint step.

## Repository layout

```
src/        the editor: model, canvases, panels, exports, the copilot's tools
tests/      unit tests (vitest), with their fixtures
host/       the standalone host: main.tsx mounts App; contract.ts and
            ai-models.ts stand in for two packages of the hosted app
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
| `storage` | Where projects are kept (`ProjectStorage`, `src/store/storage.ts`) | absent: this browser's `localStorage` |
| `modelFiles` | Where added 3D model files are kept (`ModelFileStore`) | absent: this browser's IndexedDB |
| `managedAi` | The session Sakura calls models with (`ManagedAiHost`, `src/ai/managedAi.ts`) | one with no token, so Sakura asks to sign in; signing in opens the hosted app |
| `supplierParts` | Supplier pins, land patterns and models, and the parts index | absent: parts come from the built-in library, and Sakura's from memory |
| `account` | Who is signed in, and the host's projects page | absent: the editor's own dashboard is the home page |
| `initialPrompt` | A request to open a new project with, in Sakura's composer | absent |
| `basePath` | Where the editor is mounted | absent: the site's root |

What that arrangement relies on:

- **`src/` stays host-agnostic.** The hosted app bundles the same source with
  Next.js, so `src/` reads `process.env.NODE_ENV`, never `import.meta.env`
  (`vite.config.ts` defines it), imports nothing from `host/`, and loads its
  workers and WASM through `new URL(..., import.meta.url)`, which both bundlers
  understand.
- **Two packages are stand-ins.** The editor imports types from
  `@cherryblossom/api-contract` (the shapes its host answers in) and one
  function from `@cherryblossom/ai-models` (how the model picker names a
  model). `tsconfig.json`, `vite.config.ts` and `vitest.config.ts` alias both to
  `host/`. Keep the three in step.
- **Client-only.** Every store reads `localStorage` or `location` as it is
  created, and importing `src/index.ts` starts the editor (theme sync, and in
  development the `window.__cherryblossom` hook the browser suite drives).
- **The logo is the host's** `/logo.svg`, from `public/`.
- **Workers are invisible to Vite's dependency scan**, so `optimizeDeps.entries`
  lists them; without it the first STEP file or Tidy in a fresh dev server
  re-optimises mid-request and the worker fails.

## Tests

| Tier | Where | What it's for |
|---|---|---|
| Unit | `tests/` (vitest, node) | The model, routing, pours, checks, Tidy, exports, the project file format, the copilot's tools and loop against a scripted model |
| Browser | `e2e/` (Playwright, Chromium) | The editor bundled and running: the stylesheet, the lazy 3D chunk, the workers and WASM, the examples' JSON, autosave and reload |

The copilot's tests stub `fetch`, so no model and no supplier is ever called:
`tests/copilot-parts.test.ts` scripts a model turn by turn against recorded
supplier answers (`tests/fixtures/supplier/recorded.json`), and
`tests/fixtures/imagePolicy.ts` holds the managed-AI proxy's limits on
pictures, which `src/ai/vision/limits.ts` mirrors. The browser suite stands in
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
  (`group` in `templates.ts`).
- **Schematic**: about 90 library parts (see [Library parts](#library-parts)),
  power and ground ports, orthogonal wires, net labels (on vertical wires they
  run along the wire, so labels on neighbouring pins sit side by side),
  junction dots, rubber-banding when parts move, copy/paste, undo/redo.
  Everything is at KiCad's proportions, with 0.1 for its 50 mil grid: two
  terminal parts are 300 mil from pin to pin, chips have their pins on a
  100 mil pitch, and designators, values, labels and port names are 50 mil.
  The discrete symbols are our own drawings (`model/discreteSymbols.ts`); a
  pin of a shipped one never moves without a file migration, since saved
  projects place parts by their origin and wires end where the pins were.
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
  whole (`move_by`, checked like a drag of its title).
- **Schematic drawings** (`model/drawings.ts`): text, lines, arrows,
  polygons and rectangles, as Altium's drawing tools make, for
  sheet titles, notes, callouts and the boxes that explain a sheet. Graphics
  only: connectivity, checks and the exports never read them, so a line drawn
  from pin to pin connects nothing. Colours are named (`ink`, `gray`, `red`,
  `orange`, `yellow`, `green`, `blue`, `purple`) and drawn in a shade of each
  for the light sheet and another for the dark one (`theme.ts`); a fill is a
  soft tint of one. Lines are thin, medium or thick, solid, dashed or dotted;
  texts have five sizes (small 0.1 to title 0.5), bold, italic, monospace,
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
  edits them by id, and is asked to give a sheet it builds a title and only
  the notes a reader needs. `editor/schematic/drawingPaint.ts` is what both
  the canvas and `look`'s picture draw them with.
- **Tidy** (`model/tidy`, see [Tidy](#tidy-arranging-the-schematic)): the
  schematic redrawn as an engineering sheet, blocks in reading order, from
  the toolbar's broom, `T`, or Sakura's `tidy_schematic`. With one block
  selected it tidies that block where it is. One undo step, and it never
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
  so no placement, drag, rotation or flip moves it), ratsnest, interactive
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
- **Autorouter**: two-layer grid A* with vias and net-aware clearances. Nets can
  have their own trace width (set in the Inspector's net list, e.g. 1 mm for
  motor and battery current), supply nets get wider traces by default,
  connections that can't be made wide (into small pads) fall back to narrower
  ones, pads drop vias into ground pours, and failed nets are retried first.
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
  via keeps its drill clear of every existing via's.
  `route_pcb` says which left-over connections are at fine-pitch pads and what
  was tried, and tells Sakura not to clear and re-route the same layout (the
  router is deterministic); only connections away from fine-pitch pads are
  blamed on room.
- **Copper pours**: board-wide fills per net and layer (Clipper2), with
  clearance to other nets, thermal spokes (2 or 4, square or at 45°, on
  through-hole pads or all pads, or none), minimum-width cleanup and island
  removal. Pours count for connectivity and DRC, and export as
  Gerber regions. Stitching vias tie the top and bottom pours of a net together
  on a 4 to 8 mm grid (wider on bigger boards), away from pads, traces, parts and
  silkscreen; pour islands the grid misses get a via of their own so they aren't
  removed.
- **Checks**: unconnected pins (with no-connect flags for unused pins), unrouted
  connections, shorts, clearance, parts off the board, courtyard overlap, a
  decoupling capacitor more than 3 mm from every supply pin it could serve, and
  against the design rules: trace width, drill size, annular ring, hole to
  hole, copper to the board edge, vias in SMD pads and floating copper. Project
  parts made from memory are warnings ("U3 (TPS61023): pinout and footprint not
  verified against a supplier") and ones a supplier contradicts are errors, and
  a button checks the unverified ones against supplier data (see
  [Project parts](#project-parts)). The Checks panel groups identical findings,
  and a click steps through them.
- **Electrical checks** (`model/erc.ts`, whether the circuit is right rather
  than drawn right): an LED with no series resistor, followed along strings of
  LEDs, diodes and switches to the one they share; a two-pin part with both
  pins on one net; a pin whose label no other pin has. Always warnings, never
  errors. A click selects the part; **Ignore** keeps a false alarm quiet for
  good in `Project.ignoredChecks` (keyed by component id, so a rename keeps
  it), listed under Ignored to restore. Sakura sees them in `run_checks` and
  is told not to try to fix ignored ones.
- **Project, board and design rules** (the Inspector with nothing selected):
  name, description, stats and free-form properties (revision, author...);
  board size, standard thickness, copper weight, finish (ENIG, HASL, lead-free
  HASL, OSP), solder mask and silkscreen as hex colours (green and white by
  default), mounting holes and the stackup; and the rules, grouped as traces,
  clearance, vias and holes, mask and paste, and pours, with fab capability
  classes that set a fab's limits in one step. Every rule is used by routing,
  pours, checks or the Gerbers (`model/rules.ts`). Lengths show in mm or mil.
- **3D view**: procedural models for every library package (chip passives with
  value codes, gull-wing ICs with markings, TO-220, crystals, through-hole and
  SMD electrolytics, tantalums, headers, sockets, screw and pluggable terminal
  blocks, JST and Qwiic housings, USB-C and micro-USB, a barrel jack, microSD,
  a coin cell holder, a relay, a buzzer, WS2812B LEDs, tact and slide
  switches, trimmers, glowing LEDs, the dev boards on their headers (Arduino
  Nano, ESP32 DevKits, D1 Mini, XIAO), a Pico soldered by its castellations,
  bare WROOM modules and an I2C OLED module). The board shows glossy mask over
  copper relief, gold, solder or bare copper pads, plated holes and slots and silkscreen, with
  soft shadows, a studio floor with a mm grid, a view cube, any mask and
  silkscreen colour, the four finishes, open or tented vias, and PNG export.
  **Parts can be drawn with their real 3D model files** (STEP, OBJ, WRL, STL,
  GLB): one the user adds in the Inspector, the supplier's model of the
  part, which parts Sakura builds from an LCSC record get on their own, or
  KiCad's, which KiCad parts from the parts database get. The generated
  bodies are the instant preview and the fallback, read from the package's
  name where the land has one; see
  [Real 3D models](#real-3d-models-and-the-step-export).
- **Export**: RS-274X Gerbers (copper with pours, mask and paste with the rules'
  expansions, silkscreen, edge cuts), Excellon drill (slotted holes, such as
  USB-C shell tabs, as G85 slots), BOM CSV, pick-and-place CSV, fabrication
  notes (the board spec, the smallest features, the rules and the project's
  properties), the project file (re-importable), and, for other tools,
  Circuit JSON (tscircuit) and a KiCad project (see
  [Taking boards to other tools](#taking-boards-to-other-tools)), and the board
  as a STEP assembly for mechanical CAD (from the Export menu or the 3D view's
  toolbar). None of them involves the AI.
- **Light and dark themes**: follows the system setting until you pick one with
  the sun/moon button in the top bar or under Settings.
- **Parts search**: understands values ("10k", "4k7", "100nF", "16 MHz"),
  packages ("0805", "SOT-23"), pin counts ("6 pin header"), part-number
  fragments ("555", "328p"), synonyms ("ldo", "op-amp") and typos. A value or
  package in the query is applied to the part it places, so "10k 0603" places
  a 10k 0603 resistor. In a host that hands the editor a parts source (the
  hosted app does; this build doesn't), under the library's results come the
  parts database's (`panels/IndexResults.tsx`): KiCad's library parts and the supplier records
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
  Sakura.
- **Sakura, the copilot**: adds parts, creates the ones the library doesn't
  have from supplier data (LCSC's catalogue, with EasyEDA's symbols and land
  patterns) or the parts database (KiCad's libraries), wires nets, groups and
  draws on the schematic (blocks, titles, notes, arrows, boxes), lays out,
  pours and routes the board, and runs checks
  through tool calls. It also does the hand work on the PCB: `place_parts`
  moves, turns, flips and locks parts (by millimetres or beside a pin, such as
  "C1 beside U1.VIN within 1 mm", with the gap it reached reported), `set_net_width`
  sets a net's trace width like the Inspector's net list, and `clear_routing`
  deletes copper so it can be routed again (`src/ai/pcbTools.ts`; the search for
  a free spot beside a pin is `model/placeNear.ts`). `get_design` reports each
  part's PCB position, side, rotation and lock. Every change is a separate undo step. It is a panel of its
  own on the left, between the parts library and the canvas. "Sakura" is the
  product's name for it; the code still calls it the copilot. It needs a
  managed-AI session from the host (see [The host](#the-host)): this build has
  none, so the panel shows its sign-in notice and never makes a request.
- **Panels**: the parts library and Sakura on the left, Inspect and Checks on
  the right. Each panel's own header button is the only thing that closes it,
  and a closed panel leaves a tab hanging off that edge of the canvas, in its
  upper half, with an icon and its name written down it ("Parts", "Ask AI") to
  reopen it. There are no panel toggles in the top bar. The library's
  categories fold away from their headings.
- **Project parts**: a part the copilot makes (`create_part`) is stored in the
  project, so it opens the same in any browser and from an exported file. It
  is listed under "This project" in the library and placed like any other.

## Library parts

- **Generic**: resistors, ceramic, electrolytic and tantalum capacitors,
  inductors, trimmers, crystals, diodes, Schottkys, Zeners, LEDs, BJTs and
  MOSFETs, power and ground ports, a battery.
- **ICs and power**: NE555, LM358, ATmega328P (TQFP-32 and DIP-28), ATtiny85,
  74HC595, CH340C, CH340G, ULN2003A, PC817, TB6612FNG, LM7805, AMS1117-3.3 and
  -5.0, AP2112K-3.3, a CR2032 holder, WS2812B.
- **Modules**: Arduino Nano, Raspberry Pi Pico, ESP32-WROOM-32E,
  ESP32-S3-WROOM-1, ESP32-DevKitC, ESP32 DevKit V1, Wemos D1 Mini, Seeed XIAO
  ESP32-C3, a 0.96" I2C OLED.
- **Connectors**: 2.54 mm headers (1x2 to 1x10 male and female, 2x3 ISP, 2x5,
  2x20), DIP-8/14/16/28 IC sockets, screw terminals, Phoenix MKDS 1,5 (5.08 mm)
  and PT 1,5 (3.5 mm) terminal blocks, Phoenix MC 1,5 (3.81 mm) and MSTBA 2,5
  (5.08 mm) pluggable headers, JST PH and XH (2 to 4 pins), Qwiic / STEMMA QT,
  USB-C (USB 2.0, 16 contacts), micro-USB, a 5.5 x 2.1 mm barrel jack, a
  microSD socket.
- **Electromechanical**: tact switches, a slide switch, a 5 V relay, a buzzer.

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
| `W` | wire | `X` | route |
| `L` | net label | `V` | via tool / via while routing |
| `R` | rotate | `R` / `F` | rotate / flip side |
| `/` | flip wire bend | `L` | switch layer |
| `B` | block tool | `W` (routing) | next preferred trace width |
| `⇧T` / `P` | text / line | | |
| `⇧R` | rectangle | | |
| `⌘D` / `⌘C` `⌘V` | duplicate / copy, paste | `/` | flip trace bend |
| `⌘G` / `⇧⌘G` | group as a block / ungroup | | |
| `F` | fit | `F` (nothing selected) | fit board |
| `T` | tidy the sheet, or the selected block | | |

The PCB toolbar also has autoroute and ground-pour buttons (the pour button also
adds stitching vias); the Inspector sets the board, the design rules, pours and
stitching.

Both editors: `Del` deletes, `Esc` cancels, `⌘Z` / `⇧⌘Z` undo/redo, Space-drag
or middle-drag pans, the wheel or a pinch zooms. `[` and `]` show or hide the
parts library and the side panel, and `⌘L` opens or closes Sakura (from
anywhere, its composer included, and it lands in the composer).

## Layout

- `src/index.ts`: the entry a host imports (`host/main.tsx` here) — starts theme sync and, in
  development, exposes `window.__cherryblossom` for driving the editor from
  browser automation.
- `src/model`: document types, design rules and the stackup (`rules.ts`),
  parts library (`library.ts`, with the modules and connectors in
  `partsModules.ts` and `partsConnectors.ts`, built with `partKit.ts`),
  discrete symbols (`discreteSymbols.ts`) and box symbols (`symbols.ts`),
  the footprint adapter, data-defined footprints
  (`footprintLibrary.ts`, `footprintModules.ts`, `footprintConnectors.ts`, on
  `footprintKit.ts`), connectivity, schematic blocks and Tidy (`tidy/`),
  PCB analysis/DRC, copper pours, autorouter, pure editing operations,
  templates and the shipped examples (`examples.ts`, `examples/*.json`).
- `src/editor`: SVG viewport, schematic and PCB editors (the schematic's
  drawings are painted by `schematic/drawingPaint.ts`), canvas palettes
  (`theme.ts`), three.js board (`three/models` holds the procedural part
  models, `three/files` the readers for real model files and their cache).
- `src/pages`: dashboard and editor. What the dashboard does to stored
  projects is `src/store/projectActions.ts`, shared with the hosted
  app's projects page through `src/projects.ts`.
- `src/panels`: the top bar and its account menu, toolbars, inspector, checks, library, copilot,
  settings and export menu.
- `src/export`: Gerber, Excellon, BOM, PnP and zip bundling, and the exits to
  other tools: `circuitJson.ts`, `kicad.ts`, and `step3d.ts` over the STEP
  writer in `step/`.
- `src/ai`: copilot tool schemas and executors (`tools.ts`; the part tools in
  `partTools.ts`, the drawing tools in `drawingTools.ts`, name lookups in
  `partLookup.ts` and in the parts database in `databaseLookup.ts`, what
  every tool is made of in `toolKit.ts`), the agent loop, `managedAi.ts`, the only code that talks to
  `/api/v1` for models, and `supplierParts.ts`, the host's parts source.
- `src/model/kicad`: KiCad's symbol and footprint files as parts:
  the S-expression reader (`sexpr.ts`), symbols (`symbol.ts`), footprints as
  lands (`footprint.ts`) and the two paired pin for pad, with the reason when
  they can't be (`convert.ts`). `library.ts` walks a library directory for the
  tests. The parts database runs it when it is filled, so the editor never
  converts a KiCad file itself; `model/indexPart.ts` builds a project part from
  what the database stores.
- `src/model/supplier`: supplier part data in the editor's terms: pin roles
  (`roles.ts`), the pin map and land comparisons (`pinmap.ts`, `land.ts`),
  footprint names that draw another package (`footprintGuard.ts`), building a
  part's pins and land from a record (`build.ts`) and checking a drawing
  against one (`verify.ts`). `model/partChecks.ts` is what Checks says about
  project parts.
- `src/store`: zustand stores (project with history and autosave, UI state,
  theme), memoised analysis, the storage interface and this browser's
  implementation of it (`storage.ts`), and browser settings (`settings.ts`).
- `src/model/projectFile.ts`: the project file format, its migrations and the
  tolerant reader (`normalizeProject`).

## Not included yet

Real-time multiplayer, simulation, hierarchical sheets, custom pour outlines,
schematic drawings in the KiCad and Circuit JSON exports (and arcs, curves and
pictures among the drawings), boards with more than two layers, blind and buried vias, net classes beyond
per-net trace widths (per-net clearance), rip-up of existing
traces during autorouting, dragging a database or supplier part onto the
canvas (click or Enter), version history of a
project, sharing, and product analytics. For 3D: checks against the real
models (part heights, parts that collide, a model that doesn't sit on its
pads), copper, mask and silkscreen as layers of the STEP export, 3D models in
the KiCad export, model files inside a downloaded project file, and a model for
a package that has no model file (those draw as a body read from the package's
name, or the footprint's).

## Projects: storage and the file format

**Storage is the host's.** `App` takes a `ProjectStorage`
(`src/store/storage.ts`): a live list, `load`, `create`, `save` and `remove`.
The hosted app's keeps projects in the signed-in account; without one the
editor uses `browserProjectStorage`, this browser's `localStorage`, which is
what this build and the tests run on. Storage moves text and summaries and never parses
a project.

**The format is `model/projectFile.ts`**, one format for the account, the
browser and a downloaded file:

```json
{ "format": "cherryblossom.project", "version": 2, "project": { "name": "…", "components": [], … } }
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
- **Writing** (`serializeProject`) always writes the current version, so a
  project is upgraded the first time it is saved after a format change.

**To change the format**, bump `PROJECT_FILE_VERSION` and add the migration from
the previous one — plain JSON in and out, importing nothing from the live
model, since it describes a format as it was — with a document of the old
version in `tests/project-file.test.ts`. A new optional field that
`normalizeProject` can default needs no bump; a rename, a move, or a new unit
or meaning does. Never change or remove a shipped migration: stored projects and
files stay at whatever version wrote them until they are next saved.

**Saving** is autosave, in `store/projectStore.ts`: 600 ms after edits pause,
one save at a time, each naming the revision it was made from. A stale revision
is refused (`conflict`, two tabs or computers on one project), and so is an
older format over a newer one (`outdated`), a project gone elsewhere
(`not_found`) and one over the size cap (`too_large`, about 900 KB in an
account; the examples are 8 to 60 KB). Refusals stop autosave until the user
answers in the top bar ("Keep mine" saves over the other copy); a save that
doesn't arrive is retried with backoff. A drag in progress is never saved, and
a tab closed with a save pending asks before leaving.

**Projects from before accounts.** On the first visit with account storage,
`moveBrowserProjects` uploads every project left in `localStorage`, in the
current format with its dates, and deletes each from the browser only once it
has landed. One it can't read is left where it is.

## Project parts

`model/customParts.ts`. The library has the generic parts and the common
specific ones (see [Library parts](#library-parts)); anything else (an LDO by
part number, a sensor, an odd connector) is a *project part*: a
`CustomPartSpec` stored in the project (`Project.parts`), so it opens the same
in any browser and from an exported file. `normalizeProject` drops one that no
longer builds.

- **Where they come from.** Sakura's `create_part` builds one from a supplier
  record when the host provides supplier data (`model/supplierPart.ts`, over
  `model/supplier/build.ts`), and from the pinout it remembers only when none
  does. A part picked from the parts index is built by `model/indexPart.ts`.
  Each says where it came from (`source` on the spec), and the Inspector shows
  the credit.
- **Checked, never trusted.** A part made from memory is a warning in Checks
  ("pinout and footprint not verified against a supplier"), and one a supplier
  contradicts is an error (`model/partChecks.ts`, `model/supplier/verify.ts`).
  A pin's role is read from its name (`model/supplier/roles.ts`), and a land is
  compared with the supplier's pad by pad (`model/supplier/land.ts`).
- **Without a supplier source**, as here, the copilot's parts are made from
  memory and marked unverified, and the library panel offers only the built-in
  library.

## Schematic edits by the copilot

Sakura's tools (`src/ai/tools.ts`) may not join nets nobody asked to join. Pins join through wire ends, labels and names (`model/connectivity.ts`), so a wire or label that lands on another net is a short, and none of the tools may draw one or leave one behind.

- **`model/merges.ts`** compares the nets before and after an edit (`unrequestedMerges`): a net may join another only when the call named it (the pins it was given, the net it was told to name). Pins, wires and labels all count, so a stray label's name appearing on a net is reported, and so is a new name clash. `pinsUnderOtherNets` finds pins left under another net's wire, which look connected. `connectionsLost` finds pins an edit cut loose.
- **`connect`** (`model/attach.ts`) judges each way of drawing against an index of the sheet instead of recomputing connectivity: a drawn wire for two pins, then labels. A label is tried as a straight stub (0.3, 0.5, 0.9), bent, and last on the pin itself. Nothing may touch the 0.3 in front of another pin (`PIN_CORRIDOR`), so no wire leaves a neighbour without a way out. The result is checked once more with the full connectivity. Pins that cannot be reached are left out and named with what is in the way; the rest are connected (`Partly connected: ...`). If fewer than two pins (one with `net_name`) can be connected nothing changes. The reply offers a spot for the blocked part only after trying it.
- **`update_component`** checks every move, turn and power port rail against the same rules and refuses (changing nothing) with the pins and nets, and a spot or turn that was tried (`model/spots.ts`). What hangs off a part's pins and is nobody else's moves and turns with it (`partFollowers` in `model/ops.ts`): the drawing is cut into fragments of wires, labels and power symbols that touch, and a fragment that reaches the part's pins and no other part's goes whole (a stub to a net label, a symbol on a pin, a comb joining supply pins with a tee to a symbol). Wires that reach other parts stretch (moves) or follow the pin (turns), and wires that end on a wire that moves follow it. Whatever sat on a wire that was reshaped and is no longer on it (a net label in the middle of the wire, the end of a wire that tees into it) is put back on the net (`reseat` in `model/ops.ts`, inside `moveSchematicItems` and `rotateComponent`, so a canvas drag gets it too): on the same run of the wire when it can, only where it touches nothing of another net, never pulling a wire end off a pin that stays, and when it cannot move (it is still held by another wire it crossed, or sits on a pin) with a short wire from it to the wire it lost. A wire stretched into a hook or a doubled-back spur is simplified first, so a label on the spur is reseated rather than left floating. A pin that touched another part's pin directly, with no wire between them to stretch (a power symbol set right on a pin, as Tidy draws them, or two parts pin to pin), gets a short wire to the pin that stayed (`bridgePinContacts`, in the same two functions), as KiCad's drag does, so neither is stuck; a wire that would land on another net is refused like any other. Fragments, an index of the sheet and its connectivity are built once per sheet, so a drag frame is under a millisecond. A move or turn that would still cut a pin off its net, or take a name (a label, a power symbol) off it, is refused like a join is (`pinsCutOff` in `model/merges.ts`, one check with the joins in `moveProblems`), naming the pins, each pin once: a pin already named among the nets it would join is not named again as cut. Dragging a part on the canvas carries and reseats the same things (`dragPlan`, used by `SchematicEditor.tsx`), and is checked when it is dropped (below).
- **The canvas has the same rules, by hand** (`model/schematicEdit.ts`). The R key, the Inspector's rotate button, a drag's drop, paste and duplicate, and placing a part (click or drag from the library) are built with the carrier above and checked with `moveProblems`, then returned or refused with a sentence that says what to do (`CanvasNotice`, `uiApi().showNotice`) and nothing changed. Drawing is not refused: only two nets that each already stand for something (they have a name, or hold 2+ pins) joined, a pin cut off its net, or a pin left lying on another net's wire (`lenient` in `unrequestedMerges`). A symbol dropped on a pin or a wire end, a label naming an unnamed wire, a pin meeting a loose wire, all go through; so does a two-pin part dropped with both pins on the middle of a wire, which cuts the wire at its pins and runs the net through it (`spliceInline`; with anything else touching that stretch it is refused with "cut the wire first"). A single part whose quarter turn is blocked goes to the next position that is not and says so. The check takes the store's memoised `getConnectivity` for the sheet it started from (`Guard.conn`) and computes the result once. `tests/net-rules.ts` writes the rules out for `tests/schematic-edit-fuzz.test.ts` and `tests/examples-turns.test.ts`; `tests/schematic-edit-speed.test.ts` holds a drop and a turn to a time on a 315 part sheet.
- **`add_component`** with x/y, **`create_part`** with `replaces` and **`remove_component`** are checked too; removing a part says which pins it cut loose.
- **Names `connect` makes up** (`NETn`) are renamed when their net is joined under another name, and never count as a name clash.
- **The tests**: `tests/connect-shorts.test.ts` and `tests/schematic-edits.test.ts` pin the cases. `tests/connect-fuzz.test.ts` runs random designs through every tool with an oracle (`tests/schematic-fuzz.ts`); set `FUZZ_DESIGNS=300` for the full run. `tests/sakura-move-drops-connections.test.ts` and `tests/sakura-session-fuzz.test.ts` replay a Sakura session in which a move cut a BME280's supply pins loose, and `tests/tidied-move-fuzz.test.ts` moves and turns random parts on sheets drawn the way Tidy draws them (`tests/tidy-shapes.ts`): each call keeps every pin on its net, or is refused and changes nothing (`FUZZ_SHEETS=200` for more). `tests/drag-keeps-nets.test.ts` pins drags that used to cut a net, and `tests/examples-moves.test.ts` drags every part of every example 18 ways (the shipped ones and the ones drawn before Tidy, `tests/frozen-examples.ts`; rates such as fewer than 5% refused are held on the latter only, since a tidied sheet packs parts closer and a big jump lands on a neighbour, which is refused as it should be), and none is left out of the count: each drop keeps the netlist, connects only by the lenient rule, or is refused with the sheet untouched (the drops an unchecked drag would have broken are the refused ones), and fewer than 5% of nudges by update_component are refused. `tests/reseat.test.ts` holds `reseat` to doing no harm of its own on hand-drawn sheets.

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
empty, else the blocks it added or changed parts in.

- **Between blocks** (`flow.ts`): reading order by signal flow, from the nets
  and the parts on them: the connector on the highest supply first, then
  regulation, the controller (the chip with the most pins), the chips it talks
  to, then connectors and indicators, then test points. Frames go in rows with
  even gutters, the row width chosen for a compact, landscape sheet; a short
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
  cluster. The clusters of a block are packed like frames on the sheet, nets
  between them labelled.
- **About a part** (`block.ts`): the main part first, then decoupling
  capacitors in rows above it (upright, supply port on top, ground below),
  chains on neighbouring pins (an LED and its resistor) fanned out into
  columns, then parts across two of its pins (a crystal), and then each other
  part at the cheapest spot near what it connects to, a two-pin part on a port
  upright where it can be, every spot tried for real: drawn, wired (`route.ts`, A* on the 0.1 grid
  with a cost per bend) and given room for its labels and ports, and refused if
  anything would touch anything else (`space.ts`). Supplies get power and
  ground ports at their pins, except a supply the block wires, which gets one
  port per wired piece; a net that leaves the cluster, has a name, or couldn't
  be wired whole gets a label, reading across (its stub turns off a pin on the
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
  (`U1_XTAL1`, or the editor's `Net-(R1-2)`) counts for nothing; only names
  someone else gave do (`TidyNet.given`). So a second tidy, which finds those
  names drawn, makes every choice the first one did.
- **Names**: an unnamed net that needs a label is named after its most telling
  pin (`U1_OUT`), as the tscircuit importer names them, and a pour, stitching
  via or trace width follows it to its new name. A named net keeps the name it
  goes by, and every other name it had (a 5V label and a VCC port) is drawn as
  a label of its own, so the merge stays visible in Checks: beside the net's
  label where it fits, else on another of its pins or its wires once the sheet
  is drawn (`room.ts`), never on wire that reaches no part (stowed below the
  blocks, it would move with that wire next time). A name with no room anywhere
  is left out and the message says so; it never stops the rest of the sheet
  being tidied.
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
  design in under a second. `tests/tidy-metrics.ts` measures all of it from a
  project alone.

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

The 3D view's generated bodies (`three/models`) are built from a footprint and
a part alone, so they are there the moment the view opens, for any part. They
are a likeness. **A real model file is the truth**: where a part has one, the
3D view draws it once it is read, and the STEP export writes it.

### In the document

- **A model belongs to a part on a footprint** (`Project.models`, a list of
  `ModelAssignment`; `model/models3d.ts`), as a KiCad footprint carries its
  model: every component of that part on that footprint is drawn with it. An
  optional field, so no format version; `normalizeModels` drops a malformed
  entry. Paste copies a part's model with it (`withModelsFrom`).
- **A `Model3D` names a file and says where it sits**: `source` `file` (one the
  user added, by the SHA-256 of its bytes), `supplier` (the supplier's model,
  by its id) or `kicad` (a STEP file in KiCad's 3D library, by
  `<release>/<path>`, through `PartsIndexSource.model`; `format` is always
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
  megabytes and a project may hold about 900 KB. The host gives `App` a
  `ModelFileStore` (`store/modelFiles.ts`: `put` and `get` by hash; the
  hosted app's keeps them in the account, this build's in this browser's
  IndexedDB), and supplier files come through `SupplierPartsSource.model(id,
  "obj" | "step")`. A project file
  downloaded and opened on another account names files that account doesn't
  have: those parts show their generated bodies, and the status line says why.

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
  leaves no model rather than a wrong one. A stored supplier record gets
  `supplierModel`, or, when its land was swapped for a footprinter name, the
  model moved with the pads (`supplierModelOnLand`), or none if they don't
  match. Only a part newly added gets a model: one the project already has
  keeps what the user chose for it, the generated body included. KiCad model
  ids follow one rule (`model/supplier/kicadModel.ts`).
- **The Inspector's 3D model section** (`panels/ModelSection.tsx`): add a file
  (STEP, OBJ, WRL, STL or GLB, 40 MB at most; read before it is kept, so a
  file that doesn't read is neither stored nor assigned), take the supplier
  model of the part's LCSC number, or search the supplier for one (a library
  part on `0603` can take a real chip model this way); edit the placement; or
  go back to the generated body. A file placed by its own origin that lands off
  its footprint (a manufacturer's model drawn about some other point) is
  centred on the footprint instead.

### Drawing them

- `three/files/library.ts` reads each file once for the page and every part
  is a copy sharing its geometry (`userData.shared`, which `disposeGeometries`
  leaves alone). `BoardScene` draws generated bodies first and swaps in each
  real model as its file is read (`refreshModels`), without rebuilding the
  board. The toolbar's Boxes button turns real models off (a browser setting,
  `realModels`), and a status line counts files loading and names ones that
  failed, with Retry. Sakura's `look` at the 3D board waits up to 4 s for them.
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
- **Bodies from a package's name** (`three/models/translate.ts`, `plan.ts`):
  the generated body of a part whose land has a package name
  (`FootprintDef.package`, set for supplier and KiCad lands) is read from the
  name first: chips by code with the role from the name's prefix,
  SOT/SOD/SMA/SMB/SMC, SO/SSOP/TSSOP/MSOP/QFP, QFN/DFN/SON, BGA/CSP/LGA, DIP,
  TO-220/92/252/263, vertical 2.54 mm headers and sockets, JST PH/XH/EH, with
  the body size from the name (`3.9x4.9mm`, or a supplier's `L4.9-W3.9`),
  never the category default a project part's `body3d` holds; SOICs 7.5 mm
  wide are 2.65 mm tall and 5.3 mm ones 2.05, plastic QFPs 2.7, SOT-523s
  0.8 mm wide; TO-220 and TO-92 bodies turned along their pad row; and
  exposed pads drawn as plates, not leads. Things that look like these but
  aren't (TO-247, TO-92 lying flat, PowerPAK, horizontal or SMD headers, DIP
  sockets) and any name it doesn't know fall through to the footprint rules.
  `model/partPackage.ts` reads the package when drawing, so parts placed
  before get it too, and only on the part's own footprint: one switched to
  another footprint is drawn by that footprint's rules. Library parts have no package and draw as
  before (`tests/library-models.test.ts`).
- **EasyEDA's placement rule** was checked against through-hole pins: turn the
  model by its `c_rotation` about its bounding box's centre, then put that
  centre on the centre of the model outline the record draws, and its bottom at
  `z`. On the XH-3A the pin tails land on the holes to 0.00 mm. (`c_origin` is
  sometimes nonsense: -861 mm on an SOT-23.)

### The STEP export (`export/step3d.ts`, `export/step/`)

The board and every placed part as one AP214 assembly, for mechanical CAD:
from the Export menu, or the 3D view's toolbar.

- **What each part is in the file** (`step3d.ts`): its real model where it has
  one (a supplier's STEP fetched for the export, or the STEP file the user
  added, copied whole and exact; a mesh file as its mesh), else its generated
  body, faceted. A model file that can't be read is written as the generated
  body, and a STEP file that can't be fetched (a supplier's over the rate
  limit, say) as the mesh the 3D view drew; the export's notes say which parts.
  Every part written as its generated body is listed in one note ("12 parts
  are approximate bodies, not their real models: R1, R2, ... and 4 more"),
  twelve designators at most, so nobody takes a guessed height for a real one. Each distinct model is written
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
    surfaces, all with `POLY_LOOP` faces. About 175 bytes a triangle: the ESP32
    robot example, all generated bodies, is 23 MB, most of it the DevKit's 82k
    triangles.
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
is how the boards of the tscircuit editor `/app` used to be came across in
October 2026; the export is the way out
for someone who wants to leave, or to use another tool beside this one. Both
return `notes`, in sentences, for what did not carry over, and the export menu
shows the exporter's under "What does not carry over".

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
them, so they are in this package's `package.json`): about 4 MB of JavaScript
that no one editing a board downloads.

- The converter draws a schematic unit as 15 mm and ours is 12.7 mm (ten of
  KiCad's 50 mil), so the schematic is scaled by 12.7 / 15 first, which puts
  every pin on KiCad's grid exactly.
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
  design rules, default sizes and per-net widths (as net classes) in the
  `.kicad_pro`, each pour's clearance, thinnest neck and thermal gap and
  bridge, the mask and paste openings, and the project's name, revision,
  company, description and properties in the title block and the project's text
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
- **Copper** on the two outer layers comes across: traces, vias and pours of
  a net. A board routed on four layers comes across unrouted.
- What didn't come across as it was is returned as `notes`, in sentences.
