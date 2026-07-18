import { useEffect } from "react";
import { useAccountStore } from "@/store/accountStore";
import { useAuthStore } from "@/store/authStore";

/** Keep memory-only account data aligned with the current WorkOS session. */
export function useManagedAccountLifecycle(): void {
  const authStatus = useAuthStore((state) => state.status);
  const authUserId = useAuthStore((state) => state.user?.id ?? null);
  const accountUserId = useAccountStore((state) => state.accountUserId);
  const load = useAccountStore((state) => state.load);
  const clear = useAccountStore((state) => state.clear);

  useEffect(() => {
    if (authStatus !== "signedIn" || !authUserId) {
      clear();
      return;
    }

    if (accountUserId && accountUserId !== authUserId) clear();
    void load().catch(() => {
      // The account store owns the visible retry/error state.
    });
  }, [accountUserId, authStatus, authUserId, clear, load]);
}
