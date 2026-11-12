// Runs the shared Markdown cases through react-markdown with the same plugins
// as MarkdownViewer. `swarm-embed` elements become a probe that prints the
// embed they stand for; everything else renders as MarkdownViewer renders it.
//
// Run from live/: bun test src/components/viewers/__tests__/
import { describe, expect, test } from "bun:test"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { renderToStaticMarkup } from "react-dom/server"
import cases from "@/lib/swarm-embed-cases.json"
import { embedFromElementProps, remarkSwarmEmbed } from "@/lib/swarm-embed"

const components = {
  "swarm-embed": (props: Record<string, unknown>) => <i data-probe={JSON.stringify(embedFromElementProps(props))} />,
} as never

const decode = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&")

function render(markdown: string): { markup: string; embeds: unknown[]; text: string } {
  const markup = renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm, remarkSwarmEmbed]} components={components}>
      {markdown}
    </Markdown>,
  )
  const embeds = Array.from(markup.matchAll(/data-probe="([^"]*)"/g), (m) => JSON.parse(decode(m[1])))
  return { markup, embeds, text: decode(markup.replace(/<[^>]+>/g, "")) }
}

describe("swarm embeds in rendered Markdown, shared cases", () => {
  for (const c of cases.documents) {
    test(c.name, () => {
      const { embeds, text } = render(c.markdown)
      expect(embeds).toEqual(c.embeds)
      for (const visible of c.visibleText) expect(text).toContain(visible)
    })
  }

  test("a valid tag leaves no raw tag text and no tag element in the output", () => {
    const { markup } = render(cases.documents[0].markdown)
    expect(markup).not.toContain("&lt;Swarm")
    expect(markup).not.toMatch(/<swarm/i)
    expect(markup).toContain("<p>Before.</p>")
    expect(markup).toContain("<p>After.</p>")
  })

  test("a hostile tag never becomes an element or carries its attribute", () => {
    const { markup } = render(`<SwarmSheet id="7f1c2a4e-9b3d-4e61-8a0f-5c2d1e3b4a67" onload="alert(1)" />\n`)
    expect(markup).not.toMatch(/<swarm/i)
    expect(markup).not.toContain("data-probe")
    // The attribute shows only as escaped text, never inside a real tag.
    expect(markup).not.toMatch(/<[a-z][^>]*\sonload=/i)
    expect(markup).toContain("onload=&quot;alert(1)&quot;")
  })
})
