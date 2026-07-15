// Resolve editorStore.selectedKeys → component designators for UI that only
// applies to parts (PropertiesPanel, properties drawer). Trace / connection
// keys (conn_*) and other non-component selections are ignored.

import { extractComponents } from "@/utils/tsxTransform";
import type { StableKey } from "./keys";

export function componentNamesForKeys(
  tsxCode: string,
  keys: ReadonlySet<StableKey>
): string[] {
  if (keys.size === 0) return [];
  const keyToName = new Map<string, string>();
  for (const c of extractComponents(tsxCode)) {
    const k = c.props.key;
    if (k) keyToName.set(k, c.name);
  }
  const names: string[] = [];
  for (const k of keys) {
    const name = keyToName.get(k);
    if (name) names.push(name);
  }
  return names;
}

export function selectionIncludesComponent(
  tsxCode: string,
  keys: ReadonlySet<StableKey>
): boolean {
  return componentNamesForKeys(tsxCode, keys).length > 0;
}

/** True when exactly one component is selected (trace keys ignored). */
export function selectionIsSingleComponent(
  tsxCode: string,
  keys: ReadonlySet<StableKey>
): boolean {
  return componentNamesForKeys(tsxCode, keys).length === 1;
}
