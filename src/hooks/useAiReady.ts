import { useAuthStore } from "@/store/authStore";
import { useAccountStore } from "@/store/accountStore";
import type { SettingsTab } from "@/store/settingsStore";

export interface AiReady {
  /**
   * True when an AI call can be made right now — either the signed-in account
   * has an allowed model selected, or the visitor is signed out and chats
   * anonymously on the free model.
   */
  ready: boolean;
  /**
   * True while readiness is still being resolved (session restore or account
   * load in flight at launch). Composers should show a disabled input —
   * not the setup CTA — so signed-in users don't get a "Sign in" flash.
   */
  pending: boolean;
  /** Where a "set this up" CTA should land. */
  settingsTab: SettingsTab;
  /** Short CTA copy for composers shown when not ready. */
  ctaMessage: string;
}

// Reactive mirror of chatStore's resolveChatAuth() for the UI: composers use it
// to swap the input for a setup CTA and to route "Open Settings" to the right
// tab. Keep the readiness rule in lockstep with resolveChatAuth so the CTA and
// the send path always agree.
export function useAiReady(): AiReady {
  const authStatus = useAuthStore((s) => s.status);
  const authUserId = useAuthStore((s) => s.user?.id ?? null);
  const account = useAccountStore((s) => s.account);
  const accountUserId = useAccountStore((s) => s.accountUserId);
  const accountStatus = useAccountStore((s) => s.status);
  const selectedModel = useAccountStore((s) => s.selectedModel);

  const authPending = authStatus === "unknown" || authStatus === "signingIn";
  const currentAccount =
    authStatus === "signedIn" &&
    authUserId !== null &&
    accountUserId === authUserId
      ? account
      : null;
  const selectedModelAllowed =
    currentAccount?.plan.managedAi === true &&
    selectedModel !== null &&
    currentAccount.plan.allowedModels.includes(selectedModel);
  const accountUserMismatch =
    authStatus === "signedIn" &&
    authUserId !== null &&
    accountUserId !== null &&
    accountUserId !== authUserId;
  const accountPending =
    authStatus === "signedIn" &&
    currentAccount === null &&
    (accountUserMismatch ||
      accountStatus === "idle" ||
      accountStatus === "loading");

  if (authPending || accountPending) {
    return {
      ready: false,
      pending: true,
      settingsTab: "account",
      ctaMessage: "Loading managed AI models…",
    };
  }

  // Signed-out visitors chat anonymously on the free model — the composer
  // stays active and the proxy enforces the anonymous limits server-side.
  if (authStatus === "signedOut") {
    return {
      ready: true,
      pending: false,
      settingsTab: "account",
      ctaMessage: "",
    };
  }

  if (selectedModelAllowed) {
    return {
      ready: true,
      pending: false,
      settingsTab: "account",
      ctaMessage: "",
    };
  }

  if (currentAccount) {
    return {
      ready: false,
      pending: false,
      settingsTab: "account",
      ctaMessage:
        "Your account plan doesn't include a managed AI model. See Settings → Account.",
    };
  }

  return {
    ready: false,
    pending: false,
    settingsTab: "account",
    ctaMessage: "Managed AI is unavailable right now. Retry from the model selector.",
  };
}
