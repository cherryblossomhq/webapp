import { useEffect, useState } from "react"
import type { ReferenceImage } from "../model/types"
import { loadImage, onImagesChange } from "./imageFiles"

/** Starts loading a project's images and redraws the component as each arrives (`imageFiles.ts`). */
export function useImages(images: ReferenceImage[] | undefined) {
  const [, bump] = useState(0)
  useEffect(() => onImagesChange(() => bump((n) => n + 1)), [])
  useEffect(() => {
    for (const m of images ?? []) void loadImage(m.file)
  }, [images])
}
