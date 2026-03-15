import {
  createDatabase,
  getConfig,
  AgentS3Client,
  getUserByApiKey,
  resolveContext,
  dispatchOp,
  createUser,
  setConfigValue,
  listUserOrgs,
} from "@agentfs/core";
import type { DB, OpContext } from "@agentfs/core";

let _db: DB | null = null;
let _s3: AgentS3Client | null = null;
let _ctx: OpContext | null = null;

function getEmbeddedContext(): OpContext {
  if (_ctx) return _ctx;

  const config = getConfig();
  _db = createDatabase();
  _s3 = new AgentS3Client(config.s3);

  let apiKey = config.auth.apiKey;

  // Auto-bootstrap local user if none exists
  if (!apiKey) {
    const result = createUser(_db, { email: "local@agentfs.local" });
    setConfigValue("auth.apiKey", result.apiKey);
    apiKey = result.apiKey;
  }

  const user = getUserByApiKey(_db, apiKey);
  if (!user) throw new Error("Invalid API key in config");

  const resolved = resolveContext(_db, { userId: user.id });

  _ctx = {
    db: _db,
    s3: _s3,
    orgId: resolved.orgId,
    driveId: resolved.driveId,
    userId: user.id,
  };

  return _ctx;
}

export function getEmbeddedOrgId(): string {
  return getEmbeddedContext().orgId;
}

export async function embeddedCallOp(
  orgId: string,
  op: string,
  params: Record<string, any>
): Promise<any> {
  const ctx = getEmbeddedContext();
  return dispatchOp(ctx, op, params);
}

/** Check if daemon is reachable */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const config = getConfig();
    const url = `http://${config.server.host}:${config.server.port}/health`;
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}
