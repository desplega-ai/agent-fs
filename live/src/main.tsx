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
import { signInWithKeyHandoff } from "./lib/key-handoff"
import { toast } from "./stores/toast"

// First, before any request or render: a "Continue with <swarm>" return
// carries an API key in the URL fragment.
signInWithKeyHandoff(window, {
  info: (message) => toast(message, { duration: 8000 }),
  error: (message) => toast.error(message),
})

installStaleChunkReload()
trackSessionStart()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
