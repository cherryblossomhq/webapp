import { useEffect, useState } from "react"
import { loadImage, onImagesChange } from "./imageFiles"

/** Starts loading a project's images (a board's, or a schematic's pictures in the file store) and redraws the component as each arrives (`imageFiles.ts`). */
export function useImages(images: readonly { file: string }[] | undefined) {
  const [, bump] = useState(0)
  useEffect(() => onImagesChange(() => bump((n) => n + 1)), [])
  useEffect(() => {
    for (const m of images ?? []) void loadImage(m.file)
  }, [images])
}
