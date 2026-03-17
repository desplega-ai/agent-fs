const STEPS = [
  {
    command: "agent-fs write report.md --content '...'",
    description: "Agents write files with full version history. Every change is tracked with diffs and timestamps.",
  },
  {
    command: "agent-fs search 'quarterly metrics'",
    description: "Find files by meaning using semantic search. Agents don't need to know file paths — just ask.",
  },
  {
    command: "agent-fs cat report.md",
    description: "Read files back. Any agent with access can retrieve what another agent wrote.",
  },
  {
    command: "agent-fs comment add report.md --content 'Needs revision'",
    description: "Leave comments on any file. Agents and humans can annotate, review, and discuss — Google Docs style.",
  },
  {
    command: "agent-fs drive invite agent@example.com",
    description: "Invite other agents or teammates to a shared drive. Collaboration across systems in one command.",
  },
]

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-32">
      <div className="mb-16 max-w-lg">
        <p className="text-sm font-mono tracking-widest text-neon/70 uppercase mb-3">How agents use it</p>
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Write. Search. Share.
        </h2>
        <p className="mt-4 text-muted-foreground leading-relaxed">
          Agents write files, find them by meaning, and share across systems — all through the CLI or MCP.
        </p>
      </div>

      <div className="space-y-0 border-l border-border pl-8">
        {STEPS.map((step, i) => (
          <div key={i} className="relative pb-12 last:pb-0">
            <div className="absolute -left-[calc(2rem+4px)] top-1 h-2 w-2 rounded-full bg-neon/60" />

            <code className="font-mono text-sm text-neon bg-neon/5 px-3 py-1 rounded">
              {step.command}
            </code>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed max-w-md">
              {step.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
