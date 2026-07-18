import { useAuthStore } from "@/store/authStore";
import { useAccountStore } from "@/store/accountStore";
import { useChatStore, type AiProvider } from "@/store/chatStore";
import type { SettingsTab } from "@/store/settingsStore";

export interface AiReady {
  /** True when the active provider can make an AI call right now. */
  ready: boolean;
  /**
   * True while readiness is still being resolved (account mode, session
   * restore in flight at launch). Composers should show a disabled input —
   * not the setup CTA — so signed-in users don't get a "Sign in" flash.
   */
  pending: boolean;
  provider: AiProvider;
  /** Where a "set this up" CTA should land: the sign-in or the API-key section. */
  settingsTab: SettingsTab;
  /** Short CTA copy for composers shown when not ready. */
  ctaMessage: string;
}

// Reactive mirror of chatStore's resolveChatAuth() for the UI: composers use it
// to swap the input for a setup CTA and to route "Open Settings" to the right
// tab. Keep the readiness rule in lockstep with resolveChatAuth so the CTA and
// the send path always agree.
export function useAiReady(): AiReady {
  const provider = useChatStore((s) => s.aiProvider);
  const apiKey = useChatStore((s) => s.apiKey);
  const authStatus = useAuthStore((s) => s.status);
  const authUserId = useAuthStore((s) => s.user?.id ?? null);
  const account = useAccountStore((s) => s.account);
  const accountUserId = useAccountStore((s) => s.accountUserId);
  const accountStatus = useAccountStore((s) => s.status);
  const selectedModel = useAccountStore((s) => s.selectedModel);

  if (provider === "account") {
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
    const accountPending =
      authStatus === "signedIn" &&
      currentAccount === null &&
      (accountStatus === "idle" || accountStatus === "loading");

    if (authPending || accountPending) {
      return {
        ready: false,
        pending: true,
        provider,
        settingsTab: "account",
        ctaMessage: "Loading managed AI models…",
      };
    }

    if (selectedModelAllowed) {
      return {
        ready: true,
        pending: false,
        provider,
        settingsTab: "account",
        ctaMessage: "",
      };
    }

    if (currentAccount) {
      return {
        ready: false,
        pending: false,
        provider,
        settingsTab: "account",
        ctaMessage:
          "Your account plan doesn't include a managed AI model. See Settings → Account.",
      };
    }

    return {
      ready: false,
      pending: false,
      provider,
      settingsTab: "account",
      ctaMessage:
        authStatus === "signedIn"
          ? "Managed AI is unavailable right now. Retry from the model selector."
          : "Sign in to your Cherry Blossom account to start chatting.",
    };
  }
  return {
    ready: apiKey.trim() !== "",
    pending: false,
    provider,
    settingsTab: "ai",
    ctaMessage: "Add your Anthropic API key to start chatting.",
  };
}
