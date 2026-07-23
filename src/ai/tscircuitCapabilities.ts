import {
  DESIGNATOR_PREFIX_BY_TAG,
  NON_COMPONENT_KEYABLE_TAGS,
} from "../editor/shared/keys";

const LEGACY_OR_LOGICAL_TAGS: ReadonlySet<string> = new Set(["bug", "net"]);

/**
 * Built-in placeable components the AI can author through semantic tools.
 * Derive this from the editor's canonical element registry so newly supported
 * tscircuit components cannot silently drift out of the AI capability layer.
 */
export const AI_PLACEABLE_COMPONENT_TAGS: readonly string[] = Object.freeze(
  Object.keys(DESIGNATOR_PREFIX_BY_TAG).filter(
    (tag) =>
      !LEGACY_OR_LOGICAL_TAGS.has(tag) &&
      !NON_COMPONENT_KEYABLE_TAGS.has(tag)
  )
);

const AI_PLACEABLE_COMPONENT_TAG_SET = new Set(AI_PLACEABLE_COMPONENT_TAGS);
const JSX_PROP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PIN_LABEL = /^[A-Za-z0-9_]+$/;
const NET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isAiPlaceableComponentTag(tag: string): boolean {
  return AI_PLACEABLE_COMPONENT_TAG_SET.has(tag);
}

export function isValidJsxPropName(name: string): boolean {
  return JSX_PROP_NAME.test(name);
}

export function isValidPinLabel(label: string): boolean {
  return PIN_LABEL.test(label);
}

export function isValidNetName(name: string): boolean {
  return NET_NAME.test(name);
}
