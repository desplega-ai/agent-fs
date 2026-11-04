import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/space-grotesk/400.css"
import "@fontsource/space-grotesk/500.css"
import "@fontsource/space-grotesk/700.css"
import "@fontsource/jetbrains-mono/400.css"
import "./index.css"
import App from "./App"
import { trackSessionStart } from "./lib/telemetry"
import { installStaleChunkReload } from "./lib/stale-chunk"
import { applyKeyHandoff, takeKeyHandoff } from "./lib/key-handoff"
import { toast } from "./stores/toast"

// First, before any request or render: a "Continue with <swarm>" return
// carries an API key in the URL fragment.
const handoff = takeKeyHandoff(window)
if (handoff && !applyKeyHandoff(handoff).ok) {
  toast.error("The sign-in link did not say which agent-fs server it is for. Connect with a key instead.")
}

installStaleChunkReload()
trackSessionStart()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
