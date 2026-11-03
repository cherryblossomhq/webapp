import { useEffect, useMemo, useRef, useState } from "react"
import type { Project } from "../model/types"
import { getPreviewFills } from "../store/analysis"
import type { PreviewPicture } from "../store/projectActions"
import { boardPreviewSvg } from "./boardPreviewSvg"

/**
 * A board preview (`boardPreviewSvg`) shown as an image: the browser draws it once, where the same
 * drawing as page elements was thousands of nodes to lay out per card.
 */
export function PreviewImage({ svg }: { svg: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), [svg])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return <img src={url} alt="" aria-hidden draggable={false} className="h-full w-full object-contain" />
}

/** A preview: a kept picture by its link, or SVG text drawn here. */
function Picture({ picture }: { picture: PreviewPicture }) {
  if ("svg" in picture) return <PreviewImage svg={picture.svg} />
  return <img src={picture.url} alt="" aria-hidden draggable={false} decoding="async" className="h-full w-full object-contain" />
}

/** An image's bytes loaded and decoded, so showing it draws at once; settles either way. */
function preload(url: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve()
  const img = new Image()
  img.src = url
  return img.decode().catch(() => {})
}

/** True once the element has come within 320 px of view, in the closest `[data-scroll-root]` or the page. */
export function useSeen(ref: React.RefObject<Element | null>): boolean {
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
 * A preview that is asked for only once its place nears view, and drawn when it comes: a project's
 * (`projectPicture`) or an example's (`examplePreview`). `id` says when it is another preview. Nothing
 * shows until it comes, or when it can't be drawn.
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
      // A kept picture replaces the one drawn here once storage has it (the list then names it): load it before
      // the swap, so the card goes from one to the other without a blank frame between them.
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

/**
 * Top view of the bare board as a fab would ship it, drawn here and now. A projects page draws its
 * previews in a worker instead (`LazyPreview`); this is for a project already open.
 */
export function BoardPreview({ project }: { project: Project }) {
  const svg = useMemo(() => boardPreviewSvg(project, getPreviewFills(project)), [project])
  return <PreviewImage svg={svg} />
}
