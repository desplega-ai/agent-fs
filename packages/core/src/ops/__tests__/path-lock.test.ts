import { describe, test, expect } from "bun:test";
import { withPathLock, pathLockSize } from "../path-lock.js";

describe("withPathLock", () => {
  test("same drive and path run one after the other", async () => {
    const events: string[] = [];
    const run = (n: number, ms: number) =>
      withPathLock("d", ["/a"], async () => {
        events.push(`start${n}`);
        await Bun.sleep(ms);
        events.push(`end${n}`);
      });
    await Promise.all([run(1, 20), run(2, 1)]);
    expect(events).toEqual(["start1", "end1", "start2", "end2"]);
  });

  test("different paths, or the same path in different drives, overlap", async () => {
    for (const [d1, p1, d2, p2] of [
      ["d", "/a", "d", "/b"],
      ["d1", "/a", "d2", "/a"],
    ]) {
      const events: string[] = [];
      const run = (n: number, d: string, p: string) =>
        withPathLock(d, [p], async () => {
          events.push(`start${n}`);
          await Bun.sleep(10);
          events.push(`end${n}`);
        });
      await Promise.all([run(1, d1, p1), run(2, d2, p2)]);
      expect(events.indexOf("start2")).toBeLessThan(events.indexOf("end1"));
    }
  });

  test("a throwing callback releases the lock and propagates its error", async () => {
    const first = withPathLock("d", ["/a"], async () => {
      throw new Error("boom");
    });
    const second = withPathLock("d", ["/a"], async () => "ok");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
  });

  test("the lock map is empty after everything settles", async () => {
    await Promise.allSettled([
      withPathLock("d", ["/a"], async () => Bun.sleep(5)),
      withPathLock("d", ["/a", "/b"], async () => {
        throw new Error("x");
      }),
      withPathLock("d", ["/b"], async () => 1),
    ]);
    expect(pathLockSize()).toBe(0);
  });

  test("opposite key order does not deadlock", async () => {
    await Promise.all([
      withPathLock("d", ["/a", "/b"], async () => Bun.sleep(5)),
      withPathLock("d", ["/b", "/a"], async () => Bun.sleep(5)),
    ]);
  });
});
