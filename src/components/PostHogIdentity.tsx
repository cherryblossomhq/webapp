import { useEffect } from "react";
import posthog from "posthog-js";
import { useAuthStore } from "@/store/authStore";

/** Keep PostHog's persisted browser identity aligned with the WorkOS session. */
export function PostHogIdentity() {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    // __loaded stays false when analytics initialization was skipped because
    // no project token was available at build time.
    if (status === "unknown" || !posthog.__loaded) return;

    // Comparing ids also handles a different WorkOS user signing in on a
    // browser where PostHog still has the previous user's persisted identity.
    if (status === "signedIn" && user) {
      if (posthog.get_distinct_id() !== user.id) {
        posthog.identify(user.id, {
          email: user.email,
          first_name: user.first_name ?? undefined,
          last_name: user.last_name ?? undefined,
        });
      }
    } else if (status === "signedOut" && posthog._isIdentified()) {
      // Prevent the next visitor on a shared browser from inheriting this user.
      posthog.reset();
    }
  }, [status, user]);

  return null;
}
