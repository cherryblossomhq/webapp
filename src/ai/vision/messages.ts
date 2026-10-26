import type { ChatMessage, UserContentPart } from "../managedAi"
import type { LookImage } from "./encode"
import { PROXY_MAX_IMAGE_CHARS_EACH, PROXY_MAX_IMAGE_CHARS_TOTAL, PROXY_MAX_IMAGES } from "./limits"

// How a picture is put to the model. Chat Completions tool results are text, so a picture goes
// in a user message right after the tool results of the turn that asked for it, as an
// `image_url` part holding a base64 data URL, which OpenRouter passes to Claude as an image.
// (The proxy lets only that shape through: see `request-policy.ts` on the website.)

export const OMITTED = "[An earlier screenshot was left out to save tokens. Look again if you need it.]"

export const dataUrl = (image: LookImage) => `data:${image.mediaType};base64,${image.base64}`

/** The user message that carries the pictures a turn's tool calls made. */
export function pictureMessage(images: LookImage[]): ChatMessage {
  const content: UserContentPart[] = [
    {
      type: "text",
      text:
        images.length === 1
          ? "This is the picture your look call made. It is not a message from the user."
          : `These are the ${images.length} pictures your look calls made, in order. They are not a message from the user.`,
    },
  ]
  for (const image of images) content.push({ type: "image_url", image_url: { url: dataUrl(image) } })
  return { role: "user", content }
}

const isImage = (p: UserContentPart) => p.type === "image_url"

/** What the proxy takes of the pictures in one request; see `limits.ts`. */
export interface ImageBudget {
  maxEach: number
  maxTotal: number
  maxCount: number
}

export const PROXY_IMAGE_BUDGET: ImageBudget = {
  maxEach: PROXY_MAX_IMAGE_CHARS_EACH,
  maxTotal: PROXY_MAX_IMAGE_CHARS_TOTAL,
  maxCount: PROXY_MAX_IMAGES,
}

/** How many pictures the conversation holds, counted part by part across every message. */
export const countImages = (history: ChatMessage[]) =>
  history.reduce((n, m) => n + (m.role === "user" && Array.isArray(m.content) ? m.content.filter(isImage).length : 0), 0)

/**
 * Keep the `keep` newest pictures in the conversation and swap the rest for a line of text.
 * Pictures are counted one by one, newest first, across the whole history, so a message with
 * three of them counts three. A picture is also dropped, however new, when it would take the
 * kept ones past `budget` (the proxy's limits on one request): a conversation can then never be
 * left holding a history the proxy refuses. A picture rides along in every later request, so
 * left alone each would cost its tokens again each round.
 *
 * Only the oldest pictures change, and a message is replaced only when one of its pictures goes,
 * so everything before the first dropped picture is sent exactly as it was before and the
 * provider's prompt cache on that part holds. What follows a dropped picture is re-read once at
 * full price: the price of not paying for a stale picture on every round.
 */
export function pruneImages(history: ChatMessage[], keep: number, budget: ImageBudget = PROXY_IMAGE_BUDGET): void {
  let kept = 0
  let chars = 0
  const allowed = Math.min(keep, budget.maxCount)
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== "user" || !Array.isArray(m.content) || !m.content.some(isImage)) continue
    let dropped = false
    const parts: UserContentPart[] = []
    // Newest first inside the message too: the last picture of a batch is the newest.
    for (let j = m.content.length - 1; j >= 0; j--) {
      const part = m.content[j]
      if (part.type !== "image_url") {
        parts.push(part)
        continue
      }
      const size = part.image_url.url.length
      if (kept < allowed && size <= budget.maxEach && chars + size <= budget.maxTotal) {
        kept++
        chars += size
        parts.push(part)
      } else {
        dropped = true
        // Several left out side by side say it once.
        const last = parts[parts.length - 1]
        if (!(last && last.type === "text" && last.text === OMITTED)) parts.push({ type: "text", text: OMITTED })
      }
    }
    if (dropped) history[i] = { role: "user", content: parts.reverse() }
  }
}
