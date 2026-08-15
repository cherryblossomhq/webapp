// Platform detection for on-screen key hints.
//
// `navigator.platform` is deprecated and, worse, frozen: Apple silicon still
// reports "MacIntel" and some browsers plan to freeze it further. User-Agent
// Client Hints exposes the same answer without the legacy baggage, so read that
// first and keep the old property as the fallback for browsers without it.

interface UserAgentData {
  readonly platform?: string;
}

function platformName(): string {
  if (typeof navigator === "undefined") return "";
  const uaData = (navigator as Navigator & { userAgentData?: UserAgentData })
    .userAgentData;
  return uaData?.platform ?? navigator.platform ?? "";
}

/** True on macOS, iPadOS and iOS — the platforms whose modifier is ⌘, not Ctrl. */
export function isApplePlatform(): boolean {
  return /mac|iphone|ipad|ipod/i.test(platformName());
}

/** Modifier on its own, for a standalone key chip: "⌘" or "Ctrl". */
export function modKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

/** Modifier as a prefix, for inline hints like `${modKeyPrefix()}S`. */
export function modKeyPrefix(): string {
  return isApplePlatform() ? "⌘" : "Ctrl+";
}
