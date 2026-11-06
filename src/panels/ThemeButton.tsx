import { Monitor, Moon, Sun } from "lucide-react"
import { cycleTheme, nextThemePref, useTheme, type ThemePref } from "../store/themeStore"
import { IconButton } from "../ui/controls"

const NAME: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" }
const ICON = { system: Monitor, light: Sun, dark: Moon } satisfies Record<ThemePref, unknown>

/** Shows the theme in use and cycles it on click: system, then each scheme in turn (`nextThemePref`). */
export function ThemeButton() {
  const pref = useTheme((s) => s.pref)
  const system = useTheme((s) => s.system)
  const next = nextThemePref(pref, system)
  const Icon = ICON[pref]
  return (
    <IconButton label={`Theme: ${NAME[pref]}${pref === "system" ? ` (${system})` : ""}`} hint={`Click for ${NAME[next]}`} onClick={cycleTheme}>
      <Icon size={17} />
    </IconButton>
  )
}
