import { Command } from "commander";
// @ts-ignore — bun supports text imports, inlined at build time
import content from "../../../../skills/agent-fs/SKILL.md" with { type: "text" };

export function docsCommand() {
  return new Command("docs")
    .description("Show agent-fs documentation and command reference")
    .action(() => {
      // Strip YAML frontmatter
      const stripped = content.replace(/^---[\s\S]*?---\n*/, "");
      console.log(stripped);
    });
}
