# Managed Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in users choose any managed model allowed by `GET /api/v1/me` from a compact selector in the chat header, while keeping BYOK behavior unchanged.

**Architecture:** A typed account transport owns the HTTP contract, and a focused Zustand store owns the last good account snapshot plus a persisted selected model. A top-level lifecycle hook synchronizes that store with WorkOS auth, while chat snapshots the selected canonical model once per send and the header selector subscribes only to the account fields it renders.

**Tech Stack:** React 19, TypeScript, Zustand, Radix dropdown primitives, Vitest, React Testing Library.

---

### Task 1: Account API transport

**Files:**
- Create: `src/utils/accountApi.ts`
- Test: `src/utils/accountApi.test.ts`

- [ ] **Step 1: Write failing transport tests**

Cover the absolute `/api/v1/me` URL, bearer and accept headers, `cache: "no-store"`, no credentials option, complete success parsing, typed JSON errors, malformed successful payloads, and non-JSON failures.

```ts
expect(fetchMock).toHaveBeenCalledWith(
  "https://example.test/api/v1/me",
  expect.objectContaining({
    method: "GET",
    headers: {
      authorization: "Bearer token",
      accept: "application/json",
    },
    cache: "no-store",
  }),
);
expect(init).not.toHaveProperty("credentials");
```

- [ ] **Step 2: Verify the tests fail for the missing module**

Run: `npm test -- src/utils/accountApi.test.ts`

Expected: FAIL because `./accountApi` does not exist.

- [ ] **Step 3: Implement the typed transport**

Define `MeResponse`, `AccountApiError`, `MANAGED_ACCOUNT_URL`, and `fetchMe(accessToken, signal?)`. Validate the user ID, plan tier/name/managed flag/model array, numeric limit and usage fields, nullable reset timestamps, and unlimited flag before returning.

```ts
const base = configured ?? "https://www.trycherryblossom.com";
export const MANAGED_ACCOUNT_URL = new URL("/api/v1/me", base).toString();

export async function fetchMe(token: string, signal?: AbortSignal) {
  const response = await fetch(MANAGED_ACCOUNT_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw accountError(response.status, body);
  return parseMeResponse(body);
}
```

- [ ] **Step 4: Verify transport tests pass**

Run: `npm test -- src/utils/accountApi.test.ts`

Expected: PASS.

### Task 2: Single-flight forced auth refresh

**Files:**
- Modify: `src/store/authStore.ts`
- Test: `src/store/authStore.test.ts`

- [ ] **Step 1: Write failing auth-store tests**

Mock `authTransport` before importing the store. Verify concurrent `refresh()` calls invoke `authRefresh()` once and return the same restored session, rejected refreshes preserve an existing signed-in session, and sign-out prevents an older in-flight refresh from resurrecting it.

```ts
const [first, second] = [
  useAuthStore.getState().refresh(),
  useAuthStore.getState().refresh(),
];
expect(authRefresh).toHaveBeenCalledTimes(1);
await expect(Promise.all([first, second])).resolves.toHaveLength(2);
```

- [ ] **Step 2: Verify the tests fail because `refresh` is absent**

Run: `npm test -- src/store/authStore.test.ts`

Expected: FAIL with `refresh is not a function` or the corresponding type error.

- [ ] **Step 3: Refactor every token refresh through one shared promise**

Expose `refresh(): Promise<AuthSession | null>` from `AuthState`. Replace the separate init/scheduled paths with one module-level `refreshPromise`, keep the `sessionEpoch` guard, apply successful sessions once, and preserve signed-in state on transient errors. The scheduled timer may log and reschedule, while explicit callers receive the rejection.

```ts
let refreshPromise: Promise<AuthSession | null> | null = null;

function refreshSession(): Promise<AuthSession | null> {
  refreshPromise ??= performRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}
```

- [ ] **Step 4: Verify auth-store tests pass**

Run: `npm test -- src/store/authStore.test.ts`

Expected: PASS.

### Task 3: Managed account state

**Files:**
- Create: `src/store/accountStore.ts`
- Test: `src/store/accountStore.test.ts`

- [ ] **Step 1: Write failing account-store tests**

Mock `fetchMe` and auth state. Cover one in-flight request for concurrent loads, persisted selection retention, Opus preference, first-model fallback, empty/disabled plans, transient-error retention, stale result rejection after `clear()`, a single 401 refresh and retry with the new token, and sign-out after a second 401.

```ts
useAccountStore.getState().setSelectedModel("anthropic/claude-sonnet-5");
await useAccountStore.getState().load();
expect(useAccountStore.getState().selectedModel).toBe(
  "anthropic/claude-sonnet-5",
);
```

- [ ] **Step 2: Verify the tests fail for the missing store**

Run: `npm test -- src/store/accountStore.test.ts`

Expected: FAIL because `./accountStore` does not exist.

- [ ] **Step 3: Implement the focused store**

Keep `account`, `accountUserId`, `status`, `error`, and `selectedModel`, with `load`, `refresh`, `setSelectedModel`, and `clear`. Persist only the selection under `cherryblossom:managed-model`; keep the last good response on refresh failures; use one module-level in-flight promise and an epoch to reject stale completion writes.

```ts
function reconcileModel(models: string[], selected: string | null) {
  if (selected && models.includes(selected)) return selected;
  if (models.includes(DEFAULT_MANAGED_MODEL)) return DEFAULT_MANAGED_MODEL;
  return models[0] ?? null;
}
```

For a 401, call `useAuthStore.getState().refresh()` once and retry with the current token. If the retry is also 401, call `signOut()` and reject while preserving any last good account snapshot until the lifecycle clears it.

- [ ] **Step 4: Verify account-store tests pass**

Run: `npm test -- src/store/accountStore.test.ts`

Expected: PASS.

### Task 4: Chat model propagation

**Files:**
- Modify: `src/utils/chatTransport.ts`
- Modify: `src/utils/chatTransport.test.ts`
- Modify: `src/store/chatStore.ts`
- Modify: `src/store/chatStore.test.ts`

- [ ] **Step 1: Change the transport expectation to Anthropic Opus and verify red**

```ts
expect(managedModelId("claude-opus-4-8")).toBe(
  "anthropic/claude-opus-4.8",
);
```

Run: `npm test -- src/utils/chatTransport.test.ts`

Expected: FAIL because the current mapping returns `tencent/hy3:free`.

- [ ] **Step 2: Remove the Tencent override and verify green**

Map native Opus to `anthropic/claude-opus-4.8`; canonical IDs continue passing through unchanged.

Run: `npm test -- src/utils/chatTransport.test.ts`

Expected: PASS.

- [ ] **Step 3: Write failing chat-store model tests**

Initialize account mode with an allowed selected model. Make the first turn call a tool and the second finish, then assert every design call uses the selected canonical ID even if the store selection changes between rounds. Assert BYOK still uses `claude-opus-4-8`, and managed mode with no selected model returns `no_managed_model` without invoking transport.

```ts
const models = mockInvoke.mock.calls
  .filter(([kind]) => kind === "chat_stream_turn")
  .map(([, args]) => (args as { model: string }).model);
expect(models).toEqual([
  "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5",
]);
```

- [ ] **Step 4: Verify chat-store tests fail on the fixed model**

Run: `npm test -- src/store/chatStore.test.ts`

Expected: FAIL because design turns still use native Opus.

- [ ] **Step 5: Snapshot the managed model once per send**

At the start of `sendMessage`, read `useAccountStore.getState().selectedModel` only for account mode. Keep native Opus for BYOK, use the snapshot in every design loop iteration, and add the `no_managed_model` guard before adding the user message.

- [ ] **Step 6: Verify chat-store tests pass**

Run: `npm test -- src/store/chatStore.test.ts`

Expected: PASS.

### Task 5: Auth/account lifecycle and readiness

**Files:**
- Create: `src/hooks/useManagedAccountLifecycle.ts`
- Create: `src/hooks/useAiReady.test.tsx`
- Modify: `src/hooks/useAiReady.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write failing readiness tests**

Render a tiny probe that calls `useAiReady()`. Verify account mode is pending during auth restore and initial account loading, ready only with a selected allowed model, and unavailable with account/plan copy for an empty model list or load error. Verify API-key readiness stays unchanged.

- [ ] **Step 2: Verify readiness tests fail**

Run: `npm test -- src/hooks/useAiReady.test.tsx`

Expected: FAIL because readiness currently considers sign-in alone sufficient.

- [ ] **Step 3: Implement lifecycle and readiness**

The lifecycle hook observes auth status and user ID. It loads once after a signed-in session is restored, clears account memory on sign-out, and clears/reloads when the WorkOS user ID changes. `App` invokes the hook alongside auth initialization.

`useAiReady` uses narrow account selectors. Account mode is pending until the initial account request settles, ready only with a selected model, and returns specific plan/unavailable CTA copy otherwise. BYOK remains key-based.

- [ ] **Step 4: Verify readiness tests pass**

Run: `npm test -- src/hooks/useAiReady.test.tsx`

Expected: PASS.

### Task 6: Header model selector

**Files:**
- Create: `src/components/ManagedModelSelector.tsx`
- Test: `src/components/ManagedModelSelector.test.tsx`
- Modify: `src/components/ChatPanel.tsx`

- [ ] **Step 1: Write failing selector tests**

Render the component against reset stores. Verify it hides for BYOK, shows compact loading before the first response, renders known friendly labels and canonical fallbacks, marks/selects one radio item, refreshes on open, disables switching while streaming, keeps cached choices visible beside a refresh error, offers retry without cached data, and renders unavailable for an empty/disabled plan.

```ts
await user.click(screen.getByRole("button", { name: /model/i }));
expect(refresh).toHaveBeenCalledTimes(1);
await user.click(screen.getByRole("menuitemradio", { name: /Sonnet/i }));
expect(useAccountStore.getState().selectedModel).toBe(
  "anthropic/claude-sonnet-5",
);
```

- [ ] **Step 2: Verify selector tests fail for the missing component**

Run: `npm test -- src/components/ManagedModelSelector.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the compact accessible selector**

Use the existing `DropdownMenu`, `DropdownMenuRadioGroup`, and `DropdownMenuRadioItem`. Known labels are Claude Haiku 4.5, Claude Sonnet 5, Claude Opus 4.8, Claude Fable 5, and HY 3 Free; unknown IDs display unchanged. The trigger sits beside “AI Assistant,” opens cached data immediately, calls `refresh()` on open, and is disabled while streaming.

Cached data plus an error keeps radio choices usable and adds a small retry item. First-load errors show retry; empty/disabled plans show “No managed models.”

- [ ] **Step 4: Add the selector to the chat header**

Render `<ManagedModelSelector />` inside the title row immediately after “AI Assistant.” Keep the right-side new-chat and close actions unchanged.

- [ ] **Step 5: Verify selector tests pass**

Run: `npm test -- src/components/ManagedModelSelector.test.tsx`

Expected: PASS.

### Task 7: Full verification and cleanup

**Files:**
- Review all files above

- [ ] **Step 1: Run the focused feature suite**

Run:

```bash
npm test -- \
  src/utils/accountApi.test.ts \
  src/store/authStore.test.ts \
  src/store/accountStore.test.ts \
  src/utils/chatTransport.test.ts \
  src/store/chatStore.test.ts \
  src/hooks/useAiReady.test.tsx \
  src/components/ManagedModelSelector.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the repository check**

Run: `npm run check`

Expected: TypeScript succeeds and all Vitest tests pass.

- [ ] **Step 3: Run lint**

Run: `npm run lint`

Expected: no ESLint errors.

- [ ] **Step 4: Review the final diff against the design**

Run: `git diff --check && git diff --stat origin/main... && git status --short`

Confirm every design goal is covered, the account response/token is memory-only, no account fetch was added to the send path, BYOK/background model behavior is unchanged, and no unrelated files changed.

- [ ] **Step 5: Commit the implementation**

```bash
git add src docs/superpowers/plans/2026-07-18-managed-model-selector.md
git commit -m "Add managed model selector"
```
