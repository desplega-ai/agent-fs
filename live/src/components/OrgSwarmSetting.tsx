import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { DEFAULT_SWARM_URL, endpointHost, swarmUrlFromInput } from "@/lib/key-handoff"
import { toast } from "@/stores/toast"
import { cn } from "@/lib/utils"
import type { ApiError } from "@/api/client"

function errorMessage(err: unknown): string {
  return (err as Partial<ApiError> | null)?.message || "Something went wrong"
}

const DEFAULT_HOST = endpointHost(DEFAULT_SWARM_URL)

/**
 * The org's swarm URL, for org admins: where "Continue with <swarm>" sends
 * people who open a link without a key. Empty means the default swarm.
 */
export function OrgSwarmSetting({ orgId }: { orgId: string }) {
  const { client } = useAuth()
  const org = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () => client.getOrg(orgId),
    retry: false,
  })

  let body: React.ReactNode
  if (org.isPending) body = <div className="flex justify-center py-4"><Spinner /></div>
  else if (org.error) body = <p role="alert" className="text-sm text-destructive">{errorMessage(org.error)}</p>
  else {
    const stored = org.data.swarmUrl ?? null
    // A fresh form per saved value, so the field shows what the server stored.
    body = <SwarmUrlForm key={stored ?? ""} orgId={orgId} stored={stored} />
  }

  return (
    <section aria-label="Agent Swarm" className="space-y-2">
      <h2 className="text-sm font-medium">Agent Swarm</h2>
      {body}
    </section>
  )
}

function SwarmUrlForm({ orgId, stored }: { orgId: string; stored: string | null }) {
  const { client } = useAuth()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(stored ?? "")
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (swarmUrl: string | null) => client.updateOrgSwarmUrl(orgId, swarmUrl),
    onSuccess: (org) => {
      queryClient.setQueryData(["org-settings", orgId], org)
      void queryClient.invalidateQueries({ queryKey: ["org-swarm-url"] })
      toast.success(org.swarmUrl ? `Continue now uses ${endpointHost(org.swarmUrl)}` : `Continue now uses the default, ${DEFAULT_HOST}`)
    },
    onError: (err) =>
      setError(
        (err as Partial<ApiError>).status === 400
          ? "Enter an http or https URL without a query, for example https://swarm.example.com."
          : errorMessage(err),
      ),
  })

  const submit = (value: string | null) => {
    setError(null)
    save.mutate(value)
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit(swarmUrlFromInput(draft))
  }
  const unchanged = swarmUrlFromInput(draft) === stored

  return (
    <form noValidate onSubmit={onSubmit} aria-label="Swarm URL" className="space-y-2 rounded-lg border border-border p-3">
      <label htmlFor="org-swarm-url" className="text-sm">
        People who open a link without a key sign in with this swarm.
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="org-swarm-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={`Default: ${DEFAULT_HOST}`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby="org-swarm-url-help"
          className="sm:flex-1"
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending || unchanged} className="flex-1 sm:flex-none">
            {save.isPending ? <Spinner size="sm" /> : null}
            Save
          </Button>
          {stored && (
            <Button type="button" variant="outline" disabled={save.isPending} className="flex-1 sm:flex-none" onClick={() => submit(null)}>
              Use default
            </Button>
          )}
        </div>
      </div>
      <p
        id="org-swarm-url-help"
        className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}
        role={error ? "alert" : undefined}
      >
        {error ??
          `${stored ? "" : `Default: ${DEFAULT_HOST}. `}A self-hosted swarm sets this on first start. Change it if your team uses a different swarm.`}
      </p>
    </form>
  )
}
