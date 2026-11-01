import type { ProjectRole } from "./storage"

/**
 * Sharing a project with other people, by email or by link, as the Share dialog
 * (`panels/ShareDialog.tsx`) sees it. The host implements it: the website's is the hosted
 * app's, which sends the invitations. The editor holds no rule about who may do what:
 * `SharingState` says what the user may do (`canInvite`, `canManage`), and the host refuses
 * anything else whatever the dialog shows.
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

/**
 * Who the project's link lets in: anyone signed in who opens it, as `role`, or (`role: null`) no
 * one but the people invited. `token` is the link's secret while it is on, which
 * `SharingSource.linkUrl` makes the link to copy.
 */
export interface ShareLink {
  role: MemberRole | null
  token?: string
}

export interface SharingState {
  role: ProjectRole
  /** The user's own id, to tell them apart in the list. */
  you: string
  canInvite: boolean
  /** Changing roles, removing people, and the link: the owner's. */
  canManage: boolean
  /** The user has the project only through its link: they invite no one, and see no addresses. */
  viaLink: boolean
  link: ShareLink
  owner: SharePerson
  members: ShareMember[]
  /** Open invitations; empty for a viewer, who sees none. */
  invites: ShareInvite[]
}

/**
 * What one address came to: a new invitation, an open one sent again under a new link, someone
 * else's open invitation left as it is (only its sender or the owner sends it again), or a person
 * who has the project already.
 */
export type InviteStatus = "invited" | "renewed" | "pending" | "member"

export type InviteResult =
  | { ok: true; outcomes: { email: string; status: InviteStatus }[]; emailConfigured: boolean }
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
  /**
   * Open the project to anyone signed in with its link, as viewers or editors, or (`null`) only to
   * the people invited. `reset` makes a new link: the old one stops working, for everyone who came
   * in through it too. Turning the link off and on again keeps it.
   */
  setLink(projectId: string, role: MemberRole | null, reset?: boolean): Promise<{ ok: true } | { ok: false; message: string }>
  /** The project's link, to copy and post anywhere. */
  linkUrl(token: string): string
}

/**
 * Sharing for the development harness, which has no accounts: invitations and the link kept in
 * this tab's memory and never sent, so the Share dialog can be seen and driven
 * (`/editor-harness?account`) without a backend. Nobody can accept or open one.
 */
export function localSharing(owner: SharePerson): SharingSource {
  let state: SharingState = { role: "owner", you: owner.userId, canInvite: true, canManage: true, viaLink: false, link: { role: null }, owner, members: [], invites: [] }
  let linkToken: string | undefined
  const listeners = new Set<(s: SharingState) => void>()
  const set = (next: SharingState) => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(43)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b % 64]).join("")
  return {
    watch(_projectId, listener) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async invite(_projectId, emails, role) {
      const outcomes: { email: string; status: InviteStatus }[] = []
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
    async setLink(_projectId, role, reset) {
      if (reset || !linkToken) linkToken = token()
      set({ ...state, link: role ? { role, token: linkToken } : { role: null } })
      return { ok: true }
    },
    linkUrl: (t) => `${window.location.origin}/share/${t}`,
  }
}
