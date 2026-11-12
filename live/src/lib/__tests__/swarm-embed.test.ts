import { describe, expect, test } from "bun:test"
import cases from "../swarm-embed-cases.json"
import { embedFromElementProps, matchSwarmEmbed, remarkSwarmEmbed, swarmFileHref } from "../swarm-embed"

const ID = "7f1c2a4e-9b3d-4e61-8a0f-5c2d1e3b4a67"

describe("matchSwarmEmbed, shared cases", () => {
  for (const c of cases.matcher) {
    test(`${c.category}: ${c.name}`, () => {
      expect(matchSwarmEmbed(c.html)).toEqual(c.expect as never)
    })
  }

  test("the fixture covers every status", () => {
    const statuses = new Set(cases.matcher.map((c) => (c.expect as { status: string }).status))
    expect([...statuses].sort()).toEqual(["embed", "invalid", "none"])
  })
})

type Node = { type: string; value?: string; children?: Node[]; data?: { hName?: string; hProperties?: Record<string, string> } }

describe("remarkSwarmEmbed", () => {
  const run = (tree: Node) => (remarkSwarmEmbed() as (tree: Node) => void)(tree)

  test("replaces a block tag with a swarm-embed element and drops its text", () => {
    const html: Node = { type: "html", value: `<SwarmSheet id="${ID}" tab="Q4" height="300" />` }
    run({ type: "root", children: [html] })
    expect(html.type).toBe("swarmEmbed")
    expect(html.value).toBeUndefined()
    expect(html.data).toEqual({
      hName: "swarm-embed",
      hProperties: { dataKind: "sheet", dataObjectId: ID, dataTab: "Q4", dataHeight: "300" },
    })
  })

  test("leaves invalid tags and other HTML alone", () => {
    const bad: Node = { type: "html", value: `<SwarmSheet id="${ID}" onload="x" />` }
    const other: Node = { type: "html", value: "<details>x</details>" }
    run({ type: "root", children: [bad, other] })
    expect(bad).toEqual({ type: "html", value: `<SwarmSheet id="${ID}" onload="x" />` })
    expect(other.type).toBe("html")
  })

  test("skips inline HTML, wherever it sits under inline content", () => {
    const inline: Node = { type: "html", value: `<SwarmSheet id="${ID}" />` }
    const nested: Node = { type: "html", value: `<SwarmBoard id="${ID}" />` }
    run({
      type: "root",
      children: [
        { type: "paragraph", children: [inline] },
        { type: "paragraph", children: [{ type: "strong", children: [nested] }] },
      ],
    })
    expect(inline.type).toBe("html")
    expect(nested.type).toBe("html")
  })

  test("reaches a tag inside a block container", () => {
    const html: Node = { type: "html", value: `<SwarmBoard id="${ID}" fit="true" />` }
    run({ type: "root", children: [{ type: "blockquote", children: [{ type: "list", children: [{ type: "listItem", children: [html] }] }] }] })
    expect(html.data?.hProperties).toEqual({ dataKind: "board", dataObjectId: ID, dataFit: "true" })
  })
})

describe("embedFromElementProps", () => {
  test("reads back what the plugin wrote", () => {
    expect(
      embedFromElementProps({ "data-kind": "sheet", "data-object-id": ID, "data-tab": "Q4", "data-readonly": "true" }),
    ).toEqual({ tag: "SwarmSheet", props: { id: ID, tab: "Q4", readonly: true } })
  })

  test("refuses values the grammar refuses", () => {
    expect(embedFromElementProps({ "data-kind": "sheet", "data-object-id": "x" })).toBeNull()
    expect(embedFromElementProps({ "data-kind": "board", "data-object-id": ID, "data-height": "9" })).toBeNull()
    expect(embedFromElementProps({ "data-kind": "board", "data-object-id": ID, "data-tab": 'a" onload="x' })).toBeNull()
    expect(embedFromElementProps({ "data-kind": "chart", "data-object-id": ID })).toBeNull()
    expect(embedFromElementProps({})).toBeNull()
  })
})

describe("swarmFileHref", () => {
  test("links the file in the swarm dashboard", () => {
    expect(swarmFileHref("https://app.agent-swarm.dev", "org-1", "drv-2", "notes/Q4 plan.md")).toBe(
      "https://app.agent-swarm.dev/file/~/org-1/drv-2/notes/Q4%20plan.md",
    )
  })

  test("keeps a path on the swarm URL and drops a trailing slash", () => {
    expect(swarmFileHref("https://host.test/swarm/", "o", "d", "/a.md")).toBe("https://host.test/swarm/file/~/o/d/a.md")
  })

  test("refuses a missing, malformed or non-http swarm URL", () => {
    for (const url of [null, undefined, "", "not a url", "javascript:alert(1)", "data:text/html,x"]) {
      expect(swarmFileHref(url, "o", "d", "a.md")).toBeNull()
    }
  })
})
