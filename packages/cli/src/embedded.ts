import {
  createDatabase,
  getConfig,
  AgentS3Client,
  getUserByApiKey,
  resolveContext,
  dispatchOp,
  ensureLocalUser,
  createEmbeddingProviderFromEnv,
} from "@/core";
import type { DB, OpContext, EmbeddingProvider } from "@/core";

let _db: DB | null = null;
let _s3: AgentS3Client | null = null;
let _ctx: OpContext | null = null;
let _embeddingProviderPromise: Promise<EmbeddingProvider | null> | null = null;

async function initEmbeddedContext(): Promise<OpContext> {
  // Ensure sync context exists first (db, s3, user, etc.)
  const ctx = getEmbeddedContextSync();

  // Upgrade with embedding provider if not yet set
  if (ctx.embeddingProvider === undefined) {
    const config = getConfig();
    if (!_embeddingProviderPromise) {
      _embeddingProviderPromise = createEmbeddingProviderFromEnv(config.embedding);
    }
    ctx.embeddingProvider = await _embeddingProviderPromise;
  }

  return ctx;
}

/** Synchronous context getter for cases that don't need embedding provider */
function getEmbeddedContextSync(): OpContext {
  if (_ctx) return _ctx;

  const config = getConfig();
  _db = createDatabase();
  _s3 = new AgentS3Client(config.s3);

  const { apiKey } = ensureLocalUser(_db);

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
  return getEmbeddedContextSync().orgId;
}

export async function embeddedCallOp(
  orgId: string,
  op: string,
  params: Record<string, any>
): Promise<any> {
  const ctx = await initEmbeddedContext();
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
