import { X } from "lucide-react"
import { useEffect } from "react"
import { useTheme, type ThemePref } from "../store/themeStore"
import { useUi } from "../store/uiStore"
import { Button, IconButton, Segmented } from "../ui/controls"

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen)
  return open ? <SettingsDialogBody /> : null
}

function SettingsDialogBody() {
  const themePref = useTheme((s) => s.pref)
  const setThemePref = useTheme((s) => s.setPref)
  const close = () => useUi.getState().setSettingsOpen(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="w-full max-w-[420px] rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="settings-title" className="text-[15px] font-semibold">
            Settings
          </h2>
          <IconButton label="Close" type="button" onClick={close}>
            <X size={16} />
          </IconButton>
        </div>

        <div>
          <span className="mb-1 block text-[12px] text-ink-2">Theme</span>
          <Segmented<ThemePref>
            size="sm"
            value={themePref}
            onChange={setThemePref}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
        <p className="mt-4 text-[12px] text-ink-3">Sakura, the copilot, runs on your Cherry Blossom plan; pick its model at the top of its panel.</p>

        <div className="mt-5 flex justify-end">
          <Button type="button" variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}
