import { listDriveMembersPublic } from "../identity/drives.js";
import type {
  DriveMembersParams,
  DriveMembersResult,
  OpContext,
} from "./types.js";

export async function driveMembers(
  ctx: OpContext,
  _params: DriveMembersParams
): Promise<DriveMembersResult> {
  const members = listDriveMembersPublic(ctx.db, ctx.driveId);
  members.sort((a, b) =>
    (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email)
  );
  return { members };
}
