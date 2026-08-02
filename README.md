<div align="center">

<img src="public/logo.svg" alt="Cherry Blossom Editor" width="96" />

# Cherry Blossom Editor

### Write a circuit. Get a board.

A browser-based PCB and schematic editor. Describe a circuit as TSX and watch it
render live to a schematic, a PCB canvas, a 3D view, and a BOM — every view a
projection of the same source. Nothing is uploaded, nothing needs an account.

![License](https://img.shields.io/badge/license-AGPL--3.0-e0335e)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Status](https://img.shields.io/badge/status-early%20stage-ff69b4)

</div>

> [!WARNING]
> **Early stage.** The schematic and PCB editors work end to end, but expect
> rough edges and breaking changes.

---

## What's inside

| Surface | What it does |
|---|---|
| **Schematic** | Autolayout and trace solving, rendered from the evaluated circuit, with click-to-select into a properties panel. |
| **PCB canvas** | Pan/zoom, layers, ratsnest airwires, drag-to-place, and an interactive 45° manual router with live clearance checking. |
| **Design rule checks** | Clearance and geometry DRC surfaced in an issues drawer alongside evaluator warnings. |
| **3D view** | Board and component models rendered in the browser. |
| **Code** | Edit the circuit's raw TSX in CodeMirror — every other view updates from it. |
| **Export** | KiCad, BOM CSV, pick-and-place CSV, SPICE, STL, and the app's own JSON project format. |

Projects autosave to `localStorage` and can be saved to or loaded from a
`.cherryblossom.json` file. There is no account system and nothing leaves your
machine.

## Quick start

Requires **Node 24** (see [`.nvmrc`](.nvmrc)).

```bash
npm install
npm run dev          # http://localhost:5173
```

No environment variables, no API keys, no services to provision — a fresh clone
runs as-is.

<details>
<summary><b>Every other script</b></summary>

```bash
npm run build        # typecheck + production bundle into dist/
npm run preview      # serve the production bundle
npm run test         # vitest
npm run lint
npm run typecheck
npm run check        # lint + typecheck + test — run before you open a PR

npm run test:e2e:install   # once: install the Playwright chromium build
npm run test:e2e           # browser suite against the dev server
```

</details>

## How it works

`src/store/circuitStore.ts` holds `tsxCode` as the **single source of truth**.
Components, the netlist, and board config are parsed out of that string on
demand ([`src/utils/tsxTransform.ts`](src/utils/tsxTransform.ts) — Babel +
recast, with a regex fallback) and cached. Undo/redo is a 50-entry ring buffer
over the whole string, not a per-edit journal.

PCB route geometry and hand-placed positions live in a **sidecar** —
`editorStore.manualEdits` — keyed by a stable `key="…"` prop injected into every
component. That indirection is what lets a wholesale rewrite of the TSX keep
your manual routing attached to the right parts.

```
src/
  editor/        canvas, PCB routing + DRC, schematic view, evaluator services
  components/    toolbar, dialogs, shadcn-style ui primitives
  store/         circuitStore (TSX + circuit JSON), settingsStore
  views/         the editor shell and its panels
  utils/         TSX transforms, footprint catalog, KiCad export
server/
  proxy.mjs      same-origin CORS proxy for model and datasheet hosts
```

[`server/proxy.mjs`](server/proxy.mjs) exists because a few upstreams the 3D
viewer and component import need don't send permissive CORS headers. It is
https-only, restricted to an exact-host allowlist, strips identity headers, caps
responses at 16 MiB, holds no credentials, and is mounted as Vite middleware at
`/api/proxy` in dev and preview.

## Contributions

**We're not looking for pull requests right now.** The project is early enough
that the architecture is still moving under our feet, and a PR you spend real
time on may sit unreviewed or get closed because it collides with something
we're already rewriting. We'd rather say that up front than waste your evening.

Bug reports are genuinely useful — open an issue. Found a security problem?
Please don't file it publicly; contact a maintainer directly.

[AGENTS.md](AGENTS.md) documents the architecture and the sharp edges. It
doubles as the instruction file for coding agents (`CLAUDE.md` is a symlink to
it, so Claude Code, Codex, Cursor, and anything else following the `AGENTS.md`
convention all read the same thing).

The license lets you fork freely — if you need a change we won't take, that's
what forking is for.

## License

[GNU Affero General Public License v3.0 or later](LICENSE)
(`AGPL-3.0-or-later`) — OSI-approved open source. Use it commercially, modify
it, redistribute it, build a business on it.

The one obligation: if you distribute a modified version, or **run one as a
network service others interact with**, you have to offer those users the
complete corresponding source of your version under this same license. Keeping
improvements private while serving them to the public is the thing AGPL rules
out.

Using the editor to design boards — including boards you sell — carries no
obligation at all. This governs the editor's own source, not your circuits.

Third-party components keep their own licenses; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

"Cherry Blossom" and the cherry blossom logo are trademarks and are not
licensed — please rename and re-brand forks.

<div align="center">
<br />
Made with 🌸 for the hardware community
</div>
