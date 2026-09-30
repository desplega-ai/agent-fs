import { describe, expect, spyOn, test } from "bun:test";
import { publishDriveEvent, subscribeDrive, type DriveEvent } from "../bus.js";

function event(driveId: string): DriveEvent {
  return { type: "file.changed", driveId, path: "/a.md", version: 1, operation: "write", actor: "user", at: new Date().toISOString() };
}

describe("drive event bus", () => {
  test("subscribes and unsubscribes", () => {
    const driveId = crypto.randomUUID();
    const received: DriveEvent[] = [];
    const unsubscribe = subscribeDrive(driveId, (e) => received.push(e));
    const change = event(driveId);
    publishDriveEvent(change);
    unsubscribe();
    unsubscribe();
    publishDriveEvent(change);
    expect(received).toEqual([change]);
  });

  test("isolates drives", () => {
    const driveId = crypto.randomUUID();
    const received: DriveEvent[] = [];
    const unsubscribe = subscribeDrive(driveId, (e) => received.push(e));
    try {
      publishDriveEvent(event(crypto.randomUUID()));
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  test("continues after a listener throws", () => {
    const driveId = crypto.randomUUID();
    const received: DriveEvent[] = [];
    const error = spyOn(console, "error").mockImplementation(() => {});
    const first = subscribeDrive(driveId, () => { throw new Error("Listener failed"); });
    const second = subscribeDrive(driveId, (e) => received.push(e));
    try {
      const change = event(driveId);
      expect(() => publishDriveEvent(change)).not.toThrow();
      expect(received).toEqual([change]);
      expect(error).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      error.mockRestore();
      first();
      second();
    }
  });

  test("an old unsubscribe does not remove a new subscription", () => {
    const driveId = crypto.randomUUID();
    const old = subscribeDrive(driveId, () => {});
    old();
    const received: DriveEvent[] = [];
    const current = subscribeDrive(driveId, (e) => received.push(e));
    try {
      old();
      publishDriveEvent(event(driveId));
      expect(received).toHaveLength(1);
    } finally {
      current();
    }
  });
});
