# Cherry Blossom — Agent Guide

Vendor-neutral guide for any coding agent (Claude Code, Codex, Cursor, Aider, etc.).
`CLAUDE.md` is a symlink to this file — edit here, not there.

---

## Product Context

- **What this is:** A modern, AI-first PCB design tool with a UI that rivals Figma's aesthetic while delivering Altium-level feature power.
- **Who it's for:** Hobbyists building at home + professional hardware engineers.
- **Space:** EDA (Electronic Design Automation) / PCB design.
- **Primary app:** This **private** [`cherryblossomhq/webapp`](https://github.com/cherryblossomhq/webapp) repo contains the current product, hosted at [app.trycherryblossom.com](https://app.trycherryblossom.com). It supersedes the original desktop app.
- **Marketing site & managed API:** The **private** [`cherryblossomhq/website`](https://github.com/cherryblossomhq/website) repo powers [trycherryblossom.com](https://www.trycherryblossom.com): the marketing site, account and billing flows, and the managed API this app calls for authentication-backed account data and AI completions. Plan definitions, model access, quotas, rate limits, and the OpenRouter proxy live there, not in this repo.
- **Legacy desktop app:** The older Tauri v2 app lives in the **private** [`cherryblossomhq/cherryblossom`](https://github.com/cherryblossomhq/cherryblossom) repo. Historical release binaries live in the **public** [`cherryblossomhq/releases`](https://github.com/cherryblossomhq/releases) repo, but the product is now web-only and no downloads are offered.
- **Project type:** Web app — React 19 + TypeScript SPA built with Vite. Fully client-side except one tiny same-origin endpoint, `/api/proxy` (`server/proxy.mjs`), which replays requests to a fixed allowlist of CORS-less upstreams (EasyEDA, the tscircuit model CDN, the LCSC datasheet hosts). In dev/preview the endpoint is a Vite middleware; deployed, it's the Vercel function `api/proxy.mjs`. There is no other backend in this repo.
- **Stage:** Early-stage startup, **not launched yet** — there are no production users. Backward compatibility is **not** a concern: don't add migration shims, compatibility layers, or deprecation cycles to preserve old behavior. Prefer clean, decisive changes. Large breaking changes (data model, file formats, APIs) are welcome when they make the design better.

---

## Build, Run, Test, Release

```bash
npm install              # Install dependencies (first time)
npm run dev              # Vite dev server at http://localhost:5173 (doppler-wrapped)
npm run build            # tsc + production web bundle (dist/) — plain env (Vercel)
npm run build:local      # doppler-wrapped local production build
npm run preview          # Serve the production bundle locally

npm run check            # tsc --noEmit + vitest run  ← run this before committing
npm run typecheck        # tsc --noEmit only
npm run test             # vitest run (unit tests)
npm run test:watch       # vitest watch mode
npm run test:e2e         # Playwright (requires `npm run test:e2e:install` once)
npm run lint             # eslint .
```

### Environment Variables & Secrets

- **Doppler** manages all env vars — no `.env` files, ever. One-time setup: install the [Doppler CLI](https://docs.doppler.com/docs/install-cli), `doppler login`, then `doppler setup` (reads `doppler.yaml` → project **`webapp`**, config `prd` by default).
- **Injection paths:** local `npm run dev` / `npm run build:local` are `doppler run --` wrapped, so `VITE_*` vars flow from the active Doppler config and are **baked into the bundle at build time**. Deployed builds on Vercel run plain `npm run build` — env arrives via the **Doppler → Vercel sync integration** (configured in the Doppler dashboard on the `webapp` project), which mirrors the config into the Vercel project env.
- **Configs** (Doppler project `webapp`): `dev` — staging WorkOS client id + `VITE_MANAGED_AI_URL` pointing at a localhost website checkout; `dev_personal` — per-developer config; `prd` — production values. `doppler.yaml` selects `prd`, so a fresh checkout runs against the live API. Switch with `doppler configure set config dev`.
- The two auth build-time vars travel as a pair: `VITE_WORKOS_CLIENT_ID` (public web-app client id) and `VITE_MANAGED_AI_URL` (managed AI proxy endpoint). A token minted by a staging WorkOS client only validates against a backend running staging — never mix one config's client id with another's proxy URL.
- Analytics uses `VITE_POSTHOG_PROJECT_TOKEN` and `VITE_POSTHOG_HOST`, copied from the website project's corresponding `NEXT_PUBLIC_POSTHOG_*` values so both surfaces report to one PostHog project.
- There are no server-side secrets in this repo: the WorkOS client id is a public identifier, and the `/api/proxy` endpoint holds no credentials.

### Deployment / Versioning

The app deploys like any static SPA + one serverless function (`vercel.json` carries the SPA rewrite): every push to `main` goes live on Vercel. There are no versioned releases, binaries, or release notes — a page reload always serves the latest deploy. The `version` in `package.json` is informational only: it's injected into the bundle as `__APP_VERSION__` (vite.config.ts) and shown in the Settings dialog.

---

## Architecture

### Data Model
- `circuitStore.tsxCode` is the single source of truth for all circuit state.
- Components, connectivity (the `connections` netlist), and board config are parsed on demand from the TSX string via `tsxTransform.ts` and cached. PCB route geometry lives in the editor's `manualEdits` sidecar, not the TSX.
- History is a 50-snapshot ring buffer over the full TSX string — undo/redo swaps the whole string.

### Key Modules
- **`src/store/circuitStore.ts`** — Zustand store owning all circuit state; all mutations go through here.
- **`src/store/chatStore.ts`** — Chat history + streaming state, and the free-running multi-turn AI tool loop (dispatches each tool call, feeds `role: "tool"` results back, applies the final TSX).
- **`src/utils/chatTransport.ts`** — The single seam for every external call the chat loop makes: `streamTurn` (one model turn, browser fetch + SSE parsing), the per-tool HTTP backends, and the model-facing tool definitions (`CHAT_TOOLS`).
- **`src/utils/tsxTransform.ts`** — AST-based TSX read/write using Babel + recast, regex fallback if Babel parse fails; every edit produces a new TSX string.
- **`src/utils/chatSystemPrompt.ts`** — Builds the static system prompt + dynamic circuit context sent to the selected model.
- **`src/utils/easyedaImport.ts`** — Two-stage EasyEDA fetch (search → detail) backing the AI `import_component` tool, routed through `/api/proxy`.
- **`src/utils/datasheets.ts`** — `fetch_datasheet` backend: discovers the datasheet URL via EasyEDA, downloads the PDF through `/api/proxy`, has a plan-allowed helper model (preferring Claude Haiku) extract a structured summary, and caches summaries in localStorage (`listCachedDatasheets` seeds the chat's dynamic context).
- **`src/utils/proxy-fetch.ts`** — Installs a global fetch shim that re-targets `easyeda.com` / `modelcdn.tscircuit.com` requests to `/api/proxy`, plus a direct `proxyFetch(url)` helper for datasheet PDFs.
- **`server/proxy.mjs`** — The `/api/proxy` handler (plain Node `(req, res)` style): https-only, exact-host allowlist, blocked identity headers, 16 MiB response cap. Mounted by a Vite middleware in dev/preview (`vite.config.ts`) and re-exported as the Vercel function `api/proxy.mjs` in production.
- **`src/editor/pcb/drc.ts`** — PCB design-rule checks (run by `usePcbDrc`, surfaced on the PCB tab).

### Transport layer (`src/utils/chatTransport.ts`)
Every external call the AI loop makes is a browser fetch behind one seam. The multi-turn tool loop is **not** here — it runs in `src/store/chatStore.ts`. The transport only does single per-call work:
- `streamTurn({auth, model, system, messages, tools?, thinkingEffort?, sessionId?}, callbacks?)` — streams **one** model turn over SSE and returns the assembled result using OpenRouter Chat Completions semantics (`text`, tool calls, `reasoning.text` / `reasoning.details`, and `finishReason: "stop" | "length" | "tool_calls" | …`). Live non-empty text/thinking deltas fire `onText`/`onThinking`; empty provider deltas are ignored so they cannot split a continuous UI trace. The JS loop calls it repeatedly. `auth` is `{token, url}` (WorkOS access token → the OpenAI-compatible OpenRouter proxy at `/api/v1/chat/completions`). Messages, function definitions, assistant `tool_calls`, and `role: "tool"` results use OpenRouter's OpenAI-compatible schema directly; `reasoning_details` is preserved unchanged and in order through tool rounds. The managed origin is baked in from `VITE_MANAGED_AI_URL`; the client forces the current completions path. HTTP errors reject with `"{status}:{body}"`, mid-stream errors with `"api_error:{msg}"`, and safe diagnostics retain `Retry-After` / `x-generation-id`.
- `searchJlcpcb(query, limit?)` / `lookupFootprint(lcscId?, mpn?)` — direct fetches to `jlcsearch.tscircuit.com` (CORS-enabled), formatted for the model.
- `fetchDatasheet(auth, model, lcscId, mpn?)` — delegates to `src/utils/datasheets.ts`; `model` is the plan-allowed helper model selected by `chatStore` (same `auth` shape as `streamTurn`).
- `import_component` has no HTTP backend of its own — it resolves inline via `easyedaImport.fetchComponentDef`.

Tool-action rows (search / footprint / datasheet / import) are pushed directly by the JS loop as it dispatches each call.

### AI Edit Flow
```
User prompt → chatStore.sendMessage (JS) runs a free-running tool loop:
  repeat: streamTurn (one turn) → if finishReason == tool_calls,
          dispatch each tool in JS (search_jlcpcb / lookup_footprint /
          fetch_datasheet / import_component / edit_tsx / write_tsx) → feed
          one role:"tool" result per tool_call_id
          back → loop, until the model emits answer text (or MAX_TOOL_ROUNDS)
  → prepend any inline-imported component definitions
  → extractComponents(tsx) — structural parse check
  → circuitStore.applyAiEdit(tsx) → setTsxCode → re-extract → UI re-renders
  → background validation cycle surfaces eval/DRC results as a system message
```

---

## Auth & Managed AI (WorkOS)

### Sign-in (web SPA)
- This app is a *public client* — PKCE, no client secret; only the public `VITE_WORKOS_CLIENT_ID` ships in the bundle. Don't reuse the marketing/API site's WorkOS application; this app needs its own (or at least its own redirect URI).
- The flow lives in **`src/utils/authTransport.ts`**: PKCE verifier + CSRF state in sessionStorage → full-page redirect to the AuthKit authorize URL → WorkOS redirects back to `{origin}/callback?code=…` → `authRefresh` (from authStore's launch-time `init`) exchanges the code and cleans the URL. Register `{origin}/callback` (dev: `http://localhost:5173/callback`) on the WorkOS environment's Redirects page.
- The **rotating refresh token** persists in localStorage (scoped per client id). JS holds the short-lived access token in memory only — `src/store/authStore.ts` (session state + scheduled refresh).

### Managed AI
- Signed-in users access AI exclusively through `POST /api/v1/chat/completions`, the website repo's **OpenAI Chat Completions-compatible OpenRouter proxy**, authenticated with the WorkOS access token as `Authorization: Bearer`. It enforces plan/model/rate limits via Convex and passes OpenRouter JSON/SSE through unchanged. The browser client builds the Chat Completions payload and parses OpenRouter's stream; the proxy must allow this app's origin in its CORS policy. Model IDs are canonical OpenRouter IDs from the account plan's `allowedModels` list.
- **Error contract:** proxy errors are `{ "error": { "type", "message" } }`: `401 not_authenticated`, `403 plan_required | model_not_allowed` (surface the server's message — it names the plan/model), `429 rate_limited` (+ `Retry-After`), `400 invalid_request`, or `502 upstream_error`. OpenRouter-originated non-2xx responses pass through and may only provide `error.message` / `error.code`; mid-stream errors can arrive in an HTTP-200 SSE chunk. User-facing mapping lives in `friendlyChatError` (`chatStore.ts`).
- Plans (`free`/`pro`/`enterprise`) and their per-minute/per-day rates + monthly token quotas are defined in the **website repo** (`convex/plans.ts`) — this repo never sees plan logic, only the error types above.

### Analytics (PostHog)
- `src/utils/analytics.ts` initializes the browser SDK when `VITE_POSTHOG_PROJECT_TOKEN` is available. The current defaults capture pageviews, autocapture, web vitals, and exceptions.
- `src/components/PostHogIdentity.tsx` identifies a restored WorkOS user by id/email/name and resets PostHog on sign-out so a shared browser cannot leak identity between users.
- SDK traffic stays first-party at `/ingest`: Vite proxies it during dev/preview, while `vercel.json` supplies equivalent production rewrites. There is no server-side capture.

---

## Conventions & Gotchas

- tscircuit packages update frequently and can introduce breaking changes — check release notes when upgrading.
- `easyedaImport.ts` is a two-stage network call that fails silently on partial API responses; keep its search/detail and partial-response tests current when changing it.
- Drag-and-drop positions stream live via `pendingEditEvents` (preview only) and are baked into TSX props on drop completion — don't read position from live circuit JSON during a drag.
- Chunk size limit is raised to 10 MB in `vite.config.ts` because tscircuit bundles are large.
- Prompt caching requires the static system prompt to stay ≥ 4,096 tokens to activate on Sonnet 4.6.
- TypeScript strict mode is on. Don't introduce `any` without a good reason.
- All circuit mutations go through `circuitStore` actions — never mutate state directly.

---

## Repo-Level Skills

`skills-lock.json` is managed by `npx skills` — a small CLI that pins agent skill files (markdown guides for specific libraries) from GitHub by content hash, so every agent that runs in this repo gets the same version.

To refresh or add skills: `npx skills add <owner>/<repo>` / `npx skills update`. Commit the updated `skills-lock.json`. Don't hand-edit it.

---

## Skill Routing

Only invoke a skill when the user explicitly requests it. If an available skill could be helpful, you may recommend it to the user, but do not invoke it without their approval.

---

## Commit Conventions

- No AI co-author trailers, no "Generated with Claude Code" footers.
- Commit title only by default; add a body only when the change genuinely needs explanation.
- Roadmap and follow-up work lives in GitHub issues, not in tracked `TODO.md` files.
