import { isDeepStrictEqual } from "node:util";
import { AgentFSError, EditConflictError } from "../errors.js";
import type { PresenceEvent, PresenceSession, PresenceState } from "./types.js";

type Entry = {
  userId: string;
  session?: PresenceSession;
  state?: PresenceState;
  lastSeen: number;
  bindings: number;
};

export class PresenceLimitError extends AgentFSError {
  constructor() {
    super("RATE_LIMITED", "Too many presence sessions for this user and drive");
  }
}

export class PresenceRegistry {
  private drives = new Map<string, Map<string, Entry>>();
  private listeners = new Map<string, Set<(event: PresenceEvent) => void>>();
  private now: () => number;
  private timer: ReturnType<typeof setInterval>;
  private getDisplayName: (userId: string) => string | null;

  constructor(options: {
    now?: () => number;
    getDisplayName?: (userId: string) => string | null;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.getDisplayName = options.getDisplayName ?? (() => null);
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref();
  }

  private entries(driveId: string) {
    let entries = this.drives.get(driveId);
    if (!entries) this.drives.set(driveId, entries = new Map());
    return entries;
  }

  private assertOwner(entry: Entry | undefined, userId: string) {
    if (entry && entry.userId !== userId) {
      throw new EditConflictError("Presence session belongs to another user");
    }
  }

  upsert(driveId: string, sessionId: string, user: { id: string; email: string }, state: PresenceState): PresenceSession {
    const entries = this.entries(driveId);
    let entry = entries.get(sessionId);
    this.assertOwner(entry, user.id);
    if (!entry?.session && [...entries.values()].filter((e) => e.session && e.userId === user.id).length >= 32) {
      throw new PresenceLimitError();
    }
    const now = this.now();
    if (!entry) entries.set(sessionId, entry = { userId: user.id, lastSeen: now, bindings: 0 });
    entry.lastSeen = now;
    if (entry.session && isDeepStrictEqual(entry.state, state)) return structuredClone(entry.session);
    const at = new Date(now).toISOString();
    entry.state = structuredClone(state);
    entry.session = {
      ...entry.state, sessionId, userId: user.id, email: user.email,
      displayName: entry.session ? entry.session.displayName : this.getDisplayName(user.id), updatedAt: at,
    };
    this.publish({ type: "presence.updated", driveId, session: structuredClone(entry.session), at });
    return structuredClone(entry.session);
  }

  snapshot(driveId: string) {
    return {
      driveId,
      sessions: [...(this.drives.get(driveId)?.values() ?? [])]
        .flatMap((entry) => entry.session ? [structuredClone(entry.session)] : []),
      at: new Date(this.now()).toISOString(),
    };
  }

  remove(driveId: string, sessionId: string, userId: string) {
    const entry = this.drives.get(driveId)?.get(sessionId);
    this.assertOwner(entry, userId);
    if (!entry) return;
    const hadSession = !!entry.session;
    entry.session = undefined;
    entry.state = undefined;
    if (entry.bindings === 0) {
      const entries = this.drives.get(driveId)!;
      entries.delete(sessionId);
      if (entries.size === 0) this.drives.delete(driveId);
    }
    if (hadSession) this.publish({ type: "presence.left", driveId, sessionId, userId, at: new Date(this.now()).toISOString() });
  }

  bind(driveId: string, sessionId: string, userId: string): () => void {
    const entries = this.entries(driveId);
    let entry = entries.get(sessionId);
    this.assertOwner(entry, userId);
    if (!entry) entries.set(sessionId, entry = { userId, lastSeen: this.now(), bindings: 0 });
    entry.bindings++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.bindings === 0) this.remove(driveId, sessionId, userId);
    };
  }

  sweep() {
    const cutoff = this.now() - 45_000;
    for (const [driveId, entries] of this.drives) {
      for (const [sessionId, entry] of entries) {
        // A bound stream proves the tab is alive (it re-checks auth every 5 s), even when a
        // background tab's heartbeat timer is throttled. The TTL only covers unbound sessions.
        if (entry.session && entry.bindings === 0 && entry.lastSeen < cutoff) this.remove(driveId, sessionId, entry.userId);
      }
    }
  }

  subscribe(driveId: string, listener: (event: PresenceEvent) => void): () => void {
    const listeners = this.listeners.get(driveId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(driveId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(driveId) === listeners) this.listeners.delete(driveId);
    };
  }

  private publish(event: PresenceEvent) {
    for (const listener of [...(this.listeners.get(event.driveId) ?? [])]) {
      try { listener(event); } catch (error) { console.error(error); }
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.drives.clear();
    this.listeners.clear();
  }
}
