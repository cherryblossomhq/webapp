import { PROXY_MAX_IMAGE_CHARS_EACH, PROXY_MAX_IMAGE_CHARS_TOTAL, PROXY_MAX_IMAGES } from "../../src/ai/vision/limits"

type Part = { type: string; image_url?: { url: string } }

const PICTURE = /^data:image\/(png|jpeg);base64,/

/**
 * What the managed AI proxy accepts of the pictures in a request, by the limits in
 * `src/ai/vision/limits.ts`: pictures only in user messages, each a PNG or JPEG data URL within the
 * per-picture cap, and no more pictures, or picture data, in one request than its caps allow.
 * Null when the request passes, else the reason it would be refused.
 */
export function imagePolicyError({ messages }: { model?: string; messages: { role: string; content?: unknown }[] }): string | null {
  let count = 0
  let chars = 0
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as Part[]) {
      if (part.type === "text") continue
      if (part.type !== "image_url") return `Content parts of type ${part.type} aren't accepted.`
      if (message.role !== "user") return "Images are only accepted in user messages."
      const url = part.image_url?.url ?? ""
      if (!PICTURE.test(url)) return "An image must be a PNG or JPEG data URL."
      if (url.length > PROXY_MAX_IMAGE_CHARS_EACH) return "An image is too large."
      count++
      chars += url.length
    }
  }
  if (count > PROXY_MAX_IMAGES) return `The request carries more images than the ${PROXY_MAX_IMAGES} allowed.`
  if (chars > PROXY_MAX_IMAGE_CHARS_TOTAL) return "The request carries more images than fit in one request."
  return null
}
