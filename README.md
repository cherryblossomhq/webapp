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

```bash
npm install
npm run dev            # http://localhost:5173

# Production build (dist/)
npm run build
npm run preview        # serve the production bundle locally
```

Everything runs in the browser out of the box — add your Anthropic API key in **Settings → AI** to use the design assistant. Two optional build-time env vars (see `.env.example`) enable WorkOS sign-in and the managed AI proxy:

- `VITE_WORKOS_CLIENT_ID` — public AuthKit client id; register `{origin}/callback` on the WorkOS environment's Redirects page.
- `VITE_MANAGED_AI_URL` — the managed Anthropic-compatible proxy endpoint paired with that WorkOS environment.

The only server-side piece is `/api/proxy` (`server/proxy.mjs`), a small same-origin relay for the few upstream hosts that don't send CORS headers (EasyEDA, the tscircuit model CDN, LCSC datasheets). The Vite dev/preview servers mount it automatically; on Vercel it deploys as the `api/proxy.mjs` function with the SPA rewrite in `vercel.json`.

> 💡 Before committing, run `npm run check` (typecheck + tests).

<div align="center">
<br />
Made with 🌸 for the hardware community
</div>
