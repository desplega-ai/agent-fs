import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AgentFsClient } from "@/api/client"
import type { MeResponse, Drive, Org } from "@/api/types"
import {
  getActiveCredential,
  setActiveCredential as setStoredActive,
  type Credential,
} from "@/stores/credentials"

interface AuthContextValue {
  credential: Credential
  client: AgentFsClient
  user: MeResponse | undefined
  orgs: Org[]
  orgId: string | null
  orgName: string | null
  setOrgId: (id: string) => void
  drives: Drive[]
  driveId: string
  driveName: string | null
  setDriveId: (id: string) => void
  switchAccount: (id: string) => void
  isLoading: boolean
  error: string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [credentialId, setCredentialId] = useState(() => getActiveCredential()?.id)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(
    () => localStorage.getItem("agent-fs-active-org")
  )
  const [activeDriveId, setActiveDriveId] = useState<string | null>(
    () => localStorage.getItem("agent-fs-active-drive")
  )

  const credential = useMemo(() => {
    if (!credentialId) return null
    return getActiveCredential()
  }, [credentialId])

  useEffect(() => {
    if (!credential) {
      navigate("/credentials", { replace: true })
    }
  }, [credential, navigate])

  const client = useMemo(() => {
    if (!credential) return null
    return new AgentFsClient({ endpoint: credential.endpoint, apiKey: credential.apiKey })
  }, [credential])

  const { data: user, error: meError, isLoading: meLoading } = useQuery({
    queryKey: ["me", credential?.id],
    queryFn: () => client!.getMe(),
    enabled: !!client,
    retry: false,
  })

  const { data: orgsData } = useQuery({
    queryKey: ["orgs", credential?.id],
    queryFn: () => client!.getOrgs(),
    enabled: !!client,
  })

  const orgs = orgsData?.orgs ?? []
  const orgId = activeOrgId ?? user?.defaultOrgId ?? null
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? null

  const { data: drivesData } = useQuery({
    queryKey: ["drives", orgId],
    queryFn: () => client!.getDrives(orgId!),
    enabled: !!client && !!orgId,
  })

  const drives = drivesData?.drives ?? []
  const isDefaultOrg = orgId === user?.defaultOrgId
  const driveId = activeDriveId ?? (isDefaultOrg ? user?.defaultDriveId : null) ?? drives[0]?.id ?? ""
  const driveName = drives.find((d) => d.id === driveId)?.name ?? null

  const setOrgId = useCallback((id: string) => {
    setActiveOrgId(id)
    setActiveDriveId(null)
    localStorage.setItem("agent-fs-active-org", id)
    localStorage.removeItem("agent-fs-active-drive")
    queryClient.invalidateQueries({ queryKey: ["drives"] })
    queryClient.invalidateQueries({ queryKey: ["ls"] })
    queryClient.invalidateQueries({ queryKey: ["comments"] })
  }, [queryClient])

  const setDriveId = useCallback((id: string) => {
    setActiveDriveId(id)
    localStorage.setItem("agent-fs-active-drive", id)
    queryClient.invalidateQueries({ queryKey: ["ls"] })
    queryClient.invalidateQueries({ queryKey: ["comments"] })
  }, [queryClient])

  const switchAccount = useCallback((id: string) => {
    setStoredActive(id)
    setCredentialId(id)
    setActiveOrgId(null)
    setActiveDriveId(null)
    localStorage.removeItem("agent-fs-active-org")
    localStorage.removeItem("agent-fs-active-drive")
    queryClient.clear()
  }, [queryClient])

  const error = meError
    ? (meError as Error).message || "Failed to authenticate"
    : orgId === null && user
      ? "No org found for this API key"
      : null

  useEffect(() => {
    if (meError) {
      navigate("/credentials", { replace: true })
    }
  }, [meError, navigate])

  if (!credential || !client) return null

  return (
    <AuthContext.Provider
      value={{
        credential,
        client,
        user,
        orgs,
        orgId,
        orgName,
        setOrgId,
        drives,
        driveId,
        driveName,
        setDriveId,
        switchAccount,
        isLoading: meLoading,
        error,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
