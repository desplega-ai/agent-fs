import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { stdio } from "../../stdio.js";
import { webhookCommands, webhookParamsFromOpts } from "../webhook.js";

describe("webhookParamsFromOpts", () => {
  test("create defaults to drive scope and collects repeated --event", () => {
    expect(
      webhookParamsFromOpts(
        "create",
        { event: ["comment.mentioned", "comment.created"] },
        "https://hooks.example.com/af"
      )
    ).toEqual({
      scope: "drive",
      url: "https://hooks.example.com/af",
      eventTypes: ["comment.mentioned", "comment.created"],
    });
  });

  test("--org-wide maps to scope org, --description passes through", () => {
    expect(
      webhookParamsFromOpts(
        "create",
        { event: ["comment.created"], orgWide: true, description: "ops" },
        "https://hooks.example.com/af"
      )
    ).toEqual({
      scope: "org",
      url: "https://hooks.example.com/af",
      eventTypes: ["comment.created"],
      description: "ops",
    });
  });

  test("create needs at least one --event", () => {
    expect(() => webhookParamsFromOpts("create", { event: [] }, "https://hooks.example.com/af")).toThrow(
      "at least one --event"
    );
  });

  test("list defaults to all and checks --scope", () => {
    expect(webhookParamsFromOpts("list", {})).toEqual({ scope: "all" });
    expect(webhookParamsFromOpts("list", { scope: "org" })).toEqual({ scope: "org" });
    expect(() => webhookParamsFromOpts("list", { scope: "everything" })).toThrow("--scope");
  });

  test("update maps --disable, --enable, --rotate-secret, --url and --event", () => {
    expect(webhookParamsFromOpts("update", { disable: true }, "wh1")).toEqual({ id: "wh1", enabled: false });
    expect(webhookParamsFromOpts("update", { enable: true }, "wh1")).toEqual({ id: "wh1", enabled: true });
    expect(
      webhookParamsFromOpts(
        "update",
        { rotateSecret: true, url: "https://b.example.com", event: ["comment.deleted"] },
        "wh1"
      )
    ).toEqual({
      id: "wh1",
      url: "https://b.example.com",
      eventTypes: ["comment.deleted"],
      rotateSecret: true,
    });
  });

  test("update keeps an empty --description (it clears the note)", () => {
    expect(webhookParamsFromOpts("update", { description: "" }, "wh1")).toEqual({ id: "wh1", description: "" });
  });

  test("update refuses --enable with --disable, and no change at all", () => {
    expect(() => webhookParamsFromOpts("update", { enable: true, disable: true }, "wh1")).toThrow("not both");
    expect(() => webhookParamsFromOpts("update", { event: [] }, "wh1")).toThrow("Nothing to update");
  });
});

describe("webhook command", () => {
  test("parses flags through commander into the op call", async () => {
    const calls: Array<{ orgId: string; op: string; params: Record<string, unknown> }> = [];
    const client = {
      callOp: async (orgId: string, op: string, params: Record<string, unknown>) => {
        calls.push({ orgId, op, params });
        return { id: "wh1", workerEnabled: true, secret: "whsec_x" };
      },
    };
    const program = new Command().option("--json").exitOverride();
    program.addCommand(webhookCommands(program, client as never, () => "org1", () => "drive1"));

    const originalWrite = stdio.writeStdout;
    const originalError = console.error;
    const stdout: string[] = [];
    const stderr: string[] = [];
    stdio.writeStdout = (data: string) => {
      stdout.push(data);
    };
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    try {
      await program.parseAsync(
        ["--json", "webhook", "create", "https://hooks.example.com/af", "--event", "comment.mentioned", "--event", "comment.created", "--org-wide"],
        { from: "user" }
      );
    } finally {
      stdio.writeStdout = originalWrite;
      console.error = originalError;
    }

    expect(calls).toEqual([
      {
        orgId: "org1",
        op: "webhook-create",
        params: {
          scope: "org",
          url: "https://hooks.example.com/af",
          eventTypes: ["comment.mentioned", "comment.created"],
          driveId: "drive1",
        },
      },
    ]);
    expect(JSON.parse(stdout.join(""))).toEqual({ id: "wh1", workerEnabled: true, secret: "whsec_x" });
    expect(stderr.join("\n")).toContain("shown only this once");
  });
});
