import { createContext, useContext } from "react"

/** Who is signed in, as the top bar's account menu shows them. */
export interface AccountUser {
  /** Their name, or "" when the host has none. */
  name: string
  email: string
  /** A picture to draw in place of their initials. */
  pictureUrl?: string | null
}

/**
 * The host's account, for a host that has one: the website's is the signed-in user. The session is
 * the host's, so every way out of the editor here is a link to one of its pages.
 */
export interface EditorAccount {
  /** `null` while the host is still finding out. */
  user: AccountUser | null
  /** The host's own projects page. "All projects" leaves the editor for it, in place of the editor's dashboard. */
  projectsUrl: string
  /** Plan, usage and billing. */
  settingsUrl: string
  /** A navigation that ends the session. */
  signOutUrl: string
}

export const AccountContext = createContext<EditorAccount | undefined>(undefined)

/** The host's account; `undefined` in a host without one, such as the development harness. */
export const useEditorAccount = () => useContext(AccountContext)
