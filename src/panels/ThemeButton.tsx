import { Moon, Sun } from "lucide-react"
import { toggleTheme, useTheme } from "../store/themeStore"
import { IconButton } from "../ui/controls"

/** Flips between light and dark; "System" is in Settings. */
export function ThemeButton() {
  const scheme = useTheme((s) => s.scheme)
  return (
    <IconButton label={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
      {scheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </IconButton>
  )
}
