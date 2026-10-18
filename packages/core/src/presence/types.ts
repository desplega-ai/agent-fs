export type PresenceQuote = { exact: string; prefix?: string; suffix?: string };
export type PresenceSelection = {
  quote: PresenceQuote;
  lineStart: number;
  lineEnd: number;
  fileVersion?: number | null;
  collapsed: boolean;
};
export type PresenceTextPos = {
  quote: PresenceQuote;
  charOffset: number;
  lineStart: number;
  fileVersion?: number | null;
};
export type PresenceState = {
  path: string | null;
  mode: "view" | "edit";
  selection?: PresenceSelection | null;
  pointer?: PresenceTextPos | null;
  commentId?: string | null;
  commentState?: "viewing" | "replying" | null;
};
export type PresenceSession = PresenceState & {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string | null;
  updatedAt: string;
};
export type PresenceEvent =
  | { type: "presence.updated"; driveId: string; session: PresenceSession; at: string }
  | { type: "presence.left"; driveId: string; sessionId: string; userId: string; at: string };
