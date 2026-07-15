/**
 * SettingsDialog — the app's settings surface. A modal Dialog (same primitive
 * as ShortcutsHelp) laid out as a left nav + right content pane. Open state and
 * the active tab live in `settingsStore`, so the toolbar gear, the Cmd/Ctrl+,
 * shortcut, and the chat's "Open Settings" CTA can all drive it.
 *
 * Sections:
 *  - AI       — how the assistant connects: managed AI via the signed-in
 *               account, or the user's own Anthropic API key
 *  - Account  — WorkOS sign-in / signed-in card
 *  - Updates  — version + check for updates (desktop updater)
 */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDialogReturnFocus } from "@/hooks/useDialogReturnFocus";
import { useChatStore } from "@/store/chatStore";
import { useUpdaterStore } from "@/store/updaterStore";
import { useSettingsStore, type SettingsTab } from "@/store/settingsStore";
import { useAuthStore } from "@/store/authStore";
import { isAuthAvailable, type AuthUser } from "@/utils/authTransport";
import { openExternal } from "@/utils/openExternal";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  User,
  Download,
  Eye,
  EyeOff,
  Check,
  ExternalLink,
  Lock,
  Loader2,
  ArrowUpCircle,
  AlertCircle,
  SlidersHorizontal,
} from "lucide-react";

const ANTHROPIC_KEYS_URL = "https://console.anthropic.com/settings/keys";
const SAVED_RESET_MS = 1500;

const TABS: { id: SettingsTab; label: string; icon: typeof Sparkles }[] = [
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "account", label: "Account", icon: User },
  { id: "updates", label: "Updates", icon: Download },
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

// One selectable card in the provider radio group.
function ProviderCard({
  title,
  description,
  selected,
  disabled,
  badge,
  onSelect,
}: {
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected ? "border-primary/60 bg-primary/5" : "border-border hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary" : "border-muted-foreground/40"
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function AiSection() {
  const apiKey = useChatStore((s) => s.apiKey);
  const setApiKey = useChatStore((s) => s.setApiKey);
  const provider = useChatStore((s) => s.aiProvider);
  const setAiProvider = useChatStore((s) => s.setAiProvider);
  const authStatus = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const authAvailable = isAuthAvailable();

  const [value, setValue] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    []
  );

  const trimmed = value.trim();
  // Saving an empty value would just clear the key with no signal — and there's
  // nothing to save when the field already matches what's stored.
  const canSave = trimmed.length > 0 && trimmed !== apiKey;

  const handleSave = () => {
    if (!canSave) return;
    setApiKey(trimmed);
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), SAVED_RESET_MS);
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="AI"
        description="Cherry Blossom uses Claude to design and edit your circuit. Choose how the assistant connects."
      />

      <div role="radiogroup" aria-label="AI provider" className="flex flex-col gap-2">
        <ProviderCard
          title="Cherry Blossom account"
          description="Managed AI through your account — no API key needed."
          selected={provider === "account"}
          disabled={!authAvailable}
          badge={!authAvailable ? "Coming soon" : undefined}
          onSelect={() => setAiProvider("account")}
        />
        <ProviderCard
          title="Your Anthropic API key"
          description="Bring your own key — calls go straight to Anthropic."
          selected={provider === "apiKey"}
          onSelect={() => setAiProvider("apiKey")}
        />
      </div>

      {provider === "account" &&
        (authStatus === "signedIn" && user ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            Signed in as {user.email} — the assistant is ready to use.
          </p>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              Sign in to your account to use managed AI.
            </p>
            <Button size="sm" onClick={() => setActiveTab("account")}>
              Sign in
            </Button>
          </div>
        ))}

      {provider === "apiKey" && (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor="settings-api-key" className="ui-label text-muted-foreground">
              Anthropic API key
            </label>
            <div className="relative">
              <input
                id="settings-api-key"
                type={showKey ? "text" : "password"}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
                placeholder="sk-ant-..."
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/50"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Hide API key" : "Show API key"}
                aria-pressed={showKey}
                className="absolute right-1 top-1/2 -translate-y-1/2 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => openExternal(ANTHROPIC_KEYS_URL)}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Get a key from the Anthropic Console
                <ExternalLink className="size-3" aria-hidden="true" />
              </button>
              <Button size="sm" onClick={handleSave} disabled={!canSave}>
                {saved ? (
                  <>
                    <Check className="size-3.5" aria-hidden="true" />
                    Saved
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>

          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            Stored locally on this device — only ever sent to Anthropic.
          </p>
        </>
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
  "Built-in AI — chat without bringing your own API key",
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

function AccountSection() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const error = useAuthStore((s) => s.error);
  const signIn = useAuthStore((s) => s.signIn);
  const cancelSignIn = useAuthStore((s) => s.cancelSignIn);

  const available = isAuthAvailable();

  if (available && status === "signedIn" && user) {
    return (
      <div className="flex flex-col gap-5">
        <SectionHeader
          title="Account"
          description="You're signed in — managed AI is available in the AI tab, no API key needed."
        />
        <SignedInCard user={user} />
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
          Sign in to unlock managed AI — no API key required.
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

function UpdatesSection() {
  const currentVersion = useUpdaterStore((s) => s.currentVersion);
  const newVersion = useUpdaterStore((s) => s.newVersion);
  const checking = useUpdaterStore((s) => s.checking);
  const checkResult = useUpdaterStore((s) => s.checkResult);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Updates"
        description="Keep Cherry Blossom up to date with the latest features and fixes."
      />

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Current version</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {currentVersion ? `v${currentVersion}` : "—"}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => void checkForUpdates()}
        >
          {checking ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Checking…
            </>
          ) : (
            "Check for updates"
          )}
        </Button>
      </div>

      {!checking && newVersion && (
        <p className="flex items-center gap-1.5 text-xs text-primary">
          <ArrowUpCircle className="size-3.5 shrink-0" aria-hidden="true" />
          Update available: v{newVersion}
        </p>
      )}
      {!checking && !newVersion && checkResult === "uptodate" && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 shrink-0" aria-hidden="true" />
          You're up to date.
        </p>
      )}
      {!checking && !newVersion && checkResult === "error" && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
          Couldn't check for updates. Check your connection and try again.
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
  const resetCheckResult = useUpdaterStore((s) => s.resetCheckResult);
  const onCloseAutoFocus = useDialogReturnFocus(open);

  // Each fresh open starts from a clean inline status — a stale "up to date" /
  // "couldn't check" from a prior session shouldn't reappear on reopen. An
  // actually-available update lives in `newVersion`, so it survives.
  useEffect(() => {
    if (open) resetCheckResult();
  }, [open, resetCheckResult]);

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
          </nav>

          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "ai" && <AiSection />}
            {activeTab === "account" && <AccountSection />}
            {activeTab === "updates" && <UpdatesSection />}
            {activeTab === "advanced" && <AdvancedSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
