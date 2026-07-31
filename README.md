# Cherry Blossom Editor

A browser-based PCB and schematic editor. Circuits are described as TSX and
rendered live to a schematic, a PCB canvas, a 3D view, and a BOM — everything
runs client-side.

Built on [tscircuit](https://github.com/tscircuit/tscircuit).

![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue)

## What's in here

- **Schematic view** — tscircuit's autolayout + trace solver, rendered read-only
  from the evaluated circuit, with click-to-select into a properties panel.
- **PCB canvas** — pan/zoom, layers, ratsnest airwires, drag-to-place, and an
  interactive 45° manual router with live clearance checking.
- **Design rule checks** — clearance and geometry DRC surfaced in an issues
  drawer alongside evaluator warnings.
- **3D view** — board and component models via `@tscircuit/3d-viewer`.
- **Code tab** — edit the circuit's raw TSX with CodeMirror; every other view is
  a projection of it.
- **Export** — KiCad, BOM CSV, pick-and-place CSV, SPICE, STL, and the app's own
  JSON project format.

Projects autosave to `localStorage` and can be saved to / loaded from a
`.cherryblossom.json` file. There is no account system and nothing is uploaded.

## Running it

Requires Node 24 (see `.nvmrc`).

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts:

```bash
npm run build        # typecheck + production bundle into dist/
npm run preview      # serve the production bundle
npm run test         # vitest
npm run lint
npm run typecheck
npm run check        # lint + typecheck + test

npm run test:e2e:install   # once: install the Playwright chromium build
npm run test:e2e           # browser suite against the dev server
```

No environment variables or secrets are needed — a fresh clone runs as-is.

## Architecture

`src/store/circuitStore.ts` holds `tsxCode` as the single source of truth.
Components, the netlist, and board config are parsed out of that string on
demand (`src/utils/tsxTransform.ts`, Babel + recast with a regex fallback) and
cached. Undo/redo is a 50-entry ring buffer over the whole string.

PCB route geometry and hand-placed positions live in a **sidecar** —
`editorStore.manualEdits` — keyed by a stable `key="…"` prop injected into every
component. That indirection is what lets a wholesale TSX rewrite keep your
manual routing attached to the right parts.

```
src/
  editor/        canvas, PCB routing + DRC, schematic view, evaluator services
  components/    toolbar, dialogs, shadcn-style ui primitives
  store/         circuitStore (TSX + circuit JSON), settingsStore
  utils/         TSX transforms, footprint catalog, KiCad export
server/proxy.mjs same-origin CORS proxy for the tscircuit model CDN and
                 EasyEDA/LCSC datasheet hosts (allowlisted, https-only)
```

`server/proxy.mjs` exists because a few upstreams the 3D viewer and component
import need don't send permissive CORS headers. It's mounted as Vite middleware
at `/api/proxy` in dev and preview, is plain Node `(req, res)`, and holds no
credentials.

## Contributing

Issues and pull requests are welcome — please run `npm run check` before
opening one. Contributions are accepted under the project license (AGPL-3.0).

The tscircuit packages this depends on move fast and occasionally ship breaking
changes — check their release notes before bumping. React is pinned through
`overrides` so the whole tree resolves one copy; nested tscircuit dependencies
will otherwise pull a second one and hooks will break at runtime.

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`)
— OSI-approved open source. Use it commercially, modify it, redistribute it,
build a business on it.

The one obligation: if you distribute a modified version, or **run one as a
network service others interact with**, you have to offer those users the
complete corresponding source of your version under this same license. Keeping
improvements private while serving them to the public is the thing AGPL rules
out.

Using the editor to design boards — including boards you sell — carries no
obligation at all. This governs the editor's own source, not your circuits.

Third-party components keep their own licenses; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

"Cherry Blossom" and the cherry blossom logo are trademarks and are not licensed
— please rename and re-brand forks.

```
Copyright (C) 2026 Cherry Blossom

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.
```
