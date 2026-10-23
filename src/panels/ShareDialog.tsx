import { Check, Link2, Mail, RotateCw, Users, X } from "lucide-react"
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react"
import { goHome } from "../App"
import { projectStorage, useProjectStore } from "../store/projectStore"
import type { MemberRole, ShareInvite, ShareMember, SharingSource, SharingState } from "../store/sharing"
import { Avatar } from "../ui/Avatar"
import { Button, IconButton } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"

/**
 * Sharing the open project: invite people by email as editors or viewers, see who has it, and
 * (for the owner) change what they may do or take it away. Who may do what is the host's to decide;
 * this shows what `SharingState` says the user may do, and says the host's refusals as they come.
 */

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/
const ROLE_LABEL: Record<MemberRole, string> = { editor: "Can edit", viewer: "Can view" }

function useSharing(source: SharingSource, projectId: string) {
  const [state, setState] = useState<SharingState | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () =>
      source.watch(
        projectId,
        (next) => {
          setState(next)
          setError(null)
        },
        (e) => setError(e.message),
      ),
    [source, projectId],
  )
  return { state, error }
}

function RoleSelect({ value, onChange, disabled, label }: { value: MemberRole; onChange: (role: MemberRole) => void; disabled?: boolean; label: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as MemberRole)}
      className="h-8 shrink-0 cursor-pointer rounded-[var(--radius-ctl)] border border-line bg-field pl-2 pr-1 text-[12.5px] text-ink outline-none hover:bg-hover focus:border-select disabled:cursor-default disabled:opacity-60"
    >
      <option value="editor">Can edit</option>
      <option value="viewer">Can view</option>
    </select>
  )
}

/** Addresses typed into the invite field, as chips: comma, space, Enter or a paste ends one. */
function EmailField({ emails, setEmails, onSubmit, disabled }: { emails: string[]; setEmails: (e: string[]) => void; onSubmit: () => void; disabled: boolean }) {
  const [draft, setDraft] = useState("")
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const take = (text: string) => {
    const found = text
      .split(/[\s,;]+/)
      .map((e) => e.trim().replace(/^<|>$/g, ""))
      .filter(Boolean)
    if (!found.length) return false
    setEmails([...new Set([...emails, ...found.map((e) => e.toLowerCase())])])
    setDraft("")
    return true
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (!take(draft) && emails.length) onSubmit()
    } else if ((e.key === "," || e.key === " " || e.key === ";") && draft.trim()) {
      e.preventDefault()
      take(draft)
    } else if (e.key === "Backspace" && !draft && emails.length) {
      setEmails(emails.slice(0, -1))
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text")
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault()
      take(text)
    }
  }
  return (
    <div
      className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 rounded-[var(--radius-ctl)] border border-line bg-field px-1.5 py-1 focus-within:border-select"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          input.current?.focus()
        }
      }}
    >
      {emails.map((email) => (
        <span
          key={email}
          className={`flex h-6 items-center gap-1 rounded-[5px] pl-2 pr-1 text-[12px] ${EMAIL.test(email) ? "bg-chrome-2 text-ink" : "bg-danger-soft text-danger"}`}
          title={EMAIL.test(email) ? undefined : "Not an email address"}
        >
          {email}
          <button type="button" aria-label={`Remove ${email}`} className="rounded-[3px] p-0.5 text-ink-3 hover:text-ink" onClick={() => setEmails(emails.filter((x) => x !== email))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        aria-label="Email addresses to invite"
        type="email"
        multiple
        disabled={disabled}
        value={draft}
        placeholder={emails.length ? "" : "Add people by email"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        onBlur={() => take(draft)}
        className="h-6 min-w-[140px] flex-1 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  )
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label={copied ? "Link copied" : "Copy invitation link"}
      hint={copied ? undefined : "Send it to them yourself: it opens the project once they sign in"}
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        })
      }}
    >
      {copied ? <Check size={15} className="text-ok" /> : <Link2 size={15} />}
    </IconButton>
  )
}

function inviteLine(invite: ShareInvite) {
  if (invite.expired) return "Invitation expired"
  switch (invite.emailStatus) {
    case "sending":
      return "Sending invitation…"
    case "sent":
      return "Invitation sent"
    case "failed":
      return "The email didn't send: copy the link"
    case "not_configured":
      return "Not emailed: copy the link and send it"
  }
}

function PersonRow({ avatar, title, subtitle, children }: { avatar: ReactNode; title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex min-h-11 items-center gap-2.5 py-1">
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-[600] text-ink">{title}</div>
        {subtitle && <div className="truncate text-[12px] text-ink-2">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </li>
  )
}

/** A button that asks once more before doing something that can't be taken back. */
function ConfirmButton({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!asking) return
    const t = setTimeout(() => setAsking(false), 3500)
    return () => clearTimeout(t)
  }, [asking])
  return (
    <Button variant={asking ? "danger" : "ghost"} className="h-7 px-2 text-[12px]" onClick={() => (asking ? onConfirm() : setAsking(true))}>
      {asking ? confirm : label}
    </Button>
  )
}

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project)
  const source = projectStorage()?.sharing
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])
  if (!project || !source) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="share-title" className="w-full max-w-[520px] animate-pop-in rounded-[var(--radius-panel)] border border-line bg-surface shadow-dialog">
        <ShareBody source={source} projectId={project.id} projectName={project.name} onClose={onClose} />
      </div>
    </div>
  )
}

type Sent = { tone: "ok" | "error"; text: string }

function ShareBody({ source, projectId, projectName, onClose }: { source: SharingSource; projectId: string; projectName: string; onClose: () => void }) {
  const { state, error } = useSharing(source, projectId)
  const [emails, setEmails] = useState<string[]>([])
  const [role, setRole] = useState<MemberRole>("editor")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)

  const invalid = emails.filter((e) => !EMAIL.test(e))
  const invite = async () => {
    if (!emails.length || invalid.length || busy) return
    setBusy(true)
    setSent(null)
    try {
      const result = await source.invite(projectId, emails, role, message.trim() || undefined)
      if (!result.ok) {
        setSent({ tone: "error", text: result.message })
        return
      }
      const invited = result.outcomes.filter((o) => o.status !== "member").map((o) => o.email)
      const members = result.outcomes.filter((o) => o.status === "member").map((o) => o.email)
      const parts = [
        invited.length &&
          (result.emailConfigured
            ? `Invited ${listOf(invited)}. ${invited.length === 1 ? "They'll" : "They'll each"} get an email with a link.`
            : `Invited ${listOf(invited)}. Email isn't set up here, so copy ${invited.length === 1 ? "their link" : "each link"} below and send it.`),
        members.length && `${listOf(members)} ${members.length === 1 ? "has" : "have"} access already.`,
      ].filter(Boolean)
      setSent({ tone: "ok", text: parts.join(" ") })
      setEmails([])
      setMessage("")
    } catch {
      setSent({ tone: "error", text: "Couldn't send the invitation. Check your connection and try again." })
    } finally {
      setBusy(false)
    }
  }

  const act = (run: () => Promise<unknown>) => {
    run().catch((e: unknown) => setSent({ tone: "error", text: e instanceof Error ? e.message : "That didn't work. Try again." }))
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 id="share-title" className="min-w-0 truncate text-[15px] font-[650] text-ink">
          Share “{projectName}”
        </h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>

      <div className="px-5 pb-5 pt-4">
        {state === undefined && !error && <div className="h-40 animate-pulse rounded-[8px] bg-chrome" />}
        {(state === null || error) && (
          <p className="text-[13px] text-ink-2">{error ? "Couldn't load who this project is shared with. Check your connection." : "This project isn't shared with you any more."}</p>
        )}
        {state && (
          <>
            {state.canInvite ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void invite()
                }}
              >
                <div className="flex items-start gap-2">
                  <EmailField emails={emails} setEmails={setEmails} onSubmit={() => void invite()} disabled={busy} />
                  <RoleSelect value={role} onChange={setRole} label="What they may do" />
                  <Button type="submit" variant="primary" disabled={!emails.length || !!invalid.length || busy} className="h-9">
                    {busy ? "Inviting…" : "Invite"}
                  </Button>
                </div>
                {emails.length > 0 && (
                  <textarea
                    aria-label="A note for the email"
                    value={message}
                    maxLength={500}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Add a note (optional)"
                    rows={2}
                    className="mt-2 w-full resize-none rounded-[var(--radius-ctl)] border border-line bg-field px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-select"
                  />
                )}
                {invalid.length > 0 && <p className="mt-1.5 text-[12px] text-danger">{listOf(invalid)} {invalid.length === 1 ? "isn't an email address" : "aren't email addresses"}.</p>}
              </form>
            ) : (
              <p className="rounded-[8px] bg-chrome px-3 py-2 text-[12.5px] text-ink-2">You can view this project. Its owner and editors can invite people.</p>
            )}
            {sent && (
              <p role="status" className={`mt-2.5 text-[12.5px] ${sent.tone === "ok" ? "text-ok" : "text-danger"}`}>
                {sent.text}
              </p>
            )}

            <h3 className="mb-1 mt-5 text-[12px] font-[600] text-ink-2">People with access</h3>
            <ul className="divide-y divide-line/60">
              <PersonRow
                avatar={<Avatar person={state.owner} size="sm" />}
                title={
                  <>
                    {state.owner.name || state.owner.email || "The owner"}
                    {state.owner.userId === state.you && <span className="font-[400] text-ink-2"> (you)</span>}
                  </>
                }
                subtitle={state.owner.name ? state.owner.email : undefined}
              >
                <span className="px-2 text-[12.5px] text-ink-2">Owner</span>
              </PersonRow>
              {state.members.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  state={state}
                  onRole={(r) => act(() => source.setRole(projectId, m.userId, r))}
                  onRemove={() =>
                    act(async () => {
                      await source.removeMember(projectId, m.userId)
                      // Leaving: the project is gone from here.
                      if (m.userId === state.you) goHome()
                    })
                  }
                />
              ))}
              {state.invites.map((i) => (
                <PersonRow
                  key={i.id}
                  avatar={
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-line text-ink-3">
                      <Mail size={13} />
                    </span>
                  }
                  title={i.email}
                  subtitle={<span className={i.expired || i.emailStatus === "failed" ? "text-warn" : undefined}>{inviteLine(i)}</span>}
                >
                  <span className="px-1 text-[12.5px] text-ink-2">{ROLE_LABEL[i.role]}</span>
                  <CopyLink url={source.inviteUrl(i.token)} />
                  {(state.canManage || i.mine) && (
                    <>
                      <IconButton label="Send again" hint="A new email with a new link; the old link stops working" onClick={() => act(() => source.resend(i.id).then((r) => (r.ok ? undefined : setSent({ tone: "error", text: r.message }))))}>
                        <RotateCw size={14} />
                      </IconButton>
                      <IconButton label="Withdraw invitation" onClick={() => act(() => source.revoke(i.id))}>
                        <X size={15} />
                      </IconButton>
                    </>
                  )}
                </PersonRow>
              ))}
            </ul>
            <p className="mt-4 flex items-start gap-1.5 text-[12px] leading-[1.45] text-ink-3">
              <Users size={13} className="mt-px shrink-0" />
              Everyone with access works on the same board, live: they see each other's cursors and changes as they happen.
              {state.role === "owner" ? " Editors can invite people; only you can change roles." : ""}
            </p>
          </>
        )}
      </div>
    </>
  )
}

function MemberRow({ member, state, onRole, onRemove }: { member: ShareMember; state: SharingState; onRole: (r: MemberRole) => void; onRemove: () => void }) {
  const isYou = member.userId === state.you
  return (
    <PersonRow
      avatar={<Avatar person={member} size="sm" />}
      title={
        <>
          {member.name || member.email}
          {isYou && <span className="font-[400] text-ink-2"> (you)</span>}
        </>
      }
      subtitle={member.name ? member.email : undefined}
    >
      {state.canManage ? (
        <>
          <RoleSelect value={member.role} onChange={onRole} label={`What ${member.name || member.email} may do`} />
          <ConfirmButton label="Remove" confirm="Remove access?" onConfirm={onRemove} />
        </>
      ) : (
        <>
          <span className="px-2 text-[12.5px] text-ink-2">{ROLE_LABEL[member.role]}</span>
          {isYou && (
            <ConfirmButton label="Leave" confirm="Leave project?" onConfirm={onRemove} />
          )}
        </>
      )}
    </PersonRow>
  )
}

const listOf = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`)

/** The top bar's Share button: brand-coloured, as the way to bring someone in. */
export function ShareButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip label="Share" hint="Invite people by email to work on this board with you">
      <button onClick={onClick} className="flex h-8 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-brand px-3 text-[12.5px] font-[650] text-white transition-[filter] hover:brightness-110">
        Share
      </button>
    </Tooltip>
  )
}
