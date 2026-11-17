import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { Spinner } from "@/components/ui/spinner"
import { useDriveResolution, type DriveResolution, type DriveTarget } from "@/hooks/use-drive-resolution"
import { drivePathFor, isAdminView, takesPath, type DriveScopeIds, type DriveView } from "@/lib/drive-route"

interface DriveScopeValue {
  resolution: DriveResolution
  /** The org and drive the address names, once resolved. */
  ids: DriveScopeIds | null
  /** The org and drive (or only the org, when the route keeps the active drive) are the active ones. */
  inContext: boolean
  /** An org-scoped key cannot open this org. */
  outOfKeyScope: boolean
  /** Rebuilds this address for another drive, by ID, keeping the rest of it. */
  addressFor: (ids: DriveScopeIds) => string
  names: { org: string; drive: string } | null
}

const DriveScopeContext = createContext<DriveScopeValue | null>(null)

/** The route's drive scope, or null outside a drive route (e.g. `/files`). */
export function useDriveScope(): DriveScopeValue | null {
  return useContext(DriveScopeContext)
}

/** The org and drive of the route. Only inside <DriveScopeGate>, where they are resolved. */
export function useRouteDrive(): DriveScopeIds {
  const ids = useContext(DriveScopeContext)?.ids
  if (!ids) throw new Error("useRouteDrive must be used inside DriveScopeGate")
  return ids
}

function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * The drive part of an address, by ID (`/<view>/~/<org id>/<drive id>/…`) or
 * by name (`/<view>/<org name>/<drive name>/…`). Both forms of a view render
 * through this component, so switching an address between them keeps the
 * page mounted. It resolves the drive, syncs it into the auth and browser
 * contexts like the routes did before, and moves an ID address to the name
 * form once the names are known to be unambiguous.
 */
export function DriveScope({
  view,
  syncFile = true,
  syncDrive = true,
  children,
}: {
  view: DriveView
  syncFile?: boolean
  /** False keeps the active drive (Members, Webhooks manage a drive without browsing it). */
  syncDrive?: boolean
  children: ReactNode
}) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { user, orgId, driveId, setOrgId, setDriveId } = useAuth()
  const { setSelectedFile } = useBrowser()

  // Names come from the raw segments, decoded once: the router's params decode
  // `%25` a second time.
  const segments = location.pathname.split("/")
  const byId = segments[2] === "~"
  const rawRest = segments.slice(byId ? 5 : 4).join("/")
  const orgName = decodeSegment(segments[2])
  const driveName = decodeSegment(segments[3])
  const target: DriveTarget | null = byId
    ? params.orgId && params.driveId ? { ids: { orgId: params.orgId, driveId: params.driveId } } : null
    : orgName !== null && driveName !== null ? { names: { org: orgName, drive: driveName } } : null
  const resolution = useDriveResolution(target, isAdminView(view))
  const ids = resolution.status === "ready" ? resolution.ids : null
  const names = resolution.status === "ready" ? resolution.names : null
  const outOfKeyScope = !!ids && !!user?.scopedOrgId && ids.orgId !== user.scopedOrgId
  const paramFile = params["*"] ?? null

  // URL -> context fires only when the resolved drive changes. The router
  // applies navigations inside a transition, so an in-app org or drive switch
  // commits its context update while this route (and its stale address) is
  // still mounted; reading the context through a ref keeps that commit from
  // re-running the sync and undoing the switch.
  const ctxRef = useRef({ orgId, driveId })
  useEffect(() => {
    ctxRef.current = { orgId, driveId }
  })

  const targetOrgId = outOfKeyScope ? undefined : ids?.orgId
  const targetDriveId = outOfKeyScope || !syncDrive ? undefined : ids?.driveId
  useEffect(() => {
    if (targetOrgId && targetOrgId !== ctxRef.current.orgId) setOrgId(targetOrgId)
  }, [targetOrgId, setOrgId])

  useEffect(() => {
    if (targetDriveId && targetDriveId !== ctxRef.current.driveId) setDriveId(targetDriveId)
  }, [targetDriveId, setDriveId])

  useEffect(() => {
    if (!syncFile) return
    setSelectedFile(paramFile && paramFile.length > 0 ? paramFile : null)
  }, [paramFile, syncFile, setSelectedFile])

  const addressFor = (to: DriveScopeIds) =>
    drivePathFor(view, to, null) + (takesPath(view) ? rawRest : "") + location.search + location.hash

  // An ID address moves to the name form, keeping the encoded path, query,
  // fragment and history state. Same component, so nothing remounts.
  const canonical = byId && ids && names && !outOfKeyScope ? drivePathFor(view, ids, names) + (takesPath(view) ? rawRest : "") : null
  useEffect(() => {
    if (!canonical) return
    navigate({ pathname: canonical, search: location.search, hash: location.hash }, { replace: true, state: location.state })
  }, [canonical, location.search, location.hash, location.state, navigate])

  const inContext = !!ids && !outOfKeyScope && orgId === ids.orgId && (!syncDrive || driveId === ids.driveId)
  const value: DriveScopeValue = { resolution, ids, inContext, outOfKeyScope, addressFor, names: target && "names" in target ? target.names : null }
  return <DriveScopeContext.Provider value={value}>{children}</DriveScopeContext.Provider>
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 p-4 text-center text-sm">{children}</div>
}

/**
 * Renders the page once its drive is resolved and active, so no page starts
 * requests against the previous drive. Until then: a spinner, or why the
 * address opens nothing.
 */
export function DriveScopeGate({ children }: { children: ReactNode }) {
  const scope = useContext(DriveScopeContext)
  const { orgs, user } = useAuth()
  if (!scope) return <>{children}</>
  const { resolution, names } = scope
  const label = names ? `“${names.drive}” in “${names.org}”` : "this drive"

  if (resolution.status === "loading") {
    return (
      <Centered>
        <Spinner />
      </Centered>
    )
  }
  if (resolution.status === "failed") {
    return <Centered>Couldn’t load your drives to open {label}. Reload the page to try again.</Centered>
  }
  if (resolution.status === "missing") {
    return (
      <Centered>
        <p>None of your drives is {label}.</p>
        <Link to="/files" className="text-xs text-muted-foreground underline">Go to your files</Link>
      </Centered>
    )
  }
  if (resolution.status === "ambiguous") {
    return (
      <Centered>
        <p>More than one of your drives is {label}. Which one?</p>
        {resolution.pairs.map((pair) => (
          <Link key={`${pair.orgId}/${pair.driveId}`} to={scope.addressFor(pair)} replace className="underline">
            {names?.org} / {names?.drive} ({pair.driveId.slice(0, 8)})
          </Link>
        ))}
      </Centered>
    )
  }
  if (scope.outOfKeyScope) {
    const keyOrg = orgs.find((o) => o.id === user?.scopedOrgId)?.name ?? "its org"
    return <Centered>This key can only open {keyOrg}.</Centered>
  }
  return scope.inContext ? <>{children}</> : null
}
