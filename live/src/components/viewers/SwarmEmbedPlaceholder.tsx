import { ExternalLink, Shapes, Table2 } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { AgentFsClient } from "@/api/client"
import { embedFromElementProps, swarmFileHref } from "@/lib/swarm-embed"
import { useMarkdownDocPath } from "./MarkdownImage"

/**
 * What a `<SwarmSheet … />` or `<SwarmBoard … />` line shows here: one line
 * saying the object renders live in the swarm dashboard, with a link to this
 * file there when the org has a swarm. Live never loads the object. Props are
 * checked again with the Markdown grammar, so a hand-built element shows
 * nothing.
 */
export function SwarmEmbedPlaceholder(props: Record<string, unknown>) {
  const embed = embedFromElementProps(props)
  const docPath = useMarkdownDocPath()
  const { credential, orgId, driveId } = useAuth()
  // The same query the sign-in page uses, so it is usually cached already.
  const { data: swarmUrl } = useQuery({
    queryKey: ["org-swarm-url", credential.endpoint, orgId],
    queryFn: () => AgentFsClient.getOrgSwarmUrl({ endpoint: credential.endpoint, orgId: orgId! }),
    enabled: !!embed && !!orgId,
    retry: false,
    staleTime: Infinity,
  })
  if (!embed) return null

  const isSheet = embed.tag === "SwarmSheet"
  const Icon = isSheet ? Table2 : Shapes
  const href = orgId && driveId && docPath ? swarmFileHref(swarmUrl, orgId, driveId, docPath) : null
  return (
    <div
      data-swarm-embed={isSheet ? "sheet" : "board"}
      className="my-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span>{isSheet ? "Swarm sheet" : "Swarm board"} · renders live in the swarm dashboard.</span>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
        >
          Open in swarm
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </div>
  )
}
