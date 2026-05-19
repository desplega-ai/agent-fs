import { Navbar } from "@/components/Navbar"
import { Hero } from "@/components/Hero"
import { Features } from "@/components/Features"
import { HowItWorks } from "@/components/HowItWorks"
import { Footer } from "@/components/Footer"
import { DocsIndexPage, DocsPage } from "@/pages/DocsPage"

function currentRoute() {
  const pathname = window.location.pathname
  if (pathname === "/docs" || pathname === "/docs/") return { page: "docs-index" as const }
  if (pathname.startsWith("/docs/")) {
    return { page: "doc" as const, slug: pathname.replace(/^\/docs\/+/, "").replace(/\/$/, "") }
  }
  return { page: "home" as const }
}

function App() {
  const route = currentRoute()

  if (route.page === "docs-index") {
    return (
      <div className="relative min-h-screen">
        <div className="grid-bg" aria-hidden="true" />
        <Navbar />
        <DocsIndexPage />
        <Footer />
      </div>
    )
  }

  if (route.page === "doc") {
    return (
      <div className="relative min-h-screen">
        <div className="grid-bg" aria-hidden="true" />
        <Navbar wide />
        <DocsPage slug={route.slug} />
        <Footer wide />
      </div>
    )
  }

  return (
    <div className="relative min-h-screen">
      <div className="grid-bg" aria-hidden="true" />
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
      </main>
      <Footer />
    </div>
  )
}

export default App
