import { useState } from "react"

/** Someone to draw: a picture, or their initials when there is none or it won't load. */
export interface AvatarPerson {
  name: string
  email?: string
  pictureUrl?: string | null
}

export const initials = (person: AvatarPerson) =>
  person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase() ||
  person.email?.[0]?.toUpperCase() ||
  "?"

const SIZES = { xs: "size-6 text-[10px]", sm: "size-7 text-[11px]", md: "size-9 text-[13px]" }

/**
 * A person's picture, or their initials. `color` rings them in their collaborator colour and fills
 * the initials with it, so a face in the top bar matches their cursor on the canvas.
 */
export function Avatar({ person, size, color, className = "" }: { person: AvatarPerson | null; size: keyof typeof SIZES; color?: string; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null)
  const box = SIZES[size]
  if (!person) return <span className={`${box} block shrink-0 animate-pulse rounded-full bg-chrome-2 ${className}`} />
  const picture = person.pictureUrl && person.pictureUrl !== broken ? person.pictureUrl : null
  const ring = color ? { boxShadow: `0 0 0 2px var(--color-surface), 0 0 0 4px ${color}` } : undefined
  return picture ? (
    <img
      src={picture}
      alt=""
      // Google and GitHub serve these from their own hosts, and Google refuses a request that names the referring page.
      referrerPolicy="no-referrer"
      onError={() => setBroken(picture)}
      style={ring}
      className={`${box} shrink-0 rounded-full object-cover ${className}`}
    />
  ) : (
    <span
      style={color ? { ...ring, backgroundColor: color, color: "#fff" } : undefined}
      className={`${box} flex shrink-0 select-none items-center justify-center rounded-full font-[650] ${color ? "" : "bg-brand-soft text-brand"} ${className}`}
    >
      {initials(person)}
    </span>
  )
}
