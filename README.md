<div align="center">

# 🌸 Cherry Blossom

### An AI-first PCB design tool with a modern UI

Cherry Blossom combines a discoverable, Figma-style interface with the depth professional EDA
tools demand — built for hobbyists at home and hardware engineers at work.
Describe a circuit in plain English, drag components onto the board, or do both.

<br />

![Web](https://img.shields.io/badge/Web-Vite%20%2B%20SPA-646CFF?logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![version](https://img.shields.io/github/v/release/cherryblossomhq/releases?label=latest&color=brightgreen)
![Status](https://img.shields.io/badge/status-early%20stage-ff69b4)

</div>

> [!WARNING]
> **Very early stage.** The schematic and PCB editors work end to end, but expect rough edges and breaking changes.

---


## Getting started

Env vars (the WorkOS client id + managed AI URL) come from [Doppler](https://docs.doppler.com/docs/install-cli) — no `.env` files to pass around. Install the CLI, log in, then run `doppler setup` once; it reads the committed `doppler.yaml` and points this repo at the `webapp` project's `prd` config automatically.

```bash
doppler login          # once per machine
doppler setup          # once per clone — auto-configures from doppler.yaml

npm install
npm run dev            # http://localhost:5173 — env injected via `doppler run`

# Production build (dist/)
npm run build:local    # doppler-wrapped local build
npm run preview        # serve the production bundle locally
```

Switch environments with `doppler configure set config dev` (or `dev_personal`). Rotate a value once in the [Doppler dashboard](https://dashboard.doppler.com) and everyone's next run picks it up.

**Hosting (Vercel):** the deployed build runs plain `npm run build` — env vars reach it through the **Doppler → Vercel sync integration** (Doppler dashboard → `webapp` → config → Integrations → Vercel), which mirrors the config into the Vercel project's environment. The `/api/proxy` relay (`server/proxy.mjs`) deploys as the `api/proxy.mjs` function with the SPA rewrite in `vercel.json`; the Vite dev/preview servers mount the same handler locally.

Everything else runs in the browser — add your Anthropic API key in **Settings → AI** to use the design assistant without WorkOS sign-in.

> 💡 Before committing, run `npm run check` (typecheck + tests).

<div align="center">
<br />
Made with 🌸 for the hardware community
</div>
