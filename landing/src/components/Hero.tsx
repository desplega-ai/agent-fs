import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const CLI_LINES = [
  "bun add -g @desplega.ai/agent-fs",
  "agent-fs onboard",
  'agent-fs write hello.md --content "# Hello from an agent"',
]

const SKILL_LINES = [
  "npx skills add desplega-ai/agent-fs",
]

export function Hero() {
  return (
    <section className="relative flex min-h-[100dvh] flex-col items-center justify-center px-6 pt-16 hero-glow">
      <div className="max-w-3xl text-center">
        <p className="animate-fade-up text-sm tracking-widest text-neon/70 font-mono uppercase mb-6">
          The file system for AI agents
        </p>

        <h1 className="animate-fade-up delay-100 text-[clamp(2.5rem,7vw,4rem)] font-bold leading-[0.95] tracking-tight">
          A file system for
          <br />
          <span className="text-neon">AI agents.</span>
        </h1>

        <p className="animate-fade-up delay-200 mx-auto mt-6 max-w-md text-lg text-muted-foreground leading-relaxed">
          A sharable, searchable, persistent file system that any AI agent can use — via CLI or MCP.
        </p>
      </div>

      <div className="animate-fade-up delay-300 mt-14 w-full max-w-lg space-y-2">
        <div className="rounded-md border border-border bg-card p-5 font-mono text-left">
          <p className="mb-3 text-[11px] uppercase tracking-widest text-muted-foreground/60 select-none">Install</p>
          {CLI_LINES.map((line, i) => (
            <div key={i} className="text-[13px] leading-7 flex">
              <span className="text-neon/40 select-none mr-2">$</span>
              <span className="text-foreground/80">{line}</span>
            </div>
          ))}
        </div>
        <div className="rounded-md border border-border bg-card p-5 font-mono text-left">
          <p className="mb-3 text-[11px] uppercase tracking-widest text-muted-foreground/60 select-none">Or add as a skill</p>
          {SKILL_LINES.map((line, i) => (
            <div key={i} className="text-[13px] leading-7 flex">
              <span className="text-neon/40 select-none mr-2">$</span>
              <span className="text-foreground/80">{line}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="animate-fade-up delay-400 mt-8 flex gap-3">
        <a
          href="https://github.com/desplega-ai/agent-fs"
          className={cn(
            buttonVariants({ size: "lg" }),
            "font-mono text-sm px-6"
          )}
        >
          Get started
        </a>
      </div>
    </section>
  )
}
