import { LayoutGrid, LogOut, UserRound } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"
import { leaveFor } from "../App"
import { useEditorAccount } from "../store/account"
import { Avatar } from "../ui/Avatar"
import { useDismiss } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"

function MenuLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a
      role="menuitem"
      href={href}
      onClick={(e) => {
        // A plain click waits for the last edits to land; one for a new tab leaves this page as it is.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        leaveFor(href)
      }}
      className="flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-[13px] text-ink hover:bg-chrome"
    >
      <span className="text-ink-2">{icon}</span>
      {children}
    </a>
  )
}

/**
 * Who is signed in, at the right of the top bar, and the ways out of the editor that belong to the
 * account: the projects page, account settings and signing out. Every item is a link to the host's
 * pages, a full page load, since the session and those pages are the host's.
 */
export function AccountMenu() {
  const account = useEditorAccount()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  if (!account) return null
  const { user } = account
  return (
    <div ref={ref} className="relative">
      <Tooltip label="Account" hint={user?.email}>
        <button
          aria-label="Account"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`flex size-8 items-center justify-center rounded-full transition-shadow ${open ? "ring-2 ring-line" : "hover:ring-2 hover:ring-line"}`}
        >
          <Avatar person={user} size="sm" />
        </button>
      </Tooltip>
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 top-10 z-30 w-[256px] origin-top-right animate-pop-in rounded-[10px] border border-line bg-surface p-1 shadow-menu">
          <div className="flex items-center gap-2.5 px-2.5 pb-2.5 pt-2">
            <Avatar person={user} size="md" />
            <div className="min-w-0">
              {user?.name && <div className="truncate text-[13px] font-[650] text-ink">{user.name}</div>}
              <div className={`truncate ${user?.name ? "text-[12px] text-ink-2" : "text-[13px] font-[650] text-ink"}`}>{user?.email ?? "Signed in"}</div>
            </div>
          </div>
          <div className="mx-1 mb-1 h-px bg-line" />
          <MenuLink href={account.projectsUrl} icon={<LayoutGrid size={15} />}>
            All projects
          </MenuLink>
          <MenuLink href={account.settingsUrl} icon={<UserRound size={15} />}>
            Account settings
          </MenuLink>
          <div className="mx-1 my-1 h-px bg-line" />
          <MenuLink href={account.signOutUrl} icon={<LogOut size={15} />}>
            Sign out
          </MenuLink>
        </div>
      )}
    </div>
  )
}
