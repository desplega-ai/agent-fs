import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { getRegisteredOps, getOpDefinition } from "@agentfs/core";
import { registerTools } from "../tools.js";
import { createTestContext } from "../../../core/src/test-utils.js";

describe("registerTools", () => {
  test("registers all ops as MCP tools", () => {
    const registeredTools: Array<{ name: string; description: string }> = [];

    // Mock McpServer with just the tool() method
    const mockServer = {
      tool: (name: string, description: string, _schema: any, _handler: any) => {
        registeredTools.push({ name, description });
      },
    };

    const { ctx } = createTestContext();
    registerTools(mockServer as any, () => ctx);

    const ops = getRegisteredOps();
    expect(registeredTools.length).toBe(ops.length);

    for (const op of ops) {
      expect(registeredTools.some((t) => t.name === op)).toBe(true);
    }
  });

  test("tool descriptions are rich descriptions from the registry", () => {
    const registeredTools: Array<{ name: string; description: string }> = [];

    const mockServer = {
      tool: (name: string, description: string, _schema: any, _handler: any) => {
        registeredTools.push({ name, description });
      },
    };

    const { ctx } = createTestContext();
    registerTools(mockServer as any, () => ctx);

    for (const tool of registeredTools) {
      // Descriptions should be rich (not just "agentfs <op>")
      expect(tool.description.length).toBeGreaterThan(20);
      // Descriptions should match the registry
      const def = getOpDefinition(tool.name);
      expect(tool.description).toBe(def!.description);
    }
  });

  test("tool handler calls dispatchOp and returns MCP text response", async () => {
    let capturedHandler: ((params: any) => Promise<any>) | null = null;

    const mockServer = {
      tool: (name: string, _desc: string, _schema: any, handler: any) => {
        if (name === "write") capturedHandler = handler;
      },
    };

    const { ctx } = createTestContext();
    registerTools(mockServer as any, () => ctx);

    expect(capturedHandler).not.toBeNull();

    // Call the write handler
    const result = await capturedHandler!({
      path: "/mcp-test.txt",
      content: "MCP test content",
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version).toBe(1);
    expect(parsed.path).toBe("/mcp-test.txt");
  });
});

describe("Schema conversion", () => {
  test("all op schemas are ZodObject instances", () => {
    const ops = getRegisteredOps();
    for (const op of ops) {
      const def = getOpDefinition(op);
      expect(def).toBeDefined();
      // All our op schemas should be ZodObject
      expect(def!.schema).toBeInstanceOf(z.ZodObject);
    }
  });

  test("ZodObject schemas have extractable shape", () => {
    const ops = getRegisteredOps();
    for (const op of ops) {
      const def = getOpDefinition(op);
      if (def!.schema instanceof z.ZodObject) {
        const shape = (def!.schema as z.ZodObject<any>).shape;
        expect(typeof shape).toBe("object");
      }
    }
  });
});
