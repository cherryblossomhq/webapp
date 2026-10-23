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
  /** The link's secret: `SharingSource.inviteUrl` makes the link to copy. */
  token: string
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
