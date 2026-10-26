import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App, type ManagedAiHost } from "../src"
import "../src/index.css"

/**
 * Sakura, the copilot, runs on Cherry Blossom's managed AI, which this build doesn't have: with no
 * session the copilot shows its sign-in notice and never makes a request. Signing in opens the
 * hosted app, where Sakura is.
 */
const hostedApp: ManagedAiHost = {
  getAccessToken: async () => null,
  signIn: () => window.open("https://www.trycherryblossom.com/app", "_blank", "noopener"),
}

/**
 * The editor on its own: projects in this browser's storage, 3D model files in its IndexedDB, and
 * the editor's own dashboard as the home page.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App managedAi={hostedApp} />
  </StrictMode>,
)
