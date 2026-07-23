/**
 * SettingsDialog — the app's settings surface. A modal Dialog (same primitive
 * as ShortcutsHelp) laid out as a left nav + right content pane. Open state and
 * the active tab live in `settingsStore`, so the toolbar gear, the Cmd/Ctrl+,
 * shortcut, and the chat's "Open Settings" CTA can all drive it.
 *
 * Sections:
 *  - Account  — WorkOS sign-in / signed-in card
 *  - Advanced — power-user toggles
 */
import { useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDialogReturnFocus } from "@/hooks/useDialogReturnFocus";
import { useSettingsStore, type SettingsTab } from "@/store/settingsStore";
import { useAuthStore } from "@/store/authStore";
import { useAccountStore } from "@/store/accountStore";
import type { MeResponse } from "@/utils/accountApi";
import { isAuthAvailable, type AuthUser } from "@/utils/authTransport";
import { openExternal } from "@/utils/openExternal";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  User,
  ExternalLink,
  Loader2,
  AlertCircle,
  SlidersHorizontal,
  RefreshCw,
} from "lucide-react";

const MANAGE_ACCOUNT_URL = "https://www.trycherryblossom.com/account";

const TABS: { id: SettingsTab; label: string; icon: typeof User }[] = [
  { id: "account", label: "Account", icon: User },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
];

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-heading text-base font-medium leading-none">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

function AdvancedSection() {
  const showCodeTab = useSettingsStore((s) => s.showCodeTab);
  const setShowCodeTab = useSettingsStore((s) => s.setShowCodeTab);

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Advanced"
        description="Power-user options for working closer to the circuit."
      />
      <ToggleRow
        label="Show Code tab"
        description="Add a tab to view and edit the circuit's raw TSX."
        checked={showCodeTab}
        onChange={setShowCodeTab}
      />
    </div>
  );
}

const PREMIUM_PERKS = [
  "Built-in AI through your Cherry Blossom account",
  "Access premium models and higher limits",
  "Priority access to new AI features",
];

function initials(user: AuthUser): string {
  const parts = [user.first_name, user.last_name].filter(Boolean) as string[];
  if (parts.length > 0) {
    return parts.map((p) => p[0]!.toUpperCase()).join("");
  }
  return user.email[0]?.toUpperCase() ?? "?";
}

function SignedInCard({ user }: { user: AuthUser }) {
  const signOut = useAuthStore((s) => s.signOut);
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        {user.profile_picture_url ? (
          <img
            src={user.profile_picture_url}
            alt=""
            className="size-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary"
          >
            {initials(user)}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {fullName || user.email}
          </span>
          {fullName && (
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          )}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}

const TOKEN_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const RESET_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function MonthlyUsage({
  account,
  refreshing,
  refreshError,
  onRefresh,
}: {
  account: MeResponse;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
}) {
  const used = Math.max(0, account.usage.monthlyTokens);
  const limit = Math.max(0, account.limits.monthlyTokens);
  const hasLimit = limit > 0;
  const rawPercent = hasLimit ? (used / limit) * 100 : 0;
  const percent = Math.min(100, Math.max(0, rawPercent));
  const percentLabel = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(rawPercent);
  const resetDate = account.usage.monthResetsAt
    ? RESET_DATE_FORMATTER.format(new Date(account.usage.monthResetsAt))
    : null;

  return (
    <div
      className="flex flex-col gap-2.5 rounded-lg border border-border px-3 py-2.5"
      aria-busy={refreshing}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Monthly usage</span>
          <span className="text-xs text-muted-foreground">
            {account.plan.name} plan
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium tabular-nums">
            {hasLimit ? `${percentLabel}% used` : "No allowance"}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh usage"
            title="Refresh usage"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw
              className={cn("size-3", refreshing && "animate-spin")}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>

      {hasLimit && (
        <div
          role="progressbar"
          aria-label="Monthly token usage"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
          aria-valuetext={`${TOKEN_FORMATTER.format(used)} of ${TOKEN_FORMATTER.format(limit)} tokens used`}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {hasLimit
            ? `${TOKEN_FORMATTER.format(used)} of ${TOKEN_FORMATTER.format(limit)} tokens`
            : "No monthly tokens included"}
        </span>
        {resetDate && <span className="shrink-0">Resets {resetDate}</span>}
      </div>

      {refreshError && (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-xs text-destructive"
        >
          <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
          Usage may be out of date. {refreshError}
        </p>
      )}
    </div>
  );
}

function PendingMonthlyUsage({
  error,
  refreshing,
  onRefresh,
}: {
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div
        role={error ? "alert" : "status"}
        aria-live={error ? "assertive" : "polite"}
        className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
      >
        {error ? (
          <AlertCircle
            className="size-3.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        )}
        <span className={cn("truncate", error && "text-destructive")}>
          {error ?? "Loading current usage…"}
        </span>
      </div>
      {error && (
        <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}>
          Retry
        </Button>
      )}
    </div>
  );
}

function AccountSection() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const error = useAuthStore((s) => s.error);
  const signIn = useAuthStore((s) => s.signIn);
  const cancelSignIn = useAuthStore((s) => s.cancelSignIn);
  const account = useAccountStore((s) => s.account);
  const accountUserId = useAccountStore((s) => s.accountUserId);
  const accountStatus = useAccountStore((s) => s.status);
  const accountError = useAccountStore((s) => s.error);
  const refreshAccount = useAccountStore((s) => s.refresh);

  const available = isAuthAvailable();
  const authUserId = user?.id ?? null;

  useEffect(() => {
    if (!available || status !== "signedIn" || !authUserId) return;
    void refreshAccount().catch(() => {
      // The account store keeps the visible retry/error state.
    });
  }, [authUserId, available, refreshAccount, status]);

  if (available && status === "signedIn" && user) {
    const currentAccount = accountUserId === user.id ? account : null;
    const refreshUsage = () => {
      void refreshAccount().catch(() => {
        // The account store keeps the visible retry/error state.
      });
    };

    return (
      <div className="flex flex-col gap-5">
        <SectionHeader
          title="Account"
          description="You're signed in to your Cherry Blossom account."
        />
        <SignedInCard user={user} />

        {currentAccount ? (
          <MonthlyUsage
            account={currentAccount}
            refreshing={accountStatus === "loading"}
            refreshError={accountError}
            onRefresh={refreshUsage}
          />
        ) : (
          <PendingMonthlyUsage
            error={accountStatus === "error" ? accountError : null}
            refreshing={accountStatus === "loading"}
            onRefresh={refreshUsage}
          />
        )}

        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="self-start"
            onClick={() => openExternal(MANAGE_ACCOUNT_URL)}
          >
            Manage account
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </Button>
          <p className="text-xs text-muted-foreground">
            Update your profile, plan, and billing on trycherryblossom.com.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="font-heading text-base font-medium leading-none">Premium</h3>
          {!available && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              Coming soon
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Sign in to unlock managed AI.
        </p>
      </div>

      <ul className="flex flex-col gap-2.5">
        {PREMIUM_PERKS.map((perk) => (
          <li key={perk} className="flex items-start gap-2 text-sm text-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span>{perk}</span>
          </li>
        ))}
      </ul>

      {!available ? (
        <div>
          <Button disabled title="Coming soon" aria-disabled>
            Sign in
          </Button>
        </div>
      ) : status === "signingIn" ? (
        <div className="flex items-center gap-2">
          <Button disabled>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Waiting for browser…
          </Button>
          <Button variant="ghost" size="sm" onClick={cancelSignIn}>
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button
            onClick={() => void signIn()}
            disabled={status === "unknown"}
          >
            Sign in
          </Button>
        </div>
      )}

      {available && status === "signingIn" && (
        <p className="text-xs text-muted-foreground">
          Finish signing in using the window we opened in your browser.
        </p>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const open = useSettingsStore((s) => s.open);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const onCloseAutoFocus = useDialogReturnFocus(open);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeSettings(); }}>
      <DialogContent
        className="sm:max-w-2xl p-0 gap-0 overflow-hidden"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div className="flex h-[440px]">
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border bg-muted/30 p-2">
            <DialogTitle className="px-2 pt-1 pb-2 text-sm">Settings</DialogTitle>
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    active
                      ? "bg-background text-foreground ring-1 ring-foreground/10"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
            <span className="mt-auto px-2 pb-1 text-xs text-muted-foreground tabular-nums">
              v{__APP_VERSION__}
            </span>
          </nav>

          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "account" && <AccountSection />}
            {activeTab === "advanced" && <AdvancedSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
