# Managed model selector design

## Context

Managed chat currently starts from the native Claude Opus model ID and rewrites it to `tencent/hy3:free` in the transport. That temporary override makes every signed-in user use the same model, even when their plan permits other OpenRouter models.

The website now exposes `GET /api/v1/me`. Its `plan.allowedModels` field is the server-provided list of canonical OpenRouter model IDs the signed-in user may request. The chat completions endpoint remains authoritative and may still reject a model from a stale account snapshot.

## Goals

- Put a compact managed-model selector directly in the chat header.
- Offer only models returned by `GET /api/v1/me`.
- Use the selected canonical model for every round of a managed chat turn.
- Preserve the direct Anthropic BYOK path and its native model ID.
- Remove the temporary Claude Opus to Tencent rewrite.
- Keep account loading and selection logic small, testable, and reusable.
- Avoid avoidable requests, duplicate token refreshes, stale async writes, and unnecessary React renders.

## Non-goals

- Displaying plan limits or usage counters from the account response.
- Adding a BYOK model selector.
- Changing model access or rate-limit enforcement on the website.
- Refreshing account data after every chat completion.
- Changing the fixed models used by background history folding or datasheet summarization.

## Architecture

### Account API transport

Add `src/utils/accountApi.ts` as the only HTTP seam for `GET /api/v1/me`. It will:

- derive `/api/v1/me` from `VITE_MANAGED_AI_URL` using an absolute path, matching the documented endpoint behavior;
- expose the typed account response and a typed error containing HTTP status, API error type, and message;
- send the WorkOS bearer token, `Accept: application/json`, and `cache: "no-store"`;
- avoid cookies and credentials.

The client will parse the complete documented response even though this feature initially consumes only the user, plan, and allowed-model fields. This keeps the transport aligned with the API contract without spreading response-shape knowledge through UI code.

The transport will validate the fields this feature depends on before accepting a response. A syntactically valid but incompatible payload is treated as a load error rather than being allowed to corrupt selection state.

### Account state

Add a focused Zustand account store containing:

- the most recent successful account response;
- `idle`, `loading`, `ready`, and `error` request status;
- the selected managed model;
- `load`, `refresh`, `setSelectedModel`, and `clear` actions.

The store will keep a successful response when a later refresh fails, as recommended by the API contract. It will single-flight concurrent loads so session restoration and opening the picker cannot issue duplicate requests. Results that finish after sign-out or account replacement will not overwrite current state.

Only the selected model is persisted in local storage. Account data and access tokens remain memory-only. The selection key is scoped to managed AI rather than chat history so clearing a conversation does not reset the user's preference.

After each successful account response, selection is reconciled deterministically:

1. retain the persisted selection when it is still present in `allowedModels`;
2. otherwise prefer `anthropic/claude-opus-4.8` when available, preserving the existing managed-chat quality default;
3. otherwise select the first server-returned model;
4. use no selection when the list is empty.

No client-defined model is ever added to the allowed list.

A small top-level lifecycle effect will load account state once a signed-in session is restored and clear the in-memory response on sign-out or user replacement. This keeps auth/account synchronization independent of whether the chat panel happens to be mounted.

### Authentication retry

Expose a force-refresh action from the auth store and use the same single-flight path for scheduled and forced WorkOS refreshes. This prevents concurrent refresh-token rotation within the tab.

An account request that receives `401` will force-refresh once and retry once with the new access token. If the retry also returns `401`, the app will transition to signed-out state. Other failures preserve any last successful account data and surface a retry state in the picker.

### Chat integration

When account mode is active, `chatStore.sendMessage` will snapshot the selected canonical model at the beginning of the send. Every model/tool round in that send uses the snapshot, so the provider cannot change mid-loop. The header selector is also disabled while streaming.

The managed transport will receive canonical OpenRouter IDs directly. Its native-to-managed mapping remains only for internal native Claude IDs and maps Claude Opus to `anthropic/claude-opus-4.8`; the temporary Tencent override is removed. BYOK continues to send native `claude-opus-4-8` directly to Anthropic.

Sending is disabled while the initial account request is unresolved or when no allowed managed model exists. A plan with `managedAi: false` or an empty `allowedModels` list produces a clear account/plan message instead of attempting a doomed completion. A later completion-side rejection is still shown through the existing authoritative error handling.

## User interface

Create a small model-selector component in the chat header beside “AI Assistant.” It is rendered only for the Cherry Blossom account provider.

- The trigger shows a concise friendly label for known models and falls back to the canonical model ID for unknown future entries.
- Opening the picker presents the last successful list immediately and refreshes account data in the background.
- The last successful list remains usable during a transient refresh failure, with a visible retry affordance.
- During the first load, the trigger shows a compact loading state.
- When loading fails without cached data, or when the plan has no models, the trigger shows the corresponding unavailable state and lets the user retry where applicable.
- Switching is disabled while chat is streaming.
- The menu uses accessible single-selection semantics and keyboard interaction from the existing UI primitives.

The selector subscribes only to the account fields it renders. Existing chat message rows remain memoized and do not re-render because account usage counters or unrelated account fields change.

## Request lifecycle

1. The top-level account lifecycle observes a restored signed-in session and loads account state if no successful snapshot exists for that user.
2. The store fetches `/api/v1/me`, applying the one-time `401` refresh-and-retry rule.
3. The store reconciles the persisted selection against `allowedModels`.
4. Opening the picker requests a refresh, deduplicated with any request already in flight.
5. Starting a message snapshots the current selected model and passes it to every managed tool-loop round.
6. Signing out clears in-memory account state while retaining the harmless model preference for possible reuse after a later sign-in.

There is deliberately no account fetch on the send path, so sending adds no extra network latency.

## Error handling

- `401`: refresh the WorkOS token once and retry; a second `401` signs out.
- `502`, malformed response, or network failure: retain the last successful data; otherwise show a load error and retry affordance.
- Empty model list or `managedAi: false`: disable managed sending and direct the user to account settings.
- Selected model removed by a plan change: reconcile immediately to the deterministic fallback.
- Completion endpoint rejects a previously allowed model: retain the existing server-message mapping because completions are authoritative.

## Testing

Tests will be written before production changes and cover:

- deriving the account endpoint, request headers/options, success parsing, and typed API errors;
- account-store single-flight loading, successful reconciliation, persisted selection, stale-selection replacement, transient-error retention, empty plans, and sign-out clearing;
- one-time `401` token refresh/retry and terminal authentication failure;
- selected managed model propagation through every main chat round, while BYOK retains its native model;
- removal of the Tencent override from managed model mapping;
- selector loading, available-model rendering, switching, refresh-on-open, streaming disablement, and unavailable/error states;
- readiness behavior while account models are loading or unavailable.

Final verification will run the repository's full `npm run check`, followed by lint for the touched codebase.
