import { describe, expect, it } from "vitest"
import { fakePicture } from "./fixtures/pictures"
import type { ChatMessage } from "../src/ai/managedAi"
import { KEEP_IMAGES, MAX_IMAGE_BYTES, MAX_LOOKS_PER_REQUEST, PROXY_MAX_IMAGE_CHARS_EACH, PROXY_MAX_IMAGE_CHARS_TOTAL, PROXY_MAX_IMAGES } from "../src/ai/vision/limits"
import { countImages, dataUrl, OMITTED, pictureMessage, pruneImages } from "../src/ai/vision/messages"
// The proxy's rules for pictures, so what the editor sends is checked against its limits.
import { imagePolicyError } from "./fixtures/imagePolicy"

// Pictures in the conversation, counted one by one. A conversation keeps its pictures between
// requests, so what it holds when sent must always be something the proxy accepts: one history
// over its limits is refused, and so is every later request that carries it.

const imageUrls = (history: ChatMessage[]) =>
  history.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.flatMap((p) => (p.type === "image_url" ? [p.image_url.url] : [])) : []))

const policy = (messages: ChatMessage[]) => imagePolicyError({ model: "vendor/large", messages })

describe("pruning pictures part by part", () => {
  it("counts pictures, not messages: a batch of three is three", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }, pictureMessage([fakePicture("a"), fakePicture("b"), fakePicture("c")])]
    expect(countImages(history)).toBe(3)
    pruneImages(history, 2)
    expect(countImages(history)).toBe(2)
    // The oldest of the batch went, and a note stands where it was.
    const [first, ...rest] = (history[1].content as { type: string; text?: string }[]).slice(1)
    expect(first).toEqual({ type: "text", text: OMITTED })
    expect(rest.map((p) => p.type)).toEqual(["image_url", "image_url"])
    expect(imageUrls(history)).toEqual([dataUrl(fakePicture("b")), dataUrl(fakePicture("c"))])
  })

  it("keeps the newest across messages and says once where several went", () => {
    const history: ChatMessage[] = [
      pictureMessage([fakePicture("a"), fakePicture("b"), fakePicture("c")]),
      { role: "assistant", content: "ok" },
      pictureMessage([fakePicture("d")]),
    ]
    pruneImages(history, 2)
    expect(imageUrls(history)).toEqual([dataUrl(fakePicture("c")), dataUrl(fakePicture("d"))])
    // a and b were side by side, so one line stands for both.
    const notes = (history[0].content as { type: string; text?: string }[]).filter((p) => p.text === OMITTED)
    expect(notes).toHaveLength(1)
    expect((history[0].content as { type: string }[]).map((p) => p.type)).toEqual(["text", "text", "image_url"])
  })

  it("leaves a message alone when none of its pictures goes, and is idempotent", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }, pictureMessage([fakePicture("a")]), pictureMessage([fakePicture("b")])]
    const before = [...history]
    pruneImages(history, 2)
    expect(history).toEqual(before)
    history.push(pictureMessage([fakePicture("c")]))
    pruneImages(history, 2)
    const once = JSON.stringify(history)
    pruneImages(history, 2)
    expect(JSON.stringify(history)).toBe(once)
    expect(history[0]).toBe(before[0])
  })

  it("keeps the part of the history before the first dropped picture exactly as it was", () => {
    // The provider's prompt cache holds a request's start: only what follows an old picture changes.
    const history: ChatMessage[] = [{ role: "user", content: "build it" }, { role: "assistant", content: "done" }, pictureMessage([fakePicture("a")]), pictureMessage([fakePicture("b")])]
    const before = history.map((m) => JSON.stringify(m))
    history.push(pictureMessage([fakePicture("c")]))
    pruneImages(history, 2)
    expect(history.slice(0, 2).map((m) => JSON.stringify(m))).toEqual(before.slice(0, 2))
    expect(JSON.stringify(history[3])).toBe(before[3])
  })
})

describe("what the proxy would be sent", () => {
  it("is under every limit with three looks at the picture cap, history after history", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }]
    for (let batch = 0; batch < 5; batch++) {
      history.push(pictureMessage(["a", "b", "c"].map((t) => fakePicture(`${t}${batch}`, MAX_IMAGE_BYTES))))
      pruneImages(history, Math.max(KEEP_IMAGES, 3))
      // The batch just made is whole, the older ones are gone.
      expect(countImages(history)).toBe(3)
      expect(policy(history)).toBeNull()
    }
  })

  it("holds at the picture cap for the most the editor can keep, by arithmetic and not by luck", () => {
    const base64Chars = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + "data:image/jpeg;base64,".length
    expect(base64Chars).toBeLessThanOrEqual(PROXY_MAX_IMAGE_CHARS_EACH)
    const most = Math.max(KEEP_IMAGES, MAX_LOOKS_PER_REQUEST)
    expect(most).toBeLessThanOrEqual(PROXY_MAX_IMAGES)
    expect(most * PROXY_MAX_IMAGE_CHARS_EACH).toBeLessThanOrEqual(PROXY_MAX_IMAGE_CHARS_TOTAL)
  })

  it("repairs a history the proxy would refuse: six pictures at the cap become what fits", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }]
    for (let i = 0; i < 6; i++) history.push(pictureMessage([fakePicture(String(i), MAX_IMAGE_BYTES)]))
    expect(policy(history)).toMatch(/more images/)
    pruneImages(history, MAX_LOOKS_PER_REQUEST)
    expect(countImages(history)).toBe(3)
    expect(policy(history)).toBeNull()
  })

  it("drops a picture over the per-picture limit, and the oldest first when the total is over", () => {
    const history: ChatMessage[] = [pictureMessage([fakePicture("a", 470_000)]), pictureMessage([fakePicture("b", 470_000)]), pictureMessage([fakePicture("c", 700_000)])]
    pruneImages(history, 3, { maxEach: 640_000, maxTotal: 1_000_000, maxCount: 8 })
    // c is too big alone; a and b are about 627,000 characters each, so only the newer of them fits.
    expect(imageUrls(history)).toEqual([dataUrl(fakePicture("b", 470_000))])
    expect(policy(history)).toBeNull()
  })
})
