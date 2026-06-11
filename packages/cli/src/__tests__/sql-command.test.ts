import { describe, expect, test } from "bun:test";
import { parseTableBinding } from "../commands/sql.js";

describe("parseTableBinding", () => {
  test("plain name=path", () => {
    expect(parseTableBinding("sales=/data/sales.csv")).toEqual({
      name: "sales",
      value: "/data/sales.csv",
    });
  });

  test("format override via :format suffix", () => {
    expect(parseTableBinding("logs=/raw/data.txt:csv")).toEqual({
      name: "logs",
      value: { path: "/raw/data.txt", format: "csv" },
    });
    expect(parseTableBinding("app=/backups/dump:sqlite")).toEqual({
      name: "app",
      value: { path: "/backups/dump", format: "sqlite" },
    });
  });

  test("unknown suffix after colon is kept as part of the path", () => {
    expect(parseTableBinding("t=/odd/file:v2.csv")).toEqual({
      name: "t",
      value: "/odd/file:v2.csv",
    });
  });

  test("path may contain = after the first one", () => {
    expect(parseTableBinding("t=/a/b=c.csv")).toEqual({
      name: "t",
      value: "/a/b=c.csv",
    });
  });

  test("rejects bindings without a name", () => {
    expect(() => parseTableBinding("/data/sales.csv")).toThrow(/Invalid --table/);
    expect(() => parseTableBinding("=x.csv")).toThrow(/Invalid --table/);
  });
});
