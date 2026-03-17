const FEATURES = [
  {
    title: "Agent-first",
    description: "Designed for autonomous agents to read, write, and share files across systems without human intervention.",
  },
  {
    title: "CLI + MCP",
    description: "Full CLI for scripting and automation. MCP server for Claude Code, Codex, and any MCP-compatible agent.",
  },
  {
    title: "Semantic search",
    description: "Find files by meaning, not just name. Full-text search and vector embeddings built in.",
  },
  {
    title: "Self-hostable",
    description: "SQLite metadata + S3-compatible blob storage. Run anywhere. Your data stays yours.",
  },
]

export function Features() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-32">
      <div className="mb-16 max-w-lg">
        <p className="text-sm font-mono tracking-widest text-neon/70 uppercase mb-3">Why agent-fs</p>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Infrastructure for the agent&nbsp;era.
        </h2>
        <p className="mt-4 text-muted-foreground leading-relaxed">
          Agents are the new users. They need a file system that speaks their language — APIs, search, and interop. Not mount points.
        </p>
      </div>

      <div className="grid gap-px rounded-lg border border-border overflow-hidden sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <div
            key={feature.title}
            className="bg-card p-8 transition-colors hover:bg-card/80"
          >
            <h3 className="font-mono text-sm text-neon tracking-wide mb-3">
              {feature.title}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
