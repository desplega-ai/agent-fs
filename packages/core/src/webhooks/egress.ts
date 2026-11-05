// agent-fs egress policy for outbound webhooks, on top of the copied guard in
// egress-guard.ts.
//
// The allowlist here is additive, unlike agent-swarm's exclusive
// `policy.allowlist`: a listed host may be private (a compose service name, a
// LAN receiver), and any public host stays reachable. It goes through the
// guard's `isTrusted` hook, and `policy.allowlist` is always null.

import { ValidationError } from "../errors.js";
import {
  assertEgressAllowed,
  createGuardedFetch,
  EgressDeniedError,
  matchesAllowlist,
  parseEgressAllowlist,
  validateEgressAllowlist,
  type GuardedFetchOptions,
} from "./egress-guard.js";

export const WEBHOOK_ALLOWED_HOSTS_ENV = "AGENT_FS_WEBHOOK_ALLOWED_HOSTS";
export const WEBHOOK_ALLOW_PRIVATE_ENV = "AGENT_FS_WEBHOOK_ALLOW_PRIVATE";

/** Longest webhook URL accepted, in characters. */
export const WEBHOOK_URL_MAX_CHARS = 2_048;

export interface WebhookEgressConfig {
  /** `host[:port]` patterns that may be private or plain http; null = none. */
  allowedHosts: string[] | null;
  /** `AGENT_FS_WEBHOOK_ALLOW_PRIVATE=true`: every private target is allowed. */
  allowPrivate: boolean;
}

/**
 * The webhook egress config, read from `env` on every call so tests (and a
 * restart with new env) see changes. Throws on an invalid allowlist: the
 * worker refuses to start and `webhook-create` fails rather than silently
 * ignoring an entry.
 */
export function webhookEgressConfig(env: NodeJS.ProcessEnv = process.env): WebhookEgressConfig {
  const raw = env[WEBHOOK_ALLOWED_HOSTS_ENV] ?? "";
  const invalid = validateEgressAllowlist(raw);
  if (invalid) throw new Error(invalid);
  return {
    allowedHosts: parseEgressAllowlist(raw),
    allowPrivate: env[WEBHOOK_ALLOW_PRIVATE_ENV] === "true",
  };
}

function guardOptions(
  config: WebhookEgressConfig,
  resolve?: GuardedFetchOptions["resolve"],
): GuardedFetchOptions {
  const allowed = config.allowedHosts;
  return {
    policy: { allowPrivate: config.allowPrivate, allowlist: null },
    isTrusted: allowed ? (url) => matchesAllowlist(url, allowed) : undefined,
    ...(resolve ? { resolve } : {}),
  };
}

function refuse(message: string): ValidationError {
  return new ValidationError(message, {
    field: "url",
    suggestion: `Use a public https:// URL, or list the host in ${WEBHOOK_ALLOWED_HOSTS_ENV}`,
  });
}

/**
 * Check a webhook URL at create/update time. Refuses an unparsable URL,
 * userinfo, more than 2,048 chars, a protocol other than http(s), plain
 * `http:` unless the host is allowlisted or private targets are allowed, and
 * (after resolving DNS) any private, loopback or link-local target. Every
 * refusal is a `ValidationError` on `url`. The worker checks again at send
 * time, because DNS can change.
 */
export async function assertWebhookUrl(
  raw: string,
  opts: { env?: NodeJS.ProcessEnv; resolve?: GuardedFetchOptions["resolve"] } = {},
): Promise<URL> {
  if (raw.length > WEBHOOK_URL_MAX_CHARS) {
    throw refuse(`Webhook URL is longer than ${WEBHOOK_URL_MAX_CHARS} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse("Webhook URL is not a valid URL");
  }
  if (url.username || url.password) {
    throw refuse("Webhook URL must not contain a username or password");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw refuse(`Webhook URL must use https:// (got ${url.protocol})`);
  }

  const config = webhookEgressConfig(opts.env);
  const allowlisted = config.allowedHosts ? matchesAllowlist(url, config.allowedHosts) : false;
  if (url.protocol === "http:" && !allowlisted && !config.allowPrivate) {
    throw refuse(
      `Webhook URL must use https://. Plain http:// is accepted only for hosts in ${WEBHOOK_ALLOWED_HOSTS_ENV} or with ${WEBHOOK_ALLOW_PRIVATE_ENV}=true`,
    );
  }

  try {
    await assertEgressAllowed(url, guardOptions(config, opts.resolve));
  } catch (err) {
    if (err instanceof EgressDeniedError) throw refuse(err.message);
    throw err;
  }
  return url;
}

let cachedFetch: { key: string; fetch: typeof fetch } | null = null;

/**
 * A `fetch` that applies the webhook egress policy to the request and to
 * every redirect hop (DNS resolve, deny if any answer is private, connect to
 * the checked address). The default instance is cached and rebuilt when the
 * env changes; passing `baseFetch` or `resolve` builds a fresh one.
 */
export function webhookFetch(
  opts: {
    env?: NodeJS.ProcessEnv;
    baseFetch?: typeof fetch;
    resolve?: GuardedFetchOptions["resolve"];
  } = {},
): typeof fetch {
  const config = webhookEgressConfig(opts.env);
  if (opts.baseFetch || opts.resolve) {
    return createGuardedFetch(opts.baseFetch ?? fetch, guardOptions(config, opts.resolve));
  }
  const key = JSON.stringify(config);
  if (cachedFetch?.key !== key) {
    cachedFetch = { key, fetch: createGuardedFetch(fetch, guardOptions(config)) };
  }
  return cachedFetch.fetch;
}
