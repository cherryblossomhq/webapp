import type { ProjectRole } from "./storage"

/**
 * Sharing a project with other people by email, as the Share dialog (`panels/ShareDialog.tsx`)
 * sees it. The host implements it: the website's is the hosted app's, which sends the
 * invitations. The editor holds no rule about who may do what: `SharingState` says what the user
 * may do (`canInvite`, `canManage`), and the host refuses anything else whatever the dialog shows.
 */

export type MemberRole = "editor" | "viewer"

export interface SharePerson {
  userId: string
  name: string
  email: string
  pictureUrl?: string
}

export interface ShareMember extends SharePerson {
  role: MemberRole
}

export interface ShareInvite {
  id: string
  /** The address it was sent to. */
  email: string
  role: MemberRole
  /**
   * The link's secret, which `SharingSource.inviteUrl` makes the link to copy. Only for the owner
   * and whoever sent it: a link is a way into the project.
   */
  token?: string
  /** `not_configured`: the host sends no email, and the link is the inviter's to send. */
  emailStatus: "sending" | "sent" | "failed" | "not_configured"
  expired: boolean
  /** Sent by this user, who may withdraw it whatever their role. */
  mine: boolean
  createdAt: number
}

export interface SharingState {
  role: ProjectRole
  /** The user's own id, to tell them apart in the list. */
  you: string
  canInvite: boolean
  canManage: boolean
  owner: SharePerson
  members: ShareMember[]
  /** Open invitations; empty for a viewer, who sees none. */
  invites: ShareInvite[]
}

export type InviteResult =
  | { ok: true; outcomes: { email: string; status: "invited" | "renewed" | "member" }[]; emailConfigured: boolean }
  | { ok: false; message: string }

export interface SharingSource {
  /** Who has a project, live. `null` when the user has no access to it. */
  watch(projectId: string, listener: (state: SharingState | null) => void, onError: (error: Error) => void): () => void
  invite(projectId: string, emails: string[], role: MemberRole, message?: string): Promise<InviteResult>
  /** Send an open invitation again, under a new link. */
  resend(inviteId: string): Promise<{ ok: true } | { ok: false; message: string }>
  revoke(inviteId: string): Promise<void>
  setRole(projectId: string, userId: string, role: MemberRole): Promise<void>
  /** Take the project from a member, or (with the user's own id) leave it. */
  removeMember(projectId: string, userId: string): Promise<void>
  /** The link an invitation opens, to copy and send by hand. */
  inviteUrl(token: string): string
}

/**
 * Sharing for the development harness, which has no accounts: invitations kept in this tab's
 * memory and never sent, so the Share dialog can be seen and driven (`/editor-harness?account`)
 * without a backend. Nobody can accept one.
 */
export function localSharing(owner: SharePerson): SharingSource {
  let state: SharingState = { role: "owner", you: owner.userId, canInvite: true, canManage: true, owner, members: [], invites: [] }
  const listeners = new Set<(s: SharingState) => void>()
  const set = (next: SharingState) => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b % 64]).join("").slice(0, 43)
  return {
    watch(_projectId, listener) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async invite(_projectId, emails, role) {
      const outcomes: { email: string; status: "invited" | "renewed" | "member" }[] = []
      let invites = state.invites
      for (const raw of emails) {
        const email = raw.trim().toLowerCase()
        if (email === owner.email.toLowerCase()) outcomes.push({ email, status: "member" })
        else if (invites.some((i) => i.email === email)) {
          invites = invites.map((i) => (i.email === email ? { ...i, role, token: token() } : i))
          outcomes.push({ email, status: "renewed" })
        } else {
          invites = [...invites, { id: `inv_${token().slice(0, 8)}`, email, role, token: token(), emailStatus: "not_configured", expired: false, mine: true, createdAt: Date.now() }]
          outcomes.push({ email, status: "invited" })
        }
      }
      set({ ...state, invites })
      return { ok: true, outcomes, emailConfigured: false }
    },
    async resend(inviteId) {
      set({ ...state, invites: state.invites.map((i) => (i.id === inviteId ? { ...i, token: token() } : i)) })
      return { ok: true }
    },
    async revoke(inviteId) {
      set({ ...state, invites: state.invites.filter((i) => i.id !== inviteId) })
    },
    async setRole(_projectId, userId, role) {
      set({ ...state, members: state.members.map((m) => (m.userId === userId ? { ...m, role } : m)) })
    },
    async removeMember(_projectId, userId) {
      set({ ...state, members: state.members.filter((m) => m.userId !== userId) })
    },
    inviteUrl: (t) => `${window.location.origin}/invite/${t}`,
  }
}
