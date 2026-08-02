# Cherry Blossom Editor — Agent Guide

Vendor-neutral guide for any coding agent (Claude Code, Codex, Cursor, Aider, etc.).
`CLAUDE.md` is a symlink to this file — edit here, not there.

Read [`README.md`](README.md) first for what the app is and how to run it. This
file covers the parts that are easy to get wrong.

---

## Build, run, test

```bash
npm install
npm run dev          # Vite dev server on :5173
npm run check        # lint + typecheck + test — run this before committing
npm run build        # tsc && vite build
npm run test:e2e     # Playwright (run test:e2e:install once first)
```

No environment variables. A fresh clone runs as-is.

## Data model

`circuitStore.tsxCode` is the single source of truth for all circuit state.
Everything else is derived:

- Components, the `connections` netlist, and board config are parsed on demand
  from the TSX string by `src/utils/tsxTransform.ts` (Babel + recast, with a
  regex fallback when Babel can't parse) and cached.
- History is a 50-snapshot ring buffer over the **whole TSX string** — undo/redo
  swaps the entire string, it isn't a per-edit journal.
- PCB route geometry and hand-placed positions live in the editor's
  `manualEdits` sidecar (`editorStore`), **not** in the TSX.

All circuit mutations go through `circuitStore` actions. Never mutate state
directly.

### Stable keys are load-bearing

Every component gets a `key="…"` prop injected (`src/editor/shared/keys.ts`).
The sidecar is keyed by it, so it must survive a wholesale rewrite of the TSX —
`applyTsxRewrite` defensively re-injects keys and preserves existing valid ones.
Drop that and manual routing silently reattaches to the wrong parts.

## Responsive layout ("compact" mode)

The editor is a fixed, non-scrolling shell, so a viewport that's too small
doesn't degrade — it hides controls. Two hooks in `src/hooks/useViewport.ts`
drive every adaptation, and the split between them matters:

- **`useIsCompact()`** — the viewport is under `COMPACT_BREAKPOINT` (800px). Use
  it for **layout**: a half-width desktop window is compact too and gets the same
  treatment as a phone. It collapses the toolbar's file actions into a File menu
  and help/theme/settings into an overflow menu; uncollapsed the bar is ~610px of
  non-shrinking content and pushes the settings gear off-screen with no scroll.
- **`useIsTouch()`** — `(pointer: coarse)`: imprecise pointer, no hover. Use it
  for **hit sizing** and to reveal hover-only affordances. Never for layout.

Global rules in `src/index.css` already handle whole classes of problem — don't
re-fix these per component:

- `input/textarea/select` are forced to ≥16px under `(pointer: coarse)`. Any
  smaller and iOS zooms the page on focus and never zooms back out.
- Hover-revealed controls are forced visible under `(hover: none)`.
- `html/body/#root` are `100dvh` (with a `%` fallback) and
  `overscroll-behavior: none`, declared **unlayered** alongside the RunFrame
  shield — `100%` resolves against the layout viewport, which mobile Safari
  doesn't shrink for its URL bar.
- Safe-area insets are applied **once** on the `EditorView` root. Panels inside
  it are already clear of the notch and home indicator; adding their own
  double-pads.

`index.html` carries `viewport-fit=cover` (required for `env()` insets to be
non-zero) and `interactive-widget=resizes-content`.

Compact behaviour has **no browser coverage** — the e2e suite is desktop-only
(`chromium`, and the PCB specs pin their own viewport). Changes below
`COMPACT_BREAKPOINT` need checking by hand in a narrow window.

## Key modules

- **`src/store/circuitStore.ts`** — Zustand store owning circuit state.
- **`src/utils/tsxTransform.ts`** — AST-based TSX read/write; every edit
  produces a new TSX string.
- **`src/editor/services/CircuitEvaluator.ts`** — debounced background eval;
  results carry the hash of the TSX they came from so a stale result can't be
  mistaken for a fresh one.
- **`src/editor/pcb/route*.ts`** — the interactive 45° manual router: graph,
  solver, live preview, clearance, overlay drawing.
- **`src/editor/pcb/drc.ts`** — design-rule checks, run by `usePcbDrc`.
- **`src/utils/proxy-fetch.ts`** — global fetch shim re-targeting the 3D model
  CDN and EasyEDA/LCSC hosts at `/api/proxy`. The allowlist is the one in
  `server/proxy.mjs`; keep the two in sync.
- **`server/proxy.mjs`** — the `/api/proxy` handler: https-only, exact-host
  allowlist, blocked identity headers, 16 MiB response cap. Mounted as Vite
  middleware in dev and preview.

## Gotchas

- Drag-and-drop positions stream live via `pendingEditEvents` (preview only) and
  are baked into TSX props on drop completion — don't read position from live
  circuit JSON during a drag.
- `vite.config.ts` resolves `react` / `react-dom` through `createRequire` rather
  than a hardcoded `./node_modules` path, so a hoisted install resolves one copy.
  Keep it that way.
- The chunk size limit is raised to 10 MB in `vite.config.ts` because the
  circuit-evaluation and 3D bundles are large. That warning is expected, not a
  regression.
- `.npmrc` sets `legacy-peer-deps=true` because the circuit dependency tree
  carries a conflicting `typescript` peer range. Side effect: npm no longer
  auto-installs peers, so **any peer needed at runtime must be declared
  explicitly**. Several dependencies in `package.json` are not imported directly
  by `src/` for exactly this reason — don't "prune" them without checking the
  transitive tree first.
- React is pinned through `overrides` so the whole tree resolves one copy;
  nested dependencies will otherwise pull a second React and hooks break at
  runtime.
- The upstream circuit/EDA packages release frequently and can introduce
  breaking changes. Check their release notes when upgrading, and re-run the PCB
  integration tests.

## Conventions

- TypeScript strict mode. Don't introduce `any` without a good reason.
- Named exports; PascalCase components, camelCase utils.
- Tailwind utility classes, no inline styles. 2-space indent. Mobile-first.
- Commit titles only by default; add a body when the change needs explanation.
- No AI co-author trailers or "Generated with …" footers in commits.
