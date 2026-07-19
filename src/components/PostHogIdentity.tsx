import { useEffect } from "react";
import { useAuthStore } from "@/store/authStore";
import { initPostHog } from "@/utils/analytics";

/** Keep PostHog's persisted browser identity aligned with the WorkOS session. */
export function PostHogIdentity() {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    const signedInUser = status === "signedIn" ? user : null;
    if (status !== "signedOut" && !signedInUser) return;

    initPostHog((posthog) => {
      if (!signedInUser) {
        if (posthog.get_property("$user_id")) posthog.reset();
        return;
      }

      const identifiedUserId = posthog.get_property("$user_id");
      if (identifiedUserId && identifiedUserId !== signedInUser.id) {
        posthog.reset();
      }

      posthog.identify(signedInUser.id, {
        email: signedInUser.email,
        first_name: signedInUser.first_name ?? undefined,
        last_name: signedInUser.last_name ?? undefined,
      });
    });
  }, [status, user]);

  return null;
}
