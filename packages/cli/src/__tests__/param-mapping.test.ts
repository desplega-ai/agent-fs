import { describe, test, expect } from "bun:test";

/**
 * Tests for CLI flag → Zod schema param mapping.
 * The CLI uses --old/--new flags but the edit Zod schema expects old_string/new_string.
 * The CLI uses --expected-version but the write Zod schema expects expectedVersion.
 */

function applyParamMapping(params: Record<string, any>): Record<string, any> {
  const mapped = { ...params };

  // These mappings mirror packages/cli/src/commands/ops.ts
  if (mapped["expected-version"] !== undefined) {
    mapped.expectedVersion = mapped["expected-version"];
    delete mapped["expected-version"];
  }
  if (mapped["old"] !== undefined) {
    mapped.old_string = mapped["old"];
    delete mapped["old"];
  }
  if (mapped["new"] !== undefined) {
    mapped.new_string = mapped["new"];
    delete mapped["new"];
  }

  return mapped;
}

describe("CLI param mapping", () => {
  test("maps --old to old_string and --new to new_string", () => {
    const input = { path: "/test.md", old: "hello", new: "world" };
    const result = applyParamMapping(input);

    expect(result.old_string).toBe("hello");
    expect(result.new_string).toBe("world");
    expect(result.old).toBeUndefined();
    expect(result.new).toBeUndefined();
    expect(result.path).toBe("/test.md");
  });

  test("maps --expected-version to expectedVersion", () => {
    const input = { path: "/test.md", "expected-version": "3" };
    const result = applyParamMapping(input);

    expect(result.expectedVersion).toBe("3");
    expect(result["expected-version"]).toBeUndefined();
  });

  test("does not affect params without CLI flag names", () => {
    const input = { path: "/test.md", content: "hello", message: "update" };
    const result = applyParamMapping(input);

    expect(result).toEqual(input);
  });

  test("handles missing optional params gracefully", () => {
    const input = { path: "/test.md", old: "hello" };
    const result = applyParamMapping(input);

    expect(result.old_string).toBe("hello");
    expect(result.new_string).toBeUndefined();
    expect(result.old).toBeUndefined();
  });
});
