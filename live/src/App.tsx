import { useEffect } from "react"
import { BrowserRouter, Routes, Route, Navigate, Outlet, useParams } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/contexts/theme"
import { AuthProvider, useAuth } from "@/contexts/auth"
import { BrowserProvider, useBrowser } from "@/contexts/browser"
import { Shell } from "@/components/layout/Shell"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { CredentialsPage } from "@/pages/Credentials"
import { FileBrowserPage } from "@/pages/FileBrowser"
import { FileDetailPage } from "@/pages/FileDetail"
import { Spinner } from "@/components/ui/spinner"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

/**
 * Layout that hoists AuthProvider + BrowserProvider above the authenticated
 * routes so providers stay mounted across in-app navigation. Per-route URL
 * params are synced into the providers via <RouteParamsSync/>.
 */
function AuthenticatedLayout() {
  return (
    <AuthProvider>
      <BrowserProvider>
        <Outlet />
      </BrowserProvider>
    </AuthProvider>
  )
}

/**
 * Syncs URL params (orgId, driveId, splat path) into the hoisted Auth + Browser
 * providers via post-mount setters. Mount inside any route that has these params.
 */
function RouteParamsSync({ syncFile = true }: { syncFile?: boolean } = {}) {
  const params = useParams()
  const { setOrgId, setDriveId, orgId, driveId } = useAuth()
  const { setSelectedFile } = useBrowser()

  const paramOrgId = params.orgId
  const paramDriveId = params.driveId
  const paramFile = params["*"] ?? null

  useEffect(() => {
    if (paramOrgId && paramOrgId !== orgId) {
      setOrgId(paramOrgId)
    }
  }, [paramOrgId, orgId, setOrgId])

  useEffect(() => {
    if (paramDriveId && paramDriveId !== driveId) {
      setDriveId(paramDriveId)
    }
  }, [paramDriveId, driveId, setDriveId])

  useEffect(() => {
    if (!syncFile) return
    setSelectedFile(paramFile && paramFile.length > 0 ? paramFile : null)
  }, [paramFile, syncFile, setSelectedFile])

  return null
}

function FileRoute() {
  return (
    <>
      <RouteParamsSync />
      <Shell>
        <FileBrowserPage />
      </Shell>
    </>
  )
}

function DetailRoute() {
  return (
    <>
      <RouteParamsSync />
      <Shell>
        <FileDetailPage />
      </Shell>
    </>
  )
}

function FilesRoute() {
  return (
    <Shell>
      <FileBrowserPage />
    </Shell>
  )
}

/** Resolves /orgs/:orgId/files/* to /file/~/:orgId/:driveId/* using default drive */
function OrgFileRedirect() {
  return (
    <>
      <RouteParamsSync syncFile={false} />
      <OrgFileRedirectInner />
    </>
  )
}

function OrgFileRedirectInner() {
  const params = useParams()
  const { driveId, isLoading } = useAuth()
  const orgId = params.orgId!
  const filePath = params["*"] ?? ""

  if (isLoading || !driveId) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return <Navigate to={`/file/~/${orgId}/${driveId}/${filePath}`} replace />
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
                <Route element={<AuthenticatedLayout />}>
                  <Route path="/orgs/:orgId/files/*" element={<OrgFileRedirect />} />
                  <Route path="/file/~/:orgId/:driveId/*" element={<FileRoute />} />
                  <Route path="/detail/~/:orgId/:driveId/*" element={<DetailRoute />} />
                  <Route path="/files" element={<FilesRoute />} />
                  <Route path="*" element={<Navigate to="/files" replace />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
