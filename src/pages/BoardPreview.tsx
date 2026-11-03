import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import type { PreviewPicture } from "../store/projectActions"

/** A preview shown as an image: a kept picture by its link, or SVG text drawn in the preview worker. */
function Picture({ picture }: { picture: PreviewPicture }) {
  const svgUrl = useMemo(() => ("svg" in picture ? URL.createObjectURL(new Blob([picture.svg], { type: "image/svg+xml" })) : null), [picture])
  useEffect(() => () => void (svgUrl && URL.revokeObjectURL(svgUrl)), [svgUrl])
  const src = svgUrl ?? ("url" in picture ? picture.url : "")
  return <img src={src} alt="" aria-hidden draggable={false} decoding="async" className="h-full w-full object-contain" />
}

/** An image's bytes loaded and decoded, so showing it draws at once; settles either way. */
function preload(url: string): Promise<void> {
  const img = new Image()
  img.src = url
  return img.decode().catch(() => {})
}

/** True once the element has come within 320 px of view, in the closest `[data-scroll-root]` or the page. */
function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), {
      root: el.closest("[data-scroll-root]"),
      rootMargin: "320px 0px",
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

/**
 * A board preview, asked for once its place nears view (`projectPicture`, `examplePreview`). `id` says when it is another
 * one; the one shown stays until the next is ready, so a card never blanks. Nothing shows until the first comes.
 */
export function LazyPreview({ id, load, className }: { id: string; load: () => Promise<PreviewPicture | string | null>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const seen = useSeen(ref)
  const [picture, setPicture] = useState<PreviewPicture | null>(null)
  const latest = useRef(load)
  useEffect(() => {
    latest.current = load
  })
  useEffect(() => {
    if (!seen) return
    let current = true
    void latest.current().then(async (p) => {
      const next = typeof p === "string" ? { svg: p } : p
      if (next && "url" in next) await preload(next.url)
      if (current) setPicture(next)
    })
    return () => {
      current = false
    }
  }, [seen, id])
  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center">
      {picture ? (
        <div className={className ?? "h-full w-full"}>
          <Picture picture={picture} />
        </div>
      ) : null}
    </div>
  )
}
