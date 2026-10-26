// What a screenshot for the model may cost. An image is billed by its pixels, about width x
// height / 750 tokens on Claude, so the pixel caps are the token caps, and the byte cap keeps a
// request far below the proxy's and the host's body limits.

export type LookDetail = "normal" | "high"

export const LOOK_SIZES: Record<LookDetail, { maxEdge: number; maxPixels: number }> = {
  // 1200 x 900 is the largest 4:3 picture here: about 1,440 tokens.
  normal: { maxEdge: 1280, maxPixels: 1_100_000 },
  // For a crowded board seen whole: about 2,270 tokens.
  high: { maxEdge: 1600, maxPixels: 1_700_000 },
}

/** The shortest side a picture gets, so a long thin board is still readable. */
export const MIN_EDGE = 96

/** The most an encoded picture may weigh, before base64. */
export const MAX_IMAGE_BYTES = 450_000

/** Pictures the copilot may ask for in one request, enforced in code and not left to the prompt. */
export const MAX_LOOKS_PER_REQUEST = 3

/**
 * Pictures kept in the conversation sent to the model, counted one by one and not by message;
 * earlier ones become a line of text. A batch of looks made in one turn is kept whole (up to
 * `MAX_LOOKS_PER_REQUEST`), so the model never has a picture it just asked for taken away.
 */
export const KEEP_IMAGES = 2

/**
 * What the managed AI proxy accepts of the pictures in one request. A conversation
 * keeps its pictures between requests, so these are enforced on the history before every send:
 * one over the limit would be refused and every later request in the conversation with it.
 */
export const PROXY_MAX_IMAGE_CHARS_EACH = 640_000
export const PROXY_MAX_IMAGES = 8
export const PROXY_MAX_IMAGE_CHARS_TOTAL = 3_200_000

export interface PixelSize {
  width: number
  height: number
}

/** The picture size for a view of this aspect ratio (width over height), inside the caps. */
export function fitSize(aspect: number, detail: LookDetail = "normal"): PixelSize {
  const { maxEdge, maxPixels } = LOOK_SIZES[detail]
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  // The pixel cap sets the size of the picture, the edge cap its longest side.
  let width = Math.sqrt(maxPixels * a)
  let height = width / a
  if (width > maxEdge) {
    width = maxEdge
    height = width / a
  }
  if (height > maxEdge) {
    height = maxEdge
    width = height * a
  }
  width = Math.max(MIN_EDGE, Math.floor(width))
  height = Math.max(MIN_EDGE, Math.floor(height))
  // A very thin view held up to the shortest side can overshoot the pixel cap: shrink the long side.
  while (width * height > maxPixels && (width > MIN_EDGE || height > MIN_EDGE)) {
    if (width >= height) width = Math.max(MIN_EDGE, Math.floor(width * 0.95))
    else height = Math.max(MIN_EDGE, Math.floor(height * 0.95))
  }
  return { width, height }
}

/** What an image costs on Claude: width x height / 750 tokens, rounded up. */
export const imageTokens = ({ width, height }: PixelSize) => Math.ceil((width * height) / 750)

/** How many pictures one request has left. Made fresh for each request the user sends. */
export interface LookBudget {
  used: number
  max: number
}

export const newLookBudget = (max = MAX_LOOKS_PER_REQUEST): LookBudget => ({ used: 0, max })
