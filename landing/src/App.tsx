import { Navbar } from "@/components/Navbar"
import { Hero } from "@/components/Hero"
import { Features } from "@/components/Features"
import { HowItWorks } from "@/components/HowItWorks"
import { Footer } from "@/components/Footer"
import { DocsPage } from "@/pages/DocsPage"
import { Outlet, useParams } from "react-router-dom"
import { ThemeProvider } from "@/lib/theme"

export function HomePage() {
  return (
    <main>
      <Hero />
      <Features />
      <HowItWorks />
    </main>
  )
}

export function DocDetailPage() {
  const { slug } = useParams()
  return <DocsPage slug={slug} />
}

export function AppLayout({ wide = false }: { wide?: boolean }) {
  return (
    <ThemeProvider>
      <div className="relative min-h-screen">
        <div className="grid-bg" aria-hidden="true" />
        <Navbar wide={wide} />
        <Outlet />
        <Footer wide={wide} />
      </div>
    </ThemeProvider>
  )
}
