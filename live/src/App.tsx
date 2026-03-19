import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
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

function FileRoute() {
  const params = useParams()
  const orgId = params.orgId!
  const driveId = params.driveId!
  const filePath = params["*"] ?? null

  return (
    <AuthProvider initialOrgId={orgId} initialDriveId={driveId}>
      <BrowserProvider initialFile={filePath}>
        <Shell breadcrumbs={<Breadcrumbs />}>
          <FileBrowserPage />
        </Shell>
      </BrowserProvider>
    </AuthProvider>
  )
}

function DetailRoute() {
  const params = useParams()
  const orgId = params.orgId!
  const driveId = params.driveId!
  const filePath = params["*"] ?? ""

  return (
    <AuthProvider initialOrgId={orgId} initialDriveId={driveId}>
      <BrowserProvider initialFile={filePath}>
        <FileDetailPage />
      </BrowserProvider>
    </AuthProvider>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/file/~/:orgId/:driveId/*" element={<FileRoute />} />
            <Route path="/detail/~/:orgId/:driveId/*" element={<DetailRoute />} />
            <Route path="/files" element={<AuthenticatedShell />} />
            <Route path="*" element={<Navigate to="/files" replace />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  )
}
