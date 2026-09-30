export type DriveEvent =
  | {
      type: "file.changed";
      driveId: string;
      path: string;
      version: number;
      operation: "write" | "edit" | "append" | "delete" | "revert";
      actor: string;
      at: string;
    }
  | {
      type: "comment.changed";
      driveId: string;
      path: string;
      commentId: string;
      parentId: string | null;
      action: "created" | "updated" | "resolved" | "reopened" | "deleted";
      actor: string;
      at: string;
    };

const listeners = new Map<string, Set<(event: DriveEvent) => void>>();

export function publishDriveEvent(event: DriveEvent): void {
  for (const listener of [...(listeners.get(event.driveId) ?? [])]) {
    try {
      listener(event);
    } catch (error) {
      // A listener must not interrupt the mutation or other listeners.
      console.error(error);
    }
  }
}

export function subscribeDrive(driveId: string, fn: (event: DriveEvent) => void): () => void {
  const subscribers = listeners.get(driveId) ?? new Set();
  subscribers.add(fn);
  listeners.set(driveId, subscribers);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && listeners.get(driveId) === subscribers) listeners.delete(driveId);
  };
}
