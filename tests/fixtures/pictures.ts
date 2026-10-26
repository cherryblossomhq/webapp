const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A picture of about `bytes` bytes that starts like a real PNG (the proxy checks); `tag` makes it recognisable. */
export const fakePicture = (tag: string, bytes = 440_000) => {
  const body = Buffer.alloc(Math.max(0, bytes - PNG_MAGIC.length), tag.charCodeAt(0))
  return { mediaType: "image/png" as const, base64: Buffer.concat([PNG_MAGIC, body]).toString("base64"), width: 1000, height: 1000, bytes }
}
