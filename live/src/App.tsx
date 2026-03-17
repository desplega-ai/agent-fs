import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "@/contexts/theme"
import { AuthProvider } from "@/contexts/auth"
import { BrowserProvider } from "@/contexts/browser"
import { Shell } from "@/components/layout/Shell"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { CredentialsPage } from "@/pages/Credentials"
import { FileBrowserPage } from "@/pages/FileBrowser"
import { FileDetailPage } from "@/pages/FileDetail"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

function AuthenticatedShell() {
  return (
    <AuthProvider>
      <BrowserProvider>
        <Shell breadcrumbs={<Breadcrumbs />}>
          <FileBrowserPage />
        </Shell>
      </BrowserProvider>
    </AuthProvider>
  )
}

function AuthenticatedDetail() {
  return (
    <AuthProvider>
      <BrowserProvider>
        <FileDetailPage />
      </BrowserProvider>
    </AuthProvider>
  )
}

// Disambiguator: /files with no splat → browser, /files/something → detail
function FilesRouter() {
  const params = useParams()
  const splat = params["*"]

  if (!splat) return <AuthenticatedShell />
  return <AuthenticatedDetail />
}

export default function App() {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/files/*" element={<FilesRouter />} />
            <Route path="/files" element={<AuthenticatedShell />} />
            <Route path="*" element={<Navigate to="/files" replace />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  )
}
