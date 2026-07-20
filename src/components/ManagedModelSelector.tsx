import { ChevronDown, Loader2, RefreshCw, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccountStore } from "@/store/accountStore";
import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import { openExternal } from "@/utils/openExternal";

const UPGRADE_URL = "https://www.trycherryblossom.com/pricing";

const MODEL_LABELS: Record<string, string> = {
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
  "anthropic/claude-sonnet-5": "Claude Sonnet 5",
  "anthropic/claude-opus-4.8": "Claude Opus 4.8",
  "anthropic/claude-fable-5": "Claude Fable 5",
  "tencent/hy3:free": "HY 3 Free",
};

function managedModelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}

export function ManagedModelSelector() {
  const isStreaming = useChatStore((state) => state.isStreaming);
  const authStatus = useAuthStore((state) => state.status);
  const authUserId = useAuthStore((state) => state.user?.id ?? null);
  const account = useAccountStore((state) => state.account);
  const accountUserId = useAccountStore((state) => state.accountUserId);
  const status = useAccountStore((state) => state.status);
  const error = useAccountStore((state) => state.error);
  const selectedModel = useAccountStore((state) => state.selectedModel);
  const refresh = useAccountStore((state) => state.refresh);
  const setSelectedModel = useAccountStore((state) => state.setSelectedModel);
  const signIn = useAuthStore((state) => state.signIn);

  const currentAccount =
    authStatus === "signedIn" &&
    authUserId !== null &&
    accountUserId === authUserId
      ? account
      : null;
  // Signed-out visitors chat anonymously: requests carry no model at all and
  // the proxy picks one server-side, so there is nothing to select (or show
  // as current) — only a sign-in CTA.
  const anonymous = authStatus === "signedOut";
  const models = currentAccount?.plan.managedAi
    ? currentAccount.plan.allowedModels
    : [];
  // Free-plan users see a nudge to unlock the fuller model roster.
  const isFreePlan = currentAccount?.plan.tier === "free";
  const currentModel =
    selectedModel && models.includes(selectedModel)
      ? selectedModel
      : (models[0] ?? null);
  const accountUserMismatch =
    authStatus === "signedIn" &&
    authUserId !== null &&
    accountUserId !== null &&
    accountUserId !== authUserId;
  const firstLoad =
    authStatus === "signedIn" &&
    currentAccount === null &&
    (accountUserMismatch || status === "idle" || status === "loading");
  const triggerText = anonymous
    ? "Auto model"
    : firstLoad
      ? "Loading models…"
      : currentModel
        ? managedModelLabel(currentModel)
        : currentAccount
          ? "No managed models"
          : "Models unavailable";

  const retry = () => {
    void refresh().catch(() => {
      // The account store keeps the error visible in this menu.
    });
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !isStreaming && !anonymous) retry();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isStreaming}
          aria-label={`Managed model: ${triggerText}`}
          title={isStreaming ? "Model can't change while chatting" : triggerText}
          className="flex h-6 max-w-48 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {firstLoad && (
            <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
          )}
          <span className="truncate">{triggerText}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        {anonymous ? (
          <>
            <DropdownMenuLabel className="max-w-64 whitespace-normal font-normal text-muted-foreground">
              A model is picked for you automatically.
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void signIn()}>
              Sign in to choose a model
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {models.length > 0 && (
              <DropdownMenuRadioGroup
                value={currentModel ?? undefined}
                onValueChange={setSelectedModel}
              >
                {models.map((model) => (
                  <DropdownMenuRadioItem key={model} value={model}>
                    {managedModelLabel(model)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}

            {models.length === 0 && firstLoad && (
              <DropdownMenuItem disabled>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Loading models…
              </DropdownMenuItem>
            )}

            {models.length === 0 && currentAccount && (
              <DropdownMenuItem disabled>
                No managed models on this plan.
              </DropdownMenuItem>
            )}

            {models.length === 0 && !currentAccount && !firstLoad && !error && (
              <DropdownMenuItem disabled>Sign in to load models.</DropdownMenuItem>
            )}

            {isFreePlan && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => openExternal(UPGRADE_URL)}
                  className="text-primary focus:text-primary"
                >
                  <Sparkles aria-hidden="true" />
                  Upgrade for more models
                </DropdownMenuItem>
              </>
            )}

            {error && (
              <>
                {(models.length > 0 || isFreePlan) && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="max-w-64 whitespace-normal font-normal text-destructive">
                  {error}
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={retry}>
                  <RefreshCw aria-hidden="true" />
                  Retry
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
